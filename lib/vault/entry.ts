/**
 * Vault entry type definitions.
 *
 * Based on patterns from Padloc (AGPL-3.0), adapted for NodeZero's
 * CBOR-based, field-level-encrypted vault format.
 */

export type EntryType = 'login' | 'note' | 'card' | 'identity';

/** Plaintext view of a credential entry (in-memory only, never stored) */
export interface VaultEntry {
  id: string;
  type: EntryType;
  title: string;
  url: string;
  username: string;
  password: string;
  notes: string;
  tags: string[];
  favicon?: string;
  createdAt: number;  // Unix ms
  updatedAt: number;  // Unix ms
  lastUsed?: number;  // Unix ms
}

/** Fields that get individually encrypted in the vault bundle */
export type EncryptedFields = 'username' | 'password' | 'notes';

/** Encrypted representation stored in the vault bundle */
export interface VaultEntryEncrypted {
  id: string;
  type: EntryType;
  title: string;         // plaintext (metadata, not secret)
  url: string;           // plaintext (metadata)
  tags: string[];        // plaintext (metadata)
  favicon?: string;      // plaintext (metadata)
  createdAt: number;
  updatedAt: number;
  lastUsed?: number;
  // Encrypted fields — base64-encoded [nonce||ciphertext+tag]
  enc: {
    username?: string;
    password?: string;
    notes?: string;
  };
}

/** Create a new empty entry with defaults */
export function createEntry(partial: Partial<VaultEntry> = {}): VaultEntry {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    type: 'login',
    title: '',
    url: '',
    username: '',
    password: '',
    notes: '',
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

/** Extract encrypted fields from a plaintext entry */
export function getEncryptableFields(entry: VaultEntry): Record<string, string> {
  return {
    username: entry.username,
    password: entry.password,
    notes: entry.notes,
  };
}

/** Merge decrypted fields back into an encrypted entry stub */
export function mergeDecryptedFields(
  stub: VaultEntryEncrypted,
  decrypted: Record<string, string>
): VaultEntry {
  return {
    id: stub.id,
    type: stub.type,
    title: stub.title,
    url: stub.url,
    tags: stub.tags,
    favicon: stub.favicon,
    createdAt: stub.createdAt,
    updatedAt: stub.updatedAt,
    lastUsed: stub.lastUsed,
    username: decrypted['username'] ?? '',
    password: decrypted['password'] ?? '',
    notes: decrypted['notes'] ?? '',
  };
}

/** Detect the primary URL hostname for favicon lookup */
export function extractHostname(url: string): string {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
  } catch {
    return '';
  }
}

/** Favicon URL from Google's favicon service */
export function getFaviconUrl(url: string): string {
  const hostname = extractHostname(url);
  if (!hostname) return '';
  return `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
}
