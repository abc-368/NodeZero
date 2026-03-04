/**
 * pool.ts — Local token pool management (chrome.storage.local)
 *
 * Stores signed tokens locally as a FIFO queue. Tokens are consumed
 * one at a time for each upload, and the pool is refilled in batches
 * when it drops below the minimum threshold.
 *
 * Storage keys:
 *   nz:tokens       — StoredNodeZeroToken[]  (the actual tokens)
 *   nz:tokens:meta  — TokenPoolMeta          (cached server-side balance info)
 */

import {
  TOKEN_MIN_POOL_SIZE,
  TOKEN_TTL_SECONDS,
  FALLBACK_DEVICE_BUDGET,
  MIN_DEVICE_BUDGET,
} from '@/lib/constants';

export const POOL_KEY = 'nz:tokens';
export const META_KEY = 'nz:tokens:meta';
const BUDGET_KEY = 'nz:settings:deviceBudget';

export interface StoredNodeZeroToken {
  version: 2;
  mint: 'nodezero.top';
  type: 'sync';
  input: string;       // hex-encoded 32-byte VOPRF input
  output: string;      // hex-encoded 32-byte VOPRF output
  issuedAt: number;    // epoch seconds
  expiresAt: number;   // issuedAt + TOKEN_TTL_SECONDS
}

/** Cached metadata from the last issuance / balance response. */
export interface TokenPoolMeta {
  remaining: number;            // tokens remaining in daily pool (all devices)
  dailyAllowance: number;       // server-authoritative (e.g. 100 or 500)
  defaultDeviceBudget: number;  // server-authoritative default budget for this tier
  tier: string;                 // 'free' | 'premium' — server-authoritative
  premiumExpiresAt: string | null; // ISO date or null
  resetsAt: number;             // epoch seconds (next midnight UTC)
  lastUpdated: number;          // epoch ms
}

/** Composite balance for UI display. */
export interface TokenBalance {
  held: number;            // non-expired tokens on this device
  remaining: number;       // remaining in daily pool (all devices, cached)
  dailyAllowance: number;
  resetsAt: number;
  initialized: boolean;    // true after at least one issuance has populated meta
}

// ── Pool reads ──────────────────────────────────────────────────────

/** Load all tokens from storage (including expired — use purge to clean). */
async function loadRawPool(): Promise<StoredNodeZeroToken[]> {
  const data = await chrome.storage.local.get(POOL_KEY);
  return (data[POOL_KEY] as StoredNodeZeroToken[] | undefined) ?? [];
}

/** Save tokens to storage. */
async function savePool(tokens: StoredNodeZeroToken[]): Promise<void> {
  await chrome.storage.local.set({ [POOL_KEY]: tokens });
}

/** Get non-expired tokens. */
export async function getAvailableTokens(): Promise<StoredNodeZeroToken[]> {
  const pool = await loadRawPool();
  const now = Math.floor(Date.now() / 1000);
  return pool.filter(t => t.expiresAt > now);
}

/** Get pool size (non-expired count). */
export async function getPoolSize(): Promise<number> {
  return (await getAvailableTokens()).length;
}

/** Check if pool needs refill (below minimum threshold). */
export async function shouldRefreshPool(): Promise<boolean> {
  const available = await getPoolSize();
  return available < TOKEN_MIN_POOL_SIZE;
}

// ── Pool metadata ───────────────────────────────────────────────────

/** Load cached pool metadata (from last issuance/balance call). */
export async function getPoolMeta(): Promise<TokenPoolMeta | null> {
  const data = await chrome.storage.local.get(META_KEY);
  return (data[META_KEY] as TokenPoolMeta | undefined) ?? null;
}

/** Save pool metadata (call after every issuance or balance check). */
export async function savePoolMeta(meta: TokenPoolMeta): Promise<void> {
  await chrome.storage.local.set({ [META_KEY]: meta });
}

/**
 * Atomically update pool tokens + metadata together.
 * Ensures chrome.storage.onChanged fires once with consistent state.
 */
export async function updatePoolAndMeta(
  tokens: StoredNodeZeroToken[],
  meta: TokenPoolMeta,
): Promise<void> {
  const pool = await loadRawPool();
  pool.push(...tokens);
  await chrome.storage.local.set({
    [POOL_KEY]: pool,
    [META_KEY]: meta,
  });
}

// ── Composite balance for UI ────────────────────────────────────────

/**
 * Get the composite token balance for display.
 * Combines local pool size with cached server-side remaining count.
 *
 * Handles staleness:
 *  - If no meta exists yet (first run before any issuance), returns
 *    initialized=false so the UI can decide whether to render.
 *  - If the cached resetsAt has passed (new UTC day), treats the daily
 *    pool as fully available (optimistic) until the next server call
 *    refreshes the meta.
 */
export async function getTokenBalance(): Promise<TokenBalance> {
  const held = await getPoolSize();
  const meta = await getPoolMeta();

  // No meta yet — first run, before any issuance has happened
  if (!meta) {
    return {
      held,
      remaining: 0,
      dailyAllowance: 0,
      resetsAt: 0,
      initialized: false,
    };
  }

  const now = Math.floor(Date.now() / 1000);

  // If the daily reset time has passed, the cached remaining is stale.
  // Optimistically show the full daily allowance until the next issuance
  // call fetches fresh data from the server.
  if (now >= meta.resetsAt && meta.resetsAt > 0) {
    return {
      held,
      remaining: meta.dailyAllowance,
      dailyAllowance: meta.dailyAllowance,
      resetsAt: meta.resetsAt,  // UI can detect this is stale
      initialized: true,
    };
  }

  return {
    held,
    remaining: meta.remaining,
    dailyAllowance: meta.dailyAllowance,
    resetsAt: meta.resetsAt,
    initialized: true,
  };
}

// ── Device budget ───────────────────────────────────────────────────

/**
 * Get the effective device budget for this device.
 *
 * Priority: user override (slider) → server-provided default → absolute fallback.
 * The server-provided `defaultDeviceBudget` is cached in pool meta from issuance responses.
 */
export async function getDeviceBudget(): Promise<number> {
  // User override takes priority (they explicitly set the slider)
  const override = await chrome.storage.local.get(BUDGET_KEY);
  if (override[BUDGET_KEY] != null) {
    return override[BUDGET_KEY] as number;
  }

  // Otherwise, use the server-provided default
  const meta = await getPoolMeta();
  if (meta?.defaultDeviceBudget) {
    return meta.defaultDeviceBudget;
  }

  // Absolute fallback (first run, before any server contact)
  return FALLBACK_DEVICE_BUDGET;
}

/** Save user-configured device budget. */
export async function setDeviceBudget(budget: number): Promise<void> {
  const clamped = Math.max(MIN_DEVICE_BUDGET, budget);
  await chrome.storage.local.set({ [BUDGET_KEY]: clamped });
}

// ── Pool mutations ──────────────────────────────────────────────────

/**
 * Pop one token from the pool (FIFO — oldest first).
 * Returns null if pool is empty or all tokens are expired.
 */
export async function consumeToken(): Promise<StoredNodeZeroToken | null> {
  const pool = await loadRawPool();
  const now = Math.floor(Date.now() / 1000);

  // Find first non-expired token
  const index = pool.findIndex(t => t.expiresAt > now);
  if (index === -1) return null;

  const [token] = pool.splice(index, 1);
  await savePool(pool);
  return token;
}

/**
 * Store newly issued tokens (appended to the end of the pool).
 */
export async function storeTokens(tokens: StoredNodeZeroToken[]): Promise<void> {
  const pool = await loadRawPool();
  pool.push(...tokens);
  await savePool(pool);
}

/**
 * Purge expired tokens from storage.
 * Returns number of tokens purged.
 */
export async function purgeExpiredTokens(): Promise<number> {
  const pool = await loadRawPool();
  const now = Math.floor(Date.now() / 1000);
  const valid = pool.filter(t => t.expiresAt > now);
  const purged = pool.length - valid.length;
  if (purged > 0) {
    await savePool(valid);
  }
  return purged;
}

/**
 * Clear the entire token pool and metadata (e.g. on vault delete / key rotation).
 */
export async function clearPool(): Promise<void> {
  await chrome.storage.local.remove([POOL_KEY, META_KEY]);
}
