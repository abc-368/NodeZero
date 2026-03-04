/**
 * bitcoin.ts — Bitcoin address derivation
 *
 * Derives SegWit (bc1q, BIP-84) and Taproot (bc1p, BIP-86) addresses
 * from a BIP-39 mnemonic using @scure/btc-signer and @scure/bip32.
 *
 * Key paths:
 *   SegWit:  m/84'/0'/0'/0/{index}
 *   Taproot: m/86'/0'/0'/0/{index}
 */

import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { p2wpkh, p2tr } from '@scure/btc-signer';
import { hex } from '@scure/base';

// ── Types ─────────────────────────────────────────────────────────────────

export type BtcAddressType = 'segwit' | 'taproot';

export interface BtcAccount {
  privateKey: Uint8Array;   // 32 bytes — caller must zero after use
  publicKey: Uint8Array;    // 33 bytes (compressed)
  address: string;          // bc1q... (segwit) or bc1p... (taproot)
  addressType: BtcAddressType;
  index: number;
  derivationPath: string;
}

// ── Derivation ────────────────────────────────────────────────────────────

const SEGWIT_BASE = "m/84'/0'/0'/0";
const TAPROOT_BASE = "m/86'/0'/0'/0";

/**
 * Derive a Bitcoin SegWit (bc1q) address from a BIP-39 mnemonic.
 * BIP-84: m/84'/0'/0'/0/{index}
 */
export function deriveBtcSegwitAccount(mnemonic: string, index: number = 0): BtcAccount {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const masterKey = HDKey.fromMasterSeed(seed);
  const derivationPath = `${SEGWIT_BASE}/${index}`;
  const child = masterKey.derive(derivationPath);

  if (!child.privateKey || !child.publicKey) {
    throw new Error('Failed to derive Bitcoin key');
  }

  const payment = p2wpkh(child.publicKey);

  // Zero the seed
  seed.fill(0);

  return {
    privateKey: new Uint8Array(child.privateKey),
    publicKey: new Uint8Array(child.publicKey),
    address: payment.address!,
    addressType: 'segwit',
    index,
    derivationPath,
  };
}

/**
 * Derive a Bitcoin Taproot (bc1p) address from a BIP-39 mnemonic.
 * BIP-86: m/86'/0'/0'/0/{index}
 */
export function deriveBtcTaprootAccount(mnemonic: string, index: number = 0): BtcAccount {
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const masterKey = HDKey.fromMasterSeed(seed);
  const derivationPath = `${TAPROOT_BASE}/${index}`;
  const child = masterKey.derive(derivationPath);

  if (!child.privateKey || !child.publicKey) {
    throw new Error('Failed to derive Bitcoin key');
  }

  // p2tr takes the x-only public key (32 bytes, strip the prefix)
  const xOnlyPub = child.publicKey.slice(1);
  const payment = p2tr(xOnlyPub);

  // Zero the seed
  seed.fill(0);

  return {
    privateKey: new Uint8Array(child.privateKey),
    publicKey: new Uint8Array(child.publicKey),
    address: payment.address!,
    addressType: 'taproot',
    index,
    derivationPath,
  };
}

/**
 * Derive a Bitcoin account (either SegWit or Taproot) from a mnemonic.
 */
/**
 * Derive a Bitcoin account (either SegWit or Taproot) from a mnemonic.
 */
export function deriveBtcAccount(
  mnemonic: string,
  index: number = 0,
  type: BtcAddressType = 'segwit',
): BtcAccount {
  return type === 'taproot'
    ? deriveBtcTaprootAccount(mnemonic, index)
    : deriveBtcSegwitAccount(mnemonic, index);
}

// ── Balance & Transaction History (Blockstream API) ───────────────────────

const BLOCKSTREAM_API = 'https://blockstream.info/api';

export interface BtcBalanceInfo {
  confirmed: number;   // satoshis
  unconfirmed: number;  // satoshis
  total: number;        // satoshis
  btc: string;          // formatted BTC string
}

/**
 * Fetch Bitcoin balance for an address via Blockstream API (free, no key).
 */
export async function fetchBtcBalance(address: string): Promise<BtcBalanceInfo> {
  const resp = await fetch(`${BLOCKSTREAM_API}/address/${address}`);
  if (!resp.ok) throw new Error(`Blockstream API error: ${resp.status}`);

  const data = await resp.json() as {
    chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
    mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
  };

  const confirmed = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
  const unconfirmed = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;
  const total = confirmed + unconfirmed;

  return {
    confirmed,
    unconfirmed,
    total,
    btc: formatSatoshis(total),
  };
}

export interface BtcTxItem {
  txid: string;
  status: { confirmed: boolean; block_time?: number };
  vin: Array<{ prevout?: { scriptpubkey_address?: string; value?: number } }>;
  vout: Array<{ scriptpubkey_address?: string; value?: number }>;
}

/**
 * Fetch recent Bitcoin transactions for an address via Blockstream API.
 * Returns the last 10 transactions.
 */
export async function fetchBtcTxHistory(address: string): Promise<BtcTxItem[]> {
  const resp = await fetch(`${BLOCKSTREAM_API}/address/${address}/txs`);
  if (!resp.ok) return [];
  const txs = await resp.json() as BtcTxItem[];
  return txs.slice(0, 10);
}

/**
 * Format satoshis to BTC string with appropriate precision.
 */
export function formatSatoshis(sats: number): string {
  if (sats === 0) return '0';
  const btc = sats / 1e8;
  if (btc < 0.0001) return btc.toFixed(8).replace(/0+$/, '');
  if (btc < 1) return btc.toFixed(6).replace(/0+$/, '');
  return btc.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}
