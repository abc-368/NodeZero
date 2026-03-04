/**
 * NodeZero extension constants
 *
 * Centralized configuration: mint public key, token pool settings, API base.
 */

/** Backend API base URL (same as sync.ts DEFAULT_POINTER_URL). */
export const SYNC_API_BASE = 'https://nodezero-backend.netalgowin.workers.dev';

/**
 * Mint VOPRF P-256 public key (hex-encoded compressed point, 33 bytes).
 *
 * Used by the client to verify DLEQ proofs during token finalization.
 * This key is published at GET /v2/tokens/pubkey.
 *
 * Key rotation: replace with new public key from secrets/voprf-public.hex
 * after running scripts/generate-mint-key.mjs --force in the backend repo.
 * Old tokens (signed by old key) expire naturally within 24h.
 *
 */
export const MINT_VOPRF_PUBLIC_KEY_HEX = '02ef7ea81df20661bba3ded5eaa8510a72e56dfe3a152edbc5158ef21b8f6cc8e0';

/** Number of tokens to request in each issuance batch. */
export const TOKEN_BATCH_SIZE = 50;

/** Refill the pool when it drops below this threshold. */
export const TOKEN_MIN_POOL_SIZE = 20;

/** Token TTL in seconds (24 hours). */
export const TOKEN_TTL_SECONDS = 86_400;

/**
 * Fallback per-device budget — used ONLY before first server contact.
 * After the first /v2/tokens/issue call, the extension caches the server-provided
 * `defaultDeviceBudget` from the response and uses that instead.
 */
export const FALLBACK_DEVICE_BUDGET = 50;

/** Minimum allowed device budget (below this, UX is frustrating). */
export const MIN_DEVICE_BUDGET = 10;
