/**
 * hd.ts — Hierarchical Deterministic wallet derivation
 *
 * Derives Ethereum accounts from BIP-39 mnemonic using BIP-44 paths.
 * Uses @scure/bip32 (audited, same ecosystem as bip39).
 *
 * Key paths:
 *   Ethereum: m/44'/60'/0'/0/{index}
 *   Bitcoin SegWit: m/84'/0'/0'/0/{index}   (see bitcoin.ts)
 *   Bitcoin Taproot: m/86'/0'/0'/0/{index}   (see bitcoin.ts)
 */

import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { keccak_256 } from '@noble/hashes/sha3';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EthAccount {
  privateKey: Uint8Array;   // 32 bytes — caller must zero after use
  publicKey: Uint8Array;    // 65 bytes (uncompressed) or 33 bytes (compressed)
  address: string;          // checksummed hex (EIP-55)
  index: number;
  derivationPath: string;
}

// ── Derivation ────────────────────────────────────────────────────────────────

const ETH_BASE_PATH = "m/44'/60'/0'/0";

/**
 * Derive an Ethereum account from a BIP-39 mnemonic.
 *
 * @param mnemonic - BIP-39 mnemonic phrase
 * @param index    - Account index (default 0)
 */
export function deriveEthAccount(mnemonic: string, index: number = 0): EthAccount {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const masterKey = HDKey.fromMasterSeed(seed);
  const derivationPath = `${ETH_BASE_PATH}/${index}`;
  const child = masterKey.derive(derivationPath);

  if (!child.privateKey) throw new Error('Failed to derive private key');

  // Get uncompressed public key (65 bytes: 0x04 || x || y)
  // secp256k1 public key from @scure/bip32 is compressed (33 bytes)
  // We need uncompressed for keccak256 address derivation
  const pubKey = child.publicKey!;

  // Derive address from compressed public key
  const address = pubKeyToAddress(pubKey);

  // Zero the seed
  seed.fill(0);

  return {
    privateKey: new Uint8Array(child.privateKey),
    publicKey: pubKey,
    address,
    index,
    derivationPath,
  };
}

/**
 * Derive an HD master key from mnemonic (for multiple derivation paths).
 * Caller should zero the seed bytes after use.
 */
export function masterKeyFromMnemonic(mnemonic: string): { masterKey: HDKey; seed: Uint8Array } {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const masterKey = HDKey.fromMasterSeed(seed);
  return { masterKey, seed };
}

/**
 * Derive Ethereum address from a compressed secp256k1 public key (33 bytes).
 * address = keccak256(uncompressed_pubkey_sans_prefix)[12:]
 *
 * Since @scure/bip32 gives us compressed keys, we need to decompress first.
 */
export function pubKeyToAddress(compressedPubKey: Uint8Array): string {
  // Decompress the public key using secp256k1 curve math
  const uncompressed = decompressPublicKey(compressedPubKey);

  // keccak256 of the uncompressed key without the 0x04 prefix
  const hash = keccak_256(uncompressed.slice(1));

  // Last 20 bytes
  const addressBytes = hash.slice(12);

  // Convert to hex and apply EIP-55 checksum
  return toChecksumAddress(addressBytes);
}

/**
 * Decompress a secp256k1 compressed public key (33 bytes → 65 bytes).
 * Uses curve equation: y² = x³ + 7 (mod p)
 */
function decompressPublicKey(compressed: Uint8Array): Uint8Array {
  if (compressed.length !== 33) throw new Error('Invalid compressed public key length');

  const prefix = compressed[0];
  if (prefix !== 0x02 && prefix !== 0x03) throw new Error('Invalid public key prefix');

  // secp256k1 curve parameter p
  const p = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F');

  // Extract x coordinate
  const x = bytesToBigInt(compressed.slice(1));

  // y² = x³ + 7 mod p
  const y2 = (modPow(x, 3n, p) + 7n) % p;
  let y = modPow(y2, (p + 1n) / 4n, p);

  // Ensure correct parity
  const isOdd = y % 2n === 1n;
  const shouldBeOdd = prefix === 0x03;
  if (isOdd !== shouldBeOdd) y = p - y;

  const result = new Uint8Array(65);
  result[0] = 0x04;
  result.set(bigIntToBytes(x, 32), 1);
  result.set(bigIntToBytes(y, 32), 33);
  return result;
}

// ── EIP-55 checksum ───────────────────────────────────────────────────────────

function toChecksumAddress(addressBytes: Uint8Array): string {
  const hex = Array.from(addressBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = Array.from(keccak_256(new TextEncoder().encode(hex)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  let checksummed = '0x';
  for (let i = 0; i < 40; i++) {
    const c = hex[i];
    checksummed += parseInt(hashHex[i], 16) >= 8 ? c.toUpperCase() : c;
  }
  return checksummed;
}

// ── BigInt helpers ─────────────────────────────────────────────────────────────

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const b of bytes) result = (result << 8n) | BigInt(b);
  return result;
}

function bigIntToBytes(n: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}
