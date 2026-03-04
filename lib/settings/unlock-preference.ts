/**
 * Unlock mode preference — stored in chrome.storage.local
 *
 * Two modes:
 *   'biometric'        — (default) Auto-triggers Windows Hello face/fingerprint
 *                         on popup open. Falls back to passphrase if face scan
 *                         fails or is cancelled.
 *   'passphrase-first' — Skips biometric, shows passphrase input directly.
 *                         Faster if Windows Hello is unreliable or the user
 *                         prefers typing their passphrase. No PBKDF2 penalty
 *                         beyond the normal derivation time.
 *
 * This preference only affects 'biometric' vaults. PRF and PIN-only vaults
 * ignore it since they don't have a biometric wrap key.
 */

export type UnlockMode = 'biometric' | 'passphrase-first';

const STORAGE_KEY = 'nodezero_unlock_mode';

/**
 * Read the stored unlock preference. Defaults to 'biometric'.
 */
export async function getUnlockMode(): Promise<UnlockMode> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const mode = data[STORAGE_KEY];
  return mode === 'passphrase-first' ? 'passphrase-first' : 'biometric';
}

/**
 * Persist the unlock preference.
 */
export async function setUnlockMode(mode: UnlockMode): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: mode });
}
