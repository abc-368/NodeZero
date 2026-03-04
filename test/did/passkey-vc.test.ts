/**
 * Passkey VC tests
 *
 * Tests passkey VC issuance, JCS canonicalization consistency,
 * SHA-256 hashing, and export format.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  issuePasskeyVC,
  hashPasskeyVC,
  exportPasskeyVCAsJSON,
  type PasskeyVC,
} from '@/lib/did/passkey-vc';
import type { PasskeyFields } from '@/lib/vault/entry';
import {
  createEntry,
  getEncryptableFields,
  mergeDecryptedFields,
} from '@/lib/vault/entry';
import { rawPublicKeyToDid, setActiveKeyPair, clearActiveKeyPair } from '@/lib/did/provider';

// ── Test helpers ──────────────────────────────────────────────────────────────

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

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

  return { did, signingKey, verifyingKey };
}

function base64UrlEncode(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeTestPasskey(): PasskeyFields {
  return {
    credentialId: base64UrlEncode(randomBytes(32)),
    publicKey: base64UrlEncode(randomBytes(65)),
    publicKeyAlgorithm: -7,
    rpId: 'github.com',
    rpName: 'GitHub',
    transports: ['internal', 'hybrid'],
    aaguid: '00112233445566778899aabbccddeeff',
    signCount: 0,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Passkey VC', () => {
  let issuerDid: string;

  beforeAll(async () => {
    const issuer = await generateEd25519DID();
    issuerDid = issuer.did;
    setActiveKeyPair(issuer.signingKey, issuer.verifyingKey, issuer.did);
  });

  afterAll(() => {
    clearActiveKeyPair();
  });

  describe('issuePasskeyVC', () => {
    it('should issue a valid PasskeyCredential VC', async () => {
      const passkey = makeTestPasskey();
      const vc = await issuePasskeyVC(passkey, 'https://github.com');

      expect(vc['@context']).toContain('https://www.w3.org/ns/credentials/v2');
      expect(vc['@context']).toContain('https://nodezero.app/ns/passkey/v1');
      expect(vc.type).toContain('VerifiableCredential');
      expect(vc.type).toContain('PasskeyCredential');
      expect(vc.issuer).toBe(issuerDid);
      expect(vc.credentialSubject.id).toBe(issuerDid);
      expect(vc.id).toMatch(/^urn:uuid:/);
    });

    it('should include relying party info', async () => {
      const passkey = makeTestPasskey();
      const vc = await issuePasskeyVC(passkey);

      expect(vc.credentialSubject.relyingParty.id).toBe('github.com');
      expect(vc.credentialSubject.relyingParty.name).toBe('GitHub');
    });

    it('should include origin when provided', async () => {
      const passkey = makeTestPasskey();
      const vc = await issuePasskeyVC(passkey, 'https://github.com');

      expect(vc.credentialSubject.relyingParty.origin).toBe('https://github.com');
    });

    it('should omit origin when not provided', async () => {
      const passkey = makeTestPasskey();
      const vc = await issuePasskeyVC(passkey);

      expect(vc.credentialSubject.relyingParty.origin).toBeUndefined();
    });

    it('should include credential metadata', async () => {
      const passkey = makeTestPasskey();
      const vc = await issuePasskeyVC(passkey);

      const cred = vc.credentialSubject.credential;
      expect(cred.credentialId).toBe(passkey.credentialId);
      expect(cred.publicKey).toBe(passkey.publicKey);
      expect(cred.publicKeyAlgorithm).toBe(-7);
      expect(cred.transports).toEqual(['internal', 'hybrid']);
      expect(cred.aaguid).toBe('00112233445566778899aabbccddeeff');
    });

    it('should include eddsa-jcs-2022 proof', async () => {
      const passkey = makeTestPasskey();
      const vc = await issuePasskeyVC(passkey);

      expect(vc.proof).toBeDefined();
      expect(vc.proof!.type).toBe('DataIntegrityProof');
      expect(vc.proof!.cryptosuite).toBe('eddsa-jcs-2022');
      expect(vc.proof!.proofPurpose).toBe('assertionMethod');
      expect(vc.proof!.proofValue).toMatch(/^z[0-9a-f]+$/);
      expect(vc.proof!.verificationMethod).toContain(issuerDid);
    });

    it('should have valid issuance date', async () => {
      const before = new Date();
      const passkey = makeTestPasskey();
      const vc = await issuePasskeyVC(passkey);
      const after = new Date();

      const issued = new Date(vc.issuanceDate);
      expect(issued.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
      expect(issued.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
    });

    it('should throw if vault is locked', async () => {
      clearActiveKeyPair();
      const passkey = makeTestPasskey();

      await expect(issuePasskeyVC(passkey)).rejects.toThrow('Unlock vault');

      // Restore for subsequent tests
      const issuer = await generateEd25519DID();
      issuerDid = issuer.did;
      setActiveKeyPair(issuer.signingKey, issuer.verifyingKey, issuer.did);
    });
  });

  describe('hashPasskeyVC', () => {
    it('should produce a 64-char hex SHA-256 hash', async () => {
      const passkey = makeTestPasskey();
      const vc = await issuePasskeyVC(passkey);
      const hash = await hashPasskeyVC(vc);

      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce deterministic hash for same VC', async () => {
      const passkey = makeTestPasskey();
      const vc = await issuePasskeyVC(passkey);

      const hash1 = await hashPasskeyVC(vc);
      const hash2 = await hashPasskeyVC(vc);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hash for different VCs', async () => {
      const vc1 = await issuePasskeyVC(makeTestPasskey());
      const vc2 = await issuePasskeyVC(makeTestPasskey());

      const hash1 = await hashPasskeyVC(vc1);
      const hash2 = await hashPasskeyVC(vc2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('exportPasskeyVCAsJSON', () => {
    it('should export valid JSON', async () => {
      const passkey = makeTestPasskey();
      const vc = await issuePasskeyVC(passkey);
      const json = exportPasskeyVCAsJSON(vc);

      const parsed = JSON.parse(json);
      expect(parsed['@context']).toBeDefined();
      expect(parsed.type).toContain('PasskeyCredential');
      expect(parsed.proof).toBeDefined();
    });

    it('should be pretty-printed', async () => {
      const passkey = makeTestPasskey();
      const vc = await issuePasskeyVC(passkey);
      const json = exportPasskeyVCAsJSON(vc);

      expect(json).toContain('\n');
      expect(json).toContain('  ');
    });
  });

  describe('entry type integration', () => {
    it('should accept passkey as a valid EntryType', () => {
      const entry = createEntry({ type: 'passkey' });
      expect(entry.type).toBe('passkey');
    });

    it('should serialize PasskeyFields to passkeyJson', () => {
      const passkey = makeTestPasskey();
      const entry = createEntry({ type: 'passkey', passkey });
      const fields = getEncryptableFields(entry);

      expect(fields.passkeyJson).toBeDefined();
      const parsed = JSON.parse(fields.passkeyJson);
      expect(parsed.rpId).toBe('github.com');
      expect(parsed.credentialId).toBe(passkey.credentialId);
    });

    it('should deserialize passkeyJson back to PasskeyFields', () => {
      const passkey = makeTestPasskey();
      const stub = {
        id: 'test-id',
        type: 'passkey' as const,
        title: 'GitHub',
        url: 'https://github.com',
        tags: ['passkey'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        enc: {},
      };
      const decrypted = {
        username: '',
        password: '',
        notes: '',
        passkeyJson: JSON.stringify(passkey),
      };

      const entry = mergeDecryptedFields(stub, decrypted);
      expect(entry.passkey).toBeDefined();
      expect(entry.passkey!.rpId).toBe('github.com');
      expect(entry.passkey!.rpName).toBe('GitHub');
      expect(entry.passkey!.publicKeyAlgorithm).toBe(-7);
    });

    it('should handle missing passkeyJson gracefully', () => {
      const stub = {
        id: 'test-id',
        type: 'login' as const,
        title: 'Test',
        url: 'https://test.com',
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        enc: {},
      };
      const decrypted = { username: 'user', password: 'pass', notes: '' };

      const entry = mergeDecryptedFields(stub, decrypted);
      expect(entry.passkey).toBeUndefined();
    });
  });
});
