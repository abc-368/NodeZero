/**
 * DID:key provider using WebCrypto Ed25519
 *
 * Phase 1: Lightweight did:key implementation using browser-native Ed25519.
 * Phase 2: Replace with full Veramo integration for did:web, VC issuance, etc.
 *
 * did:key format: did:key:z6Mk<base58btc-encoded-ed25519-public-key>
 *
 * Reference: https://w3c-ccg.github.io/did-method-key/
 */

import { bufferToBase64, base64ToBuffer, bufferToHex, hexToBuffer } from '@/lib/crypto/field-encrypt';
import { mnemonicToSeedSync } from '@scure/bip39';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { ed25519 } from '@noble/curves/ed25519';

// ── Key generation ─────────────────────────────────────────────────────────

export interface DIDKeyPair {
  did: string;
  publicKeyBase64: string;
  privateKeyBase64: string; // stored encrypted in chrome.storage
}

/**
 * Generate a new Ed25519 key pair and derive the did:key identifier.
 */
export async function generateDIDKey(): Promise<{ keyPair: CryptoKeyPair; did: string }> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true, // extractable so we can export and store
    ['sign', 'verify']
  );

  const publicKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const did = rawPublicKeyToDid(new Uint8Array(publicKeyRaw));

  return { keyPair, did };
}

/**
 * Encode raw Ed25519 public key bytes to a did:key identifier.
 * Uses multicodec prefix 0xed01 for Ed25519 + base58btc multibase prefix 'z'.
 */
export function rawPublicKeyToDid(publicKeyBytes: Uint8Array): string {
  // Multicodec prefix for Ed25519 public key: 0xed 0x01
  const multicodecBytes = new Uint8Array([0xed, 0x01, ...publicKeyBytes]);
  return `did:key:z${base58btcEncode(multicodecBytes)}`;
}

/**
 * Encode raw Ed25519 public key bytes to a did:web identifier.
 * did:web requires a domain (e.g. did:web:example.com).
 * This will be used in Phase 2 for users who want a custom domain identity.
 */
export function rawPublicKeyToDidWeb(domain: string): string {
  // did:web format: did:web:<domain>[:path]
  // Note: the public key itself is not encoded in the DID string for did:web.
  // The DID document at https://<domain>/.well-known/did.json contains the key.
  return `did:web:${domain.replace(':', '%3A')}`;
}

// ── Signing & verification ─────────────────────────────────────────────────

// In-memory signing key (loaded from encrypted storage on unlock)
// Only non-extractable CryptoKeys are held — no raw key bytes in memory.
let _signingKey: CryptoKey | null = null;
let _verifyingKey: CryptoKey | null = null;
let _currentDid: string | null = null;

export function setActiveKeyPair(
  signingKey: CryptoKey,
  verifyingKey: CryptoKey,
  did: string,
): void {
  _signingKey = signingKey;
  _verifyingKey = verifyingKey;
  _currentDid = did;
}

export function clearActiveKeyPair(): void {
  _signingKey = null;
  _verifyingKey = null;
  _currentDid = null;
}

export function getActiveDid(): string | null {
  return _currentDid;
}

/**
 * Sign a byte array with the active Ed25519 signing key.
 * Returns hex-encoded signature.
 */
export async function signBundle(bytes: Uint8Array): Promise<string> {
  if (!_signingKey) throw new Error('No active signing key. Unlock the vault first.');
  const sig = await crypto.subtle.sign('Ed25519', _signingKey, bytes);
  return bufferToHex(new Uint8Array(sig));
}

/**
 * Sign a W3C Verifiable Credential (or any JSON object) as a JWS.
 * Phase 2 helper for secure sharing and delegation.
 */
export async function signVC(payload: any): Promise<string> {
  if (!_signingKey) throw new Error('No active signing key. Unlock the vault first.');
  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(payload));
  return signBundle(data);
}

/**
 * Verify an Ed25519 signature over a byte array.
 */
export async function verifyBundle(bytes: Uint8Array, hexSig: string): Promise<boolean> {
  if (!_verifyingKey) {
    // Allow verification even without an active session by loading from storage
    const stored = await loadDIDFromStorage();
    if (!stored) return false;
    _verifyingKey = await importVerifyingKey(base64ToBuffer(stored.publicKeyBase64));
  }

  try {
    const sig = hexToBuffer(hexSig);
    return await crypto.subtle.verify('Ed25519', _verifyingKey, sig, bytes);
  } catch {
    return false;
  }
}

// ── Key import helpers ────────────────────────────────────────────────────

export async function importSigningKey(pkcs8Bytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8Bytes,
    { name: 'Ed25519' },
    false,
    ['sign']
  );
}

export async function importVerifyingKey(rawBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    rawBytes,
    { name: 'Ed25519' },
    false,
    ['verify']
  );
}

// ── Storage interface (calls did/storage.ts) ──────────────────────────────

async function loadDIDFromStorage(): Promise<{ publicKeyBase64: string } | null> {
  const data = await chrome.storage.local.get('nodezero_did');
  return data['nodezero_did'] ?? null;
}

// ── Mnemonic-derived DID ──────────────────────────────────────────────────

const DID_HKDF_SALT = new TextEncoder().encode('nodezero-did-v1');

/** PKCS8 ASN.1 header for Ed25519 private key (16 bytes) */
const PKCS8_ED25519_HEADER = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/**
 * Derive a deterministic Ed25519 DID from a BIP-39 mnemonic.
 *
 * Derivation:
 *   mnemonicToSeedSync(mnemonic) → 64-byte seed
 *   → HKDF-SHA256(seed, salt="nodezero-did-v1") → 32-byte Ed25519 seed
 *   → ed25519.getPublicKey(seed) → 32-byte public key → did:key
 *
 * The HKDF domain separation ensures independence from the PBKDF2
 * recovery key derivation (which uses mnemonic + DID as salt, 2M iter).
 */
export async function deriveDIDFromMnemonic(
  mnemonic: string
): Promise<{ keyPair: CryptoKeyPair; did: string; bipSeed: Uint8Array }> {
  // Step 1: BIP-39 seed (64 bytes)
  const seed = mnemonicToSeedSync(mnemonic.trim());

  // Step 2: HKDF-SHA256 → 32-byte Ed25519 private key seed
  const privateKeySeed = hkdf(sha256, seed, DID_HKDF_SALT, undefined, 32);

  // Step 3: Derive public key
  const publicKeyBytes = ed25519.getPublicKey(privateKeySeed);
  const did = rawPublicKeyToDid(publicKeyBytes);

  // Step 4: Import into WebCrypto as CryptoKeyPair
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(PKCS8_ED25519_HEADER, 0);
  pkcs8.set(privateKeySeed, 16);

  const signingKey = await crypto.subtle.importKey(
    'pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']
  );
  const verifyingKey = await crypto.subtle.importKey(
    'raw', publicKeyBytes, { name: 'Ed25519' }, true, ['verify']
  );

  // Zero sensitive material (but NOT bipSeed — caller needs it for X25519)
  privateKeySeed.fill(0);
  pkcs8.fill(0);

  return {
    keyPair: { privateKey: signingKey, publicKey: verifyingKey } as CryptoKeyPair,
    did,
    bipSeed: seed,  // Caller must zero-fill after use
  };
}

/**
 * Derive only the DID string from a mnemonic (no WebCrypto import).
 * Fast (~1ms), synchronous. Used to look up the pointer service before
 * committing to the full key import.
 */
export function deriveDIDStringFromMnemonic(mnemonic: string): string {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const privateKeySeed = hkdf(sha256, seed, DID_HKDF_SALT, undefined, 32);
  const publicKeyBytes = ed25519.getPublicKey(privateKeySeed);
  const did = rawPublicKeyToDid(publicKeyBytes);

  // Zero sensitive material
  seed.fill(0);
  privateKeySeed.fill(0);

  return did;
}

// ── base58btc encoder (no external dep needed for this small operation) ──

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58btcEncode(bytes: Uint8Array): string {
  let num = BigInt(0);
  for (const byte of bytes) {
    num = num * BigInt(256) + BigInt(byte);
  }

  let encoded = '';
  while (num > BigInt(0)) {
    const remainder = Number(num % BigInt(58));
    encoded = BASE58_ALPHABET[remainder] + encoded;
    num = num / BigInt(58);
  }

  // Handle leading zero bytes
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = '1' + encoded;
  }

  return encoded;
}
