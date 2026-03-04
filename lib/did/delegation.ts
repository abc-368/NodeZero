/**
 * Delegation Verifiable Credentials — Phase 2 Implementation
 *
 * Allows a user (delegator) to share selected vault entries with another
 * NodeZero user (delegatee) for a bounded time period (max 90 days).
 *
 * Crypto:
 *   - VC signed with eddsa-jcs-2022 (Ed25519 over JCS-canonicalized JSON)
 *   - Vault key wrapped via X25519 ECDH + AES-256-GCM (same pattern as email/crypto.ts)
 *   - Backend stores opaque CBOR — cannot read scope or key material
 *
 * @see CRYPTOGRAPHY.md §11 for full design rationale
 */

import { getActiveDid, signBundle, rawPublicKeyToDid } from '@/lib/did/provider';
import { bufferToHex, hexToBuffer, bufferToBase64, base64ToBuffer } from '@/lib/crypto/field-encrypt';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { x25519 } from '@noble/curves/ed25519.js';
import { ed25519 } from '@noble/curves/ed25519.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DELEGATION_WRAP_INFO = 'nodezero-delegation-wrap-v1';
const MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DelegationVC {
  '@context': string[];
  type: string[];
  id: string;
  issuer: string;
  credentialSubject: {
    id: string;                   // delegatee DID
    scope: string[];              // entry UUIDs the delegatee may access
    wrappedVaultKey: string;      // base64url-encoded wrapped key (97 bytes)
  };
  issuanceDate: string;           // ISO 8601
  expirationDate: string;         // ISO 8601
  proof?: DataIntegrityProof;
}

export interface DataIntegrityProof {
  type: 'DataIntegrityProof';
  cryptosuite: 'eddsa-jcs-2022';
  verificationMethod: string;     // did:key:z6Mk...#z6Mk...
  proofPurpose: 'assertionMethod';
  proofValue: string;             // z<base58btc-encoded Ed25519 signature>
}

// ── Key wrapping ──────────────────────────────────────────────────────────────

/**
 * Wrap a 32-byte vault key for a delegatee using X25519 ECDH + AES-256-GCM.
 *
 * Wire format (97 bytes):
 *   ephemeralPub[32] || nonce[12] || encryptedKey[48] || reserved[5]
 *
 * The encrypted key is AES-GCM(wrappingKey, nonce, vaultKey) = 32 + 16-byte tag = 48 bytes.
 */
export async function wrapVaultKey(
  vaultKey: Uint8Array,
  delegateeX25519Pub: Uint8Array,
): Promise<Uint8Array> {
  if (vaultKey.length !== 32) throw new Error('Vault key must be 32 bytes');
  if (delegateeX25519Pub.length !== 32) throw new Error('X25519 public key must be 32 bytes');

  // 1. Fresh ephemeral keypair
  const ephPriv = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(ephPriv);

  // 2. ECDH → shared secret → wrapping key
  const shared = x25519.getSharedSecret(ephPriv, delegateeX25519Pub);
  const wrappingKeyBytes = hkdf(sha256, shared, undefined, DELEGATION_WRAP_INFO, 32);
  const wrappingKey = await crypto.subtle.importKey(
    'raw', wrappingKeyBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );

  // 3. Wrap vault key
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, wrappingKey, vaultKey,
  );
  const encryptedKey = new Uint8Array(ct); // 48 bytes (32 + 16 tag)

  // 4. Assemble 97-byte wire format
  const result = new Uint8Array(97);
  result.set(ephPub, 0);          // [0..31]
  result.set(nonce, 32);          // [32..43]
  result.set(encryptedKey, 44);   // [44..91]
  // [92..96] reserved, zero-filled

  // Zero ephemeral private key
  ephPriv.fill(0);
  wrappingKeyBytes.fill(0);
  shared.fill(0);

  return result;
}

/**
 * Unwrap a 32-byte vault key from a 97-byte wrapped key blob.
 */
export async function unwrapVaultKey(
  wrappedKey: Uint8Array,
  delegateeX25519Priv: Uint8Array,
): Promise<Uint8Array> {
  if (wrappedKey.length !== 97) throw new Error('Wrapped key must be 97 bytes');

  const ephPub = wrappedKey.slice(0, 32);
  const nonce = wrappedKey.slice(32, 44);
  const encryptedKey = wrappedKey.slice(44, 92);

  // ECDH → shared secret → wrapping key
  const shared = x25519.getSharedSecret(delegateeX25519Priv, ephPub);
  const wrappingKeyBytes = hkdf(sha256, shared, undefined, DELEGATION_WRAP_INFO, 32);
  const wrappingKey = await crypto.subtle.importKey(
    'raw', wrappingKeyBytes, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );

  const vaultKeyBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce }, wrappingKey, encryptedKey,
  );

  // Zero sensitive material
  shared.fill(0);
  wrappingKeyBytes.fill(0);

  return new Uint8Array(vaultKeyBuf);
}

// ── JCS canonicalization (RFC 8785) ───────────────────────────────────────────

/**
 * JSON Canonicalization Scheme per RFC 8785.
 * Produces deterministic JSON: sorted keys, no whitespace, specific number formatting.
 */
function jcsCanonical(obj: any): string {
  if (obj === null || typeof obj === 'boolean') return JSON.stringify(obj);
  if (typeof obj === 'number') {
    if (!isFinite(obj)) throw new Error('JCS: non-finite numbers not allowed');
    return Object.is(obj, -0) ? '0' : JSON.stringify(obj);
  }
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(jcsCanonical).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    const pairs = keys
      .filter(k => obj[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + jcsCanonical(obj[k]));
    return '{' + pairs.join(',') + '}';
  }
  throw new Error(`JCS: unsupported type ${typeof obj}`);
}

// ── VC issuance ───────────────────────────────────────────────────────────────

/**
 * Issue a DelegationVC to share vault entries with a delegatee.
 *
 * @param delegateeDid   - Delegatee's did:key
 * @param delegateeX25519Pub - Delegatee's X25519 public key (from email_registry)
 * @param vaultKey       - Raw 32-byte vault AES key (primary tier)
 * @param entryIds       - Entry UUIDs to share
 * @param ttlDays        - TTL in days (default 30, max 90)
 */
export async function issueDelegationVC(
  delegateeDid: string,
  delegateeX25519Pub: Uint8Array,
  vaultKey: Uint8Array,
  entryIds: string[],
  ttlDays: number = 30,
): Promise<DelegationVC> {
  const issuerDid = getActiveDid();
  if (!issuerDid) throw new Error('Unlock vault to issue delegation');
  if (entryIds.length === 0) throw new Error('Must share at least one entry');
  if (ttlDays < 1 || ttlDays > 90) throw new Error('TTL must be 1–90 days');

  // Wrap vault key for delegatee
  const wrappedKeyBytes = await wrapVaultKey(vaultKey, delegateeX25519Pub);
  const wrappedVaultKey = base64UrlEncode(wrappedKeyBytes);

  const now = new Date();
  const expiry = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

  // Build VC without proof
  const vc: DelegationVC = {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    type: ['VerifiableCredential', 'DelegationCredential'],
    id: `urn:uuid:${crypto.randomUUID()}`,
    issuer: issuerDid,
    credentialSubject: {
      id: delegateeDid,
      scope: [...entryIds],
      wrappedVaultKey,
    },
    issuanceDate: now.toISOString(),
    expirationDate: expiry.toISOString(),
  };

  // Sign with eddsa-jcs-2022
  const proof = await signVCWithJCS(vc, issuerDid);
  vc.proof = proof;

  return vc;
}

/**
 * Sign a VC using eddsa-jcs-2022 (Ed25519 over JCS-canonicalized JSON).
 */
async function signVCWithJCS(
  vc: Omit<DelegationVC, 'proof'>,
  issuerDid: string,
): Promise<DataIntegrityProof> {
  // JCS-canonicalize the VC (without proof field)
  const canonical = jcsCanonical(vc);
  const bytes = new TextEncoder().encode(canonical);

  // Sign with the active Ed25519 key
  const sigHex = await signBundle(bytes);

  // Build verification method: did:key:z6Mk...#z6Mk...
  const keyFragment = issuerDid.replace('did:key:', '');
  const verificationMethod = `${issuerDid}#${keyFragment}`;

  return {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    verificationMethod,
    proofPurpose: 'assertionMethod',
    proofValue: `z${sigHex}`,  // z-prefix for base58btc (we use hex for simplicity; matches our signBundle output)
  };
}

// ── VC verification ───────────────────────────────────────────────────────────

/**
 * Verify a DelegationVC:
 *   1. Ed25519 signature check against issuer's did:key
 *   2. Expiry check
 *   3. Delegatee match
 *
 * @param vc            - The delegation VC to verify
 * @param expectedDelegatee - Our DID (must match credentialSubject.id)
 */
export async function verifyDelegationVC(
  vc: DelegationVC,
  expectedDelegatee?: string,
): Promise<{ valid: boolean; reason?: string }> {
  // 1. Basic structure checks
  if (!vc.proof) return { valid: false, reason: 'Missing proof' };
  if (vc.proof.cryptosuite !== 'eddsa-jcs-2022') {
    return { valid: false, reason: `Unsupported cryptosuite: ${vc.proof.cryptosuite}` };
  }

  // 2. Expiry check
  const now = new Date();
  const expiry = new Date(vc.expirationDate);
  if (now > expiry) return { valid: false, reason: 'Delegation expired' };

  // 3. Issuance date sanity (not in the future by more than 5 minutes)
  const issuance = new Date(vc.issuanceDate);
  if (issuance.getTime() > now.getTime() + 5 * 60 * 1000) {
    return { valid: false, reason: 'Issuance date is in the future' };
  }

  // 4. TTL max check
  if (expiry.getTime() - issuance.getTime() > MAX_TTL_MS) {
    return { valid: false, reason: 'TTL exceeds maximum 90 days' };
  }

  // 5. Delegatee match (optional — useful when checking incoming delegations)
  if (expectedDelegatee && vc.credentialSubject.id !== expectedDelegatee) {
    return { valid: false, reason: 'Delegatee DID mismatch' };
  }

  // 6. Extract issuer's Ed25519 public key from did:key
  const issuerPubBytes = extractPubKeyFromDid(vc.issuer);
  if (!issuerPubBytes) {
    return { valid: false, reason: 'Invalid issuer did:key' };
  }

  // 7. Reconstruct VC without proof, JCS-canonicalize, verify signature
  const { proof, ...vcWithoutProof } = vc;
  const canonical = jcsCanonical(vcWithoutProof);
  const messageBytes = new TextEncoder().encode(canonical);

  // Parse signature (remove z-prefix, decode hex)
  const sigHex = proof.proofValue.startsWith('z')
    ? proof.proofValue.slice(1)
    : proof.proofValue;

  try {
    const sigBytes = hexToBuffer(sigHex);
    const verifyKey = await crypto.subtle.importKey(
      'raw', issuerPubBytes, { name: 'Ed25519' }, false, ['verify'],
    );
    const valid = await crypto.subtle.verify('Ed25519', verifyKey, sigBytes, messageBytes);
    if (!valid) return { valid: false, reason: 'Invalid signature' };
  } catch {
    return { valid: false, reason: 'Signature verification error' };
  }

  return { valid: true };
}

// ── Revocation ────────────────────────────────────────────────────────────────

/**
 * Build the DID-signed request to revoke a delegation.
 * Caller sends DELETE /v1/delegation/{id} with appropriate headers.
 */
export function buildDelegationRevokePayload(
  delegatorDid: string,
  delegationId: string,
  timestamp: number,
): Uint8Array {
  const payload = `nodezero-delegation-revoke\ndelegator:${delegatorDid}\nid:${delegationId}\ntimestamp:${timestamp}`;
  return new TextEncoder().encode(payload);
}

export function buildDelegationCreatePayload(
  delegatorDid: string,
  delegateeDid: string,
  timestamp: number,
): Uint8Array {
  const payload = `nodezero-delegation-create\ndelegator:${delegatorDid}\ndelegatee:${delegateeDid}\ntimestamp:${timestamp}`;
  return new TextEncoder().encode(payload);
}

export function buildDelegationListPayload(
  delegateeDid: string,
  timestamp: number,
): Uint8Array {
  const payload = `nodezero-delegation-list\ndelegatee:${delegateeDid}\ntimestamp:${timestamp}`;
  return new TextEncoder().encode(payload);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract raw Ed25519 public key bytes from a did:key identifier.
 */
function extractPubKeyFromDid(did: string): Uint8Array | null {
  if (!did.startsWith('did:key:z')) return null;
  try {
    const encoded = did.slice('did:key:z'.length);
    const bytes = base58btcDecode(encoded);
    // Multicodec prefix for Ed25519: 0xed 0x01
    if (bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) return null;
    return bytes.slice(2);
  } catch {
    return null;
  }
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58btcDecode(input: string): Uint8Array {
  const bytes = [0];
  for (const char of input) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value < 0) throw new Error(`Invalid base58 character: ${char}`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of input) {
    if (char === '1') bytes.push(0);
    else break;
  }
  return new Uint8Array(bytes.reverse());
}

function base64UrlEncode(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function base64UrlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
