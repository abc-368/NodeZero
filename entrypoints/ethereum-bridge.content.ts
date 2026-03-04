/**
 * EIP-1193 Bridge Content Script (ISOLATED world)
 *
 * Relays postMessage requests from the MAIN world provider to the
 * background service worker via chrome.runtime.sendMessage, then
 * posts responses back.
 *
 * Separation:
 *   MAIN world  → can access window.ethereum, page JS
 *   ISOLATED    → can access chrome.runtime.sendMessage
 *
 * The MAIN script (ethereum-provider.content.ts) posts messages,
 * this script relays them to background and returns the result.
 */

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'ISOLATED',

  main() {
    // Relay EIP-1193 requests from page → background
    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== 'NODEZERO_EIP1193_REQUEST') return;

      const { id, payload } = event.data;

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'EIP1193_REQUEST',
          payload,
        });

        window.postMessage({
          type: 'NODEZERO_EIP1193_RESPONSE',
          id,
          response,
        }, '*');
      } catch (err: any) {
        window.postMessage({
          type: 'NODEZERO_EIP1193_RESPONSE',
          id,
          response: {
            error: {
              code: -32603,
              message: err?.message || 'Internal error',
            },
          },
        }, '*');
      }
    });

    // Relay events from background → page
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'EIP1193_EVENT') {
        window.postMessage({
          type: 'NODEZERO_EIP1193_EVENT',
          event: message.event,
          data: message.data,
        }, '*');
      }
    });
  },
});
