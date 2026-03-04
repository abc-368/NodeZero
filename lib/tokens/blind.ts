/**
 * blind.ts — VOPRF (RFC 9497) client-side blinding for NODE0 tokens
 *
 * Uses @noble/curves v2 built-in VOPRF (P-256) implementation.
 * All hash-to-curve, DLEQ proof verification, and RFC 9497 compliance
 * is handled by the library — no hand-rolled crypto.
 *
 * Protocol:
 *   1. Client blinds:   { blind, blinded } = voprf.blind(input)
 *   2. Server evaluates: { evaluated, proof } = voprf.blindEvaluate(sk, pk, blinded)
 *   3. Client finalizes: output = voprf.finalize(input, blind, evaluated, blinded, pk, proof)
 *   4. Client redeems:   sends (input, output) — server verifies via voprf.evaluate(sk, input)
 *
 * The server never sees the unblinded input, so it cannot link
 * issuance to redemption (core privacy property).
 */

// @ts-ignore — @noble/curves v2 exports map uses .js suffix
import { p256_oprf } from '@noble/curves/nist.js';

const voprf = p256_oprf.voprf;

// ── Hex encoding utilities ───────────────────────────────────────────

/** Convert Uint8Array to hex string. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Convert hex string to Uint8Array. */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ── VOPRF client types ───────────────────────────────────────────────

/** A prepared blinded token, ready to send to the server. */
export interface PreparedBlindToken {
  input: Uint8Array;        // 32-byte random input (kept secret)
  blind: Uint8Array;        // blinding scalar (kept secret, needed for finalize)
  blindedHex: string;       // hex-encoded blinded point (sent to server)
}

/** A finalized VOPRF token, ready for storage and later redemption. */
export interface FinalizedToken {
  input: string;   // hex-encoded 32-byte original input
  output: string;  // hex-encoded 32-byte VOPRF output
}

// ── VOPRF client operations ──────────────────────────────────────────

/**
 * Generate a random 32-byte input, blind it for the server.
 * Returns the blinded element (hex) to send to the server,
 * plus the secret values needed for finalization.
 */
export function prepareBlindedToken(): PreparedBlindToken {
  const input = crypto.getRandomValues(new Uint8Array(32));
  const { blind, blinded } = voprf.blind(input);

  return {
    input,
    blind,
    blindedHex: bytesToHex(blinded),
  };
}

/**
 * Finalize a VOPRF token after receiving the server's evaluation.
 *
 * Verifies the DLEQ proof (ensures server used the correct key),
 * unblinds the result, and returns the final (input, output) pair.
 *
 * @throws If the DLEQ proof verification fails.
 */
export function finalizeToken(
  prepared: PreparedBlindToken,
  evaluatedHex: string,
  proofHex: string,
  serverPublicKeyHex: string,
): FinalizedToken {
  const evaluated = hexToBytes(evaluatedHex);
  const proof = hexToBytes(proofHex);
  const publicKey = hexToBytes(serverPublicKeyHex);
  const blinded = hexToBytes(prepared.blindedHex);

  // finalize verifies the DLEQ proof and unblinds the result
  // throws if proof verification fails
  const output = voprf.finalize(
    prepared.input,
    prepared.blind,
    evaluated,
    blinded,
    publicKey,
    proof,
  );

  return {
    input: bytesToHex(prepared.input),
    output: bytesToHex(output),
  };
}
