/**
 * Unit tests for lib/crypto/field-encrypt.ts — AES-GCM field encryption.
 *
 * Tests round-trip correctness, nonce uniqueness, AAD binding,
 * and encoding helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  encryptField,
  decryptField,
  encryptFields,
  decryptFields,
  importAesKey,
  bufferToBase64,
  base64ToBuffer,
  bufferToHex,
  hexToBuffer,
} from '../../lib/crypto/field-encrypt';

// ── Helpers ─────────────────────────────────────────────────────────────────

async function generateTestKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

// ── Encoding helpers ────────────────────────────────────────────────────────

describe('bufferToHex / hexToBuffer', () => {
  it('round-trips correctly', () => {
    const original = new Uint8Array([0, 1, 127, 128, 255]);
    const hex = bufferToHex(original);
    expect(hex).toBe('00017f80ff');
    const recovered = hexToBuffer(hex);
    expect(recovered).toEqual(original);
  });

  it('handles empty buffer', () => {
    const hex = bufferToHex(new Uint8Array(0));
    expect(hex).toBe('');
    expect(hexToBuffer('')).toEqual(new Uint8Array(0));
  });
});

describe('bufferToBase64 / base64ToBuffer', () => {
  it('round-trips correctly', () => {
    const original = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const b64 = bufferToBase64(original);
    const recovered = base64ToBuffer(b64);
    expect(recovered).toEqual(original);
  });

  it('handles binary data with high bytes', () => {
    const original = new Uint8Array([0, 128, 255, 1, 254]);
    const b64 = bufferToBase64(original);
    const recovered = base64ToBuffer(b64);
    expect(recovered).toEqual(original);
  });
});

// ── importAesKey ────────────────────────────────────────────────────────────

describe('importAesKey', () => {
  it('imports raw 256-bit key and returns a usable CryptoKey', async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await importAesKey(raw);
    expect(key).toBeDefined();
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(key.usages).toContain('encrypt');
    expect(key.usages).toContain('decrypt');
  });
});

// ── encryptField / decryptField ─────────────────────────────────────────────

describe('encryptField / decryptField', () => {
  it('round-trips plaintext correctly', async () => {
    const key = await generateTestKey();
    const plaintext = 'hunter2';
    const cipherBytes = await encryptField(plaintext, key);
    const decrypted = await decryptField(cipherBytes, key);
    expect(decrypted).toBe(plaintext);
  });

  it('round-trips with AAD', async () => {
    const key = await generateTestKey();
    const plaintext = 'secret-password';
    const aad = 'entry-123:password';
    const cipherBytes = await encryptField(plaintext, key, aad);
    const decrypted = await decryptField(cipherBytes, key, aad);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext on each call (nonce uniqueness)', async () => {
    const key = await generateTestKey();
    const plaintext = 'same-input';
    const c1 = await encryptField(plaintext, key);
    const c2 = await encryptField(plaintext, key);
    // Nonces are the first 12 bytes — must differ
    expect(bufferToHex(c1.slice(0, 12))).not.toBe(bufferToHex(c2.slice(0, 12)));
    // Full ciphertext should also differ
    expect(bufferToHex(c1)).not.toBe(bufferToHex(c2));
  });

  it('fails decryption with wrong key', async () => {
    const key1 = await generateTestKey();
    const key2 = await generateTestKey();
    const cipherBytes = await encryptField('secret', key1);
    await expect(decryptField(cipherBytes, key2)).rejects.toThrow();
  });

  it('fails decryption with mismatched AAD', async () => {
    const key = await generateTestKey();
    const cipherBytes = await encryptField('secret', key, 'correct-aad');
    await expect(decryptField(cipherBytes, key, 'wrong-aad')).rejects.toThrow();
  });

  it('fails on truncated ciphertext (too short)', async () => {
    const key = await generateTestKey();
    const tooShort = new Uint8Array(5); // shorter than 12-byte nonce
    await expect(decryptField(tooShort, key)).rejects.toThrow('too short');
  });

  it('handles unicode text', async () => {
    const key = await generateTestKey();
    const plaintext = 'Пароль 密码 パスワード 🔐';
    const cipherBytes = await encryptField(plaintext, key);
    const decrypted = await decryptField(cipherBytes, key);
    expect(decrypted).toBe(plaintext);
  });
});

// ── encryptFields / decryptFields ───────────────────────────────────────────

describe('encryptFields / decryptFields', () => {
  it('round-trips a set of fields with AAD binding', async () => {
    const key = await generateTestKey();
    const entryId = 'entry-abc';
    const fields = {
      username: 'alice@example.com',
      password: 'super-secret-123',
      notes: 'MFA backup: ABCD-EFGH',
    };

    const encrypted = await encryptFields(fields, key, entryId);
    expect(Object.keys(encrypted)).toEqual(['username', 'password', 'notes']);
    // Encrypted values should be base64 strings, not plaintext
    expect(encrypted['password']).not.toBe(fields['password']);

    const decrypted = await decryptFields(encrypted, key, entryId);
    expect(decrypted).toEqual(fields);
  });

  it('skips empty fields during encryption', async () => {
    const key = await generateTestKey();
    const fields = { username: 'alice', password: '', notes: '' };
    const encrypted = await encryptFields(fields, key, 'e1');
    expect(Object.keys(encrypted)).toEqual(['username']);
  });
});
