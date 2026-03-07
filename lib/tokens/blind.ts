/**
 * blind.ts — RSA blind signature math for NODE0 tokens (client-side)
 *
 * Implements Chaum's (1982) blinding/unblinding protocol using BigInt:
 *   - Generate random token T (32 bytes)
 *   - Generate random blinding factor r coprime to N
 *   - Blind:   T_blind = T · r^e mod N
 *   - Server signs: S_blind = T_blind^d mod N
 *   - Unblind: S = S_blind · r^(-1) mod N
 *   - Verify:  S^e mod N === T
 *
 * All arithmetic uses native BigInt (zero external dependencies).
 */

import type { MintPublicKeyJwk } from '@/lib/constants';

// ── BigInt math utilities ───────────────────────────────────────────

/** Modular exponentiation: base^exp mod mod (square-and-multiply). */
export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 1n) return 0n;
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) {
      result = (result * base) % mod;
    }
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

/** Extended GCD: returns [gcd, x, y] where ax + by = gcd(a, b). */
function extGcd(a: bigint, b: bigint): [bigint, bigint, bigint] {
  if (a === 0n) return [b, 0n, 1n];
  const [g, x, y] = extGcd(b % a, a);
  return [g, y - (b / a) * x, x];
}

/** Modular multiplicative inverse: a^(-1) mod m. Throws if not coprime. */
export function modInverse(a: bigint, m: bigint): bigint {
  const [g, x] = extGcd(((a % m) + m) % m, m);
  if (g !== 1n) throw new Error('No modular inverse exists (not coprime)');
  return ((x % m) + m) % m;
}

/** GCD of two BigInts. */
export function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b > 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

/** Convert Uint8Array to BigInt (big-endian unsigned). */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

/** Convert BigInt to Uint8Array of fixed length (big-endian, zero-padded). */
export function bigIntToBytes(n: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let val = n;
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = Number(val & 0xFFn);
    val >>= 8n;
  }
  return bytes;
}

/** Decode base64url string to BigInt. */
function base64urlToBigInt(b64url: string): bigint {
  const base64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytesToBigInt(bytes);
}

/** Encode Uint8Array to base64url string. */
export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode base64url to Uint8Array. */
export function base64urlToBytes(b64url: string): Uint8Array {
  const base64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ── Mint public key parsing ─────────────────────────────────────────

/** RSA modulus byte length (256 for RSA-2048). */
const RSA_MODULUS_BYTES = 256;

export interface MintPublicKey {
  e: bigint;
  N: bigint;
}

/** Parse the mint public key JWK into BigInt components. */
export function parseMintPublicKey(jwk: MintPublicKeyJwk): MintPublicKey {
  return {
    N: base64urlToBigInt(jwk.n),
    e: base64urlToBigInt(jwk.e),
  };
}

// ── Blinding / unblinding ───────────────────────────────────────────

/**
 * Generate a random blinding factor r that is coprime to N.
 * r must be in range [2, N-1] and gcd(r, N) === 1.
 */
export function generateBlindingFactor(N: bigint): bigint {
  for (let attempt = 0; attempt < 100; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(RSA_MODULUS_BYTES));
    const r = bytesToBigInt(bytes) % (N - 2n) + 2n; // range [2, N-1]
    if (gcd(r, N) === 1n) return r;
  }
  throw new Error('Failed to generate coprime blinding factor after 100 attempts');
}

/**
 * Blind a token value: T_blind = T · r^e mod N
 */
export function blindToken(
  T: bigint,
  r: bigint,
  e: bigint,
  N: bigint,
): bigint {
  const rE = modPow(r, e, N);
  return (T * rE) % N;
}

/**
 * Unblind a server response: S = S_blind · r^(-1) mod N
 */
export function unblindSignature(
  S_blind: bigint,
  r: bigint,
  N: bigint,
): bigint {
  const rInv = modInverse(r, N);
  return (S_blind * rInv) % N;
}

/**
 * Verify a blind signature: S^e mod N === T
 */
export function verifyBlindSignature(
  T: bigint,
  S: bigint,
  e: bigint,
  N: bigint,
): boolean {
  const recovered = modPow(S, e, N);
  return recovered === T;
}

// ── High-level helpers ──────────────────────────────────────────────

export interface PreparedBlindToken {
  tokenBytes: Uint8Array;       // 32-byte random T
  blindingFactor: bigint;       // r
  blindedBytes: Uint8Array;     // T_blind as RSA_MODULUS_BYTES bytes
}

/**
 * Generate a random 32-byte token, blind it for the mint.
 * Returns all components needed for unblinding after the server responds.
 */
export function prepareBlindedToken(mintPubKey: MintPublicKey): PreparedBlindToken {
  // Random 32-byte token (much smaller than N — valid element of Z_N)
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const T = bytesToBigInt(tokenBytes);

  // Generate blinding factor
  const r = generateBlindingFactor(mintPubKey.N);

  // Blind: T_blind = T · r^e mod N
  const T_blind = blindToken(T, r, mintPubKey.e, mintPubKey.N);
  const blindedBytes = bigIntToBytes(T_blind, RSA_MODULUS_BYTES);

  return { tokenBytes, blindingFactor: r, blindedBytes };
}

/**
 * Receive the server's blind signature, unblind it, verify, and return
 * the final storable {token, signature} pair as base64url strings.
 *
 * Throws if verification fails (server returned invalid signature).
 */
export function finalizeToken(
  S_blind_bytes: Uint8Array,
  blindingFactor: bigint,
  tokenBytes: Uint8Array,
  mintPubKey: MintPublicKey,
): { token: string; signature: string } {
  const S_blind = bytesToBigInt(S_blind_bytes);
  const T = bytesToBigInt(tokenBytes);

  // Unblind: S = S_blind · r^(-1) mod N
  const S = unblindSignature(S_blind, blindingFactor, mintPubKey.N);

  // Verify: S^e mod N === T
  if (!verifyBlindSignature(T, S, mintPubKey.e, mintPubKey.N)) {
    throw new Error('Blind signature verification failed — mint returned invalid signature');
  }

  // Encode for storage
  return {
    token: bytesToBase64url(tokenBytes),
    signature: bytesToBase64url(bigIntToBytes(S, RSA_MODULUS_BYTES)),
  };
}
