/**
 * Two-Tier Vault Engine (ADR-007)
 *
 * The vault bundle contains two encrypted representations of all entries:
 *   - Primary vault: encrypted with WebAuthn PRF-derived AES-GCM key
 *   - Recovery vault: encrypted with PBKDF2(mnemonic)-derived AES-GCM key
 *
 * Both vaults are serialized as CBOR and stored together in a single bundle
 * that is signed and synced to encrypted storage.
 *
 * Security invariant:
 *   - Vault signature is verified BEFORE decryption (tamper detection)
 *   - No plaintext credential data ever touches chrome.storage
 */

import { cborEncode, cborDecode } from './codec';
import {
  encryptField,
  decryptField,
  encryptFields,
  decryptFields,
  bufferToBase64,
  base64ToBuffer,
  bufferToHex,
  hexToBuffer,
} from '@/lib/crypto/field-encrypt';
import {
  VaultEntry,
  VaultEntryEncrypted,
  createEntry,
  getEncryptableFields,
  mergeDecryptedFields,
} from './entry';
import { signBundle, verifyBundle } from '@/lib/did/provider';
import { Tombstone, createTombstone, pruneTombstones } from './merge';
import { PIN_PBKDF2_ITERATIONS } from '@/lib/crypto/pin-key';

export const VAULT_VERSION = 2;

/** The encrypted vault bundle structure */
export interface VaultBundle {
  version: number;
  did: string;
  createdAt: number;
  updatedAt: number;
  kdfParams: {
    primary:
      | { type: 'prf'; rpId: string }
      | { type: 'pin'; iterations?: number }   // fallback for non-PRF authenticators
      | { type: 'biometric'; iterations?: number };  // hybrid: passphrase-derived key wrapped by biometric
    recovery: { type: 'pbkdf2'; iterations: number };
  };
  credentialId?: string; // base64-encoded WebAuthn credential ID
  primaryVault: VaultEntryEncrypted[];
  recoveryVault: VaultEntryEncrypted[];
  tombstones: Tombstone[];  // unencrypted — contains only UUIDs + timestamps
  encryptedMnemonic?: string; // AES-GCM encrypted BIP-39 mnemonic (base64), decrypted into session on unlock
  signature: string; // Ed25519 hex signature of CBOR(bundle without signature)
}

/** In-memory session state (never persisted to disk) */
export interface VaultSession {
  bundle: VaultBundle;
  entries: VaultEntry[]; // decrypted entries
  primaryKey: CryptoKey | null;
  recoveryKey: CryptoKey | null;
  mnemonic?: string; // BIP-39 phrase, in-memory only while unlocked (for HD wallet derivation)
}

// ── Bundle creation ────────────────────────────────────────────────────────

/**
 * Create a new empty vault bundle for a fresh user.
 *
 * @param primaryMode 'prf' for WebAuthn PRF (hardware key), 'pin' for PIN fallback
 */
export function createVaultBundle(
  did: string,
  rpId: string,
  credentialId?: Uint8Array,
  primaryMode: 'prf' | 'pin' | 'biometric' = 'prf'
): VaultBundle {
  const now = Date.now();
  return {
    version: VAULT_VERSION,
    did,
    createdAt: now,
    updatedAt: now,
    kdfParams: {
      primary: primaryMode === 'prf'
        ? { type: 'prf', rpId }
        : primaryMode === 'biometric'
        ? { type: 'biometric', iterations: PIN_PBKDF2_ITERATIONS }
        : { type: 'pin', iterations: PIN_PBKDF2_ITERATIONS },
      recovery: { type: 'pbkdf2', iterations: 2_000_000 },
    },
    credentialId: credentialId ? bufferToBase64(credentialId) : undefined,
    primaryVault: [],
    recoveryVault: [],
    tombstones: [],
    signature: '',
  };
}

// ── Serialization ──────────────────────────────────────────────────────────

export function serializeBundle(bundle: VaultBundle): Uint8Array {
  return cborEncode(bundle);
}

export function deserializeBundle(bytes: Uint8Array): VaultBundle {
  const raw = cborDecode(bytes) as any;
  // Normalize v1 bundles that lack the tombstones field
  if (!raw.tombstones) raw.tombstones = [];
  return raw as VaultBundle;
}

/** Compute the signable bytes (CBOR of bundle with signature field cleared) */
function getSignableBytes(bundle: VaultBundle): Uint8Array {
  return cborEncode({ ...bundle, signature: '' });
}

// ── Signing & verification ─────────────────────────────────────────────────

export async function signVaultBundle(bundle: VaultBundle): Promise<VaultBundle> {
  const bytes = getSignableBytes(bundle);
  const sig = await signBundle(bytes);
  return { ...bundle, signature: sig };
}

export async function verifyVaultBundle(bundle: VaultBundle): Promise<boolean> {
  const bytes = getSignableBytes(bundle);
  return verifyBundle(bytes, bundle.signature);
}

// ── Entry encryption / decryption ─────────────────────────────────────────

/**
 * Encrypt all entries into a vault tier using the provided key.
 */
async function encryptEntries(
  entries: VaultEntry[],
  key: CryptoKey
): Promise<VaultEntryEncrypted[]> {
  const encrypted: VaultEntryEncrypted[] = [];
  for (const entry of entries) {
    const encFields = await encryptFields(
      getEncryptableFields(entry),
      key,
      entry.id
    );
    encrypted.push({
      id: entry.id,
      type: entry.type,
      title: entry.title,
      url: entry.url,
      tags: entry.tags,
      favicon: entry.favicon,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      lastUsed: entry.lastUsed,
      enc: encFields,
    });
  }
  return encrypted;
}

/**
 * Decrypt all entries from a vault tier using the provided key.
 * Exported for use by sync.ts merge logic (decrypting remote bundles).
 */
export async function decryptEntries(
  encrypted: VaultEntryEncrypted[],
  key: CryptoKey
): Promise<VaultEntry[]> {
  const entries: VaultEntry[] = [];
  for (const enc of encrypted) {
    const decFields = await decryptFields(enc.enc, key, enc.id);
    entries.push(mergeDecryptedFields(enc, decFields));
  }
  return entries;
}

// ── High-level vault operations ───────────────────────────────────────────

/**
 * Seal a vault session back into an encrypted bundle ready for storage.
 *
 * Partial seal: if only one key is available (normal unlock path supplies
 * only the primary key), re-encrypt only that vault tier and carry the
 * other tier forward unchanged from the existing bundle.
 */
export async function sealVault(session: VaultSession): Promise<VaultBundle> {
  const { bundle, entries, primaryKey, recoveryKey, mnemonic } = session;

  // Validate keys: they must exist and be real CryptoKey objects.
  // JSON serialization (e.g. via chrome.runtime.sendMessage) turns CryptoKey into {}.
  const hasPrimary = primaryKey && (primaryKey as any).type !== undefined;
  const hasRecovery = recoveryKey && (recoveryKey as any).type !== undefined;

  if (!hasPrimary && !hasRecovery) {
    throw new Error('Cannot seal vault: at least one valid key is required');
  }

  const [primaryVault, recoveryVault] = await Promise.all([
    hasPrimary  ? encryptEntries(entries, primaryKey)  : Promise.resolve(bundle.primaryVault),
    hasRecovery ? encryptEntries(entries, recoveryKey) : Promise.resolve(bundle.recoveryVault),
  ]);

  // Encrypt mnemonic with primary key for HD wallet derivation on unlock
  let encryptedMnemonic = bundle.encryptedMnemonic;
  if (mnemonic && hasPrimary) {
    const encBytes = await encryptField(mnemonic, primaryKey, 'mnemonic');
    encryptedMnemonic = bufferToBase64(encBytes);
  }

  const updated: VaultBundle = {
    ...bundle,
    primaryVault,
    recoveryVault,
    encryptedMnemonic,
    tombstones: pruneTombstones(bundle.tombstones ?? []),
    updatedAt: Date.now(),
    signature: '',
  };

  return signVaultBundle(updated);
}

/**
 * Unseal a vault bundle using the primary key (PRF-derived).
 * Verifies signature first.
 */
export async function unsealWithPrimaryKey(
  bundle: VaultBundle,
  primaryKey: CryptoKey
): Promise<VaultSession> {
  const valid = await verifyVaultBundle(bundle);
  if (!valid) {
    throw new Error('Vault signature invalid — possible tampering detected');
  }

  const tombstoneIds = new Set((bundle.tombstones ?? []).map(t => t.id));
  const entries = (await decryptEntries(bundle.primaryVault, primaryKey))
    .filter(e => !tombstoneIds.has(e.id));

  // Decrypt mnemonic for HD wallet derivation (if present)
  let mnemonic: string | undefined;
  if (bundle.encryptedMnemonic) {
    try {
      const encBytes = base64ToBuffer(bundle.encryptedMnemonic);
      mnemonic = await decryptField(encBytes, primaryKey, 'mnemonic');
    } catch {
      // Mnemonic decryption failed — wallet won't be available but vault still works
      console.warn('[NodeZero] Failed to decrypt mnemonic — wallet disabled');
    }
  }

  return {
    bundle,
    entries,
    primaryKey,
    recoveryKey: null,
    mnemonic,
  };
}

/**
 * Unseal a vault bundle using the recovery key (PBKDF2-derived).
 * Verifies signature first.
 */
export async function unsealWithRecoveryKey(
  bundle: VaultBundle,
  recoveryKey: CryptoKey,
  mnemonic?: string
): Promise<VaultSession> {
  const valid = await verifyVaultBundle(bundle);
  if (!valid) {
    throw new Error('Vault signature invalid — possible tampering detected');
  }

  const tombstoneIds = new Set((bundle.tombstones ?? []).map(t => t.id));
  const entries = (await decryptEntries(bundle.recoveryVault, recoveryKey))
    .filter(e => !tombstoneIds.has(e.id));
  return {
    bundle,
    entries,
    primaryKey: null,
    recoveryKey,
    mnemonic,
  };
}

// ── CRUD operations on decrypted session ─────────────────────────────────

export function addEntry(session: VaultSession, entry: VaultEntry): VaultSession {
  return { ...session, entries: [...session.entries, entry] };
}

export function updateEntry(session: VaultSession, updated: VaultEntry): VaultSession {
  const entries = session.entries.map(e =>
    e.id === updated.id ? { ...updated, updatedAt: Date.now() } : e
  );
  return { ...session, entries };
}

export function deleteEntry(session: VaultSession, entryId: string): VaultSession {
  const tombstone = createTombstone(entryId);
  return {
    ...session,
    entries: session.entries.filter(e => e.id !== entryId),
    bundle: {
      ...session.bundle,
      tombstones: [...(session.bundle.tombstones ?? []), tombstone],
    },
  };
}

export function searchEntries(entries: VaultEntry[], query: string): VaultEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return entries;
  return entries.filter(
    e =>
      e.title.toLowerCase().includes(q) ||
      e.url.toLowerCase().includes(q) ||
      e.username.toLowerCase().includes(q) ||
      e.tags.some(t => t.toLowerCase().includes(q)) ||
      (e.passkey?.rpId?.toLowerCase().includes(q)) ||
      (e.passkey?.rpName?.toLowerCase().includes(q))
  );
}

// ── Grouping utilities ────────────────────────────────────────────────────

export interface GroupedEntries {
  key: string;          // normalized domain, username, or sentinel
  label: string;        // display name
  entries: VaultEntry[];
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Extract a grouping domain from a URL.
 * Strips www., returns raw IP addresses as-is, falls back to 'Other'.
 */
export function extractDomain(url: string): string {
  try {
    const hostname = new URL(
      url.startsWith('http') ? url : `https://${url}`
    ).hostname.replace(/^www\./, '');
    return hostname || 'Other';
  } catch {
    return 'Other';
  }
}

/**
 * Group entries by their URL domain.
 * Alphabetically sorted, "Other" pushed to the end.
 */
export function groupByDomain(entries: VaultEntry[]): GroupedEntries[] {
  const map = new Map<string, VaultEntry[]>();
  for (const entry of entries) {
    const domain = extractDomain(entry.url);
    const list = map.get(domain);
    if (list) list.push(entry);
    else map.set(domain, [entry]);
  }
  return sortedGroups(map, 'Other');
}

/**
 * Group entries by their username / login email.
 * Alphabetically sorted, "No username" pushed to the end.
 */
export function groupByLogin(entries: VaultEntry[]): GroupedEntries[] {
  const NO_USERNAME = 'No username';
  const map = new Map<string, VaultEntry[]>();
  for (const entry of entries) {
    const key = entry.username.trim() ? entry.username.trim().toLowerCase() : NO_USERNAME;
    const list = map.get(key);
    if (list) list.push(entry);
    else map.set(key, [entry]);
  }
  return sortedGroups(map, NO_USERNAME);
}

/** Sort groups alphabetically, pushing a sentinel key to the bottom. */
function sortedGroups(map: Map<string, VaultEntry[]>, sentinelKey: string): GroupedEntries[] {
  const groups: GroupedEntries[] = [];
  let sentinel: GroupedEntries | null = null;

  for (const [key, entries] of map) {
    const group: GroupedEntries = {
      key,
      label: key === sentinelKey ? sentinelKey : key,
      entries,
    };
    if (key === sentinelKey) sentinel = group;
    else groups.push(group);
  }

  groups.sort((a, b) => a.label.localeCompare(b.label));
  if (sentinel) groups.push(sentinel);
  return groups;
}

// ── URL matching ──────────────────────────────────────────────────────────

export function findEntriesForUrl(entries: VaultEntry[], url: string): VaultEntry[] {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return entries.filter(e => {
      try {
        const entryHostname = new URL(
          e.url.startsWith('http') ? e.url : `https://${e.url}`
        ).hostname.replace(/^www\./, '');
        return entryHostname === hostname || entryHostname.endsWith(`.${hostname}`);
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

// ── Local encrypted storage ────────────────────────────────────────────────

/** Storage key for the encrypted vault bundle in chrome.storage.local */
const VAULT_STORAGE_KEY = 'nodezero_vault_bundle';

/**
 * Persist the vault bundle to chrome.storage.local as base64-encoded CBOR.
 * The bundle itself is already encrypted — no additional encryption needed.
 */
export async function saveVaultToStorage(bundle: VaultBundle): Promise<void> {
  const bytes = serializeBundle(bundle);
  const b64 = bufferToBase64(bytes);
  await chrome.storage.local.set({ [VAULT_STORAGE_KEY]: b64 });
}

/**
 * Load the vault bundle from chrome.storage.local.
 * Returns null if no vault has been created yet.
 */
export async function loadVaultFromStorage(): Promise<VaultBundle | null> {
  const data = await chrome.storage.local.get(VAULT_STORAGE_KEY);
  const b64: string | undefined = data[VAULT_STORAGE_KEY];
  if (!b64) return null;
  const bytes = base64ToBuffer(b64);
  return deserializeBundle(bytes);
}

/**
 * Check if a vault bundle exists in storage.
 */
export async function vaultExists(): Promise<boolean> {
  const data = await chrome.storage.local.get(VAULT_STORAGE_KEY);
  return !!data[VAULT_STORAGE_KEY];
}
