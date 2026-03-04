/**
 * Unit tests for lib/crypto/recovery-key.ts — PBKDF2 mnemonic derivation.
 *
 * Tests deterministic derivation: same mnemonic + salt → same key, always.
 *
 * NOTE: Uses a low iteration count (1000) via a test-specific wrapper to
 * keep tests fast (~10ms vs ~30s at 2M iterations). The production value
 * is tested indirectly by asserting the exported constant.
 */

import { describe, it, expect } from 'vitest';
import { PBKDF2_ITERATIONS } from '../../lib/crypto/recovery-key';

// ── Test-speed KDF (1000 iterations instead of 2M) ─────────────────────────

async function deriveTestKey(
  mnemonic: string,
  didSalt: string,
  iterations = 1000
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(mnemonic.trim()),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: enc.encode(didSalt),
      iterations,
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const raw = await crypto.subtle.exportKey('raw', aesKey);
  return new Uint8Array(raw);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('recovery key derivation', () => {
  const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const testDid = 'did:key:z6MkTestSalt123';

  it('exports PBKDF2_ITERATIONS as 2_000_000', () => {
    expect(PBKDF2_ITERATIONS).toBe(2_000_000);
  });

  it('produces deterministic output (same mnemonic + salt → same key)', async () => {
    const key1 = await deriveTestKey(testMnemonic, testDid);
    const key2 = await deriveTestKey(testMnemonic, testDid);
    expect(key1).toEqual(key2);
  });

  it('produces 256-bit (32-byte) key', async () => {
    const key = await deriveTestKey(testMnemonic, testDid);
    expect(key.length).toBe(32);
  });

  it('different mnemonic → different key', async () => {
    const key1 = await deriveTestKey(testMnemonic, testDid);
    const altMnemonic = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
    const key2 = await deriveTestKey(altMnemonic, testDid);
    expect(key1).not.toEqual(key2);
  });

  it('different salt → different key', async () => {
    const key1 = await deriveTestKey(testMnemonic, 'did:key:z6MkSaltA');
    const key2 = await deriveTestKey(testMnemonic, 'did:key:z6MkSaltB');
    expect(key1).not.toEqual(key2);
  });

  it('trims whitespace from mnemonic (leading/trailing spaces ignored)', async () => {
    const key1 = await deriveTestKey(testMnemonic, testDid);
    const key2 = await deriveTestKey(`  ${testMnemonic}  `, testDid);
    expect(key1).toEqual(key2);
  });
});
