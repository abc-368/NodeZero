/**
 * NodeZero Background Service Worker
 *
 * Responsibilities:
 * - Context menu registration and handling
 * - In-memory session state (vault key, entries)
 * - Vault CRUD operations (proxied from popup/content)
 * - Cross-device sync
 * - Session timeout via chrome.idle
 *
 * Security invariant: No plaintext credential data is ever written to disk.
 * The session key and decrypted entries live only in this service worker's
 * heap. Chrome may suspend the worker — see MV3 keepalive pattern below.
 */

import { browser } from 'wxt/browser';
import { registerContextMenus, ContextMenuItemId } from '@/lib/context-menu';
import {
  MessageType,
  MessageFrom,
  NodeZeroMessage,
  SessionState,
  FillPayload,
  PageInfo,
} from '@/lib/types';
import {
  VaultSession,
  loadVaultFromStorage,
  saveVaultToStorage,
  addEntry,
  updateEntry,
  deleteEntry,
  vaultExists,
} from '@/lib/vault/vault';
import { VaultEntry, createEntry } from '@/lib/vault/entry';
import { syncVault, mergeAndSync, smartSync } from '@/lib/vault/sync';
import { clearActiveKeyPair, getActiveDid, signBundle } from '@/lib/did/provider';
import { loadAndActivateDID, clearX25519Keys } from '@/lib/did/storage';
import { importAesKey, base64ToBuffer } from '@/lib/crypto/field-encrypt';
import { getPoolSize, purgeExpiredTokens } from '@/lib/tokens/pool';
import { SYNC_API_BASE } from '@/lib/constants';
import { refillPool } from '@/lib/tokens/issuer';
import { getActiveX25519PrivateKey, getActiveX25519PublicKeyBase64 } from '@/lib/did/storage';
import { deriveEthAccount } from '@/lib/wallet/hd';
import { deriveBtcSegwitAccount } from '@/lib/wallet/bitcoin';
import { CHAIN_CONFIGS, TESTNET_CHAIN_CONFIGS, getChainConfig, EVM_CHAINS, type Chain } from '@/lib/wallet/types';
import { hashEmail, normalizeEmail, queueEmailHashForSync, lookupEmailKey } from '@/lib/email/registry';
import { encryptEmailBodyMulti, decryptEmailBody } from '@/lib/email/crypto';
import { extractEncryptedBlob, formatEncryptedMessage } from '@/lib/email/gmail-selectors';

// ── Programmatic content script injection ─────────────────────────────────
// Instead of auto-injecting on every page (which requires <all_urls>),
// we inject on demand when the user triggers a context menu action or
// opens the popup. activeTab + scripting permissions cover this.

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-inject.js'],
    });
  } catch {
    // Injection may fail on chrome://, about:, edge://, etc. — ignore silently
  }
}

// ── In-memory session (cleared on lock/idle) ──────────────────────────────

let session: VaultSession | null = null;
let primaryKeyRawB64: string | null = null; // raw key bytes for biometric upgrade

function getSessionState(): SessionState {
  return {
    isUnlocked: session !== null,
    did: session?.bundle.did ?? null,
    entryCount: session?.entries.length ?? 0,
    lastUnlocked: session ? Date.now() : null,
  };
}

function lockSession(): void {
  session = null;
  primaryKeyRawB64 = null;
  walletState.connectedOrigins.clear();
  walletState.activeAccountIndex = 0;
  clearActiveKeyPair();
  clearX25519Keys();
  // Clear session storage as well
  chrome.storage.session.clear();
}

// ── Wallet state (in-memory, per session) ─────────────────────────────

const walletState = {
  activeChain: 'base' as Chain,
  activeAccountIndex: 0,
  connectedOrigins: new Set<string>(),
  testnetMode: false,
};

// Load persisted testnet preference on startup
chrome.storage.local.get('nz_testnet_mode').then(data => {
  walletState.testnetMode = !!data.nz_testnet_mode;
});

/** Get the active chain config, respecting testnet mode */
function activeChainConfig(): import('@/lib/wallet/types').ChainConfig {
  return getChainConfig(walletState.activeChain, walletState.testnetMode);
}

/**
 * Get the active wallet address for the current chain + account index.
 * Returns null if vault is locked (no mnemonic available).
 */
function getActiveWalletAddress(): string | null {
  if (!session?.mnemonic) return null;
  try {
    if (walletState.activeChain === 'bitcoin') {
      const btcAccount = deriveBtcSegwitAccount(session.mnemonic, walletState.activeAccountIndex);
      btcAccount.privateKey.fill(0);
      return btcAccount.address;
    }
    const account = deriveEthAccount(session.mnemonic, walletState.activeAccountIndex);
    account.privateKey.fill(0);
    return account.address;
  } catch {
    return null;
  }
}

/**
 * Handle EIP-1193 JSON-RPC requests from the ethereum-bridge content script.
 */
async function handleEIP1193Request(
  payload: { method: string; params?: any[] },
  senderOrigin?: string,
): Promise<{ result?: any; error?: { code: number; message: string; data?: any } }> {
  const { method, params } = payload;

  switch (method) {
    // ── Account discovery ─────────────────────────────────────────

    case 'eth_requestAccounts': {
      if (!session?.mnemonic) {
        // Open popup to unlock
        await browser.action.openPopup?.();
        return { error: { code: 4100, message: 'Vault is locked. Please unlock NodeZero.' } };
      }
      // Auto-approve connection (user already unlocked vault)
      const address = getActiveWalletAddress();
      if (!address) return { error: { code: -32603, message: 'Failed to derive address' } };
      if (senderOrigin) walletState.connectedOrigins.add(senderOrigin);
      return { result: [address] };
    }

    case 'eth_accounts': {
      if (!session?.mnemonic) return { result: [] };
      if (senderOrigin && !walletState.connectedOrigins.has(senderOrigin)) return { result: [] };
      const address = getActiveWalletAddress();
      return { result: address ? [address] : [] };
    }

    // ── Chain info ────────────────────────────────────────────────

    case 'eth_chainId': {
      const config = activeChainConfig();
      return { result: config.chainId };
    }

    case 'net_version': {
      const config = activeChainConfig();
      return { result: String(parseInt(config.chainId, 16)) };
    }

    // ── Chain switching ──────────────────────────────────────────

    case 'wallet_switchEthereumChain': {
      const targetChainId = params?.[0]?.chainId;
      if (!targetChainId) return { error: { code: -32602, message: 'Missing chainId' } };
      const configs = walletState.testnetMode ? TESTNET_CHAIN_CONFIGS : CHAIN_CONFIGS;
      const chain = EVM_CHAINS.find(c => configs[c].chainId === targetChainId);
      if (!chain) {
        return { error: { code: 4902, message: `Chain ${targetChainId} not supported` } };
      }
      walletState.activeChain = chain;
      // Notify all tabs of chain change
      broadcastWalletEvent('chainChanged', targetChainId);
      return { result: null };
    }

    case 'wallet_addEthereumChain': {
      // We support a fixed set — check if we already have it
      const addChainId = params?.[0]?.chainId;
      const configs = walletState.testnetMode ? TESTNET_CHAIN_CONFIGS : CHAIN_CONFIGS;
      const existing = EVM_CHAINS.find(c => configs[c].chainId === addChainId);
      if (existing) {
        walletState.activeChain = existing;
        broadcastWalletEvent('chainChanged', addChainId);
        return { result: null };
      }
      return { error: { code: 4902, message: 'Chain not supported by NodeZero' } };
    }

    // ── Signing & transactions (queued for user approval) ────────

    case 'eth_sendTransaction': {
      if (!session?.mnemonic) {
        return { error: { code: 4100, message: 'Vault is locked' } };
      }
      const txParams = params?.[0];
      if (!txParams) return { error: { code: -32602, message: 'Missing transaction params' } };

      // Store pending tx for approval UI
      const txId = crypto.randomUUID();
      await chrome.storage.session.set({
        pendingWalletApproval: {
          id: txId,
          type: 'eth_sendTransaction',
          params: txParams,
          origin: senderOrigin,
          chain: walletState.activeChain,
        },
      });
      await browser.action.openPopup?.();

      // Wait for approval (poll storage)
      return await waitForApproval(txId);
    }

    case 'eth_signTypedData_v4':
    case 'eth_signTypedData': {
      if (!session?.mnemonic) {
        return { error: { code: 4100, message: 'Vault is locked' } };
      }
      const address = params?.[0];
      const typedData = params?.[1];
      if (!typedData) return { error: { code: -32602, message: 'Missing typed data' } };

      const signId = crypto.randomUUID();
      await chrome.storage.session.set({
        pendingWalletApproval: {
          id: signId,
          type: 'eth_signTypedData_v4',
          params: { address, typedData: typeof typedData === 'string' ? JSON.parse(typedData) : typedData },
          origin: senderOrigin,
          chain: walletState.activeChain,
        },
      });
      await browser.action.openPopup?.();
      return await waitForApproval(signId);
    }

    case 'personal_sign': {
      if (!session?.mnemonic) {
        return { error: { code: 4100, message: 'Vault is locked' } };
      }
      const msgHex = params?.[0];
      const signerAddr = params?.[1];
      if (!msgHex) return { error: { code: -32602, message: 'Missing message' } };

      const psId = crypto.randomUUID();
      await chrome.storage.session.set({
        pendingWalletApproval: {
          id: psId,
          type: 'personal_sign',
          params: { message: msgHex, address: signerAddr },
          origin: senderOrigin,
          chain: walletState.activeChain,
        },
      });
      await browser.action.openPopup?.();
      return await waitForApproval(psId);
    }

    // ── Read-only RPC passthrough ────────────────────────────────

    case 'eth_blockNumber':
    case 'eth_getBalance':
    case 'eth_getTransactionCount':
    case 'eth_getCode':
    case 'eth_call':
    case 'eth_estimateGas':
    case 'eth_gasPrice':
    case 'eth_getBlockByNumber':
    case 'eth_getBlockByHash':
    case 'eth_getTransactionByHash':
    case 'eth_getTransactionReceipt':
    case 'eth_getLogs':
    case 'eth_maxPriorityFeePerGas':
    case 'eth_feeHistory': {
      return await proxyRpcCall(method, params);
    }

    // ── Wallet metadata ─────────────────────────────────────────

    case 'wallet_getPermissions': {
      return { result: [{ parentCapability: 'eth_accounts' }] };
    }

    case 'wallet_requestPermissions': {
      // Auto-approve eth_accounts
      return { result: [{ parentCapability: 'eth_accounts' }] };
    }

    case 'web3_clientVersion': {
      return { result: 'NodeZero/1.0.0' };
    }

    default:
      return { error: { code: 4200, message: `Method ${method} not supported` } };
  }
}

/**
 * Proxy a read-only JSON-RPC call to the active chain's public RPC.
 */
async function proxyRpcCall(method: string, params?: any[]): Promise<any> {
  const config = activeChainConfig();
  try {
    const resp = await fetch(config.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: params || [],
      }),
    });
    const json = await resp.json() as { result?: any; error?: any };
    if (json.error) return { error: json.error };
    return { result: json.result };
  } catch (err: any) {
    return { error: { code: -32603, message: err?.message || 'RPC call failed' } };
  }
}

/**
 * Wait for user approval of a wallet action. Polls session storage.
 * Returns the result when approved/rejected, or times out after 5 min.
 */
async function waitForApproval(approvalId: string): Promise<any> {
  const TIMEOUT_MS = 300_000; // 5 min
  const POLL_MS = 500;
  const start = Date.now();

  while (Date.now() - start < TIMEOUT_MS) {
    const data = await chrome.storage.session.get('walletApprovalResult');
    const result = data.walletApprovalResult;
    if (result && result.id === approvalId) {
      await chrome.storage.session.remove('walletApprovalResult');
      if (result.approved) {
        return { result: result.value };
      } else {
        return { error: { code: 4001, message: 'User rejected the request' } };
      }
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }

  return { error: { code: -32603, message: 'Approval timed out' } };
}

/**
 * Broadcast a wallet event to all tabs (chain/account changes).
 */
async function broadcastWalletEvent(event: string, data: any): Promise<void> {
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (tab.id) {
      try {
        await browser.tabs.sendMessage(tab.id, {
          type: 'EIP1193_EVENT',
          event,
          data,
        });
      } catch { /* tab may not have bridge script */ }
    }
  }
}

// ── Background entrypoint ─────────────────────────────────────────────────

export default defineBackground(() => {
  console.log('[NodeZero] Background service worker started', { id: browser.runtime.id });

  // ── Token pool: purge expired tokens on service worker wake ────────────────
  purgeExpiredTokens().catch(() => {});

  // ── Periodic pool health check (every 30 min) ─────────────────────────────
  // Ensures expired tokens are cleaned up and the pool is refilled even if the
  // popup is never opened for long stretches.  chrome.alarms survive service
  // worker suspension — the callback re-wakes the worker automatically.
  const POOL_ALARM_NAME = 'nz:pool-health';
  chrome.alarms.create(POOL_ALARM_NAME, { periodInMinutes: 30 });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== POOL_ALARM_NAME) return;
    try {
      await purgeExpiredTokens();
      // Always call refillPool — it handles both cases internally:
      //  1. Pool below threshold → requests full batch
      //  2. Pool at budget but meta stale → requests 1 token to refresh meta
      // The META_STALE_MS check inside _refillPoolImpl decides whether to
      // skip the server call or make a lightweight refresh request.
      if (session?.bundle.did) {
        console.log('[NodeZero] Periodic pool health check');
        await refillPool(session.bundle.did);
      }
    } catch (err) {
      console.warn('[NodeZero] Periodic pool health check failed:', err);
    }
  });

  // ── v3.0.0 migration: update Worker URL to new backend ────────────────────
  // Old URLs pointed to 'nodezero-cid-pointer' or 'nodezero-pointer'.
  // v3.0 Worker lives at 'nodezero-backend'. Auto-correct on startup.
  chrome.storage.local.get('nodezero_pointer_url').then((data) => {
    const stored = data.nodezero_pointer_url as string | undefined;
    if (stored && !stored.includes('nodezero-backend')) {
      const corrected = 'https://nodezero-backend.netalgowin.workers.dev';
      chrome.storage.local.set({ nodezero_pointer_url: corrected });
      console.log('[NodeZero] Migrated Worker URL:', stored, '→', corrected);
    }
    // Clean up stale keys from previous versions
    chrome.storage.local.remove(['nodezero_storacha_space', 'nodezero_storacha_token']);
  });

  // ── MV3 keepalive — prevent service worker suspension while popup is open ──
  // An open port alone does NOT reset Chrome's 30s inactivity timer; the
  // port must be actively used.  The popup sends a 'ping' every 25s and we
  // respond with 'pong', keeping the timer reset on both sides.
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'nodezero-keepalive') return;
    port.onMessage.addListener((msg) => {
      if (msg?.type === 'ping') port.postMessage({ type: 'pong' });
    });
    port.onDisconnect.addListener(() => {
      console.log('[NodeZero] Popup keepalive port disconnected');
    });
  });

  // Context menus persist across service worker restarts in MV3.
  // Re-register only on install/update by removing all first.
  browser.runtime.onInstalled.addListener(async () => {
    await browser.contextMenus.removeAll();
    registerContextMenus();
  });

  // ── Side panel preference ────────────────────────────────────────────────
  // Respect user preference for opening as side panel instead of popup.
  // When enabled, clicking the extension icon opens the side panel.
  async function applySidePanelPreference() {
    try {
      const data = await chrome.storage.local.get('nodezero_open_mode');
      const mode = data['nodezero_open_mode'] ?? 'popup';
      if (mode === 'sidepanel' && chrome.sidePanel) {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      } else if (chrome.sidePanel) {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      }
    } catch { /* sidePanel API may not be available */ }
  }
  applySidePanelPreference();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['nodezero_open_mode']) {
      applySidePanelPreference();
    }
  });

  // ── Auto-inject content script on Gmail ─────────────────────────────────
  // The auto-decrypt MutationObserver needs to be running before the user
  // right-clicks. The Gmail host permission is declared as optional to
  // avoid Chrome Web Store in-depth review. Once the user grants it (via
  // the first email action), tabs.onUpdated can auto-inject on Gmail.
  browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (
      changeInfo.status === 'complete' &&
      tab.url?.startsWith('https://mail.google.com/')
    ) {
      // Check if the optional permission has been granted
      const granted = await chrome.permissions.contains({
        origins: ['*://mail.google.com/*'],
      });
      if (granted) {
        await ensureContentScript(tabId);
      }
    }
  });

  // ── Context menu click handler ──────────────────────────────────────────

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    const itemId = info.menuItemId as ContextMenuItemId;
    if (!tab?.id) return;

    switch (itemId) {
      case 'nodezero-fill': {
        if (!session) {
          // Open popup to unlock first
          await browser.action.openPopup?.();
          return;
        }
        // Get current tab URL, find matching entries
        const tabUrl = tab.url ?? '';
        const { findEntriesForUrl } = await import('@/lib/vault/vault');
        const matches = findEntriesForUrl(session.entries, tabUrl);
        if (matches.length === 0) {
          // No matches — open popup so user can search manually
          await browser.action.openPopup?.();
          return;
        }
        // Inject content script now (background has activeTab from context menu click)
        await ensureContentScript(tab.id);
        if (matches.length === 1) {
          // Single match — try auto-fill first
          await browser.tabs.sendMessage(tab.id, {
            type: MessageType.fillCredentials,
            from: MessageFrom.background,
            payload: { username: matches[0].username, password: matches[0].password } as FillPayload,
          } satisfies NodeZeroMessage<FillPayload>);
        }
        // Always show the FillPicker with copy buttons — provides fallback
        // when auto-fill can't match fields (e.g. non-standard login forms)
        await browser.storage.session.set({
          pendingFill: { entries: matches, tabId: tab.id },
        });
        await browser.action.openPopup?.();
        break;
      }

      case 'nodezero-generate': {
        // Send generated password to the focused input
        const password = generateSecurePassword({ length: 20 });
        await ensureContentScript(tab.id);
        await browser.tabs.sendMessage(tab.id, {
          type: MessageType.fillCredentials,
          from: MessageFrom.background,
          payload: { username: '', password } as FillPayload,
        } satisfies NodeZeroMessage<FillPayload>);
        break;
      }

      case 'nodezero-save': {
        // Ask content script for page info, then open popup to save
        try {
          await ensureContentScript(tab.id);
          const pageInfo = await browser.tabs.sendMessage(tab.id, {
            type: MessageType.getPageInfo,
            from: MessageFrom.background,
          } satisfies NodeZeroMessage) as PageInfo;

          // If the page has an empty password field, auto-generate a strong
          // password and fill it on the page — combined Save + Generate flow.
          if (pageInfo.hasPasswordField && !pageInfo.password) {
            const generated = generateSecurePassword({ length: 20 });
            pageInfo.password = generated;
            // Best-effort fill — don't let fill failure prevent saving
            try {
              await browser.tabs.sendMessage(tab.id, {
                type: MessageType.fillCredentials,
                from: MessageFrom.background,
                payload: { username: '', password: generated } as FillPayload,
              } satisfies NodeZeroMessage<FillPayload>);
            } catch {
              // Content script context may be lost — password is still stored
            }
          }

          await browser.storage.session.set({ pendingSaveLogin: pageInfo });
        } catch {
          // Content script may not be injected yet — just open popup
        }
        await browser.action.openPopup?.();
        break;
      }

      case 'nodezero-open': {
        await browser.action.openPopup?.();
        break;
      }

      // ── Email encryption context menu items ────────────────────────────

      case 'nodezero-link-email': {
        // Request Gmail permission on first email action (no-op if already granted)
        if (!(await ensureGmailPermission())) return;
        if (!session) {
          await browser.storage.session.set({
            pendingEmailAction: { action: 'link', tabId: tab.id },
          });
          await browser.action.openPopup?.();
          return;
        }
        await handleLinkEmail(tab.id);
        break;
      }

      case 'nodezero-encrypt': {
        if (!(await ensureGmailPermission())) return;
        if (!session) {
          await browser.storage.session.set({
            pendingEmailAction: { action: 'encrypt', tabId: tab.id },
          });
          await browser.action.openPopup?.();
          return;
        }
        await handleEncryptEmail(tab.id);
        break;
      }

      case 'nodezero-decrypt': {
        if (!(await ensureGmailPermission())) return;
        if (!session) {
          await browser.storage.session.set({
            pendingEmailAction: { action: 'decrypt', tabId: tab.id },
          });
          await browser.action.openPopup?.();
          return;
        }
        await handleDecryptEmail(tab.id);
        break;
      }
    }
  });

  // ── Message handler (popup ↔ background) ───────────────────────────────

  browser.runtime.onMessage.addListener(
    (message: any, sender, sendResponse) => {
      // EIP-1193 requests from ethereum-bridge content script
      if (message.type === 'EIP1193_REQUEST') {
        const origin = sender.tab?.url ? new URL(sender.tab.url).origin : undefined;
        handleEIP1193Request(message.payload, origin)
          .then(result => sendResponse(result))
          .catch(err => sendResponse({ error: { code: -32603, message: err?.message ?? 'Internal error' } }));
        return true;
      }

      // Auto-decrypt requests from content script (not from popup)
      if (message.type === 'autoDecryptEmail' && sender.tab?.id) {
        if (!session) {
          // Queue the decrypt action so it executes after biometric unlock
          browser.storage.session.set({
            pendingEmailAction: { action: 'decrypt', tabId: sender.tab.id },
          }).then(() => {
            // Set badge to signal the user to click the extension icon
            chrome.action.setBadgeText({ text: '🔓' });
            chrome.action.setBadgeBackgroundColor({ color: '#F59E0B' });
            console.log('[NodeZero] Auto-decrypt queued — vault locked, badge set');
          });
          sendResponse({ error: 'Vault is locked', queued: true });
          return false;
        }
        // Content script sends the body text directly — decrypt inline and
        // return the result so the content script can replace the specific element
        const bodyText = message.payload?.bodyText;
        if (bodyText) {
          autoDecryptInline(bodyText)
            .then(result => sendResponse(result))
            .catch(err => sendResponse({ error: err?.message ?? 'Decrypt failed' }));
        } else {
          // Fallback: use old tab-level decrypt (right-click path)
          handleDecryptEmail(sender.tab.id)
            .then(() => sendResponse({ success: true }))
            .catch(err => sendResponse({ error: err?.message ?? 'Decrypt failed' }));
        }
        return true;
      }

      // Standard popup ↔ background messages
      handleMessage(message as NodeZeroMessage).then(sendResponse).catch(err => {
        console.error('[NodeZero] Message handler error:', err);
        sendResponse({ error: err?.message ?? 'Unknown error' });
      });
      return true; // keep channel open for async response
    }
  );

  // ── Idle detection — auto-lock after 1 hour ────────────────────────────

  chrome.idle.setDetectionInterval(3600); // 3600s = 1 hour
  chrome.idle.onStateChanged.addListener((state) => {
    if (state === 'locked' || state === 'idle') {
      console.log('[NodeZero] Auto-locking due to idle/locked state');
      lockSession();
    }
  });
});

// ── Gmail optional permission ─────────────────────────────────────────────
// Declared as optional_host_permissions to avoid Chrome Web Store in-depth
// review. Requested at runtime the first time the user triggers an email
// action. Once granted it persists across sessions.

async function ensureGmailPermission(): Promise<boolean> {
  // chrome.permissions.request() is a no-op if already granted, so we call
  // it directly instead of checking contains() first. This preserves the
  // user-gesture context on macOS Chrome where an intermediate await
  // (like permissions.contains) can cause the gesture to expire before
  // request() runs.
  try {
    const granted = await chrome.permissions.request({
      origins: ['*://mail.google.com/*'],
    });
    if (granted) {
      console.log('[NodeZero] Gmail host permission granted');
    } else {
      console.warn('[NodeZero] Gmail host permission denied by user');
    }
    return granted;
  } catch (err) {
    // Fallback: if request() still throws (e.g. gesture expired), check
    // whether permission was already granted in a previous session.
    const already = await chrome.permissions.contains({
      origins: ['*://mail.google.com/*'],
    });
    if (already) return true;
    console.error('[NodeZero] Gmail permission request failed:', err);
    return false;
  }
}

// ── Email encryption handlers ─────────────────────────────────────────────

/**
 * Link the user's Gmail email to their DID.
 * Reads the logged-in email from the Gmail DOM (proof-of-access),
 * hashes it, and queues it for registration during the next vault sync.
 */
async function handleLinkEmail(tabId: number): Promise<void> {
  try {
    await ensureContentScript(tabId);
    const result = await browser.tabs.sendMessage(tabId, {
      type: 'getGmailUserEmail',
      from: MessageFrom.background,
    });

    if (result?.error) {
      console.warn('[NodeZero] Link email failed:', result.error);
      return;
    }

    const email = result?.email;
    if (!email) return;

    const normalized = normalizeEmail(email);
    const emailHash = await hashEmail(email);
    const x25519Pub = getActiveX25519PublicKeyBase64();
    const did = getActiveDid();

    if (!x25519Pub || !did) {
      console.warn('[NodeZero] Cannot link email: X25519 key or DID not available');
      return;
    }

    // Register directly via POST /v2/email/register (DID-signed, no token cost)
    const timestamp = Date.now();
    const sigPayload = `nodezero-email-register\ndid:${did}\nhash:${emailHash}\ntimestamp:${timestamp}`;
    const signature = await signBundle(new TextEncoder().encode(sigPayload));

    const resp = await fetch(`${SYNC_API_BASE}/v2/email/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DID': did,
        'X-Timestamp': timestamp.toString(),
        'X-Signature': signature,
      },
      body: JSON.stringify({ email_hash: emailHash, x25519_pub: x25519Pub }),
    });

    if (resp.ok) {
      console.log(`[NodeZero] Email registered: "${email}" normalized="${normalized}" hash=${emailHash.slice(0, 12)}…`);
    } else {
      const errBody = await resp.text();
      console.warn(`[NodeZero] Email register failed (${resp.status}):`, errBody);
      // Fallback: queue for piggybacking on next sync
      await queueEmailHashForSync(emailHash);
      console.log(`[NodeZero] Hash queued for sync fallback: ${emailHash.slice(0, 12)}…`);
    }
  } catch (err) {
    console.error('[NodeZero] Link email error:', err);
  }
}

/**
 * Encrypt the compose window body for all recipients.
 * Looks up each recipient's X25519 public key from the registry (1 token each),
 * performs multi-recipient ECDH + AES-GCM encryption, and replaces the compose body.
 *
 * If some recipients are not enrolled, shows a warning listing them and does NOT encrypt.
 */
async function handleEncryptEmail(tabId: number): Promise<void> {
  try {
    await ensureContentScript(tabId);
    const composeInfo = await browser.tabs.sendMessage(tabId, {
      type: 'getGmailComposeInfo',
      from: MessageFrom.background,
    });

    if (composeInfo?.error) {
      console.warn('[NodeZero] Encrypt email failed:', composeInfo.error);
      return;
    }

    // Use recipientEmails array (multi-recipient) with fallback to single recipientEmail
    const recipientEmails: string[] = composeInfo?.recipientEmails?.length
      ? composeInfo.recipientEmails
      : composeInfo?.recipientEmail
        ? [composeInfo.recipientEmail]
        : [];

    if (recipientEmails.length === 0) {
      console.warn('[NodeZero] No recipient emails found in compose window');
      return;
    }

    const bodyText = composeInfo?.bodyText;
    if (!bodyText?.trim()) {
      console.warn('[NodeZero] Empty compose body — nothing to encrypt');
      return;
    }

    // Look up each recipient's X25519 public key (1 token per lookup on cache miss)
    const enrolled: { email: string; pubKey: Uint8Array }[] = [];
    const notEnrolled: string[] = [];

    for (const email of recipientEmails) {
      const normalized = normalizeEmail(email);
      const hash = await hashEmail(email);
      console.log(`[NodeZero] Encrypt: looking up "${email}" normalized="${normalized}" hash=${hash.slice(0, 12)}…`);

      const result = await lookupEmailKey(hash);
      if (result?.x25519_pub) {
        enrolled.push({ email, pubKey: base64ToBuffer(result.x25519_pub) });
      } else {
        notEnrolled.push(email);
      }
    }

    // If ANY recipients are not enrolled, warn and do NOT encrypt
    if (notEnrolled.length > 0) {
      const notEnrolledList = notEnrolled.join(', ');
      console.warn(`[NodeZero] ${notEnrolled.length} recipient(s) not registered: ${notEnrolledList}`);

      const warning = notEnrolled.length === recipientEmails.length
        ? `⚠️ [NodeZero] No recipients are registered with NodeZero.\nThis email will be sent in plaintext.\n\nNot registered: ${notEnrolledList}`
        : `⚠️ [NodeZero] Some recipients are not registered with NodeZero.\nCannot encrypt — all recipients must be enrolled.\n\nNot registered: ${notEnrolledList}\nRegistered: ${enrolled.map(r => r.email).join(', ')}`;

      await browser.tabs.sendMessage(tabId, {
        type: 'replaceComposeBody',
        from: MessageFrom.background,
        payload: {
          content: bodyText + '\n\n\n' + warning,
        },
      });
      return;
    }

    // Self-encrypt: include sender's own public key so they can decrypt from Sent folder
    const ownPubBase64 = getActiveX25519PublicKeyBase64();
    const recipientPubKeys = enrolled.map(r => r.pubKey);
    if (ownPubBase64) {
      const ownPubBytes = base64ToBuffer(ownPubBase64);
      // Only add if not already in the list (sender might be emailing themselves)
      const alreadyIncluded = recipientPubKeys.some(
        pk => pk.length === ownPubBytes.length && pk.every((b, i) => b === ownPubBytes[i])
      );
      if (!alreadyIncluded) {
        recipientPubKeys.push(ownPubBytes);
        console.log('[NodeZero] Self-encrypt: sender added as recipient for Sent folder decryption');
      }
    }

    const encryptedBlob = await encryptEmailBodyMulti(bodyText, recipientPubKeys);
    // Display count excludes the sender (they don't need to know about the self-encrypt)
    const formattedMessage = formatEncryptedMessage(encryptedBlob, enrolled.length);

    // Replace compose body with encrypted content
    await browser.tabs.sendMessage(tabId, {
      type: 'replaceComposeBody',
      from: MessageFrom.background,
      payload: { content: formattedMessage },
    });

    console.log(`[NodeZero] Email body encrypted for ${enrolled.length} recipient(s)`);
  } catch (err) {
    console.error('[NodeZero] Encrypt email error:', err);
  }
}

/**
 * Decrypt the currently viewed email message.
 * Extracts the encrypted blob from the message body, performs ECDH
 * decryption with the user's X25519 private key, and replaces the body.
 */
async function handleDecryptEmail(tabId: number): Promise<void> {
  try {
    await ensureContentScript(tabId);
    const messageInfo = await browser.tabs.sendMessage(tabId, {
      type: 'getGmailMessageInfo',
      from: MessageFrom.background,
    });

    if (messageInfo?.error) {
      console.warn('[NodeZero] Decrypt email failed:', messageInfo.error);
      return;
    }

    const bodyText = messageInfo?.bodyText;
    if (!bodyText) return;

    // Extract encrypted blob from markers
    const encryptedBlob = extractEncryptedBlob(bodyText);
    if (!encryptedBlob) {
      console.warn('[NodeZero] No encrypted content found in this email');
      return;
    }

    // Get our X25519 private key
    const privateKey = getActiveX25519PrivateKey();
    if (!privateKey) {
      console.warn('[NodeZero] X25519 key not available. Vault may need to be unlocked.');
      return;
    }

    // Decrypt
    const plaintext = await decryptEmailBody(encryptedBlob, privateKey);

    // Replace message body with decrypted content + indicator banner
    const decryptedWithBanner = '🔓 Decrypted by NodeZero\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' + plaintext;
    await browser.tabs.sendMessage(tabId, {
      type: 'replaceMessageBody',
      from: MessageFrom.background,
      payload: { content: decryptedWithBanner },
    });

    console.log('[NodeZero] Email body decrypted successfully');
  } catch (err) {
    console.error('[NodeZero] Decrypt email error:', err);
  }
}

/**
 * Decrypt an encrypted email body inline — used by auto-decrypt.
 * Returns the decrypted HTML so the content script can replace the element directly.
 * This avoids the getGmailMessageInfo round-trip which can only find one message body.
 */
async function autoDecryptInline(bodyText: string): Promise<{ success: boolean; decryptedHtml?: string; error?: string }> {
  const encryptedBlob = extractEncryptedBlob(bodyText);
  if (!encryptedBlob) {
    return { success: false, error: 'No encrypted content found' };
  }

  const privateKey = getActiveX25519PrivateKey();
  if (!privateKey) {
    return { success: false, error: 'X25519 key not available' };
  }

  const plaintext = await decryptEmailBody(encryptedBlob, privateKey);

  // Build HTML-safe decrypted content with banner
  const decryptedWithBanner = '🔓 Decrypted by NodeZero\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' + plaintext;
  const decryptedHtml = decryptedWithBanner
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');

  console.log('[NodeZero] Auto-decrypt inline completed');
  return { success: true, decryptedHtml };
}

// ── Pending email action (execute after unlock) ──────────────────────────

async function executePendingEmailAction(): Promise<void> {
  const data = await browser.storage.session.get('pendingEmailAction');
  const pending = data.pendingEmailAction as
    | { action: 'link' | 'encrypt' | 'decrypt'; tabId: number }
    | undefined;

  if (!pending) return;

  // Clear immediately to prevent re-execution
  await browser.storage.session.remove('pendingEmailAction');

  if (!session) {
    console.warn('[NodeZero] Pending email action skipped — session still locked');
    return;
  }

  console.log(`[NodeZero] Executing pending email action: ${pending.action} on tab ${pending.tabId}`);

  switch (pending.action) {
    case 'link':
      await handleLinkEmail(pending.tabId);
      break;
    case 'encrypt':
      await handleEncryptEmail(pending.tabId);
      break;
    case 'decrypt':
      await handleDecryptEmail(pending.tabId);
      break;
  }
}

/**
 * Broadcast "vault unlocked" to all Gmail tabs.
 * This allows auto-decrypt observers to re-scan queued messages.
 */
async function broadcastVaultUnlocked(): Promise<void> {
  const tabs = await browser.tabs.query({ url: 'https://mail.google.com/*' });
  for (const tab of tabs) {
    if (tab.id) {
      try {
        await browser.tabs.sendMessage(tab.id, {
          type: 'vaultUnlocked',
          from: MessageFrom.background,
        });
      } catch {
        // Tab may not have content script injected — ignore
      }
    }
  }
}

// ── Message handler implementation ────────────────────────────────────────

async function handleMessage(message: NodeZeroMessage): Promise<unknown> {
  switch (message.type) {
    case MessageType.getSessionState:
      return getSessionState();

    case MessageType.lockVault:
      lockSession();
      return { success: true };

    case MessageType.unlockVault: {
      // Keys are derived in the popup (PRF/PIN ceremonies require a visible
      // document). chrome.runtime.sendMessage is JSON-serialised — CryptoKey
      // objects become {} in transit. The popup exports raw key bytes (base64)
      // alongside the session; we re-import them here as proper CryptoKeys.
      const { vaultSession, primaryKeyRaw, recoveryKeyRaw } = message.payload as {
        vaultSession: VaultSession;
        primaryKeyRaw: string | null;
        recoveryKeyRaw: string | null;
      };
      const primaryKey = primaryKeyRaw
        ? await importAesKey(base64ToBuffer(primaryKeyRaw))
        : null;
      const recoveryKey = recoveryKeyRaw
        ? await importAesKey(base64ToBuffer(recoveryKeyRaw))
        : null;
      session = { ...vaultSession, primaryKey, recoveryKey };
      primaryKeyRawB64 = primaryKeyRaw; // keep raw bytes for potential biometric upgrade

      // Activate DID signing key in background (needed for sealing).
      // Try primary key first; fall back to recovery key if DID was encrypted
      // with a different key (e.g. during recovery before PIN re-encryption).
      let didLoaded = false;
      if (primaryKey) {
        try { await loadAndActivateDID(primaryKey); didLoaded = true; } catch { /* */ }
      }
      if (!didLoaded && recoveryKey) {
        try { await loadAndActivateDID(recoveryKey); } catch { /* */ }
      }

      // Background merge check: download + merge remote changes if available.
      // Non-blocking — vault is already usable from local cache.
      if (session.bundle.did) {
        mergeAndSync(session)
          .then(result => {
            if (result.session !== session) {
              session = result.session;
              console.log('[NodeZero] Background merge complete on unlock.');
            }
          })
          .catch(err => console.warn('[NodeZero] Merge on unlock failed:', err));

        // Token pool maintenance: purge expired on unlock.
        // NOTE: Do NOT refill here — mergeAndSync → syncVault → acquireTokenAuth
        // already refills on demand. Running a second refill concurrently causes
        // a double-draw race (both requests see poolSize=0 before either writes,
        // so the server issues 100 tokens instead of 50).
        purgeExpiredTokens().catch(() => {});
      }

      // Clear any "unlock needed" badge
      chrome.action.setBadgeText({ text: '' });

      // Execute any pending email action that was queued while vault was locked
      executePendingEmailAction().catch(err =>
        console.warn('[NodeZero] Pending email action failed:', err)
      );

      // Broadcast "vault unlocked" to all Gmail tabs so auto-decrypt
      // observers can re-scan queued encrypted messages
      broadcastVaultUnlocked().catch(() => {});

      return { success: true, state: getSessionState() };
    }

    case MessageType.getVaultEntries:
      if (!session) return { error: 'Vault is locked' };
      return { entries: session.entries };

    case MessageType.saveVaultEntry: {
      if (!session) return { error: 'Vault is locked' };
      const entry = message.payload as VaultEntry;
      const existing = session.entries.find(e => e.id === entry.id);
      if (!existing) {
        // Duplicate check: same URL + username + password = duplicate
        const duplicate = session.entries.find(e =>
          e.url === entry.url &&
          e.username === entry.username &&
          e.password === entry.password
        );
        if (duplicate) {
          return { error: 'Duplicate entry — an identical login already exists' };
        }
      }
      session = existing
        ? updateEntry(session, entry)
        : addEntry(session, entry);
      return await persistAndSync();
    }

    case MessageType.deleteVaultEntry: {
      if (!session) return { error: 'Vault is locked' };
      const entryId = message.payload as string;
      session = deleteEntry(session, entryId);
      return await persistAndSync();
    }

    case MessageType.syncVault: {
      if (!session) return { error: 'Vault is locked' };
      return await persistAndSync(true); // Manual sync: wait for upload
    }

    case MessageType.importEntries: {
      if (!session) return { error: 'Vault is locked' };
      const newEntries = message.payload as VaultEntry[];
      if (!Array.isArray(newEntries) || newEntries.length === 0) {
        return { error: 'No entries provided' };
      }
      const result = deduplicateAndImport(session, newEntries);
      session = result.session;
      const syncRes = await persistAndSync();
      return { ...syncRes, imported: result.imported, skipped: result.skipped };
    }

    case MessageType.getTokenBalance: {
      if (!session) return { error: 'Vault is locked' };
      const poolSize = await getPoolSize();
      return { poolSize };
    }

    case MessageType.refreshTokens: {
      if (!session) return { error: 'Vault is locked' };
      const did4 = session.bundle.did;
      if (!did4) return { error: 'No DID available' };
      const refreshResult = await refillPool(did4);
      if ('error' in refreshResult) {
        return { error: refreshResult.error, resetsAt: refreshResult.resetsAt };
      }
      return { success: true, added: refreshResult.added, remaining: refreshResult.remaining };
    }

    case MessageType.signedApiFetch: {
      // Proxy: popup sends {path, method, body}, background signs + fetches
      if (!session) return { error: 'Vault is locked' };
      const did5 = session.bundle.did;
      if (!did5) return { error: 'No DID available' };
      const { path, method, body } = message.payload as {
        path: string;
        method?: string;
        body?: unknown;
      };
      try {
        const timestamp = Date.now();
        const payload = `nodezero-vault-read\ndid:${did5}\ntimestamp:${timestamp}`;
        const signature = await signBundle(new TextEncoder().encode(payload));
        const resp = await fetch(`${SYNC_API_BASE}${path}`, {
          method: method ?? 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-DID': did5,
            'X-Timestamp': timestamp.toString(),
            'X-Signature': signature,
            'X-NodeZero-Client': 'extension/0.2.0',
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const responseBody = await resp.json().catch(() => ({}));
        return { ok: resp.ok, status: resp.status, body: responseBody };
      } catch (err: any) {
        return { error: err?.message ?? 'Signed fetch failed' };
      }
    }

    case MessageType.upgradeToBiometric: {
      // Popup registered a WebAuthn credential; wrap the primary key
      // and upgrade the vault from 'pin' → 'biometric'.
      if (!session) return { error: 'Vault is locked' };
      if (!primaryKeyRawB64) return { error: 'Primary key raw bytes not available — re-unlock first' };
      const { credentialId: credIdB64 } = message.payload as { credentialId: string };
      if (!credIdB64) return { error: 'Missing credentialId' };
      try {
        const credBytes = base64ToBuffer(credIdB64);

        // Re-import key as extractable — the session key is non-extractable
        // (by design), but wrapPrimaryKeyForBiometric needs to export it.
        const extractableKey = await crypto.subtle.importKey(
          'raw',
          base64ToBuffer(primaryKeyRawB64),
          { name: 'AES-GCM', length: 256 },
          true,  // extractable
          ['encrypt', 'decrypt']
        );

        const { wrapPrimaryKeyForBiometric } = await import('@/lib/crypto/biometric-wrap');
        await wrapPrimaryKeyForBiometric(extractableKey, credBytes);

        const { bufferToBase64: b64 } = await import('@/lib/crypto/field-encrypt');
        const { PIN_PBKDF2_ITERATIONS } = await import('@/lib/crypto/pin-key');
        const updatedBundle = {
          ...session.bundle,
          kdfParams: {
            ...session.bundle.kdfParams,
            primary: { type: 'biometric' as const, iterations: PIN_PBKDF2_ITERATIONS },
          },
          credentialId: b64(credBytes),
        };
        await saveVaultToStorage(updatedBundle);
        session = { ...session, bundle: updatedBundle };
        console.log('[NodeZero] Biometric upgrade from Settings successful');
        return { success: true };
      } catch (err: any) {
        console.error('[NodeZero] Biometric upgrade failed:', err);
        return { error: err?.message ?? 'Biometric upgrade failed' };
      }
    }

    case MessageType.fillCredentials: {
      // Proxy request from popup: inject content script and forward fill
      // command to the target tab. The background has better activeTab
      // guarantees than the popup (especially when opened via openPopup()).
      const fillData = message.payload as FillPayload & { tabId: number };
      if (!fillData?.tabId) return { error: 'No tabId provided' };
      await ensureContentScript(fillData.tabId);
      try {
        return await browser.tabs.sendMessage(fillData.tabId, {
          type: MessageType.fillCredentials,
          from: MessageFrom.background,
          payload: { username: fillData.username, password: fillData.password } as FillPayload,
        } satisfies NodeZeroMessage<FillPayload>);
      } catch (err: any) {
        console.error('[NodeZero] Fill proxy failed:', err);
        return { error: err?.message || 'Fill failed' };
      }
    }

    // ── Wallet messages ───────────────────────────────────────────

    case MessageType.getWalletState: {
      if (!session?.mnemonic) return { error: 'No wallet (vault locked or no mnemonic)' };
      const walletAddr = getActiveWalletAddress();
      return {
        address: walletAddr,
        chain: walletState.activeChain,
        chainId: activeChainConfig().chainId,
        accountIndex: walletState.activeAccountIndex,
        hasMnemonic: true,
        testnetMode: walletState.testnetMode,
      };
    }

    case MessageType.setActiveChain: {
      const { chain: newChain } = message.payload as { chain: Chain };
      if (!CHAIN_CONFIGS[newChain]) return { error: 'Unknown chain' };
      walletState.activeChain = newChain;
      broadcastWalletEvent('chainChanged', getChainConfig(newChain, walletState.testnetMode).chainId);
      return { success: true, chain: newChain };
    }

    case MessageType.setTestnetMode: {
      const { enabled } = message.payload as { enabled: boolean };
      walletState.testnetMode = enabled;
      chrome.storage.local.set({ nz_testnet_mode: enabled });
      // Broadcast chain change since chainId changes between mainnet/testnet
      broadcastWalletEvent('chainChanged', activeChainConfig().chainId);
      return { success: true, testnetMode: enabled };
    }

    case MessageType.setActiveAccountIndex: {
      const { index: newIndex } = message.payload as { index: number };
      if (typeof newIndex !== 'number' || newIndex < 0) return { error: 'Invalid index' };
      walletState.activeAccountIndex = newIndex;
      const updatedAddr = getActiveWalletAddress();
      broadcastWalletEvent('accountsChanged', updatedAddr ? [updatedAddr] : []);
      return { success: true, address: updatedAddr };
    }

    case MessageType.approveWalletAction: {
      if (!session?.mnemonic) return { error: 'Vault is locked' };
      const { id: approveId, txHash: approveTxHash } = message.payload as { id: string; txHash?: string };
      await chrome.storage.session.set({
        walletApprovalResult: { id: approveId, approved: true, value: approveTxHash },
      });
      return { success: true };
    }

    case MessageType.rejectWalletAction: {
      const { id: rejectId } = message.payload as { id: string };
      await chrome.storage.session.set({
        walletApprovalResult: { id: rejectId, approved: false },
      });
      return { success: true };
    }

    case MessageType.signTransaction: {
      if (!session?.mnemonic) return { error: 'Vault is locked' };
      const { tx: signTx, approvalId: signApprovalId } = message.payload as { tx: any; approvalId: string };
      try {
        const walletAccount = deriveEthAccount(session.mnemonic, walletState.activeAccountIndex);
        const { signTransaction: signTxFn } = await import('@/lib/wallet/signer');
        const signedTxHex = await signTxFn(signTx, walletAccount.privateKey, walletState.activeChain, walletState.testnetMode);
        walletAccount.privateKey.fill(0);

        const rpcResult = await proxyRpcCall('eth_sendRawTransaction', [signedTxHex]);
        if (rpcResult.error) {
          await chrome.storage.session.set({
            walletApprovalResult: { id: signApprovalId, approved: false },
          });
          return { error: rpcResult.error.message || 'Broadcast failed' };
        }

        await chrome.storage.session.set({
          walletApprovalResult: { id: signApprovalId, approved: true, value: rpcResult.result },
        });
        return { success: true, txHash: rpcResult.result };
      } catch (err: any) {
        return { error: err?.message ?? 'Sign failed' };
      }
    }

    // ── Swap messages ───────────────────────────────────────────

    case MessageType.getSwapQuote: {
      // Generic eth_call proxy for swap quotes and allowance checks
      const { calldata, contractAddress } = message.payload as { calldata: string; contractAddress: string };
      try {
        const result = await proxyRpcCall('eth_call', [
          { to: contractAddress, data: '0x' + (calldata.startsWith('0x') ? calldata.slice(2) : calldata) },
          'latest',
        ]);
        if (result.error) return { error: result.error.message || 'eth_call failed' };
        return { data: result.result };
      } catch (err: any) {
        return { error: err?.message || 'Quote failed' };
      }
    }

    case MessageType.executeSwap: {
      if (!session?.mnemonic) return { error: 'Vault is locked' };
      const { tx } = message.payload as {
        tx: { to: string; data: string; value?: string; gasLimit?: string };
      };
      try {
        const walletAccount = deriveEthAccount(session.mnemonic, walletState.activeAccountIndex);
        const walletAddr = getActiveWalletAddress();

        // Get nonce
        const nonceResult = await proxyRpcCall('eth_getTransactionCount', [walletAddr, 'latest']);
        if (nonceResult.error) {
          walletAccount.privateKey.fill(0);
          return { error: 'Failed to get nonce' };
        }

        // Estimate gas (fall back to provided gasLimit or 200k)
        let gasLimit = tx.gasLimit;
        if (!gasLimit) {
          const gasResult = await proxyRpcCall('eth_estimateGas', [{
            from: walletAddr,
            to: tx.to,
            data: tx.data,
            value: tx.value || '0x0',
          }]);
          // Add 20% buffer to estimate
          if (!gasResult.error && gasResult.result) {
            const estimated = BigInt(gasResult.result);
            gasLimit = '0x' + (estimated * 120n / 100n).toString(16);
          } else {
            gasLimit = '0x30D40'; // 200000 fallback
          }
        }

        // Get current gas price
        const feeResult = await proxyRpcCall('eth_gasPrice', []);
        const baseFee = feeResult.result ? BigInt(feeResult.result) : 10000000000n;
        const maxFeePerGas = '0x' + (baseFee * 2n).toString(16);
        // Low tip for L2s like Base, reasonable for L1
        const maxPriorityFeePerGas = baseFee < 1000000000n ? '0x186A0' : '0x59682F00';

        const { signTransaction: signTxFn } = await import('@/lib/wallet/signer');
        const signedTxHex = await signTxFn(
          { ...tx, nonce: nonceResult.result, gasLimit, maxFeePerGas, maxPriorityFeePerGas },
          walletAccount.privateKey,
          walletState.activeChain,
          walletState.testnetMode,
        );
        walletAccount.privateKey.fill(0);

        const rpcResult = await proxyRpcCall('eth_sendRawTransaction', [signedTxHex]);
        if (rpcResult.error) {
          return { error: rpcResult.error.message || 'Broadcast failed' };
        }
        return { success: true, txHash: rpcResult.result };
      } catch (err: any) {
        return { error: err?.message || 'Swap failed' };
      }
    }

    case MessageType.passkeyRegistered: {
      if (!session) return { error: 'Vault is locked' };
      const pk = message.payload as {
        credentialId: string;
        publicKey: string;
        publicKeyAlgorithm: number;
        rpId: string;
        rpName: string;
        origin?: string;
        transports?: string[];
        attestationObject?: string;
        clientDataJSON?: string;
      };

      // Check for duplicate (same rpId + credentialId)
      const duplicate = session.entries.some(
        e => e.type === 'passkey' &&
             e.passkey?.rpId === pk.rpId &&
             e.passkey?.credentialId === pk.credentialId,
      );
      if (duplicate) return { success: true, duplicate: true };

      const passkeyEntry = createEntry({
        type: 'passkey',
        title: pk.rpName || pk.rpId,
        url: pk.origin ?? `https://${pk.rpId}`,
        username: '',
        password: '',
        notes: '',
        tags: ['passkey'],
        passkey: {
          credentialId: pk.credentialId,
          publicKey: pk.publicKey,
          publicKeyAlgorithm: pk.publicKeyAlgorithm,
          rpId: pk.rpId,
          rpName: pk.rpName,
          transports: pk.transports,
          signCount: 0,
          attestationObject: pk.attestationObject,
          clientDataJSON: pk.clientDataJSON,
        },
      });

      session = addEntry(session, passkeyEntry);
      await persistAndSync();
      console.log(`[NodeZero] Passkey captured: ${pk.rpName} (${pk.rpId})`);

      // Register VC hash with backend (best-effort, non-blocking)
      try {
        const { issuePasskeyVC, hashPasskeyVC } = await import('@/lib/did/passkey-vc');
        const vc = await issuePasskeyVC(passkeyEntry.passkey!, pk.origin);
        const vcHash = await hashPasskeyVC(vc);
        const did = session.bundle.did;
        const timestamp = Date.now();
        const regPayload = `nodezero-vc-register\ndid:${did}\nhash:${vcHash}\ntype:PasskeyCredential\ntimestamp:${timestamp}`;
        const regSig = await signBundle(new TextEncoder().encode(regPayload));
        fetch(`${SYNC_API_BASE}/v1/vc/register`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-DID': did,
            'X-Timestamp': timestamp.toString(),
            'X-Signature': regSig,
          },
          body: JSON.stringify({ vcHash, vcType: 'PasskeyCredential' }),
        }).catch(() => { /* ignore network errors */ });
      } catch {
        // VC registration is optional — don't fail the passkey save
      }

      return { success: true, entryId: passkeyEntry.id };
    }

    default:
      return { error: `Unknown message type: ${message.type}` };
  }
}

// ── Sync debounce — coalesce rapid background operations ─────────────────
// Without debouncing, deleting 10 entries in 5 seconds fires 10 concurrent
// smartSync calls, each consuming a token.  With a 2-second debounce, only
// the final state is uploaded — 1 token for 10 deletes.

let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;

async function persistAndSync(isManual = false): Promise<any> {
  if (!session) return { error: 'No session' };

  try {
    if (isManual) {
      // Manual sync: cancel any pending debounced sync and run immediately
      if (syncDebounceTimer) {
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = null;
      }
      // Full merge-before-upload cycle
      // Downloads remote, merges per-entry, re-encrypts, uploads
      const result = await mergeAndSync(session);
      session = result.session;
      return { success: true, result: result.syncResult };
    } else {
      // Background autosave: seal + save locally immediately (instant for UX)
      const { sealVault } = await import('@/lib/vault/vault');
      const sealed = await sealVault(session);
      session = { ...session, bundle: sealed };
      await saveVaultToStorage(sealed);

      // Debounced cloud sync: restart the timer on every change.
      // Only the final state (after 2s of quiet) gets uploaded.
      if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
      syncDebounceTimer = setTimeout(async () => {
        syncDebounceTimer = null;
        if (!session) return;
        try {
          const result = await smartSync(session);
          session = result.session;
        } catch (err) {
          console.warn('[NodeZero] Debounced sync failed:', err);
        }
      }, 2000);

      return { success: true };
    }
  } catch (err: any) {
    console.error('[NodeZero] Persist/Sync failed:', err);
    return { error: err.message || 'Sync failed' };
  }
}

// ── Import deduplication helper ────────────────────────────────────────────

function deduplicateAndImport(currentSession: VaultSession | null, newEntries: VaultEntry[]) {
  if (!currentSession) return { session: currentSession, imported: 0, skipped: newEntries.length };
  const seen = currentSession.entries.map(e => e.url + '::' + e.username);
  const toImport = newEntries.filter(e => !seen.includes(e.url + '::' + e.username));
  let s: VaultSession = currentSession;
  for (const entry of toImport) s = addEntry(s, entry);
  return { session: s, imported: toImport.length, skipped: newEntries.length - toImport.length };
}

// ── Password generator (background, no UI) ────────────────────────────────

interface GeneratorOptions {
  length?: number;
  uppercase?: boolean;
  lowercase?: boolean;
  numbers?: boolean;
  symbols?: boolean;
}

function generateSecurePassword(opts: GeneratorOptions = {}): string {
  const {
    length = 20,
    uppercase = true,
    lowercase = true,
    numbers = true,
    symbols = true,
  } = opts;

  let charset = '';
  if (uppercase) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (lowercase) charset += 'abcdefghijklmnopqrstuvwxyz';
  if (numbers) charset += '0123456789';
  if (symbols) charset += '!@#$%^&*()_+-=[]{}|;:,.<>?';

  if (!charset) charset = 'abcdefghijklmnopqrstuvwxyz';

  const randomBytes = crypto.getRandomValues(new Uint8Array(length * 2));
  let password = '';
  for (let i = 0; i < randomBytes.length && password.length < length; i++) {
    const index = randomBytes[i] % charset.length;
    password += charset[index];
  }
  return password;
}
