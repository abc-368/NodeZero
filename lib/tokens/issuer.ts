/**
 * issuer.ts — Batch VOPRF token issuance
 *
 * Calls POST /v2/tokens/issue with a DID-signed request containing
 * blinded elements. Finalizes (verifies DLEQ proof + unblinds) each
 * server response, and stores the final tokens in the local pool.
 *
 * Budget-aware: requests (deviceBudget − currentPoolSize) tokens per
 * issuance call, not a fixed batch size. The backend may return fewer
 * if other devices have consumed part of the daily allowance.
 */

import {
  prepareBlindedToken,
  finalizeToken,
  type PreparedBlindToken,
} from './blind';
import {
  getPoolSize,
  getPoolMeta,
  getDeviceBudget,
  updatePoolAndMeta,
  savePoolMeta,
  type StoredNodeZeroToken,
  type TokenPoolMeta,
} from './pool';
import {
  MINT_VOPRF_PUBLIC_KEY_HEX,
  SYNC_API_BASE,
  TOKEN_TTL_SECONDS,
} from '@/lib/constants';
import { signBundle, getActiveDid } from '@/lib/did/provider';

export interface RefillResult {
  added: number;
  remaining: number;
}

export interface RefillError {
  error: string;
  resetsAt?: number;
}

/** Compute next midnight UTC in epoch seconds. */
function nextMidnightUTC(): number {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/**
 * In-flight refill guard. Prevents concurrent issuance calls from
 * double-drawing the server's daily pool (e.g. when mergeAndSync and
 * the periodic alarm both try to refill simultaneously).
 *
 * The second caller piggybacks on the first's promise instead of
 * firing a separate server request.
 */
let _refillInFlight: Promise<RefillResult | RefillError> | null = null;

/**
 * Request a batch of VOPRF-evaluated tokens from the backend.
 *
 * Flow:
 *   1. Compute how many tokens to request (budget − current pool)
 *   2. Generate random inputs + blind them via VOPRF
 *   3. DID-sign the issuance request
 *   4. POST /v2/tokens/issue
 *   5. Finalize each token (verify DLEQ proof + unblind)
 *   6. Store in local pool + update cached metadata
 *
 * Mutex: concurrent calls are deduplicated — the second caller
 * awaits the first call's result instead of issuing a new request.
 *
 * @param did - The user's DID (must have an active signing key)
 * @returns Success: { added, remaining }  |  Error: { error, resetsAt? }
 */
export async function refillPool(did: string): Promise<RefillResult | RefillError> {
  // Deduplicate concurrent calls — second caller piggybacks on first
  if (_refillInFlight) {
    console.log('[NodeZero] refillPool: concurrent call deduplicated');
    return _refillInFlight;
  }
  _refillInFlight = _refillPoolImpl(did);
  try {
    return await _refillInFlight;
  } finally {
    _refillInFlight = null;
  }
}

/** How long before cached pool metadata is considered stale. */
const META_STALE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Refresh cached pool metadata via GET /v2/tokens/balance.
 * Does NOT issue or consume any tokens — pure read.
 */
async function _refreshMetaViaBalance(did: string): Promise<RefillResult | RefillError> {
  try {
    const timestamp = Date.now();
    const payload = `nodezero-vault-read\ndid:${did}\ntimestamp:${timestamp}`;
    const signature = await signBundle(new TextEncoder().encode(payload));

    const response = await fetch(`${SYNC_API_BASE}/v2/tokens/balance`, {
      method: 'GET',
      headers: {
        'X-DID': did,
        'X-Timestamp': timestamp.toString(),
        'X-Signature': signature,
        'X-NodeZero-Client': 'extension/0.2.0',
      },
    });

    if (!response.ok) {
      console.warn('[NodeZero] Balance refresh failed:', response.status);
      return { added: 0, remaining: 0 };
    }

    const body = await response.json() as {
      tier: string;
      premiumExpiresAt: string | null;
      remaining: number;
      dailyAllowance: number;
      defaultDeviceBudget: number;
      resetsAt: number;
    };

    await savePoolMeta({
      remaining: body.remaining,
      dailyAllowance: body.dailyAllowance,
      defaultDeviceBudget: body.defaultDeviceBudget,
      tier: body.tier ?? 'free',
      premiumExpiresAt: body.premiumExpiresAt ?? null,
      resetsAt: body.resetsAt,
      lastUpdated: Date.now(),
    });

    console.log(`[NodeZero] Meta refreshed via balance: ${body.remaining} remaining`);
    return { added: 0, remaining: body.remaining };
  } catch (err) {
    console.warn('[NodeZero] Balance refresh error:', err);
    return { added: 0, remaining: 0 };
  }
}

async function _refillPoolImpl(did: string): Promise<RefillResult | RefillError> {
  const budget = await getDeviceBudget();
  const currentSize = await getPoolSize();

  if (currentSize > 0) {
    // Pool still has tokens — no refill needed.
    // Only refresh cached meta if stale (does NOT consume tokens).
    const meta = await getPoolMeta();
    const metaAge = meta ? Date.now() - meta.lastUpdated : Infinity;
    if (metaAge < META_STALE_MS) {
      return { added: 0, remaining: meta?.remaining ?? 0 };
    }
    console.log('[NodeZero] Pool has tokens but meta is stale — refreshing via balance...');
    return _refreshMetaViaBalance(did);
  }

  // Pool is empty — claim a full device budget from the server.
  // If we have no cached meta yet (first run / recovery), bootstrap it
  // via the balance endpoint so we use the correct tier-based budget.
  let effectiveBudget = budget;
  const cachedMeta = await getPoolMeta();
  if (!cachedMeta) {
    console.log('[NodeZero] No cached meta — bootstrapping via balance before first claim...');
    await _refreshMetaViaBalance(did);
    effectiveBudget = await getDeviceBudget(); // re-read now that meta is populated
  }
  // Claim the full device budget — no batch-size cap.
  // Refills only happen when the pool is empty, so we want to claim
  // everything in one go (the server enforces the daily allowance).
  const count = effectiveBudget;

  // Step 1: Generate + blind tokens via VOPRF
  const prepared: PreparedBlindToken[] = [];
  for (let i = 0; i < count; i++) {
    prepared.push(prepareBlindedToken());
  }

  // Step 2: Build request body — hex-encoded blinded elements
  const blindedElements = prepared.map(p => p.blindedHex);

  // Step 3: Sign the issuance request
  const timestamp = Date.now();
  const payload = `nodezero-token-issue\ndid:${did}\ncount:${count}\ntimestamp:${timestamp}`;
  const signature = await signBundle(new TextEncoder().encode(payload));

  // Step 4: POST /v2/tokens/issue
  const response = await fetch(`${SYNC_API_BASE}/v2/tokens/issue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-DID': did,
      'X-Timestamp': timestamp.toString(),
      'X-Signature': signature,
      'X-NodeZero-Client': 'extension/0.2.0',
    },
    body: JSON.stringify({ blindedElements, count }),
  });

  // Handle rate limit / daily limit exhaustion
  if (response.status === 429) {
    const body = await response.json() as {
      error?: string; resetsAt?: number; remaining?: number;
      dailyAllowance?: number; defaultDeviceBudget?: number;
    };
    // Persist meta even on 429 so the UI can show "resets at X"
    const prev429 = await getPoolMeta();
    await savePoolMeta({
      remaining: body.remaining ?? 0,
      dailyAllowance: body.dailyAllowance ?? 100,
      defaultDeviceBudget: body.defaultDeviceBudget ?? 50,
      tier: prev429?.tier ?? 'free',
      premiumExpiresAt: prev429?.premiumExpiresAt ?? null,
      resetsAt: body.resetsAt ?? nextMidnightUTC(),
      lastUpdated: Date.now(),
    });
    if (body.error === 'daily_limit_reached') {
      return { error: 'daily_limit_reached', resetsAt: body.resetsAt };
    }
    return { error: 'rate_limited' };
  }

  if (!response.ok) {
    const errText = await response.text();
    return { error: `issuance_failed: ${response.status} ${errText}` };
  }

  const result = await response.json() as {
    evaluatedElements: Array<{ evaluated: string; proof: string }>;
    issued: number;
    remaining: number;
    dailyAllowance?: number;
    defaultDeviceBudget?: number;
    expiresAt: number;
  };

  if (result.issued === 0) {
    const prevEmpty = await getPoolMeta();
    await savePoolMeta({
      remaining: 0,
      dailyAllowance: result.dailyAllowance ?? 100,
      defaultDeviceBudget: result.defaultDeviceBudget ?? 50,
      tier: prevEmpty?.tier ?? 'free',
      premiumExpiresAt: prevEmpty?.premiumExpiresAt ?? null,
      resetsAt: result.expiresAt ?? nextMidnightUTC(),
      lastUpdated: Date.now(),
    });
    return { error: 'daily_limit_reached', resetsAt: result.expiresAt };
  }

  // Step 5: Finalize each token (verify DLEQ proof + unblind)
  const now = Math.floor(Date.now() / 1000);
  const tokens: StoredNodeZeroToken[] = [];

  for (let i = 0; i < result.issued; i++) {
    try {
      const { evaluated, proof } = result.evaluatedElements[i];
      const { input, output } = finalizeToken(
        prepared[i],
        evaluated,
        proof,
        MINT_VOPRF_PUBLIC_KEY_HEX,
      );
      tokens.push({
        version: 2,
        mint: 'nodezero.top',
        type: 'sync',
        input,
        output,
        issuedAt: now,
        expiresAt: now + TOKEN_TTL_SECONDS,
      });
    } catch (err) {
      console.warn(`[NodeZero] Token ${i} finalize/verify failed:`, err);
      // Skip this token — the rest may still be valid
    }
  }

  // Step 6: Store valid tokens + update cached metadata (atomic write)
  // Preserve tier info from last balance refresh (issuance endpoint doesn't return it)
  const prevMeta = await getPoolMeta();
  const meta: TokenPoolMeta = {
    remaining: result.remaining,
    dailyAllowance: result.dailyAllowance ?? 100,
    defaultDeviceBudget: result.defaultDeviceBudget ?? 50,
    tier: prevMeta?.tier ?? 'free',
    premiumExpiresAt: prevMeta?.premiumExpiresAt ?? null,
    resetsAt: result.expiresAt ?? nextMidnightUTC(),
    lastUpdated: Date.now(),
  };

  if (tokens.length > 0) {
    await updatePoolAndMeta(tokens, meta);
    console.log(`[NodeZero] Pool refilled: +${tokens.length} tokens (${result.remaining} remaining on server)`);
  } else {
    await savePoolMeta(meta);
  }

  return { added: tokens.length, remaining: result.remaining };
}
