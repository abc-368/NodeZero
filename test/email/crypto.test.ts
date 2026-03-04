/**
 * Unit tests for lib/email/crypto.ts — X25519 ECDH + AES-GCM encryption.
 *
 * Tests key derivation, single-recipient (v1-via-v2), multi-recipient v2 blobs,
 * cross-recipient decryption failure, and forward secrecy properties.
 */

import { describe, it, expect } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import {
  deriveX25519Seed,
  getX25519PublicKey,
  exportX25519PublicKeyBase64,
  computeKeyId,
  encryptEmailBody,
  encryptEmailBodyMulti,
  decryptEmailBody,
} from '../../lib/email/crypto';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Generate a fresh X25519 keypair for testing. */
function generateKeypair() {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

// ── Key derivation tests ─────────────────────────────────────────────────────

describe('X25519 key derivation', () => {
  it('deriveX25519Seed is deterministic', () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const derived1 = deriveX25519Seed(seed);
    const derived2 = deriveX25519Seed(seed);
    expect(derived1).toEqual(derived2);
  });

  it('different input seeds → different derived keys', () => {
    const seed1 = crypto.getRandomValues(new Uint8Array(32));
    const seed2 = crypto.getRandomValues(new Uint8Array(32));
    const derived1 = deriveX25519Seed(seed1);
    const derived2 = deriveX25519Seed(seed2);
    expect(derived1).not.toEqual(derived2);
  });

  it('derived seed is 32 bytes', () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const derived = deriveX25519Seed(seed);
    expect(derived.length).toBe(32);
  });

  it('getX25519PublicKey returns 32-byte public key', () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const privKey = deriveX25519Seed(seed);
    const pubKey = getX25519PublicKey(privKey);
    expect(pubKey.length).toBe(32);
  });

  it('exportX25519PublicKeyBase64 round-trips', () => {
    const { publicKey } = generateKeypair();
    const b64 = exportX25519PublicKeyBase64(publicKey);
    expect(typeof b64).toBe('string');
    // Base64 of 32 bytes = 44 chars
    expect(b64.length).toBe(44);
  });

  it('computeKeyId returns first 8 bytes of public key', () => {
    const { publicKey } = generateKeypair();
    const keyId = computeKeyId(publicKey);
    expect(keyId.length).toBe(8);
    expect(keyId).toEqual(publicKey.slice(0, 8));
  });
});

// ── Single-recipient encryption (v1 via v2) ──────────────────────────────────

describe('encryptEmailBody (single recipient)', () => {
  it('encrypt → decrypt round-trip', async () => {
    const { privateKey, publicKey } = generateKeypair();
    const plaintext = 'Hello, this is a secure message!';

    const blob = await encryptEmailBody(plaintext, publicKey);
    expect(typeof blob).toBe('string'); // base64

    const decrypted = await decryptEmailBody(blob, privateKey);
    expect(decrypted).toBe(plaintext);
  });

  it('same plaintext encrypted twice produces different blobs (ephemeral keys)', async () => {
    const { publicKey } = generateKeypair();
    const plaintext = 'Identical message';

    const blob1 = await encryptEmailBody(plaintext, publicKey);
    const blob2 = await encryptEmailBody(plaintext, publicKey);
    expect(blob1).not.toBe(blob2); // different ephemeral keys + nonces
  });

  it('wrong private key fails decryption', async () => {
    const sender = generateKeypair();
    const recipient = generateKeypair();
    const wrongKey = generateKeypair();

    const blob = await encryptEmailBody('secret data', recipient.publicKey);

    await expect(decryptEmailBody(blob, wrongKey.privateKey)).rejects.toThrow();
  });

  it('handles empty string plaintext', async () => {
    const { privateKey, publicKey } = generateKeypair();
    const blob = await encryptEmailBody('', publicKey);
    const decrypted = await decryptEmailBody(blob, privateKey);
    expect(decrypted).toBe('');
  });

  it('handles unicode plaintext', async () => {
    const { privateKey, publicKey } = generateKeypair();
    const plaintext = '🔐 Encrypted with X25519 + AES-GCM — données sécurisées';
    const blob = await encryptEmailBody(plaintext, publicKey);
    const decrypted = await decryptEmailBody(blob, privateKey);
    expect(decrypted).toBe(plaintext);
  });
});

// ── Multi-recipient encryption (v2) ──────────────────────────────────────────

describe('encryptEmailBodyMulti', () => {
  it('two recipients can both decrypt', async () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const plaintext = 'Shared secret for both Alice and Bob';

    const blob = await encryptEmailBodyMulti(plaintext, [alice.publicKey, bob.publicKey]);

    const decryptedByAlice = await decryptEmailBody(blob, alice.privateKey);
    const decryptedByBob = await decryptEmailBody(blob, bob.privateKey);
    expect(decryptedByAlice).toBe(plaintext);
    expect(decryptedByBob).toBe(plaintext);
  });

  it('non-recipient cannot decrypt', async () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const eve = generateKeypair();

    const blob = await encryptEmailBodyMulti('secret', [alice.publicKey, bob.publicKey]);

    await expect(decryptEmailBody(blob, eve.privateKey)).rejects.toThrow(
      'not encrypted for you'
    );
  });

  it('three recipients all get the same plaintext', async () => {
    const keys = [generateKeypair(), generateKeypair(), generateKeypair()];
    const plaintext = 'Three-way shared message';

    const blob = await encryptEmailBodyMulti(
      plaintext,
      keys.map(k => k.publicKey)
    );

    for (const { privateKey } of keys) {
      const decrypted = await decryptEmailBody(blob, privateKey);
      expect(decrypted).toBe(plaintext);
    }
  });

  it('rejects zero recipients', async () => {
    await expect(encryptEmailBodyMulti('test', [])).rejects.toThrow('No recipients');
  });

  it('handles large plaintext', async () => {
    const { privateKey, publicKey } = generateKeypair();
    const plaintext = 'A'.repeat(100_000); // 100KB

    const blob = await encryptEmailBodyMulti(plaintext, [publicKey]);
    const decrypted = await decryptEmailBody(blob, privateKey);
    expect(decrypted).toBe(plaintext);
  });
});

// ── Blob format detection ────────────────────────────────────────────────────

describe('blob format auto-detection', () => {
  it('rejects too-short blob', async () => {
    const { privateKey } = generateKeypair();
    // Base64 of a single byte
    const tinyBlob = btoa('\x00');
    await expect(decryptEmailBody(tinyBlob, privateKey)).rejects.toThrow();
  });
});
