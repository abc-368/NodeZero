/**
 * DID Key Storage
 *
 * Stores Ed25519 key pairs encrypted at rest in chrome.storage.local.
 * The private key is encrypted with AES-GCM using the session key (PRF-derived).
 *
 * Security invariant (CLAUDE.md §9 rule 6):
 *   DID private keys are encrypted at rest in chrome.storage.local.
 *   They are never stored in plaintext.
 */

import { encryptField, decryptField, bufferToBase64, base64ToBuffer } from '@/lib/crypto/field-encrypt';
import {
  generateDIDKey,
  importSigningKey,
  importVerifyingKey,
  setActiveKeyPair,
  DIDKeyPair,
} from './provider';
import {
  deriveX25519Seed,
  getX25519PublicKey,
  exportX25519PublicKeyBase64,
} from '@/lib/email/crypto';

const DID_STORAGE_KEY = 'nodezero_did';

// ── X25519 in-memory state (email encryption) ────────────────────────────────
// Keys are raw Uint8Array (used by @noble/curves, not Web Crypto CryptoKey).

let _x25519PrivateKey: Uint8Array | null = null;
let _x25519PublicKeyBase64: string | null = null;

/** Get the active X25519 private key bytes for email decryption. */
export function getActiveX25519PrivateKey(): Uint8Array | null {
  return _x25519PrivateKey;
}

/** Get the active X25519 public key as base64 for registry lookups. */
export function getActiveX25519PublicKeyBase64(): string | null {
  return _x25519PublicKeyBase64;
}

/** Clear X25519 keys from memory (called on lock). */
export function clearX25519Keys(): void {
  if (_x25519PrivateKey) _x25519PrivateKey.fill(0);
  _x25519PrivateKey = null;
  _x25519PublicKeyBase64 = null;
}

export interface StoredDID {
  did: string;
  publicKeyBase64: string;
  encryptedPrivateKey: string; // AES-GCM encrypted private key bytes, base64
  x25519PublicKeyBase64?: string;       // X25519 public key for email encryption
  encryptedX25519PrivateKey?: string;   // AES-GCM encrypted X25519 private key seed, base64
}

/**
 * Generate a new DID key pair and store the encrypted private key.
 *
 * @param encryptionKey - AES-GCM key to encrypt the private key at rest
 * @param existingKeyPair - optional existing key pair to re-encrypt (e.g. during PIN setup)
 * @param bipSeed - optional BIP-39 seed bytes for X25519 email encryption key derivation
 * @returns the DID string and the key pair
 */
export async function initializeDID(
  encryptionKey: CryptoKey,
  existingKeyPair?: { keyPair: CryptoKeyPair; did: string },
  bipSeed?: Uint8Array,
): Promise<{ did: string; keyPair: CryptoKeyPair }> {
  const { keyPair, did } = existingKeyPair ?? await generateDIDKey();

  const privateKeyRaw = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const publicKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);

  const privateKeyBytes = new Uint8Array(privateKeyRaw);
  const publicKeyBytes = new Uint8Array(publicKeyRaw);

  // Encrypt private key at rest
  const encryptedPrivKey = await encryptField(
    bufferToBase64(privateKeyBytes),
    encryptionKey,
    `did-private-key:${did}`
  );

  const stored: StoredDID = {
    did,
    publicKeyBase64: bufferToBase64(publicKeyBytes),
    encryptedPrivateKey: bufferToBase64(encryptedPrivKey),
  };

  // X25519 key derivation for email encryption (if BIP-39 seed provided)
  if (bipSeed) {
    try {
      const x25519Seed = deriveX25519Seed(bipSeed);
      const x25519Pub = getX25519PublicKey(x25519Seed);
      const x25519PubBase64 = exportX25519PublicKeyBase64(x25519Pub);

      // Encrypt X25519 private seed at rest
      const encryptedX25519 = await encryptField(
        bufferToBase64(x25519Seed),
        encryptionKey,
        `did-x25519-private-key:${did}`
      );

      stored.x25519PublicKeyBase64 = x25519PubBase64;
      stored.encryptedX25519PrivateKey = bufferToBase64(encryptedX25519);

      // Activate X25519 keys in memory (raw bytes)
      _x25519PrivateKey = new Uint8Array(x25519Seed);
      _x25519PublicKeyBase64 = x25519PubBase64;

      // Zero-fill original seed
      x25519Seed.fill(0);
    } catch (err) {
      console.warn('[NodeZero] X25519 key derivation failed (non-fatal):', err);
    }
  }

  await chrome.storage.local.set({ [DID_STORAGE_KEY]: stored });

  // Activate the key pair for signing
  const signingKey = await importSigningKey(privateKeyBytes);
  const verifyingKey = await importVerifyingKey(publicKeyBytes);
  setActiveKeyPair(signingKey, verifyingKey, did);

  // Zero-fill private key bytes
  privateKeyBytes.fill(0);

  return { did, keyPair };
}

/**
 * Load and decrypt the DID key pair from storage.
 * Called on vault unlock.
 *
 * @param encryptionKey - AES-GCM key (same one used during initializeDID)
 */
export async function loadAndActivateDID(encryptionKey: CryptoKey): Promise<string> {
  const data = await chrome.storage.local.get(DID_STORAGE_KEY);
  const stored: StoredDID | undefined = data[DID_STORAGE_KEY];

  if (!stored) throw new Error('No DID found in storage. Run onboarding first.');

  const { did, publicKeyBase64, encryptedPrivateKey } = stored;

  // Decrypt private key
  const encryptedBytes = base64ToBuffer(encryptedPrivateKey);
  const privateKeyB64 = await decryptField(encryptedBytes, encryptionKey, `did-private-key:${did}`);
  const privateKeyBytes = base64ToBuffer(privateKeyB64);
  const publicKeyBytes = base64ToBuffer(publicKeyBase64);

  const signingKey = await importSigningKey(privateKeyBytes);
  const verifyingKey = await importVerifyingKey(publicKeyBytes);
  setActiveKeyPair(signingKey, verifyingKey, did);

  // Load X25519 keys if available (email encryption)
  if (stored.encryptedX25519PrivateKey && stored.x25519PublicKeyBase64) {
    try {
      const encX25519Bytes = base64ToBuffer(stored.encryptedX25519PrivateKey);
      const x25519SeedB64 = await decryptField(
        encX25519Bytes, encryptionKey, `did-x25519-private-key:${did}`
      );
      const x25519SeedBytes = base64ToBuffer(x25519SeedB64);

      // Store raw bytes (used by @noble/curves, not Web Crypto)
      _x25519PrivateKey = new Uint8Array(x25519SeedBytes);
      _x25519PublicKeyBase64 = stored.x25519PublicKeyBase64;

      // Zero-fill after copy
      x25519SeedBytes.fill(0);
    } catch (err) {
      console.warn('[NodeZero] X25519 key load failed (non-fatal):', err);
      _x25519PrivateKey = null;
      _x25519PublicKeyBase64 = null;
    }
  } else {
    // ── Migration: derive X25519 from Ed25519 private key for pre-email accounts ──
    // Existing accounts created before the email feature have no X25519 keys.
    // Derive them from the Ed25519 private key via HKDF (same context string)
    // and persist encrypted so this only runs once.
    try {
      const x25519Seed = deriveX25519Seed(privateKeyBytes);
      const x25519Pub = getX25519PublicKey(x25519Seed);
      const x25519PubBase64 = exportX25519PublicKeyBase64(x25519Pub);

      // Encrypt X25519 private seed at rest
      const encryptedX25519 = await encryptField(
        bufferToBase64(x25519Seed),
        encryptionKey,
        `did-x25519-private-key:${did}`
      );

      // Update stored DID with new X25519 fields
      stored.x25519PublicKeyBase64 = x25519PubBase64;
      stored.encryptedX25519PrivateKey = bufferToBase64(encryptedX25519);
      await chrome.storage.local.set({ [DID_STORAGE_KEY]: stored });

      // Activate in memory (raw bytes)
      _x25519PrivateKey = new Uint8Array(x25519Seed);
      _x25519PublicKeyBase64 = x25519PubBase64;

      // Zero-fill original seed
      x25519Seed.fill(0);

      console.log('[NodeZero] X25519 keys migrated from Ed25519 key (one-time)');
    } catch (err) {
      console.warn('[NodeZero] X25519 migration failed (non-fatal):', err);
      _x25519PrivateKey = null;
      _x25519PublicKeyBase64 = null;
    }
  }

  // Zero-fill Ed25519 private key bytes
  privateKeyBytes.fill(0);

  return did;
}

/**
 * Get the stored DID without decrypting the private key.
 * Safe to call without the session key.
 */
export async function getStoredDID(): Promise<string | null> {
  const data = await chrome.storage.local.get(DID_STORAGE_KEY);
  const stored: StoredDID | undefined = data[DID_STORAGE_KEY];
  return stored?.did ?? null;
}

/**
 * Check if a DID has been initialized for this browser.
 */
export async function hasDID(): Promise<boolean> {
  const did = await getStoredDID();
  return !!did;
}

// ── Wrapped recovery key ────────────────────────────────────────────────────

/**
 * Store the recovery key encrypted (wrapped) by the primary key.
 *
 * This allows normal unlock (PIN or PRF) to recover the recovery key,
 * which is needed to decrypt the recoveryVault tier during cross-device sync.
 * Without this, a device can only decrypt its own primaryVault tier,
 * missing entries added by other devices in the recoveryVault tier.
 */
const WRAPPED_RECOVERY_KEY = 'nodezero_wrapped_recovery_key';

export async function storeWrappedRecoveryKey(
  primaryKey: CryptoKey,
  recoveryKey: CryptoKey
): Promise<void> {
  const rawRecovery = new Uint8Array(await crypto.subtle.exportKey('raw', recoveryKey));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    primaryKey,
    rawRecovery
  );
  rawRecovery.fill(0);

  await chrome.storage.local.set({
    [WRAPPED_RECOVERY_KEY]: {
      iv: bufferToBase64(iv),
      data: bufferToBase64(new Uint8Array(encrypted)),
    },
  });
}

/**
 * Load and unwrap the recovery key using the primary key.
 * Returns null if no wrapped key exists or decryption fails.
 */
export async function loadWrappedRecoveryKey(
  primaryKey: CryptoKey
): Promise<CryptoKey | null> {
  const stored = await chrome.storage.local.get(WRAPPED_RECOVERY_KEY);
  const wrapped = stored[WRAPPED_RECOVERY_KEY];
  if (!wrapped?.iv || !wrapped?.data) return null;

  try {
    const iv = base64ToBuffer(wrapped.iv);
    const data = base64ToBuffer(wrapped.data);
    const rawBytes = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      primaryKey,
      data
    );
    return crypto.subtle.importKey(
      'raw',
      rawBytes,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  } catch {
    return null;
  }
}
