/**
 * pow.ts — Proof-of-Work computation for first-time vault uploads
 *
 * Computes a SHA-256 partial hash collision to prove computational work.
 * At difficulty 20 (~1M iterations), this takes ~1 second on modern hardware.
 *
 * Protocol: SHA-256("nodezero-pow:{did}:{nonce}") must have `difficulty`
 * leading zero bits.
 */

/**
 * Count leading zero bits in a byte array.
 */
function countLeadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
    } else {
      let b = byte;
      while ((b & 0x80) === 0) {
        bits++;
        b <<= 1;
      }
      break;
    }
  }
  return bits;
}

/**
 * Compute a proof-of-work nonce for a DID.
 *
 * Iterates until finding a nonce where SHA-256("nodezero-pow:{did}:{nonce}")
 * has at least `difficulty` leading zero bits.
 *
 * @param did - The DID being registered
 * @param difficulty - Required leading zero bits (e.g. 20 = ~1M iterations, ~1 second)
 * @returns The nonce as a string
 */
export async function computePoW(did: string, difficulty: number): Promise<string> {
  const encoder = new TextEncoder();
  let nonce = 0;

  while (true) {
    const data = encoder.encode(`nodezero-pow:${did}:${nonce}`);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    if (countLeadingZeroBits(hash) >= difficulty) {
      return String(nonce);
    }
    nonce++;

    // Yield to event loop every 10K iterations to avoid blocking
    if (nonce % 10_000 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}
