/**
 * Passphrase-based key derivation — fallback for devices without WebAuthn PRF
 * (e.g. Windows Hello, Firefox, older authenticators)
 *
 * Flow: user-set vault passphrase
 *    → PBKDF2-SHA256(passphrase, salt="nodezero-pin-v1:" + did, iterations=600_000)
 *    → 256-bit AES-GCM key
 *
 * 600k iterations ≈ 5-8s on modern hardware — acceptable for interactive
 * daily use. Matches Bitwarden's baseline for password-derived keys.
 * Much shorter than the 2M-iteration recovery path.
 *
 * Security note: A passphrase is weaker than PRF (no hardware binding), but
 * 600K iterations + 8-char mixed-case requirement (~50+ bit entropy) makes
 * offline brute-force infeasible for months even on GPU clusters. The mnemonic
 * recovery path remains as a second independent protection layer.
 *
 * Backward compatibility: existing vaults may store 200K iterations (or no
 * iteration count at all). The `derivePinKey` function accepts an explicit
 * iteration count so callers can read it from the vault bundle.
 */

export const PIN_PBKDF2_ITERATIONS = 600_000;         // new vaults (2026-03+)
export const PIN_PBKDF2_ITERATIONS_LEGACY = 200_000;   // pre-2026-03 vaults
export const PIN_MIN_LENGTH = 8;

/**
 * Derive an AES-GCM key from a vault passphrase + DID salt.
 *
 * @param pin        - user-chosen vault passphrase (min 8 chars, mixed case + digit)
 * @param did        - user's DID string, used as part of the salt
 * @param iterations - PBKDF2 iteration count (default: 600K for new vaults)
 * @returns AES-GCM CryptoKey (extractable — must cross message bus)
 */
export async function derivePinKey(
  pin: string,
  did: string,
  iterations: number = PIN_PBKDF2_ITERATIONS,
): Promise<CryptoKey> {
  const enc = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  // extractable: true — key must be exported to raw bytes before crossing
  // the extension message bus (chrome.runtime.sendMessage is JSON-only).
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: enc.encode(`nodezero-pin-v1:${did}`),
      iterations,
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Passphrase validation — enforces minimum entropy requirements.
 *
 * Rules:
 *  1. At least 8 characters
 *  2. Not all the same character
 *  3. At least one lowercase letter
 *  4. At least one uppercase letter
 *  5. At least one digit
 *
 * This pushes effective entropy to ~50+ bits, making offline brute-force of
 * the R2 blob infeasible even with the DID known.
 */
export function validatePin(pin: string): string | null {
  if (pin.length < PIN_MIN_LENGTH) {
    return `Passphrase must be at least ${PIN_MIN_LENGTH} characters`;
  }
  if (/^(.)\1+$/.test(pin)) {
    return 'Passphrase must not be all the same character';
  }
  if (!/[a-z]/.test(pin)) {
    return 'Passphrase must include a lowercase letter';
  }
  if (!/[A-Z]/.test(pin)) {
    return 'Passphrase must include an uppercase letter';
  }
  if (!/[0-9]/.test(pin)) {
    return 'Passphrase must include a digit';
  }
  return null;
}
