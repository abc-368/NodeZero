/**
 * email/registry.ts — Email-to-DID lookup, cache, and pending hash queue
 *
 * Manages the client-side of the email registry:
 *   - Normalize + SHA-256 hash emails (no PII leaves the extension)
 *   - Cache lookup results in chrome.storage.local (24h TTL)
 *   - Queue new email hashes for piggybacked registration during vault sync
 *   - Perform token-gated lookups against GET /v2/email/lookup
 */

import { redeemTokenForUpload } from '@/lib/tokens/redeemer';
import { refillPool } from '@/lib/tokens/issuer';
import { getActiveDid } from '@/lib/did/provider';
import { SYNC_API_BASE } from '@/lib/constants';
import { bufferToHex } from '@/lib/crypto/field-encrypt';

// ── Storage keys ─────────────────────────────────────────────────────────────

const EMAIL_CACHE_KEY = 'nodezero_email_cache';
const PENDING_HASHES_KEY = 'nodezero_pending_email_hashes';

/** Cache TTL: 24 hours in milliseconds */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ── Types ────────────────────────────────────────────────────────────────────

export interface EmailCacheEntry {
  did: string;
  x25519_pub: string;
  timestamp: number; // Date.now() when cached
}

export interface EmailLookupResult {
  did: string;
  x25519_pub: string;
}

// ── Email normalization & hashing ────────────────────────────────────────────

/**
 * Normalize an email address for consistent hashing.
 *
 * Rules:
 *   1. Trim whitespace, lowercase everything
 *   2. Gmail/Googlemail: strip dots from local part (they're insignificant)
 *      john.doe@gmail.com → johndoe@gmail.com
 *   3. Googlemail → gmail.com (they're the same mailbox)
 *   4. Strip "+" sub-addressing (user+tag@gmail.com → user@gmail.com)
 *
 * This ensures the same mailbox always produces the same hash,
 * regardless of how the address is typed in a compose window.
 */
export function normalizeEmail(email: string): string {
  let normalized = email.trim().toLowerCase();

  const atIdx = normalized.indexOf('@');
  if (atIdx === -1) return normalized;

  let local = normalized.slice(0, atIdx);
  let domain = normalized.slice(atIdx + 1);

  // Unify googlemail.com → gmail.com
  if (domain === 'googlemail.com') {
    domain = 'gmail.com';
  }

  // Gmail-specific normalization
  if (domain === 'gmail.com') {
    // Strip dots from local part (Gmail ignores them)
    local = local.replace(/\./g, '');

    // Strip sub-addressing (everything after +)
    const plusIdx = local.indexOf('+');
    if (plusIdx !== -1) {
      local = local.slice(0, plusIdx);
    }
  }

  return `${local}@${domain}`;
}

/**
 * SHA-256 hash a normalized email address.
 * Returns lowercase hex string (64 chars).
 */
export async function hashEmail(email: string): Promise<string> {
  const normalized = normalizeEmail(email);
  const bytes = new TextEncoder().encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  return bufferToHex(new Uint8Array(hashBuffer));
}

// ── Cache operations ─────────────────────────────────────────────────────────

/**
 * Get a cached email lookup result.
 * Returns null if not cached or if cache entry has expired (24h TTL).
 */
export async function getCachedEmailKey(
  emailHash: string,
): Promise<EmailLookupResult | null> {
  const data = await chrome.storage.local.get(EMAIL_CACHE_KEY);
  const cache: Record<string, EmailCacheEntry> = data[EMAIL_CACHE_KEY] ?? {};

  const entry = cache[emailHash];
  if (!entry) return null;

  // Check TTL
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    // Expired — remove from cache
    delete cache[emailHash];
    await chrome.storage.local.set({ [EMAIL_CACHE_KEY]: cache });
    return null;
  }

  return { did: entry.did, x25519_pub: entry.x25519_pub };
}

/**
 * Cache an email lookup result with the current timestamp.
 */
export async function cacheEmailKey(
  emailHash: string,
  did: string,
  x25519_pub: string,
): Promise<void> {
  const data = await chrome.storage.local.get(EMAIL_CACHE_KEY);
  const cache: Record<string, EmailCacheEntry> = data[EMAIL_CACHE_KEY] ?? {};

  cache[emailHash] = { did, x25519_pub, timestamp: Date.now() };
  await chrome.storage.local.set({ [EMAIL_CACHE_KEY]: cache });
}

// ── Pending hash queue ───────────────────────────────────────────────────────
// Hashes queued here are sent to the backend as a custom header during the
// next vault sync (piggybacked on the upload request).

/**
 * Queue an email hash for registration during the next vault sync.
 */
export async function queueEmailHashForSync(emailHash: string): Promise<void> {
  const data = await chrome.storage.local.get(PENDING_HASHES_KEY);
  const pending: string[] = data[PENDING_HASHES_KEY] ?? [];

  // Avoid duplicates
  if (!pending.includes(emailHash)) {
    pending.push(emailHash);
    await chrome.storage.local.set({ [PENDING_HASHES_KEY]: pending });
  }
}

/**
 * Get all pending email hashes and clear the queue.
 * Returns an empty array if no hashes are pending.
 */
export async function getPendingEmailHashesAndClear(): Promise<string[]> {
  const data = await chrome.storage.local.get(PENDING_HASHES_KEY);
  const pending: string[] = data[PENDING_HASHES_KEY] ?? [];

  if (pending.length > 0) {
    await chrome.storage.local.set({ [PENDING_HASHES_KEY]: [] });
  }

  return pending;
}

// ── Token-gated lookup ───────────────────────────────────────────────────────

/**
 * Look up an email hash in the registry.
 *
 * 1. Check local cache first (free, no token cost)
 * 2. If cache miss, redeem 1 blind-signature token
 * 3. Query GET /v2/email/lookup?h=<hash>
 * 4. Cache the result on success (24h TTL)
 *
 * Returns null if:
 *   - No tokens available (daily limit reached)
 *   - Email not registered in the registry
 *   - Network error
 */
export async function lookupEmailKey(
  emailHash: string,
): Promise<EmailLookupResult | null> {
  // Step 1: Check cache
  const cached = await getCachedEmailKey(emailHash);
  if (cached) {
    console.log('[NodeZero] Email key found in cache');
    return cached;
  }

  // Step 2: Redeem a token for the lookup
  let auth = await redeemTokenForUpload();
  if (!auth) {
    // Pool empty — try refilling
    const did = getActiveDid();
    if (!did) return null;
    console.log('[NodeZero] Token pool empty for email lookup, refilling...');
    const result = await refillPool(did);
    if ('error' in result) {
      console.warn('[NodeZero] Token refill failed:', result.error);
      return null;
    }
    auth = await redeemTokenForUpload();
    if (!auth) return null;
  }

  // Step 3: Query the backend
  try {
    const response = await fetch(
      `${SYNC_API_BASE}/v2/email/lookup?h=${encodeURIComponent(emailHash)}`,
      {
        method: 'GET',
        headers: {
          Authorization: auth.authorization,
          'X-NodeZero-Client': 'extension/0.2.0',
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (response.status === 404) {
      console.log('[NodeZero] Email not registered in registry');
      return null;
    }

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[NodeZero] Email lookup failed ${response.status}:`, errText);
      return null;
    }

    const data = (await response.json()) as EmailLookupResult;

    // Step 4: Cache the result
    await cacheEmailKey(emailHash, data.did, data.x25519_pub);
    console.log('[NodeZero] Email key looked up and cached');

    return data;
  } catch (err) {
    console.error('[NodeZero] Email lookup network error:', err);
    return null;
  }
}
