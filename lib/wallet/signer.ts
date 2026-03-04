/**
 * Transaction signer — EVM transaction signing using @noble/secp256k1.
 *
 * Signs EIP-1559 (type 2) transactions for broadcast via eth_sendRawTransaction.
 * Private keys are zeroed immediately after use by the caller.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { CHAIN_CONFIGS, getChainConfig, type Chain } from './types';

// ── RLP encoding (minimal, tx-only) ──────────────────────────────────────

function rlpEncode(input: any): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length === 1 && input[0] < 0x80) return input;
    return concat([encodeLength(input.length, 0x80), input]);
  }
  if (Array.isArray(input)) {
    const encoded = concat(input.map(rlpEncode));
    return concat([encodeLength(encoded.length, 0xc0), encoded]);
  }
  if (typeof input === 'string') {
    return rlpEncode(hexToBytes(input));
  }
  throw new Error('Unsupported RLP input type');
}

function encodeLength(len: number, offset: number): Uint8Array {
  if (len < 56) return new Uint8Array([len + offset]);
  const lenBytes = intToBytes(len);
  return new Uint8Array([lenBytes.length + offset + 55, ...lenBytes]);
}

function intToBytes(n: number): Uint8Array {
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return new Uint8Array(bytes);
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length === 0) return new Uint8Array(0);
  const padded = h.length % 2 ? '0' + h : h;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function concat(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// ── Strip leading zeros for RLP ─────────────────────────────────────────

function stripZeros(hex: string): Uint8Array {
  const bytes = hexToBytes(hex);
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  return i > 0 ? bytes.slice(i) : bytes;
}

// ── EIP-1559 transaction signing ────────────────────────────────────────

export async function signTransaction(
  tx: {
    to: string;
    value?: string;
    data?: string;
    nonce?: string;
    gasLimit?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    gas?: string; // alias for gasLimit
  },
  privateKey: Uint8Array,
  chain: Chain,
  testnet: boolean = false,
): Promise<string> {
  const chainId = getChainConfig(chain, testnet).chainId;
  const chainIdNum = parseInt(chainId, 16);

  // Build EIP-1559 (type 2) transaction fields
  const fields = [
    stripZeros(chainId),                                         // chainId
    stripZeros(tx.nonce || '0x0'),                               // nonce
    stripZeros(tx.maxPriorityFeePerGas || '0x59682f00'),         // maxPriorityFeePerGas (~1.5 gwei)
    stripZeros(tx.maxFeePerGas || '0x2540be400'),                // maxFeePerGas (~10 gwei)
    stripZeros(tx.gasLimit || tx.gas || '0x5208'),               // gasLimit (21000 default)
    hexToBytes(tx.to),                                           // to
    stripZeros(tx.value || '0x0'),                               // value
    hexToBytes(tx.data || '0x'),                                 // data
    [],                                                          // accessList (empty)
  ];

  // RLP encode unsigned tx
  const unsignedTx = rlpEncode(fields);

  // Prepend type byte (0x02 = EIP-1559)
  const toSign = concat([new Uint8Array([0x02]), unsignedTx]);

  // Hash and sign
  const hash = keccak_256(toSign);
  const sig = secp256k1.sign(hash, privateKey);

  // Extract r, s, v (recovery id)
  const r = sig.r;
  const s = sig.s;
  const v = sig.recovery;

  // Build signed fields
  const rBytes = bigIntToBytes32(r);
  const sBytes = bigIntToBytes32(s);

  const signedFields = [
    ...fields,
    v === 0 ? new Uint8Array(0) : new Uint8Array([v]),          // yParity
    stripLeadingZeros(rBytes),                                   // r
    stripLeadingZeros(sBytes),                                   // s
  ];

  const signedTx = rlpEncode(signedFields);
  return bytesToHex(concat([new Uint8Array([0x02]), signedTx]));
}

function bigIntToBytes32(n: bigint): Uint8Array {
  const hex = n.toString(16).padStart(64, '0');
  return hexToBytes(hex);
}

function stripLeadingZeros(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  return i > 0 ? bytes.slice(i) : bytes;
}
