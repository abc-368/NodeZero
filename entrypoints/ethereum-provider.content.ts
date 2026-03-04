/**
 * EIP-1193 Provider Content Script
 *
 * Injected into every page to expose window.ethereum (EIP-1193) and
 * announce via EIP-6963 multi-provider discovery.
 *
 * Communication flow:
 *   page → window.ethereum.request() → postMessage → content script
 *   → chrome.runtime.sendMessage → background → response back
 *
 * Security:
 * - The content script acts as a bridge only; no keys or secrets are
 *   ever accessible from page context.
 * - All RPC requests are validated and routed through the background
 *   service worker which holds the session key.
 */

import { PROVIDER_INFO } from '@/lib/wallet/eip6963';

// ── Content script side: bridge between page and background ──────────────

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',

  main() {
    // Avoid double-injection
    if ((window as any).__nodezero_provider_injected) return;
    (window as any).__nodezero_provider_injected = true;

    // ── EIP-1193 Provider ──────────────────────────────────────────────

    let chainId = '0x2105'; // Base default
    let accounts: string[] = [];
    const listeners: Map<string, Set<(...args: any[]) => void>> = new Map();

    function emit(event: string, ...args: any[]) {
      const handlers = listeners.get(event);
      if (handlers) handlers.forEach(fn => fn(...args));
    }

    const provider = {
      isNodeZero: true,
      isMetaMask: false,

      // EIP-6963 metadata
      ...PROVIDER_INFO,

      // ── EIP-1193 request ─────────────────────────────────────────

      async request({ method, params }: { method: string; params?: any[] }): Promise<any> {
        // Locally handle certain read-only methods
        if (method === 'eth_chainId') return chainId;
        if (method === 'eth_accounts') return accounts;

        // All other methods proxy to background
        const response = await sendToBackground({ method, params });

        if (response?.error) {
          const err = new Error(response.error.message || 'RPC error');
          (err as any).code = response.error.code || -32603;
          (err as any).data = response.error.data;
          throw err;
        }

        // Handle side effects
        if (method === 'eth_requestAccounts') {
          accounts = response.result || [];
          emit('accountsChanged', accounts);
        }
        if (method === 'wallet_switchEthereumChain') {
          const newChainId = params?.[0]?.chainId;
          if (newChainId) {
            chainId = newChainId;
            emit('chainChanged', chainId);
          }
        }

        return response.result;
      },

      // ── EIP-1193 events ──────────────────────────────────────────

      on(event: string, handler: (...args: any[]) => void) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(handler);
      },

      removeListener(event: string, handler: (...args: any[]) => void) {
        listeners.get(event)?.delete(handler);
      },

      // Legacy aliases
      addListener(event: string, handler: (...args: any[]) => void) {
        provider.on(event, handler);
      },

      // ── EIP-3326 (deprecated but some dapps still use it) ──────

      enable() {
        return provider.request({ method: 'eth_requestAccounts' });
      },

      // ── Chain state getters ────────────────────────────────────

      get chainId() { return chainId; },
      get selectedAddress() { return accounts[0] || null; },
      get networkVersion() {
        return String(parseInt(chainId, 16));
      },
      get isConnected() { return true; },
    };

    // ── Inject as window.ethereum ──────────────────────────────────────

    // Don't override if another wallet already claimed window.ethereum
    // EIP-6963 discovery handles coexistence
    if (!(window as any).ethereum) {
      Object.defineProperty(window, 'ethereum', {
        value: provider,
        writable: false,
        configurable: true,
      });
    }

    // ── EIP-6963 Announcement ─────────────────────────────────────────

    const announceDetail = Object.freeze({
      info: Object.freeze({
        uuid: PROVIDER_INFO.uuid,
        name: PROVIDER_INFO.name,
        icon: PROVIDER_INFO.icon,
        rdns: PROVIDER_INFO.rdns,
      }),
      provider,
    });

    function announceProvider() {
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: announceDetail,
        })
      );
    }

    // Announce immediately
    announceProvider();

    // Re-announce when a dapp requests providers
    window.addEventListener('eip6963:requestProvider', () => {
      announceProvider();
    });

    // ── Message bridge ────────────────────────────────────────────────

    let requestId = 0;
    const pending = new Map<number, { resolve: Function; reject: Function }>();

    function sendToBackground(payload: { method: string; params?: any[] }): Promise<any> {
      return new Promise((resolve, reject) => {
        const id = ++requestId;
        pending.set(id, { resolve, reject });

        window.postMessage({
          type: 'NODEZERO_EIP1193_REQUEST',
          id,
          payload,
        }, '*');

        // Timeout after 5 minutes (some operations like tx approval take time)
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error('Request timed out'));
          }
        }, 300_000);
      });
    }

    // Listen for responses from the isolated content script
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== 'NODEZERO_EIP1193_RESPONSE') return;

      const { id, response } = event.data;
      const handler = pending.get(id);
      if (handler) {
        pending.delete(id);
        handler.resolve(response);
      }
    });

    // Listen for events pushed from background (chain/account changes)
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== 'NODEZERO_EIP1193_EVENT') return;

      const { event: eventName, data } = event.data;
      if (eventName === 'chainChanged') {
        chainId = data;
        emit('chainChanged', data);
      } else if (eventName === 'accountsChanged') {
        accounts = data;
        emit('accountsChanged', data);
      }
    });
  },
});
