/**
 * Passkey Bridge Content Script (ISOLATED world)
 *
 * Relays NODEZERO_PASSKEY_REGISTERED messages from the MAIN world
 * passkey intercept to the background service worker.
 *
 * Separation:
 *   MAIN world  → can wrap navigator.credentials.create()
 *   ISOLATED    → can access chrome.runtime.sendMessage
 */

import { MessageType, MessageFrom } from '@/lib/types';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'ISOLATED',

  main() {
    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== 'NODEZERO_PASSKEY_REGISTERED') return;

      try {
        await chrome.runtime.sendMessage({
          type: MessageType.passkeyRegistered,
          from: MessageFrom.content,
          payload: event.data.payload,
        });
      } catch {
        // Extension may be disabled or background not ready — silently ignore
      }
    });
  },
});
