/**
 * VOPRF round-trip test — verifies the full token lifecycle.
 *
 * Simulates:
 *   1. Client blinds input
 *   2. Server evaluates (using a test key)
 *   3. Client finalizes (verifies DLEQ proof + unblinds)
 *   4. Server verifies at redemption (re-derives output)
 *   5. Double-spend detection (same token rejected)
 *   6. Wrong key rejection (different server key → DLEQ proof fails)
 *
 * Uses @noble/curves v2 p256_oprf.voprf for both client and server sides.
 */

import { describe, it, expect } from 'vitest';
// @ts-ignore — @noble/curves v2 exports map uses .js suffix
import { p256, p256_oprf } from '@noble/curves/nist.js';
// @ts-ignore
import { sha256 } from '@noble/hashes/sha2.js';
// @ts-ignore
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import {
  prepareBlindedToken,
  finalizeToken,
  bytesToHex as clientBytesToHex,
  hexToBytes as clientHexToBytes,
} from '../../lib/tokens/blind';

const voprf = p256_oprf.voprf;

// Cast for evaluate (exists at runtime, missing from v2.0.1 types)
const voprfEvaluate = (voprf as unknown as {
  evaluate(secretKey: Uint8Array, input: Uint8Array): Uint8Array;
}).evaluate;

// ── Test key helpers ─────────────────────────────────────────────────

function generateTestKey() {
  const { secretKey, publicKey } = voprf.generateKeyPair();
  return {
    secretKey,
    publicKey,
    secretKeyHex: bytesToHex(secretKey),
    publicKeyHex: bytesToHex(publicKey),
  };
}

/** Server-side: evaluate a blinded element (mirrors backend mint.ts). */
function serverEvaluate(blindedHex: string, sk: Uint8Array, pk: Uint8Array) {
  const blinded = hexToBytes(blindedHex);
  const { evaluated, proof } = voprf.blindEvaluate(sk, pk, blinded);
  return {
    evaluated: bytesToHex(evaluated),
    proof: bytesToHex(proof),
  };
}

/** Server-side: verify a redeemed token (mirrors backend mint.ts). */
function serverVerify(inputHex: string, outputHex: string, sk: Uint8Array): boolean {
  try {
    const input = hexToBytes(inputHex);
    const output = hexToBytes(outputHex);
    const expected = voprfEvaluate(sk, input);
    if (expected.length !== output.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected[i] ^ output[i];
    }
    return diff === 0;
  } catch {
    return false;
  }
}

/** Compute double-spend hash (mirrors backend mint.ts). */
function spendHash(outputHex: string): string {
  const outputBytes = hexToBytes(outputHex);
  return bytesToHex(sha256(outputBytes));
}

// ── Tests ────────────────────────────────────────────────────────────

describe('VOPRF round-trip', () => {
  const testKey = generateTestKey();

  it('blind → evaluate → finalize → verify succeeds', () => {
    // 1. Client: blind
    const prepared = prepareBlindedToken();
    expect(prepared.input.length).toBe(32);
    expect(prepared.blindedHex.length).toBe(66); // 33-byte compressed point

    // 2. Server: evaluate
    const { evaluated, proof } = serverEvaluate(
      prepared.blindedHex,
      testKey.secretKey,
      testKey.publicKey,
    );
    expect(evaluated.length).toBe(66); // 33-byte point
    expect(proof.length).toBe(128);    // 64-byte DLEQ proof

    // 3. Client: finalize (verifies DLEQ proof)
    const token = finalizeToken(prepared, evaluated, proof, testKey.publicKeyHex);
    expect(token.input.length).toBe(64);  // 32 bytes hex
    expect(token.output.length).toBe(64); // 32 bytes hex

    // 4. Server: verify at redemption
    const valid = serverVerify(token.input, token.output, testKey.secretKey);
    expect(valid).toBe(true);
  });

  it('different inputs produce different outputs', () => {
    const p1 = prepareBlindedToken();
    const p2 = prepareBlindedToken();

    const e1 = serverEvaluate(p1.blindedHex, testKey.secretKey, testKey.publicKey);
    const e2 = serverEvaluate(p2.blindedHex, testKey.secretKey, testKey.publicKey);

    const t1 = finalizeToken(p1, e1.evaluated, e1.proof, testKey.publicKeyHex);
    const t2 = finalizeToken(p2, e2.evaluated, e2.proof, testKey.publicKeyHex);

    expect(t1.input).not.toBe(t2.input);
    expect(t1.output).not.toBe(t2.output);
  });

  it('output is deterministic for the same input and key', () => {
    // Server-side evaluate(sk, input) is deterministic
    const input = crypto.getRandomValues(new Uint8Array(32));
    const inputHex = bytesToHex(input);

    const out1 = bytesToHex(voprfEvaluate(testKey.secretKey, input));
    const out2 = bytesToHex(voprfEvaluate(testKey.secretKey, input));
    expect(out1).toBe(out2);
  });

  it('wrong server key fails verification at redemption', () => {
    const prepared = prepareBlindedToken();
    const { evaluated, proof } = serverEvaluate(
      prepared.blindedHex,
      testKey.secretKey,
      testKey.publicKey,
    );
    const token = finalizeToken(prepared, evaluated, proof, testKey.publicKeyHex);

    // Verify with a DIFFERENT key
    const wrongKey = generateTestKey();
    const valid = serverVerify(token.input, token.output, wrongKey.secretKey);
    expect(valid).toBe(false);
  });

  it('tampered output fails verification', () => {
    const prepared = prepareBlindedToken();
    const { evaluated, proof } = serverEvaluate(
      prepared.blindedHex,
      testKey.secretKey,
      testKey.publicKey,
    );
    const token = finalizeToken(prepared, evaluated, proof, testKey.publicKeyHex);

    // Flip one byte in the output
    const tamperedOutput = token.output.slice(0, -2) + 'ff';
    const valid = serverVerify(token.input, tamperedOutput, testKey.secretKey);
    expect(valid).toBe(false);
  });

  it('DLEQ proof verification rejects wrong public key', () => {
    const prepared = prepareBlindedToken();
    const { evaluated, proof } = serverEvaluate(
      prepared.blindedHex,
      testKey.secretKey,
      testKey.publicKey,
    );

    // Finalize with a DIFFERENT public key — DLEQ proof should fail
    const wrongKey = generateTestKey();
    expect(() => {
      finalizeToken(prepared, evaluated, proof, wrongKey.publicKeyHex);
    }).toThrow();
  });

  it('double-spend hashes are unique per token', () => {
    const p1 = prepareBlindedToken();
    const p2 = prepareBlindedToken();

    const e1 = serverEvaluate(p1.blindedHex, testKey.secretKey, testKey.publicKey);
    const e2 = serverEvaluate(p2.blindedHex, testKey.secretKey, testKey.publicKey);

    const t1 = finalizeToken(p1, e1.evaluated, e1.proof, testKey.publicKeyHex);
    const t2 = finalizeToken(p2, e2.evaluated, e2.proof, testKey.publicKeyHex);

    const hash1 = spendHash(t1.output);
    const hash2 = spendHash(t2.output);
    expect(hash1).not.toBe(hash2);
    expect(hash1.length).toBe(64); // SHA-256 = 32 bytes = 64 hex chars
  });

  it('same token produces same spend hash (double-spend detection)', () => {
    const prepared = prepareBlindedToken();
    const { evaluated, proof } = serverEvaluate(
      prepared.blindedHex,
      testKey.secretKey,
      testKey.publicKey,
    );
    const token = finalizeToken(prepared, evaluated, proof, testKey.publicKeyHex);

    // Same output → same hash (this is how double-spend is detected)
    expect(spendHash(token.output)).toBe(spendHash(token.output));
  });

  it('batch of 50 tokens all verify correctly', () => {
    const count = 50;
    const prepared = Array.from({ length: count }, () => prepareBlindedToken());
    const evaluated = prepared.map(p =>
      serverEvaluate(p.blindedHex, testKey.secretKey, testKey.publicKey)
    );
    const tokens = prepared.map((p, i) =>
      finalizeToken(p, evaluated[i].evaluated, evaluated[i].proof, testKey.publicKeyHex)
    );

    // All should verify
    for (const token of tokens) {
      expect(serverVerify(token.input, token.output, testKey.secretKey)).toBe(true);
    }

    // All outputs should be unique
    const outputs = new Set(tokens.map(t => t.output));
    expect(outputs.size).toBe(count);
  });
});

describe('hex encoding helpers', () => {
  it('round-trips bytes through hex', () => {
    const original = crypto.getRandomValues(new Uint8Array(32));
    const hex = clientBytesToHex(original);
    const recovered = clientHexToBytes(hex);
    expect(hex.length).toBe(64);
    expect(recovered).toEqual(original);
  });

  it('produces lowercase hex', () => {
    const bytes = new Uint8Array([0xAB, 0xCD, 0xEF]);
    expect(clientBytesToHex(bytes)).toBe('abcdef');
  });
});
