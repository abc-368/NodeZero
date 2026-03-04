/**
 * Vault Sync — Encrypted blob store + pointer service
 *
 * Architecture (v2):
 *   Extension → Worker /v1/upload   → Encrypted blob storage
 *   Extension → Worker /v1/pointer  → DID → CID mapping
 *   Extension ← Worker /v1/download ← Fetch blob by CID
 *
 * The vault blob is fully encrypted before upload — the sync service only
 * ever sees ciphertext. Content-addressing is via SHA-256 hex hash.
 *
 * Local caching: the encrypted bundle + CID are cached in
 * chrome.storage.local. On wakeup, checkAndPullIfUpdated() compares the
 * local CID with the remote pointer — zero egress if they match.
 */

import { bufferToBase64, base64ToBuffer, bufferToHex } from '@/lib/crypto/field-encrypt';
import {
  VaultBundle, VaultSession, serializeBundle, deserializeBundle,
  sealVault, decryptEntries, saveVaultToStorage, verifyVaultBundle,
} from './vault';
import { signBundle, getActiveDid } from '@/lib/did/provider';
import { mergeVaults, MergeInput } from './merge';
import { redeemTokenForUpload } from '@/lib/tokens/redeemer';
import { refillPool } from '@/lib/tokens/issuer';
import { shouldRefreshPool } from '@/lib/tokens/pool';
import { computePoW } from './pow';
import { getPendingEmailHashesAndClear } from '@/lib/email/registry';
import { getActiveX25519PublicKeyBase64 } from '@/lib/did/storage';

// ── Storage keys ────────────────────────────────────────────────────────────

const LOCAL_CID_KEY  = 'nodezero_vault_cid';
const LOCAL_VAULT_KEY = 'nodezero_vault_bundle';
const POINTER_URL_KEY = 'nodezero_pointer_url';
const DEFAULT_POINTER_URL = 'https://nodezero-backend.netalgowin.workers.dev';

/** Client identifier sent with every sync request (weak abuse filter). */
const CLIENT_HEADER = { 'X-NodeZero-Client': 'extension/0.1.0' };

export interface SyncResult {
  cid: string;
  timestamp: number;
  source: 'local' | 'r2' | 'upload';
  conflict?: boolean;         // true when server returned 409 (If-Match mismatch)
  currentCid?: string;        // remote CID returned with a 409
  tokenLimitReached?: boolean; // true when daily token allowance is exhausted
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getWorkerUrl(): Promise<string> {
  const data = await chrome.storage.local.get(POINTER_URL_KEY);
  let url = (data[POINTER_URL_KEY] as string | undefined)
    ?? (import.meta.env.VITE_POINTER_SERVICE_URL as string | undefined)
    ?? DEFAULT_POINTER_URL;

  // Inline migration: correct any stale URL from previous Worker versions
  if (url && !url.includes('nodezero-backend')) {
    url = DEFAULT_POINTER_URL;
    chrome.storage.local.set({ [POINTER_URL_KEY]: url });
  }

  return url;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bufferToHex(new Uint8Array(hash));
}

async function saveLocalCache(bundle: VaultBundle, cid: string): Promise<void> {
  const bytes = serializeBundle(bundle);
  await chrome.storage.local.set({
    [LOCAL_CID_KEY]:  { cid, timestamp: Date.now(), source: 'local' },
    [LOCAL_VAULT_KEY]: bufferToBase64(bytes),
  });
}

/**
 * Build DID auth headers for read operations (download + pointer GET).
 *
 * Uses the same X-DID / X-Timestamp / X-Signature pattern as uploads,
 * but with a `nodezero-vault-read` signature payload.
 *
 * Returns null if no signing key is active (pre-unlock / no DID loaded).
 */
async function buildReadAuthHeaders(did: string): Promise<Record<string, string> | null> {
  try {
    const timestamp = Date.now();
    const payload = `nodezero-vault-read\ndid:${did}\ntimestamp:${timestamp}`;
    const signature = await signBundle(new TextEncoder().encode(payload));
    return {
      'X-DID': did,
      'X-Timestamp': timestamp.toString(),
      'X-Signature': signature,
      ...CLIENT_HEADER,
    };
  } catch {
    // No active signing key (e.g. vault not yet unlocked) — fall back to unauthenticated
    return null;
  }
}

// ── Token authorization helper ──────────────────────────────────────────────

/**
 * Acquire a one-time upload authorization by redeeming a token.
 * If the pool is empty, attempts a refill first.
 * Returns null if daily limit is reached or no tokens available.
 */
async function acquireTokenAuth(): Promise<{ authorization: string } | null> {
  let auth = await redeemTokenForUpload();
  if (auth) return auth;

  // Pool empty — try refilling
  const did = getActiveDid();
  if (!did) return null;

  console.log('[NodeZero] Token pool empty, refilling...');
  const result = await refillPool(did);
  if ('error' in result) {
    console.warn('[NodeZero] Token refill failed:', result.error);
    return null;
  }

  // Retry redemption with fresh tokens
  auth = await redeemTokenForUpload();
  return auth;
}

// ── Upload (Extension → Worker → R2) ───────────────────────────────────────

export async function uploadVault(
  bundle: VaultBundle,
  authorization?: string,
): Promise<SyncResult> {
  const bytes = serializeBundle(bundle);
  const base  = await getWorkerUrl();

  // Skip if Worker URL is a placeholder
  if (!base || base.includes('YOUR_SUBDOMAIN')) {
    return localFallback(bytes);
  }

  try {
    const hexHash   = await sha256Hex(bytes);
    const did       = bundle.did;
    const timestamp = Date.now();

    // Sign the upload: proves the uploader owns this DID
    const sigPayload = `nodezero-vault-upload\ndid:${did}\nhash:${hexHash}\ntimestamp:${timestamp}`;
    const signature  = await signBundle(new TextEncoder().encode(sigPayload));

    // Optimistic concurrency: send our last-known CID so the server
    // can reject if another device uploaded in between.
    const localData = await chrome.storage.local.get(LOCAL_CID_KEY);
    const localCid: string | undefined = localData[LOCAL_CID_KEY]?.cid;

    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'X-DID':       did,
      'X-Timestamp': timestamp.toString(),
      'X-Signature': signature,
      ...CLIENT_HEADER,
    };
    if (localCid) {
      headers['If-Match'] = `"${localCid}"`;
    }

    // Token authorization (required by v3.1+ backend)
    if (authorization) {
      headers['Authorization'] = authorization;
    }

    // Piggyback pending email hashes for registration (non-blocking)
    try {
      const pendingHashes = await getPendingEmailHashesAndClear();
      const x25519Pub = getActiveX25519PublicKeyBase64();
      if (pendingHashes.length > 0 && x25519Pub) {
        headers['X-NodeZero-Email-Hashes'] = JSON.stringify({
          hashes: pendingHashes,
          x25519_pub: x25519Pub,
        });
        console.log(`[NodeZero] Piggybacking ${pendingHashes.length} email hash(es) on upload`);
      }
    } catch {
      // Non-fatal — email registration can retry next sync
    }

    console.log('[NodeZero] --- R2 SYNC START (v3.1.0) ---');
    console.log(`[NodeZero] Uploading to: ${base}/v1/upload  (${bytes.length} bytes)`);
    if (localCid) console.log(`[NodeZero] If-Match: "${localCid}"`);

    const response = await fetch(`${base}/v1/upload`, {
      method: 'POST',
      headers,
      body: bytes,
    });

    // 409 Conflict: another device uploaded since our last sync
    if (response.status === 409) {
      const body = await response.json() as { error: string; currentCid?: string };
      console.warn('[NodeZero] Upload conflict (409):', body.error,
        '| server CID:', body.currentCid?.slice(0, 12) + '…',
        '| sent If-Match:', localCid?.slice(0, 12) + '…');
      return {
        cid: '',
        timestamp: Date.now(),
        source: 'upload',
        conflict: true,
        currentCid: body.currentCid,
      };
    }

    // 428 Precondition Required: first upload needs PoW
    if (response.status === 428) {
      const powBody = await response.json() as {
        error: string;
        difficulty?: number;
      };
      if (powBody.error === 'pow_required' || powBody.error === 'pow_invalid') {
        const difficulty = powBody.difficulty ?? 20;
        console.log(`[NodeZero] PoW required (difficulty ${difficulty}), computing...`);
        const nonce = await computePoW(did, difficulty);
        console.log(`[NodeZero] PoW computed. Nonce: ${nonce}. Retrying upload...`);

        // Retry upload with PoW header.
        // The server checks PoW BEFORE consuming the token, so a 428
        // doesn't spend it — but the token has a 60s KV TTL that may
        // expire while PoW is computed. Acquire a fresh token to be safe.
        headers['X-NodeZero-PoW'] = nonce;

        const freshAuth = await acquireTokenAuth();
        if (freshAuth) {
          headers['Authorization'] = freshAuth.authorization;
        }

        // Re-sign with fresh timestamp
        const retryTimestamp = Date.now();
        const retrySigPayload = `nodezero-vault-upload\ndid:${did}\nhash:${hexHash}\ntimestamp:${retryTimestamp}`;
        const retrySignature = await signBundle(new TextEncoder().encode(retrySigPayload));
        headers['X-Timestamp'] = retryTimestamp.toString();
        headers['X-Signature'] = retrySignature;

        const retryResponse = await fetch(`${base}/v1/upload`, {
          method: 'POST',
          headers,
          body: bytes,
        });

        if (!retryResponse.ok) {
          const errText = await retryResponse.text();
          throw new Error(`Upload with PoW failed ${retryResponse.status}: ${errText}`);
        }

        const retryResult = await retryResponse.json() as { cid: string };
        console.log('[NodeZero] R2 upload success (with PoW). CID:', retryResult.cid);
        await saveLocalCache(bundle, retryResult.cid);
        return { cid: retryResult.cid, timestamp: Date.now(), source: 'upload' };
      }
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Upload failed ${response.status}: ${errText}`);
    }

    const result = await response.json() as { cid: string };
    const cid = result.cid;

    console.log('[NodeZero] R2 upload success. CID:', cid);
    await saveLocalCache(bundle, cid);
    return { cid, timestamp: Date.now(), source: 'upload' };
  } catch (err: any) {
    console.warn('[NodeZero] R2 upload failed:', err.message);
    return localFallback(bytes);
  }
}

/** Fallback: cache locally with a pseudo-CID (SHA-256 hex) */
async function localFallback(bytes: Uint8Array): Promise<SyncResult> {
  const cid = await sha256Hex(bytes);
  const bundle = deserializeBundle(bytes);
  await saveLocalCache(bundle, cid);
  return { cid, timestamp: Date.now(), source: 'local' };
}

// ── Pointer update (DID → CID in KV) ───────────────────────────────────────

export async function updateRemoteCid(did: string, cid: string): Promise<boolean> {
  try {
    const base = await getWorkerUrl();
    if (!base || base.includes('YOUR_SUBDOMAIN')) return false;

    const url       = `${base}/v1/pointer/${encodeURIComponent(did)}`;
    const timestamp = Date.now();
    const payload   = `nodezero-pointer-update\ndid:${did}\ncid:${cid}\ntimestamp:${timestamp}`;
    const signature = await signBundle(new TextEncoder().encode(payload));

    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...CLIENT_HEADER },
      body: JSON.stringify({ cid, timestamp, signature }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ── Download (Worker R2 → Extension) ────────────────────────────────────────

/**
 * Download a vault blob from R2.
 *
 * @param identifier - DID (did:key:z...) or hex hash (legacy)
 * @param did        - Owner DID for auth headers (defaults to identifier if it's a DID)
 */
export async function downloadVault(
  identifier: string,
  did?: string,
): Promise<VaultBundle | null> {
  const base = await getWorkerUrl();

  // Try Worker R2 — identifier can be a DID or a hex hash
  if (base && !base.includes('YOUR_SUBDOMAIN')) {
    try {
      const authDid = did ?? (identifier.startsWith('did:key:') ? identifier : undefined);
      const authHeaders = authDid ? await buildReadAuthHeaders(authDid) : null;

      const url = `${base}/v1/download/${encodeURIComponent(identifier)}`;
      const response = await fetch(url, {
        headers: authHeaders ?? CLIENT_HEADER,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        return deserializeBundle(new Uint8Array(await response.arrayBuffer()));
      }
    } catch { /* fall through */ }
  }

  // Fallback: local cache
  const localData = await chrome.storage.local.get(LOCAL_VAULT_KEY);
  if (localData[LOCAL_VAULT_KEY]) {
    return deserializeBundle(base64ToBuffer(localData[LOCAL_VAULT_KEY]));
  }

  return null;
}

// ── Sync (upload — Worker updates KV pointer atomically) ────────────────────

export async function syncVault(bundle: VaultBundle): Promise<SyncResult> {
  // Acquire token authorization before upload (v3.1+)
  const auth = await acquireTokenAuth();
  if (!auth) {
    console.warn('[NodeZero] No token authorization available. Saving locally only.');
    const bytes = serializeBundle(bundle);
    const result = await localFallback(bytes);
    return { ...result, tokenLimitReached: true };
  }

  // Worker v2.1+ updates the KV pointer atomically during upload,
  // so we no longer need a separate updateRemoteCid() call.
  return uploadVault(bundle, auth.authorization);
}

// ── Smart sync (merge-if-needed, safe for multi-device) ─────────────────────

/**
 * Smart sync with optimistic concurrency retry loop.
 *
 * 1. Check if remote CID differs from local → merge if needed
 * 2. Upload with If-Match header
 * 3. On 409 conflict → re-fetch, re-merge, retry (max 3 attempts)
 *
 * This handles the race condition where two devices check simultaneously,
 * both see the same CID, and both try to upload — the If-Match header
 * ensures only one wins, the other retries with a merge.
 */
export async function smartSync(
  session: VaultSession
): Promise<{ session: VaultSession; syncResult: SyncResult }> {
  const MAX_RETRIES = 3;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const did = session.bundle.did;

    // Quick check: has the remote changed since our last upload?
    const remoteBundle = await fetchRemoteIfDifferent(did);

    if (remoteBundle) {
      // Remote changed → another device uploaded → full merge cycle
      console.log('[NodeZero] Remote vault changed — merging before upload.');
      const merged = await mergeAndSync(session);
      // mergeAndSync seals + uploads internally; check for conflict
      if (!merged.syncResult.conflict) {
        return merged;
      }
      // Got a 409 during mergeAndSync's upload — loop and retry
      session = merged.session;
      console.warn(`[NodeZero] Upload conflict during merge (attempt ${attempt + 1}/${MAX_RETRIES}), retrying...`);
      continue;
    }

    // Acquire fresh token authorization for this upload attempt
    const auth = await acquireTokenAuth();
    if (!auth) {
      console.warn('[NodeZero] No token authorization for smart sync. Saving locally.');
      const bytes = serializeBundle(session.bundle);
      const fallback = await localFallback(bytes);
      return { session, syncResult: { ...fallback, tokenLimitReached: true } };
    }

    // CIDs match (or remote unreachable) → we're the only writer → upload
    const syncResult = await uploadVault(session.bundle, auth.authorization);
    if (!syncResult.conflict) {
      return { session, syncResult };
    }

    // Got 409 — another device uploaded between our check and our upload
    // The auth token was consumed; next iteration acquires a fresh one.
    console.warn(`[NodeZero] Upload conflict (attempt ${attempt + 1}/${MAX_RETRIES}), retrying...`);
    // Loop will re-fetch, re-merge, and retry
  }

  // Exhausted retries — fall back to a forced merge-and-sync
  console.error('[NodeZero] Upload conflict persisted after max retries. Performing final merge.');
  return mergeAndSync(session);
}

// ── Remote vault lookup (for cross-device recovery) ─────────────────────────

/**
 * Look up a DID on the pointer service and download the vault blob from R2.
 *
 * Used during cross-device recovery: user enters mnemonic → we derive DID
 * → call this to fetch the encrypted vault from R2.
 *
 * @param did - user's DID string (derived from mnemonic)
 * @returns VaultBundle if found, null otherwise
 */
export async function lookupAndDownloadVault(did: string): Promise<VaultBundle | null> {
  const base = await getWorkerUrl();
  if (!base || base.includes('YOUR_SUBDOMAIN')) return null;

  try {
    // Step 1: Query pointer service for CID (authenticated — prevents DID enumeration)
    const authHeaders = await buildReadAuthHeaders(did);
    const pointerUrl = `${base}/v1/pointer/${encodeURIComponent(did)}`;
    const pointerResp = await fetch(pointerUrl, {
      headers: authHeaders ?? CLIENT_HEADER,
      signal: AbortSignal.timeout(10_000),
    });
    // 402 = vault archived (free tier, inactive)
    if (pointerResp.status === 402) {
      const data = await pointerResp.json() as {
        error: string;
        reactivateUrl?: string;
        archivedSince?: string;
      };
      const archiveError = new Error('vault_archived') as Error & {
        reactivateUrl?: string;
        archivedSince?: string;
      };
      archiveError.reactivateUrl = data.reactivateUrl;
      archiveError.archivedSince = data.archivedSince;
      throw archiveError;
    }
    if (!pointerResp.ok) return null; // 404 = no vault for this DID

    const { cid } = (await pointerResp.json()) as { cid: string };
    if (!cid) return null;

    console.log('[NodeZero] Remote vault found. CID:', cid);

    // Step 2: Download vault blob from R2 using DID-based key (v2.1+)
    // Falls back to hash-based key for pre-2.1 blobs
    const bundle = await downloadVault(did, did) ?? await downloadVault(cid, did);
    if (bundle) {
      await saveLocalCache(bundle, cid);
      console.log('[NodeZero] Vault downloaded and cached locally.');
    }
    return bundle;
  } catch (err) {
    console.warn('[NodeZero] Remote vault lookup failed:', err);
    return null;
  }
}

// ── Pull if remote is newer ─────────────────────────────────────────────────

// ── Merge-and-sync orchestrator ──────────────────────────────────────────────

/**
 * Full merge-before-upload sync cycle:
 *   1. Download remote bundle (if CID differs)
 *   2. Decrypt remote entries with available key
 *   3. Merge local + remote per-entry (LWW + tombstones)
 *   4. Seal merged vault, save locally, upload to R2
 *
 * Returns the updated session (with merged entries) and sync result.
 */
export async function mergeAndSync(
  session: VaultSession
): Promise<{ session: VaultSession; syncResult: SyncResult }> {
  const did = session.bundle.did;

  // Step 1: Check if remote is different from local
  const remoteBundle = await fetchRemoteIfDifferent(did);

  if (remoteBundle) {
    // Verify remote signature before trusting it
    const valid = await verifyVaultBundle(remoteBundle);
    if (!valid) {
      console.warn('[NodeZero] Remote vault signature invalid. Skipping merge.');
    } else {
      // Step 2: Decrypt remote entries
      const remoteEntries = await decryptRemoteEntries(remoteBundle, session);

      if (remoteEntries.length > 0 || (remoteBundle.tombstones ?? []).length > 0) {
        // Step 3: Merge
        const localInput: MergeInput = {
          entries: session.entries,
          tombstones: session.bundle.tombstones ?? [],
        };
        const remoteInput: MergeInput = {
          entries: remoteEntries,
          tombstones: remoteBundle.tombstones ?? [],
        };
        const merged = mergeVaults(localInput, remoteInput);

        const mergedNew = merged.entries.length - session.entries.length;
        if (mergedNew > 0) {
          console.log(`[NodeZero] Merge: ${mergedNew} new entries from remote.`);
        }

        // Step 4: Update session with merged entries + carry forward opaque tier
        session = {
          ...session,
          entries: merged.entries,
          bundle: {
            ...session.bundle,
            tombstones: merged.tombstones,
            ...getOpaqueTierFromRemote(remoteBundle, session),
          },
        };
      }
    }
  }

  // Step 5: Seal, save, upload
  const sealed = await sealVault(session);
  session = { ...session, bundle: sealed };
  await saveVaultToStorage(sealed);
  let syncResult = await syncVault(sealed);

  // 409 retry: if the server tells us the actual CID, update local and retry once.
  // This handles any source of CID staleness (localFallback, missed pointer update, etc.)
  if (syncResult.conflict && syncResult.currentCid) {
    console.log('[NodeZero] 409 auto-fix: updating local CID to server value and retrying upload.');
    await chrome.storage.local.set({
      [LOCAL_CID_KEY]: { cid: syncResult.currentCid, timestamp: Date.now(), source: 'remote-409' },
    });
    syncResult = await syncVault(sealed);
  }

  return { session, syncResult };
}

// ── Merge helpers ────────────────────────────────────────────────────────────

/**
 * Download remote bundle only if its CID differs from our local cache.
 * Returns null if remote is the same or unreachable.
 */
async function fetchRemoteIfDifferent(did: string): Promise<VaultBundle | null> {
  const data = await chrome.storage.local.get([LOCAL_CID_KEY]);
  const localCid = data[LOCAL_CID_KEY]?.cid;

  const base = await getWorkerUrl();
  if (!base || base.includes('YOUR_SUBDOMAIN')) return null;

  try {
    const authHeaders = await buildReadAuthHeaders(did);
    if (!authHeaders) {
      console.warn('[NodeZero] fetchRemoteIfDifferent: no auth headers (DID key not loaded?)');
      return null;
    }
    const response = await fetch(
      `${base}/v1/pointer/${encodeURIComponent(did)}`,
      { headers: authHeaders, signal: AbortSignal.timeout(5_000) }
    );
    if (!response.ok) {
      console.warn(`[NodeZero] fetchRemoteIfDifferent: pointer GET returned ${response.status}`);
      return null;
    }

    const remoteCid = (await response.json()).cid;
    console.log(`[NodeZero] CID check — local: ${localCid?.slice(0, 12)}… remote: ${remoteCid?.slice(0, 12)}…`);

    if (!remoteCid || remoteCid === localCid) return null;

    // CIDs differ — download the remote bundle
    console.log('[NodeZero] CIDs differ — downloading remote bundle for merge.');
    const bundle = await downloadVault(did, did) ?? await downloadVault(remoteCid, did);

    // Update local CID to match remote so If-Match sends the correct value.
    // Without this, a stale local CID (e.g. from localFallback during token
    // outage) causes spurious 409 conflicts on the next upload.
    if (bundle) {
      await chrome.storage.local.set({
        [LOCAL_CID_KEY]: { cid: remoteCid, timestamp: Date.now(), source: 'remote' },
      });
      console.log('[NodeZero] Local CID updated to remote:', remoteCid.slice(0, 12) + '…');
    }

    return bundle;
  } catch (err) {
    console.warn('[NodeZero] fetchRemoteIfDifferent error:', err);
    return null;
  }
}

/**
 * Decrypt remote bundle entries using available keys.
 *
 * When both keys are available, decrypts BOTH tiers and merges them.
 * This is critical for the case where a recovery-only device (PC B) uploaded:
 * - primaryVault = carried forward opaquely (only old entries from PC A)
 * - recoveryVault = re-encrypted with all entries (old + new from PC B)
 *
 * If we only decrypted primaryVault, we'd miss PC B's new entries.
 * Merging both tiers ensures all entries are captured regardless of which
 * device uploaded and which keys it had.
 */
async function decryptRemoteEntries(
  remoteBundle: VaultBundle,
  session: VaultSession
): Promise<import('./entry').VaultEntry[]> {
  const hasPrimary = session.primaryKey && (session.primaryKey as any).type !== undefined;
  const hasRecovery = session.recoveryKey && (session.recoveryKey as any).type !== undefined;

  let primaryEntries: import('./entry').VaultEntry[] | null = null;
  let recoveryEntries: import('./entry').VaultEntry[] | null = null;

  if (hasPrimary) {
    try {
      primaryEntries = await decryptEntries(remoteBundle.primaryVault, session.primaryKey!);
    } catch { /* primary key failed */ }
  }

  if (hasRecovery) {
    try {
      recoveryEntries = await decryptEntries(remoteBundle.recoveryVault, session.recoveryKey!);
    } catch { /* recovery key failed */ }
  }

  // If both tiers decrypted, merge them (LWW per entry) to capture
  // entries that exist in one tier but not the other
  if (primaryEntries && recoveryEntries) {
    const merged = mergeVaults(
      { entries: primaryEntries, tombstones: [] },
      { entries: recoveryEntries, tombstones: [] }
    );
    return merged.entries;
  }

  // Only one tier available
  if (primaryEntries) return primaryEntries;
  if (recoveryEntries) return recoveryEntries;

  console.warn('[NodeZero] Could not decrypt remote vault for merge. Skipping merge.');
  return [];
}

/**
 * When we only have one key, carry forward the opaque (undecryptable) tier
 * from the remote bundle so it stays current after re-upload.
 */
function getOpaqueTierFromRemote(
  remoteBundle: VaultBundle,
  session: VaultSession
): Partial<Pick<VaultBundle, 'primaryVault' | 'recoveryVault'>> {
  const hasPrimary = session.primaryKey && (session.primaryKey as any).type !== undefined;
  const hasRecovery = session.recoveryKey && (session.recoveryKey as any).type !== undefined;

  const result: Partial<Pick<VaultBundle, 'primaryVault' | 'recoveryVault'>> = {};

  // If we don't have the primary key, carry forward remote's primaryVault
  if (!hasPrimary) result.primaryVault = remoteBundle.primaryVault;
  // If we don't have the recovery key, carry forward remote's recoveryVault
  if (!hasRecovery) result.recoveryVault = remoteBundle.recoveryVault;

  return result;
}
