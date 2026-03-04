/**
 * redeemer.ts — Anonymous VOPRF token redemption for upload authorization
 *
 * Calls POST /v2/tokens/redeem with (input, output) pair (NO DID headers).
 * Returns a one-time "nz-token-*" authorization string valid for 60 seconds.
 *
 * This is the core privacy mechanism: the Worker re-derives the VOPRF output
 * from the input using the server key, but cannot link the token back to
 * the DID that obtained it during issuance.
 */

import { consumeToken } from './pool';
import { SYNC_API_BASE } from '@/lib/constants';

export interface RedemptionResult {
  authorization: string;  // "nz-token-<random>"
  expiresIn: number;      // seconds (60)
}

/**
 * Redeem a single token from the local pool for upload authorization.
 *
 * Returns null if the pool is empty (caller should refill first).
 * On double-spend (409), discards the token and retries once.
 */
export async function redeemTokenForUpload(): Promise<RedemptionResult | null> {
  // First attempt
  const result = await attemptRedeem();
  if (result !== 'already_spent') return result;

  // Token was already spent (edge case — clock skew, retry from crash)
  // Discard and try the next token in the pool
  console.warn('[NodeZero] Token already spent, trying next...');
  return attemptRedeem().then(r => r === 'already_spent' ? null : r);
}

async function attemptRedeem(): Promise<RedemptionResult | 'already_spent' | null> {
  const stored = await consumeToken();
  if (!stored) return null;

  try {
    const response = await fetch(`${SYNC_API_BASE}/v2/tokens/redeem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Deliberately NO X-DID, X-Timestamp, X-Signature — anonymous
        'X-NodeZero-Client': 'extension/0.2.0',
      },
      body: JSON.stringify({
        input: stored.input,
        output: stored.output,
      }),
    });

    if (response.status === 409) {
      return 'already_spent';
    }

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[NodeZero] Token redeem failed ${response.status}:`, errText);
      return null;
    }

    const result = await response.json() as RedemptionResult;
    return result;
  } catch (err) {
    console.error('[NodeZero] Token redeem network error:', err);
    return null;
  }
}
