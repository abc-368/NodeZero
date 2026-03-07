/**
 * email/crypto.ts — X25519 ECDH + AES-GCM encryption for email bodies
 *
 * Supports two blob formats:
 *   v1 (single recipient):  ephemeral_pub(32) || nonce(12) || ciphertext
 *   v2 (multi-recipient):   0x02 || count(1) || ephemeral_pub(32) ||
 *                            [key_id(8) || wrap_nonce(12) || wrapped_cek(48)] × count ||
 *                            body_nonce(12) || ciphertext
 *
 * Uses @noble/curves for X25519 (portable, no Web Crypto X25519 dependency)
 * and Web Crypto only for AES-GCM encrypt/decrypt.
 */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { x25519 } from '@noble/curves/ed25519';
import { bufferToBase64, base64ToBuffer } from '@/lib/crypto/field-encrypt';

// HKDF context — deliberately different from DID derivation ('nodezero-did-v1')
const X25519_HKDF_CONTEXT = 'nodezero-email-x25519';
const EMAIL_HKDF_INFO = 'nodezero-email-v1';
const CEK_WRAP_INFO = 'nodezero-email-cek-wrap-v1';

/** Version byte for multi-recipient blobs. */
const V2_VERSION = 0x02;

/** Bytes per recipient entry in v2: key_id(8) + wrap_nonce(12) + wrapped_cek(48) */
const V2_RECIPIENT_ENTRY_SIZE = 8 + 12 + 48;

// ── Key derivation ──────────────────────────────────────────────────────────

/**
 * Derive 32-byte X25519 private key seed from BIP-39 seed (or any high-entropy input).
 */
export function deriveX25519Seed(inputSeed: Uint8Array): Uint8Array {
  return hkdf(
    sha256,
    inputSeed,
    undefined,  // no salt
    X25519_HKDF_CONTEXT,
    32,
  );
}

/**
 * Derive X25519 public key bytes from a 32-byte private key seed.
 */
export function getX25519PublicKey(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey);
}

/**
 * Export an X25519 public key (Uint8Array) as base64 string.
 */
export function exportX25519PublicKeyBase64(publicKey: Uint8Array): string {
  return bufferToBase64(publicKey);
}

/**
 * Compute first 8 bytes of an X25519 public key as a key identifier.
 * Used in v2 blobs so the recipient can find their wrapped CEK entry.
 */
export function computeKeyId(publicKey: Uint8Array): Uint8Array {
  return publicKey.slice(0, 8);
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Derive an AES-256-GCM key from X25519 ECDH shared secret.
 */
async function deriveAesKeyFromShared(
  sharedSecret: Uint8Array,
  info: string,
): Promise<CryptoKey> {
  const aesKeyBytes = hkdf(sha256, sharedSecret, undefined, info, 32);
  return crypto.subtle.importKey(
    'raw',
    aesKeyBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Import raw AES-256-GCM key bytes.
 */
async function importAesKeyRaw(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ── v1 encrypt (single recipient, kept for reference / backward compat) ─────

/**
 * Encrypt an email body for a single recipient (v1 format).
 *
 * Generates a fresh ephemeral X25519 keypair per message (forward secrecy).
 * Returns base64-encoded blob: ephemeral_pub(32) || nonce(12) || ciphertext
 */
export async function encryptEmailBody(
  plaintext: string,
  recipientPublicKey: Uint8Array,
): Promise<string> {
  // Delegate to multi-recipient with a single recipient
  return encryptEmailBodyMulti(plaintext, [recipientPublicKey]);
}

// ── v2 encrypt (multi-recipient) ────────────────────────────────────────────

/**
 * Encrypt an email body for one or more recipients (v2 format).
 *
 * 1. Generate random 32-byte content encryption key (CEK)
 * 2. Encrypt body once with AES-GCM using CEK
 * 3. For each recipient: ECDH → wrapping key → wrap CEK
 *
 * Returns base64-encoded v2 blob.
 */
export async function encryptEmailBodyMulti(
  plaintext: string,
  recipientPublicKeys: Uint8Array[],
): Promise<string> {
  const count = recipientPublicKeys.length;
  if (count === 0) throw new Error('No recipients');
  if (count > 255) throw new Error('Too many recipients (max 255)');

  // 1. Random CEK (32 bytes)
  const cek = crypto.getRandomValues(new Uint8Array(32));

  // 2. Encrypt body with CEK
  const bodyNonce = crypto.getRandomValues(new Uint8Array(12));
  const plainBytes = new TextEncoder().encode(plaintext);
  const bodyKey = await importAesKeyRaw(cek);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bodyNonce },
    bodyKey,
    plainBytes,
  );
  const ctBytes = new Uint8Array(ct);

  // 3. Fresh ephemeral keypair (shared across all recipients)
  const ephPriv = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(ephPriv);

  // 4. Wrap CEK for each recipient
  const recipientEntries = new Uint8Array(count * V2_RECIPIENT_ENTRY_SIZE);

  for (let i = 0; i < count; i++) {
    const recipPub = recipientPublicKeys[i];
    const offset = i * V2_RECIPIENT_ENTRY_SIZE;

    // Key ID: first 8 bytes of recipient's public key
    const keyId = computeKeyId(recipPub);
    recipientEntries.set(keyId, offset);

    // ECDH → wrapping key
    const shared = x25519.getSharedSecret(ephPriv, recipPub);
    const wrapKey = await deriveAesKeyFromShared(shared, CEK_WRAP_INFO);

    // Wrap CEK with AES-GCM
    const wrapNonce = crypto.getRandomValues(new Uint8Array(12));
    const wrappedCek = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: wrapNonce },
        wrapKey,
        cek,
      ),
    );
    // wrappedCek = 32 bytes CEK + 16 bytes GCM tag = 48 bytes

    recipientEntries.set(wrapNonce, offset + 8);
    recipientEntries.set(wrappedCek, offset + 8 + 12);
  }

  // Zero-fill secrets
  ephPriv.fill(0);
  cek.fill(0);

  // 5. Assemble v2 blob
  //    version(1) + count(1) + ephemeral_pub(32) + recipients + body_nonce(12) + ciphertext
  const headerSize = 1 + 1 + 32;
  const totalSize = headerSize + recipientEntries.length + 12 + ctBytes.length;
  const blob = new Uint8Array(totalSize);

  let pos = 0;
  blob[pos++] = V2_VERSION;
  blob[pos++] = count;
  blob.set(ephPub, pos); pos += 32;
  blob.set(recipientEntries, pos); pos += recipientEntries.length;
  blob.set(bodyNonce, pos); pos += 12;
  blob.set(ctBytes, pos);

  return bufferToBase64(blob);
}

// ── Decrypt (v1 + v2 auto-detect) ───────────────────────────────────────────

/**
 * Decrypt an email body from a NODEZERO blob (auto-detects v1 or v2).
 *
 * v1: ephemeral_pub(32) || nonce(12) || ciphertext
 * v2: 0x02 || count(1) || ephemeral_pub(32) || recipients... || body_nonce(12) || ciphertext
 */
export async function decryptEmailBody(
  blobBase64: string,
  ownPrivateKey: Uint8Array,
): Promise<string> {
  const blob = base64ToBuffer(blobBase64);

  if (blob.length < 2) {
    throw new Error('Invalid ciphertext: too short');
  }

  // Auto-detect version
  if (blob[0] === V2_VERSION) {
    return decryptV2(blob, ownPrivateKey);
  }
  return decryptV1(blob, ownPrivateKey);
}

/**
 * Decrypt v1 blob: ephemeral_pub(32) || nonce(12) || ciphertext
 */
async function decryptV1(
  blob: Uint8Array,
  ownPrivateKey: Uint8Array,
): Promise<string> {
  if (blob.length < 44) {
    throw new Error('Invalid v1 ciphertext: too short');
  }

  const ephPubBytes = blob.slice(0, 32);
  const nonce = blob.slice(32, 44);
  const ct = blob.slice(44);

  // ECDH → AES key (v1 uses EMAIL_HKDF_INFO directly)
  const shared = x25519.getSharedSecret(ownPrivateKey, ephPubBytes);
  const aesKey = await deriveAesKeyFromShared(shared, EMAIL_HKDF_INFO);

  const plainBytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    aesKey,
    ct,
  );

  return new TextDecoder().decode(plainBytes);
}

/**
 * Decrypt v2 blob: find our recipient entry, unwrap CEK, decrypt body.
 */
async function decryptV2(
  blob: Uint8Array,
  ownPrivateKey: Uint8Array,
): Promise<string> {
  const count = blob[1];
  const minSize = 2 + 32 + (count * V2_RECIPIENT_ENTRY_SIZE) + 12 + 1;
  if (blob.length < minSize) {
    throw new Error('Invalid v2 ciphertext: too short');
  }

  const ephPub = blob.slice(2, 34);
  const recipientsStart = 34;
  const recipientsEnd = recipientsStart + (count * V2_RECIPIENT_ENTRY_SIZE);
  const bodyNonce = blob.slice(recipientsEnd, recipientsEnd + 12);
  const ct = blob.slice(recipientsEnd + 12);

  // Compute our key ID
  const ownPub = x25519.getPublicKey(ownPrivateKey);
  const ownKeyId = computeKeyId(ownPub);

  // Find our entry
  let matchOffset = -1;
  for (let i = 0; i < count; i++) {
    const entryOffset = recipientsStart + (i * V2_RECIPIENT_ENTRY_SIZE);
    const entryKeyId = blob.slice(entryOffset, entryOffset + 8);

    if (uint8ArrayEquals(ownKeyId, entryKeyId)) {
      matchOffset = entryOffset;
      break;
    }
  }

  if (matchOffset === -1) {
    throw new Error('This message was not encrypted for you');
  }

  // Unwrap CEK
  const wrapNonce = blob.slice(matchOffset + 8, matchOffset + 8 + 12);
  const wrappedCek = blob.slice(matchOffset + 8 + 12, matchOffset + V2_RECIPIENT_ENTRY_SIZE);

  const shared = x25519.getSharedSecret(ownPrivateKey, ephPub);
  const wrapKey = await deriveAesKeyFromShared(shared, CEK_WRAP_INFO);

  const cekBytes = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: wrapNonce },
      wrapKey,
      wrappedCek,
    ),
  );

  // Decrypt body with CEK
  const bodyKey = await importAesKeyRaw(cekBytes);
  cekBytes.fill(0);

  const plainBytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bodyNonce },
    bodyKey,
    ct,
  );

  return new TextDecoder().decode(plainBytes);
}

// ── Utility ─────────────────────────────────────────────────────────────────

function uint8ArrayEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
