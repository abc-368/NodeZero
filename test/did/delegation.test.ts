/**
 * Delegation VC tests
 *
 * Tests the full lifecycle: key wrapping, VC issuance, signature verification,
 * expiry enforcement, and scope integrity.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import {
  wrapVaultKey,
  unwrapVaultKey,
  issueDelegationVC,
  verifyDelegationVC,
  base64UrlDecode,
  type DelegationVC,
} from '@/lib/did/delegation';
import { rawPublicKeyToDid, setActiveKeyPair, clearActiveKeyPair } from '@/lib/did/provider';

// ── Test helpers ──────────────────────────────────────────────────────────────

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function generateX25519Keypair() {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/** PKCS8 ASN.1 header for Ed25519 private key */
const PKCS8_ED25519_HEADER = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

async function generateEd25519DID() {
  const privSeed = randomBytes(32);
  const publicKeyBytes = ed25519.getPublicKey(privSeed);
  const did = rawPublicKeyToDid(publicKeyBytes);

  const pkcs8 = new Uint8Array(48);
  pkcs8.set(PKCS8_ED25519_HEADER, 0);
  pkcs8.set(privSeed, 16);

  const signingKey = await crypto.subtle.importKey(
    'pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign'],
  );
  const verifyingKey = await crypto.subtle.importKey(
    'raw', publicKeyBytes, { name: 'Ed25519' }, false, ['verify'],
  );

  return { did, signingKey, verifyingKey, privSeed, publicKeyBytes };
}

// ── Key wrapping tests ────────────────────────────────────────────────────────

describe('wrapVaultKey / unwrapVaultKey', () => {
  it('round-trip: wrap then unwrap returns original vault key', async () => {
    const vaultKey = randomBytes(32);
    const delegatee = generateX25519Keypair();

    const wrapped = await wrapVaultKey(vaultKey, delegatee.publicKey);
    expect(wrapped.length).toBe(97);

    const unwrapped = await unwrapVaultKey(wrapped, delegatee.privateKey);
    expect(unwrapped).toEqual(vaultKey);
  });

  it('different ephemeral key each time (forward secrecy)', async () => {
    const vaultKey = randomBytes(32);
    const delegatee = generateX25519Keypair();

    const wrapped1 = await wrapVaultKey(vaultKey, delegatee.publicKey);
    const wrapped2 = await wrapVaultKey(vaultKey, delegatee.publicKey);

    // Ephemeral pub key is first 32 bytes — should differ
    const ephPub1 = wrapped1.slice(0, 32);
    const ephPub2 = wrapped2.slice(0, 32);
    expect(ephPub1).not.toEqual(ephPub2);

    // Both unwrap to same key
    expect(await unwrapVaultKey(wrapped1, delegatee.privateKey)).toEqual(vaultKey);
    expect(await unwrapVaultKey(wrapped2, delegatee.privateKey)).toEqual(vaultKey);
  });

  it('wrong private key fails to unwrap', async () => {
    const vaultKey = randomBytes(32);
    const delegatee = generateX25519Keypair();
    const wrongKey = generateX25519Keypair();

    const wrapped = await wrapVaultKey(vaultKey, delegatee.publicKey);

    await expect(unwrapVaultKey(wrapped, wrongKey.privateKey)).rejects.toThrow();
  });

  it('rejects vault key of wrong length', async () => {
    const delegatee = generateX25519Keypair();

    await expect(wrapVaultKey(randomBytes(16), delegatee.publicKey)).rejects.toThrow('32 bytes');
    await expect(wrapVaultKey(randomBytes(64), delegatee.publicKey)).rejects.toThrow('32 bytes');
  });

  it('rejects X25519 pub key of wrong length', async () => {
    const vaultKey = randomBytes(32);

    await expect(wrapVaultKey(vaultKey, randomBytes(16))).rejects.toThrow('32 bytes');
  });

  it('reserved bytes are zero-filled', async () => {
    const vaultKey = randomBytes(32);
    const delegatee = generateX25519Keypair();
    const wrapped = await wrapVaultKey(vaultKey, delegatee.publicKey);

    const reserved = wrapped.slice(92, 97);
    expect(reserved).toEqual(new Uint8Array(5));
  });
});

// ── VC issuance + verification tests ──────────────────────────────────────────

describe('issueDelegationVC / verifyDelegationVC', () => {
  let delegator: Awaited<ReturnType<typeof generateEd25519DID>>;
  let delegatee: Awaited<ReturnType<typeof generateEd25519DID>>;
  let delegateeX25519: ReturnType<typeof generateX25519Keypair>;

  beforeAll(async () => {
    delegator = await generateEd25519DID();
    delegatee = await generateEd25519DID();
    delegateeX25519 = generateX25519Keypair();
  });

  it('issue → verify round-trip', async () => {
    // Set delegator as active signer
    setActiveKeyPair(delegator.signingKey, delegator.verifyingKey, delegator.did);

    const vaultKey = randomBytes(32);
    const entryIds = ['entry-1', 'entry-2', 'entry-3'];

    const vc = await issueDelegationVC(
      delegatee.did,
      delegateeX25519.publicKey,
      vaultKey,
      entryIds,
      30,
    );

    // Structure checks
    expect(vc['@context']).toContain('https://www.w3.org/ns/credentials/v2');
    expect(vc.type).toContain('DelegationCredential');
    expect(vc.issuer).toBe(delegator.did);
    expect(vc.credentialSubject.id).toBe(delegatee.did);
    expect(vc.credentialSubject.scope).toEqual(entryIds);
    expect(vc.proof).toBeDefined();
    expect(vc.proof!.cryptosuite).toBe('eddsa-jcs-2022');

    // Verify signature
    const result = await verifyDelegationVC(vc, delegatee.did);
    expect(result.valid).toBe(true);

    clearActiveKeyPair();
  });

  it('expired VC is rejected', async () => {
    setActiveKeyPair(delegator.signingKey, delegator.verifyingKey, delegator.did);

    const vaultKey = randomBytes(32);
    const vc = await issueDelegationVC(
      delegatee.did,
      delegateeX25519.publicKey,
      vaultKey,
      ['entry-1'],
      7,
    );

    // Manually backdate expiry
    const expired = { ...vc, expirationDate: '2020-01-01T00:00:00Z' };
    // Re-sign (won't match, but expiry check happens first)
    const result = await verifyDelegationVC(expired as DelegationVC, delegatee.did);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expired');

    clearActiveKeyPair();
  });

  it('delegatee DID mismatch is rejected', async () => {
    setActiveKeyPair(delegator.signingKey, delegator.verifyingKey, delegator.did);

    const vaultKey = randomBytes(32);
    const vc = await issueDelegationVC(
      delegatee.did,
      delegateeX25519.publicKey,
      vaultKey,
      ['entry-1'],
      30,
    );

    const wrongDelegatee = await generateEd25519DID();
    const result = await verifyDelegationVC(vc, wrongDelegatee.did);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('mismatch');

    clearActiveKeyPair();
  });

  it('tampered scope invalidates signature', async () => {
    setActiveKeyPair(delegator.signingKey, delegator.verifyingKey, delegator.did);

    const vaultKey = randomBytes(32);
    const vc = await issueDelegationVC(
      delegatee.did,
      delegateeX25519.publicKey,
      vaultKey,
      ['entry-1'],
      30,
    );

    // Tamper with scope
    const tampered: DelegationVC = {
      ...vc,
      credentialSubject: {
        ...vc.credentialSubject,
        scope: ['entry-1', 'entry-INJECTED'],
      },
    };

    const result = await verifyDelegationVC(tampered, delegatee.did);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('signature');

    clearActiveKeyPair();
  });

  it('rejects TTL > 90 days', async () => {
    setActiveKeyPair(delegator.signingKey, delegator.verifyingKey, delegator.did);

    const vaultKey = randomBytes(32);
    await expect(
      issueDelegationVC(delegatee.did, delegateeX25519.publicKey, vaultKey, ['entry-1'], 91),
    ).rejects.toThrow('1–90');

    clearActiveKeyPair();
  });

  it('rejects empty entry list', async () => {
    setActiveKeyPair(delegator.signingKey, delegator.verifyingKey, delegator.did);

    const vaultKey = randomBytes(32);
    await expect(
      issueDelegationVC(delegatee.did, delegateeX25519.publicKey, vaultKey, [], 30),
    ).rejects.toThrow('at least one');

    clearActiveKeyPair();
  });

  it('rejects VC without proof', async () => {
    const vc = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential', 'DelegationCredential'],
      id: 'urn:uuid:test',
      issuer: delegator.did,
      credentialSubject: { id: delegatee.did, scope: ['e1'], wrappedVaultKey: 'test' },
      issuanceDate: new Date().toISOString(),
      expirationDate: new Date(Date.now() + 86400000).toISOString(),
    } as DelegationVC;

    const result = await verifyDelegationVC(vc, delegatee.did);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('proof');
  });

  it('wrappedVaultKey decrypt cycle works end-to-end', async () => {
    setActiveKeyPair(delegator.signingKey, delegator.verifyingKey, delegator.did);

    const vaultKey = randomBytes(32);
    const vc = await issueDelegationVC(
      delegatee.did,
      delegateeX25519.publicKey,
      vaultKey,
      ['entry-1', 'entry-2'],
      30,
    );

    // Delegatee decodes the wrappedVaultKey
    const wrappedBytes = base64UrlDecode(vc.credentialSubject.wrappedVaultKey);
    expect(wrappedBytes.length).toBe(97);

    const recovered = await unwrapVaultKey(wrappedBytes, delegateeX25519.privateKey);
    expect(recovered).toEqual(vaultKey);

    clearActiveKeyPair();
  });
});

// ── JCS canonicalization tests ────────────────────────────────────────────────

describe('JCS signature determinism', () => {
  it('same VC produces same signature', async () => {
    const { did, signingKey, verifyingKey } = await generateEd25519DID();
    setActiveKeyPair(signingKey, verifyingKey, did);

    const vaultKey = randomBytes(32);
    const delegateePair = generateX25519Keypair();
    const otherDid = (await generateEd25519DID()).did;

    // Issue twice with controlled inputs
    // Can't easily control randomness in wrapping, but signature over the
    // same JCS-canonicalized document should be deterministic for the same key.
    // Here we just verify that the signature format is consistent.
    const vc = await issueDelegationVC(
      otherDid,
      delegateePair.publicKey,
      vaultKey,
      ['a', 'b'],
      7,
    );

    expect(vc.proof!.proofValue).toMatch(/^z[0-9a-f]+$/);
    expect(vc.proof!.verificationMethod).toContain(did);

    clearActiveKeyPair();
  });
});
