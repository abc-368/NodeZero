/**
 * Unit tests for lib/crypto/pin-key.ts — PBKDF2 passphrase key derivation.
 *
 * Tests determinism, uniqueness, iteration count, output format,
 * and input validation.
 */

import { describe, it, expect } from 'vitest';
import {
  derivePinKey,
  validatePin,
  PIN_PBKDF2_ITERATIONS,
  PIN_PBKDF2_ITERATIONS_LEGACY,
  PIN_MIN_LENGTH,
} from '../../lib/crypto/pin-key';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Export key to raw bytes for comparison. */
async function exportKeyBytes(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(raw);
}

const TEST_PIN = 'MyVault99';
const TEST_DID = 'did:key:z6MkTestDeterminism';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('derivePinKey', () => {
  it('same PIN + DID → same key (deterministic)', async () => {
    const key1 = await derivePinKey(TEST_PIN, TEST_DID, 1000); // low iterations for speed
    const key2 = await derivePinKey(TEST_PIN, TEST_DID, 1000);

    const bytes1 = await exportKeyBytes(key1);
    const bytes2 = await exportKeyBytes(key2);
    expect(bytes1).toEqual(bytes2);
  });

  it('different PINs → different keys', async () => {
    const key1 = await derivePinKey('Password1A', TEST_DID, 1000);
    const key2 = await derivePinKey('Password2B', TEST_DID, 1000);

    const bytes1 = await exportKeyBytes(key1);
    const bytes2 = await exportKeyBytes(key2);
    expect(bytes1).not.toEqual(bytes2);
  });

  it('different DIDs → different keys (salt varies)', async () => {
    const key1 = await derivePinKey(TEST_PIN, 'did:key:z6MkAlice', 1000);
    const key2 = await derivePinKey(TEST_PIN, 'did:key:z6MkBob', 1000);

    const bytes1 = await exportKeyBytes(key1);
    const bytes2 = await exportKeyBytes(key2);
    expect(bytes1).not.toEqual(bytes2);
  });

  it('output is exactly 32 bytes (256-bit AES key)', async () => {
    const key = await derivePinKey(TEST_PIN, TEST_DID, 1000);
    const bytes = await exportKeyBytes(key);
    expect(bytes.length).toBe(32);
  });

  it('returns AES-GCM key usable for encrypt/decrypt', async () => {
    const key = await derivePinKey(TEST_PIN, TEST_DID, 1000);

    // Verify the key has the correct algorithm and usages
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(key.extractable).toBe(true);
    expect(key.usages).toContain('encrypt');
    expect(key.usages).toContain('decrypt');

    // Verify it actually works for encryption
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode('test data');
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      plaintext,
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      ct,
    );
    expect(new Uint8Array(decrypted)).toEqual(plaintext);
  });

  it('different iteration counts → different keys', async () => {
    const key1 = await derivePinKey(TEST_PIN, TEST_DID, 1000);
    const key2 = await derivePinKey(TEST_PIN, TEST_DID, 2000);

    const bytes1 = await exportKeyBytes(key1);
    const bytes2 = await exportKeyBytes(key2);
    expect(bytes1).not.toEqual(bytes2);
  });

  it('default iterations is 600,000', () => {
    expect(PIN_PBKDF2_ITERATIONS).toBe(600_000);
    expect(PIN_PBKDF2_ITERATIONS_LEGACY).toBe(200_000);
  });

  it('uniqueness across 100 different PINs', async () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const pin = `TestPin${i.toString().padStart(3, '0')}A`;
      const key = await derivePinKey(pin, TEST_DID, 1000);
      const bytes = await exportKeyBytes(key);
      const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      keys.add(hex);
    }
    expect(keys.size).toBe(100);
  });
});

describe('validatePin', () => {
  it('accepts valid passphrase', () => {
    expect(validatePin('MyVault99')).toBeNull();
    expect(validatePin('StrongP4ss')).toBeNull();
    expect(validatePin('aB3defgh')).toBeNull();
  });

  it('rejects short passphrase', () => {
    const result = validatePin('Ab1');
    expect(result).toContain(`${PIN_MIN_LENGTH}`);
  });

  it('rejects empty passphrase', () => {
    const result = validatePin('');
    expect(result).not.toBeNull();
  });

  it('rejects all-same-character passphrase', () => {
    const result = validatePin('aaaaaaaa');
    expect(result).toContain('same character');
  });

  it('rejects passphrase without lowercase', () => {
    const result = validatePin('ABCDEFG1');
    expect(result).toContain('lowercase');
  });

  it('rejects passphrase without uppercase', () => {
    const result = validatePin('abcdefg1');
    expect(result).toContain('uppercase');
  });

  it('rejects passphrase without digit', () => {
    const result = validatePin('Abcdefgh');
    expect(result).toContain('digit');
  });
});
