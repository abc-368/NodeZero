/**
 * popout.ts — Escape the extension popup before WebAuthn ceremonies.
 *
 * Chrome's extension popup auto-closes on focus loss. Windows Hello / WebAuthn
 * dialogs steal focus, killing the ceremony. This helper detects the popup
 * context and switches to the side panel (preferred) or a pop-out window.
 *
 * Returns `true` if the caller should abort (side panel / window is opening).
 * Returns `false` if the caller should proceed in the current context.
 */

/**
 * If running in the narrow extension popup, switch to side panel or pop-out
 * window so that WebAuthn ceremonies survive focus loss.
 *
 * @returns `true` if a transition was initiated (caller should `return`).
 */
export async function escapePopupForWebAuthn(): Promise<boolean> {
  const isSidePanel = document.documentElement.classList.contains('sidepanel-mode');
  const isPoppedOut = new URLSearchParams(window.location.search).has('popout');

  if (isSidePanel || isPoppedOut || window.innerWidth > 420) {
    return false; // Already in a safe context
  }

  // Preferred: open side panel (stays integrated in the browser)
  try {
    if (chrome.sidePanel) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
      const win = await chrome.windows.getCurrent();
      await (chrome.sidePanel as any).open({ windowId: win.id });
      window.close();
      return true;
    }
  } catch {
    // Side panel API unavailable or call failed
  }

  // Fallback: pop-out to a persistent window
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL('popup.html?popout=1'),
      type: 'popup',
      width: 420,
      height: 720,
      focused: true,
    });
    window.close();
    return true;
  } catch {
    // Both methods failed — proceed in current window
  }

  return false;
}

/**
 * Restore the side panel behavior to the user's stored preference.
 * Call this after a WebAuthn ceremony completes in the side panel
 * (which was temporarily forced open by `escapePopupForWebAuthn`).
 */
export async function restoreSidePanelPreference(): Promise<void> {
  try {
    if (!chrome.sidePanel) return;
    const data = await chrome.storage.local.get('nodezero_open_mode');
    const mode = data['nodezero_open_mode'] ?? 'popup';
    await chrome.sidePanel.setPanelBehavior({
      openPanelOnActionClick: mode === 'sidepanel',
    });
  } catch {
    // Ignore — sidePanel API may not be available
  }
}
