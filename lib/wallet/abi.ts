/**
 * Minimal ABI encoding/decoding for Uniswap contract calls.
 *
 * Supports static types (address, uint, int, bool) and dynamic types
 * (bytes, bytes[]) needed for v3 SwapRouter02 and v4 UniversalRouter encoding.
 */

import { keccak_256 } from '@noble/hashes/sha3';

// ── Hex/Bytes ─────────────────────────────────────────────────────

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length === 0) return new Uint8Array(0);
  const padded = h.length % 2 ? '0' + h : h;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.substr(i * 2, 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Strip 0x prefix if present */
function strip0x(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}

// ── Function selector ─────────────────────────────────────────────

/** Compute 4-byte function selector: keccak256(signature)[0:4] */
export function fnSelector(sig: string): string {
  const hash = keccak_256(new TextEncoder().encode(sig));
  return bytesToHex(hash.slice(0, 4));
}

// ── Static type encoding (each returns 64-char hex string, no 0x) ─

/** Encode address → 32 bytes left-padded */
export function encodeAddress(addr: string): string {
  return strip0x(addr).toLowerCase().padStart(64, '0');
}

/** Encode unsigned int (any width) → 32 bytes left-padded */
export function encodeUint(value: bigint | number | string): string {
  const n = typeof value === 'bigint' ? value : BigInt(value);
  return n.toString(16).padStart(64, '0');
}

/** Encode signed int (any width) → 32 bytes, two's complement */
export function encodeInt(value: bigint | number): string {
  const n = BigInt(value);
  if (n >= 0n) return n.toString(16).padStart(64, '0');
  // Two's complement: (2^256 + n)
  return ((1n << 256n) + n).toString(16).padStart(64, '0');
}

/** Encode bool → 32 bytes */
export function encodeBool(value: boolean): string {
  return (value ? '1' : '0').padStart(64, '0');
}

// ── Dynamic type encoding ─────────────────────────────────────────

/**
 * Encode `bytes` value: length (32 bytes) + data right-padded to 32-byte boundary.
 * Returns hex string (no 0x). Input is raw hex (no 0x).
 */
export function encodeDynBytes(hex: string): string {
  const h = strip0x(hex);
  const byteLen = h.length / 2;
  const paddedDataLen = Math.ceil(byteLen / 32) * 64; // hex chars
  const padded = h.padEnd(paddedDataLen, '0');
  return encodeUint(BigInt(byteLen)) + padded;
}

/**
 * Encode `bytes[]` array: length + offsets + elements.
 * Each item is a hex string of raw bytes (no 0x).
 * Returns hex string (no 0x).
 */
export function encodeDynBytesArray(items: string[]): string {
  const n = items.length;
  // Encode each item as dynamic bytes (length + padded data)
  const encodedItems = items.map(item => encodeDynBytes(strip0x(item)));

  // Calculate offsets (relative to start of content area = right after length word)
  // Content area contains: N offset words, then element data
  let currentOffset = n * 32; // skip past all offset words (in bytes)
  const offsets: string[] = [];
  for (const encoded of encodedItems) {
    offsets.push(encodeUint(BigInt(currentOffset)));
    currentOffset += encoded.length / 2; // add encoded size in bytes
  }

  return encodeUint(BigInt(n)) + offsets.join('') + encodedItems.join('');
}

// ── Tuple encoding with mixed static/dynamic types ────────────────

export interface TuplePart {
  /** true = dynamic type (bytes, string, T[], tuple with dynamic members) */
  dynamic: boolean;
  /**
   * Hex data (no 0x):
   * - Static: exactly 64 chars (32 bytes), encoded in-place
   * - Dynamic: variable length, placed in tail with offset in head
   */
  data: string;
}

/**
 * Encode a tuple with mixed static and dynamic members.
 * Static members are placed in the head (32 bytes each).
 * Dynamic members get an offset word in the head; data in the tail.
 * Returns hex string (no 0x).
 */
export function encodeTuple(parts: TuplePart[]): string {
  const headWords = parts.length;
  const headBytes = headWords * 32;
  let tailOffset = headBytes; // first dynamic data starts right after head

  let head = '';
  let tail = '';

  for (const part of parts) {
    if (!part.dynamic) {
      head += part.data;
    } else {
      head += encodeUint(BigInt(tailOffset));
      tail += part.data;
      tailOffset += part.data.length / 2; // bytes
    }
  }

  return head + tail;
}

// ── ABI decoding ──────────────────────────────────────────────────

/** Decode uint256 from hex return data at 32-byte slot index */
export function decodeUint(data: string, slotIndex: number = 0): bigint {
  const hex = strip0x(data);
  const start = slotIndex * 64;
  const chunk = hex.slice(start, start + 64);
  if (!chunk || chunk.length === 0) return 0n;
  return BigInt('0x' + chunk);
}

// ── Convenience ───────────────────────────────────────────────────

/** Build eth_call data: selector(sig) + encoded params joined */
export function encodeFunctionCall(sig: string, params: string[]): string {
  return fnSelector(sig) + params.join('');
}
