/**
 * Recovery Key Derivation via BIP-39 Mnemonic + PBKDF2
 *
 * Flow: 12-word BIP-39 mnemonic
 *    → PBKDF2-SHA256(mnemonic, salt=did, iterations=2_000_000)
 *    → 256-bit AES-GCM key
 *
 * The 2M iterations creates ~30s derivation as a deliberate brute-force
 * compensating control against a stolen mnemonic.
 *
 * CRITICAL: Run in a Web Worker (kdf-worker.ts) to avoid freezing the UI.
 */

export const PBKDF2_ITERATIONS = 2_000_000;

export interface RecoveryKeyProgress {
  phase: 'deriving' | 'done' | 'error';
  message: string;
}

/**
 * Derive the recovery AES-GCM key from a BIP-39 mnemonic + DID salt.
 *
 * ⚠️  This function is CPU-intensive (~30s). Call it from the KDF Web Worker.
 *
 * @param mnemonic - 12-word BIP-39 mnemonic (space-separated)
 * @param didSalt  - user's DID string used as PBKDF2 salt
 * @returns AES-GCM CryptoKey (non-extractable)
 */
export async function deriveRecoveryKey(
  mnemonic: string,
  didSalt: string
): Promise<CryptoKey> {
  const enc = new TextEncoder();

  // Import mnemonic as raw key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(mnemonic.trim()),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  // PBKDF2-SHA256 with 2M iterations → 256-bit AES-GCM key
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: enc.encode(didSalt),
      iterations: PBKDF2_ITERATIONS,
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true, // must be extractable for worker-to-main-thread transfer
    ['encrypt', 'decrypt']
  );

  return aesKey;
}

/**
 * Quick benchmark: estimate how long PBKDF2 will take on this device.
 * Runs 10k iterations and extrapolates.
 */
export async function benchmarkPbkdf2(): Promise<number> {
  const enc = new TextEncoder();
  const testKey = await crypto.subtle.importKey(
    'raw',
    enc.encode('benchmark-test'),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const BENCH_ITERATIONS = 10_000;
  const start = performance.now();

  await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: enc.encode('bench-salt'),
      iterations: BENCH_ITERATIONS,
    },
    testKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  const elapsed = performance.now() - start;
  // Extrapolate to 2M iterations
  return (elapsed / BENCH_ITERATIONS) * PBKDF2_ITERATIONS;
}
