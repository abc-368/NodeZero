/**
 * NodeZero extension constants
 *
 * Centralized configuration: mint public key, token pool settings, API base.
 */

/** Backend API base URL (same as sync.ts DEFAULT_POINTER_URL). */
export const SYNC_API_BASE = 'https://nodezero-backend.netalgowin.workers.dev';

/**
 * Mint RSA-2048 public key (JWK).
 *
 * Used to blind tokens before issuance and verify blind signatures after
 * unblinding. This key is published at GET /v2/tokens/pubkey.
 *
 * Key rotation: replace with new public key from secrets/mint-public.jwk
 * after running scripts/generate-mint-key.mjs --force in the backend repo.
 * Old tokens (signed by old key) expire naturally within 24h.
 */
export const MINT_PUBLIC_KEY_JWK = {
  kty: 'RSA' as const,
  n: 'uYc0ba5PATAf_6Zul41C_XNvaGqWWkC9BwpwMBklX_LefTCSSl60SA7U4PR0wzAvhx9t4MFGuX2wcDz1XQfTnbpBKhfARvIurw3S7kegSsG2zRmT6rOBEqq5ZvW55XtqnrTpEJvA_w6eUwsDlGfQUoceZl86sW2TQTeKfsVhutsXO2nQiDaqxNFwlk-nG2N70jBbl5Ax8bakBMORV5W7KStRXI1sn2imSIalQoiZb37_2dC-oKd0_H5oEsGkuOXkERWTRczlFYDz2wTPj6zmSHS9b5KgMQkIkoasKrZTtH7LWRDzumxnbVTbgO-ZrAP8pE7XRiGM48SBady5yowF2w',
  e: 'AQAB',
};

export type MintPublicKeyJwk = typeof MINT_PUBLIC_KEY_JWK;

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
