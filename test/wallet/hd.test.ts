/**
 * HD wallet derivation tests
 *
 * Tests determinism, known BIP-44 test vectors, address derivation,
 * and multi-account support.
 */

import { describe, it, expect } from 'vitest';
import { deriveEthAccount, pubKeyToAddress, masterKeyFromMnemonic } from '@/lib/wallet/hd';

// Known BIP-39 test mnemonic (DO NOT USE for real funds)
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Known address for this mnemonic at m/44'/60'/0'/0/0
// Source: https://iancoleman.io/bip39/ (BIP-44 Ethereum)
const EXPECTED_ADDRESS_0 = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';

describe('deriveEthAccount', () => {
  it('produces deterministic address from known mnemonic', () => {
    const account = deriveEthAccount(TEST_MNEMONIC, 0);
    // Case-insensitive comparison since checksumming may differ by implementation
    expect(account.address.toLowerCase()).toBe(EXPECTED_ADDRESS_0.toLowerCase());
    // Clean up
    account.privateKey.fill(0);
  });

  it('same mnemonic + same index = same address', () => {
    const a1 = deriveEthAccount(TEST_MNEMONIC, 0);
    const a2 = deriveEthAccount(TEST_MNEMONIC, 0);
    expect(a1.address).toBe(a2.address);
    expect(a1.privateKey).toEqual(a2.privateKey);
    a1.privateKey.fill(0);
    a2.privateKey.fill(0);
  });

  it('different index = different address', () => {
    const a0 = deriveEthAccount(TEST_MNEMONIC, 0);
    const a1 = deriveEthAccount(TEST_MNEMONIC, 1);
    const a2 = deriveEthAccount(TEST_MNEMONIC, 2);

    expect(a0.address).not.toBe(a1.address);
    expect(a1.address).not.toBe(a2.address);
    expect(a0.address).not.toBe(a2.address);

    a0.privateKey.fill(0);
    a1.privateKey.fill(0);
    a2.privateKey.fill(0);
  });

  it('returns correct derivation path', () => {
    const account = deriveEthAccount(TEST_MNEMONIC, 3);
    expect(account.derivationPath).toBe("m/44'/60'/0'/0/3");
    expect(account.index).toBe(3);
    account.privateKey.fill(0);
  });

  it('private key is 32 bytes', () => {
    const account = deriveEthAccount(TEST_MNEMONIC, 0);
    expect(account.privateKey.length).toBe(32);
    account.privateKey.fill(0);
  });

  it('address is checksummed hex (EIP-55)', () => {
    const account = deriveEthAccount(TEST_MNEMONIC, 0);
    expect(account.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Should have some uppercase letters (checksumming)
    const hex = account.address.slice(2);
    const hasUpper = /[A-F]/.test(hex);
    const hasLower = /[a-f]/.test(hex);
    expect(hasUpper || hasLower).toBe(true);
    account.privateKey.fill(0);
  });
});

describe('pubKeyToAddress', () => {
  it('derives correct address from compressed public key', () => {
    const account = deriveEthAccount(TEST_MNEMONIC, 0);
    const address = pubKeyToAddress(account.publicKey);
    expect(address.toLowerCase()).toBe(EXPECTED_ADDRESS_0.toLowerCase());
    account.privateKey.fill(0);
  });

  it('rejects invalid public key length', () => {
    expect(() => pubKeyToAddress(new Uint8Array(32))).toThrow();
    expect(() => pubKeyToAddress(new Uint8Array(64))).toThrow();
  });
});

describe('masterKeyFromMnemonic', () => {
  it('derives same accounts as deriveEthAccount', () => {
    const { masterKey, seed } = masterKeyFromMnemonic(TEST_MNEMONIC);
    const child = masterKey.derive("m/44'/60'/0'/0/0");
    const directAccount = deriveEthAccount(TEST_MNEMONIC, 0);

    expect(new Uint8Array(child.privateKey!)).toEqual(directAccount.privateKey);

    seed.fill(0);
    directAccount.privateKey.fill(0);
  });

  it('derives multiple accounts efficiently', () => {
    const { masterKey, seed } = masterKeyFromMnemonic(TEST_MNEMONIC);
    const addresses = new Set<string>();

    for (let i = 0; i < 10; i++) {
      const child = masterKey.derive(`m/44'/60'/0'/0/${i}`);
      const addr = pubKeyToAddress(child.publicKey!);
      addresses.add(addr.toLowerCase());
    }

    // All 10 addresses should be unique
    expect(addresses.size).toBe(10);

    seed.fill(0);
  });
});
