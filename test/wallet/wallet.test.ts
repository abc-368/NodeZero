/**
 * Wallet integration tests
 *
 * Tests EVM derivation, Bitcoin derivation (known test vectors),
 * chain config, and address format validation.
 */

import { describe, it, expect } from 'vitest';
import { deriveEthAccount, pubKeyToAddress } from '@/lib/wallet/hd';
import {
  deriveBtcSegwitAccount,
  deriveBtcTaprootAccount,
  deriveBtcAccount,
  formatSatoshis,
} from '@/lib/wallet/bitcoin';
import { CHAIN_CONFIGS, EVM_CHAINS, type Chain } from '@/lib/wallet/types';

// Known BIP-39 test mnemonic (DO NOT USE for real funds)
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// ── EVM derivation ──────────────────────────────────────────────────────

describe('EVM derivation', () => {
  it('same mnemonic produces same address across calls', () => {
    const a1 = deriveEthAccount(TEST_MNEMONIC, 0);
    const a2 = deriveEthAccount(TEST_MNEMONIC, 0);
    expect(a1.address).toBe(a2.address);
    a1.privateKey.fill(0);
    a2.privateKey.fill(0);
  });

  it('different indices produce different addresses', () => {
    const a0 = deriveEthAccount(TEST_MNEMONIC, 0);
    const a1 = deriveEthAccount(TEST_MNEMONIC, 1);
    expect(a0.address).not.toBe(a1.address);
    a0.privateKey.fill(0);
    a1.privateKey.fill(0);
  });

  it('addresses are checksummed hex', () => {
    const account = deriveEthAccount(TEST_MNEMONIC, 0);
    expect(account.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    account.privateKey.fill(0);
  });
});

// ── Bitcoin SegWit (BIP-84) ─────────────────────────────────────────────

describe('Bitcoin SegWit derivation (BIP-84)', () => {
  it('produces a bc1q address', () => {
    const account = deriveBtcSegwitAccount(TEST_MNEMONIC, 0);
    expect(account.address).toMatch(/^bc1q/);
    expect(account.addressType).toBe('segwit');
    expect(account.derivationPath).toBe("m/84'/0'/0'/0/0");
    account.privateKey.fill(0);
  });

  it('deterministic — same mnemonic + index = same address', () => {
    const a1 = deriveBtcSegwitAccount(TEST_MNEMONIC, 0);
    const a2 = deriveBtcSegwitAccount(TEST_MNEMONIC, 0);
    expect(a1.address).toBe(a2.address);
    expect(a1.privateKey).toEqual(a2.privateKey);
    a1.privateKey.fill(0);
    a2.privateKey.fill(0);
  });

  it('different index = different address', () => {
    const a0 = deriveBtcSegwitAccount(TEST_MNEMONIC, 0);
    const a1 = deriveBtcSegwitAccount(TEST_MNEMONIC, 1);
    expect(a0.address).not.toBe(a1.address);
    a0.privateKey.fill(0);
    a1.privateKey.fill(0);
  });

  it('private key is 32 bytes', () => {
    const account = deriveBtcSegwitAccount(TEST_MNEMONIC, 0);
    expect(account.privateKey.length).toBe(32);
    account.privateKey.fill(0);
  });

  // Known test vector for BIP-84 with the "abandon" mnemonic
  // Source: https://github.com/nicephil/bip84/blob/master/test/bip84.test.ts
  it('matches known BIP-84 test vector for index 0', () => {
    const account = deriveBtcSegwitAccount(TEST_MNEMONIC, 0);
    // The "abandon" mnemonic first SegWit address is well-known
    expect(account.address).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    account.privateKey.fill(0);
  });
});

// ── Bitcoin Taproot (BIP-86) ────────────────────────────────────────────

describe('Bitcoin Taproot derivation (BIP-86)', () => {
  it('produces a bc1p address', () => {
    const account = deriveBtcTaprootAccount(TEST_MNEMONIC, 0);
    expect(account.address).toMatch(/^bc1p/);
    expect(account.addressType).toBe('taproot');
    expect(account.derivationPath).toBe("m/86'/0'/0'/0/0");
    account.privateKey.fill(0);
  });

  it('deterministic — same mnemonic + index = same address', () => {
    const a1 = deriveBtcTaprootAccount(TEST_MNEMONIC, 0);
    const a2 = deriveBtcTaprootAccount(TEST_MNEMONIC, 0);
    expect(a1.address).toBe(a2.address);
    a1.privateKey.fill(0);
    a2.privateKey.fill(0);
  });

  it('different index = different address', () => {
    const a0 = deriveBtcTaprootAccount(TEST_MNEMONIC, 0);
    const a1 = deriveBtcTaprootAccount(TEST_MNEMONIC, 1);
    expect(a0.address).not.toBe(a1.address);
    a0.privateKey.fill(0);
    a1.privateKey.fill(0);
  });

  // Known BIP-86 test vector for the "abandon" mnemonic
  it('matches known BIP-86 test vector for index 0', () => {
    const account = deriveBtcTaprootAccount(TEST_MNEMONIC, 0);
    // Known Taproot address for this mnemonic at m/86'/0'/0'/0/0
    expect(account.address).toBe('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
    account.privateKey.fill(0);
  });
});

// ── deriveBtcAccount wrapper ────────────────────────────────────────────

describe('deriveBtcAccount', () => {
  it('defaults to segwit', () => {
    const account = deriveBtcAccount(TEST_MNEMONIC, 0);
    expect(account.addressType).toBe('segwit');
    expect(account.address).toMatch(/^bc1q/);
    account.privateKey.fill(0);
  });

  it('supports taproot via type parameter', () => {
    const account = deriveBtcAccount(TEST_MNEMONIC, 0, 'taproot');
    expect(account.addressType).toBe('taproot');
    expect(account.address).toMatch(/^bc1p/);
    account.privateKey.fill(0);
  });
});

// ── Chain configs ───────────────────────────────────────────────────────

describe('chain configs', () => {
  it('all EVM chains have valid hex chainId', () => {
    for (const chain of EVM_CHAINS) {
      const config = CHAIN_CONFIGS[chain];
      expect(config.chainId).toMatch(/^0x[0-9a-fA-F]+$/);
    }
  });

  it('bitcoin config has non-hex chainId', () => {
    expect(CHAIN_CONFIGS.bitcoin.chainId).toBe('bitcoin');
    expect(CHAIN_CONFIGS.bitcoin.symbol).toBe('BTC');
    expect(CHAIN_CONFIGS.bitcoin.decimals).toBe(8);
  });

  it('all chains have rpcUrl and explorerUrl', () => {
    for (const chain of [...EVM_CHAINS, 'bitcoin'] as Chain[]) {
      const config = CHAIN_CONFIGS[chain];
      expect(config.rpcUrl).toBeTruthy();
      expect(config.explorerUrl).toBeTruthy();
    }
  });
});

// ── formatSatoshis ──────────────────────────────────────────────────────

describe('formatSatoshis', () => {
  it('formats zero', () => {
    expect(formatSatoshis(0)).toBe('0');
  });

  it('formats whole BTC', () => {
    expect(formatSatoshis(100_000_000)).toBe('1');
  });

  it('formats fractional BTC', () => {
    expect(formatSatoshis(50_000_000)).toBe('0.5');
  });

  it('formats small amounts with precision', () => {
    expect(formatSatoshis(1000)).toBe('0.00001');
  });

  it('formats very small amounts', () => {
    const result = formatSatoshis(1);
    expect(result).toBe('0.00000001');
  });
});
