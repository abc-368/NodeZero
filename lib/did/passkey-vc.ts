/**
 * Passkey Verifiable Credentials — Phase 3 Implementation
 *
 * Wraps WebAuthn registration responses in W3C VCs signed with eddsa-jcs-2022.
 * The VC is a verifiable metadata record proving the user owns a passkey for
 * a given relying party. The private key stays in the authenticator's secure
 * hardware — only public metadata is captured.
 *
 * Reuses JCS canonicalization and Ed25519 signing from delegation.ts.
 *
 * @see CLAUDE.md §8 for full design rationale
 */

import { getActiveDid, signBundle } from '@/lib/did/provider';
import { bufferToHex } from '@/lib/crypto/field-encrypt';
import type { PasskeyFields } from '@/lib/vault/entry';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PasskeyVC {
  '@context': string[];
  type: string[];
  id: string;
  issuer: string;
  credentialSubject: {
    id: string;
    relyingParty: {
      id: string;
      name: string;
      origin?: string;
    };
    credential: {
      credentialId: string;
      publicKey: string;
      publicKeyAlgorithm: number;
      transports?: string[];
      aaguid?: string;
      signCount?: number;
      createdAt: string;
    };
  };
  issuanceDate: string;
  expirationDate?: string;
  proof?: PasskeyVCProof;
}

export interface PasskeyVCProof {
  type: 'DataIntegrityProof';
  cryptosuite: 'eddsa-jcs-2022';
  verificationMethod: string;
  proofPurpose: 'assertionMethod';
  proofValue: string;
}

// ── JCS canonicalization (RFC 8785) ───────────────────────────────────────────
// Duplicated from delegation.ts to avoid circular dependency.
// Both are leaf modules; extracting to a shared util would be premature.

function jcsCanonical(obj: any): string {
  if (obj === null || typeof obj === 'boolean') return JSON.stringify(obj);
  if (typeof obj === 'number') {
    if (!isFinite(obj)) throw new Error('JCS: non-finite numbers not allowed');
    return Object.is(obj, -0) ? '0' : JSON.stringify(obj);
  }
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(jcsCanonical).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    const pairs = keys
      .filter(k => obj[k] !== undefined)
      .map(k => JSON.stringify(k) + ':' + jcsCanonical(obj[k]));
    return '{' + pairs.join(',') + '}';
  }
  throw new Error(`JCS: unsupported type ${typeof obj}`);
}

// ── VC issuance ───────────────────────────────────────────────────────────────

/**
 * Issue a PasskeyCredential VC from a WebAuthn registration response.
 *
 * The VC is self-issued (issuer === holder) and signed with the user's
 * Ed25519 DID key using eddsa-jcs-2022.
 *
 * @param passkey - Passkey fields captured from navigator.credentials.create()
 * @param origin  - The origin URL where the passkey was registered (optional)
 */
export async function issuePasskeyVC(
  passkey: PasskeyFields,
  origin?: string,
): Promise<PasskeyVC> {
  const issuerDid = getActiveDid();
  if (!issuerDid) throw new Error('Unlock vault to issue passkey VC');

  const now = new Date();

  const vc: PasskeyVC = {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://nodezero.app/ns/passkey/v1',
    ],
    type: ['VerifiableCredential', 'PasskeyCredential'],
    id: `urn:uuid:${crypto.randomUUID()}`,
    issuer: issuerDid,
    credentialSubject: {
      id: issuerDid,
      relyingParty: {
        id: passkey.rpId,
        name: passkey.rpName,
        ...(origin ? { origin } : {}),
      },
      credential: {
        credentialId: passkey.credentialId,
        publicKey: passkey.publicKey,
        publicKeyAlgorithm: passkey.publicKeyAlgorithm,
        ...(passkey.transports ? { transports: passkey.transports } : {}),
        ...(passkey.aaguid ? { aaguid: passkey.aaguid } : {}),
        ...(passkey.signCount !== undefined ? { signCount: passkey.signCount } : {}),
        createdAt: now.toISOString(),
      },
    },
    issuanceDate: now.toISOString(),
  };

  // Sign with eddsa-jcs-2022
  const proof = await signPasskeyVCWithJCS(vc, issuerDid);
  vc.proof = proof;

  return vc;
}

/**
 * Sign a PasskeyVC using eddsa-jcs-2022 (Ed25519 over JCS-canonicalized JSON).
 */
async function signPasskeyVCWithJCS(
  vc: Omit<PasskeyVC, 'proof'>,
  issuerDid: string,
): Promise<PasskeyVCProof> {
  const canonical = jcsCanonical(vc);
  const bytes = new TextEncoder().encode(canonical);
  const sigHex = await signBundle(bytes);

  const keyFragment = issuerDid.replace('did:key:', '');
  const verificationMethod = `${issuerDid}#${keyFragment}`;

  return {
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    verificationMethod,
    proofPurpose: 'assertionMethod',
    proofValue: `z${sigHex}`,
  };
}

// ── Serialization helpers (Task 11.6) ─────────────────────────────────────────

/**
 * Extract PasskeyFields from a WebAuthn AuthenticatorAttestationResponse.
 *
 * Converts ArrayBuffer fields to base64url strings for storage in the vault.
 */
export function extractPasskeyFromRegistration(
  credential: PublicKeyCredential,
  rpId: string,
  rpName: string,
): PasskeyFields {
  const response = credential.response as AuthenticatorAttestationResponse;

  // Extract public key (COSE format)
  const publicKeyBytes = response.getPublicKey?.();
  const publicKeyAlgorithm = response.getPublicKeyAlgorithm?.() ?? -7;
  const transports = response.getTransports?.() ?? [];

  // Parse attestation object for AAGUID
  const attestationObject = new Uint8Array(response.attestationObject);
  const aaguid = extractAAGUID(attestationObject);

  return {
    credentialId: base64UrlEncodeBytes(new Uint8Array(credential.rawId)),
    publicKey: publicKeyBytes
      ? base64UrlEncodeBytes(new Uint8Array(publicKeyBytes))
      : '',
    publicKeyAlgorithm,
    rpId,
    rpName,
    transports: transports.length > 0 ? transports : undefined,
    aaguid: aaguid ?? undefined,
    signCount: 0,
    attestationObject: base64UrlEncodeBytes(attestationObject),
    clientDataJSON: base64UrlEncodeBytes(new Uint8Array(response.clientDataJSON)),
  };
}

/**
 * Extract AAGUID from CBOR-encoded attestation object.
 *
 * The AAGUID is a 16-byte identifier at a fixed offset in the authenticator
 * data portion of the attestation object. We do a simplified extraction:
 * authData starts after the CBOR map header + "fmt" + "attStmt" + "authData"
 * keys. The AAGUID is at authData[37..53] (after rpIdHash[32] + flags[1] + signCount[4]).
 */
function extractAAGUID(attestationObject: Uint8Array): string | null {
  try {
    // Find authData in the CBOR — look for the rpIdHash pattern
    // authData structure: rpIdHash(32) + flags(1) + signCount(4) + aaguid(16) + ...
    // We need to find authData within the CBOR attestation object.
    // A simplified approach: search for the authData key marker and extract.
    // The CBOR map typically has keys "fmt", "attStmt", "authData".
    // authData value follows immediately after the "authData" key.

    // Simple heuristic: look for the byte sequence that represents "authData"
    // in CBOR (0x68 0x61 0x75 0x74 0x68 0x44 0x61 0x74 0x61 = "authData" with
    // CBOR text string prefix). Then the authData bytes follow.
    const authDataStr = new TextEncoder().encode('authData');
    let offset = -1;
    for (let i = 0; i < attestationObject.length - authDataStr.length; i++) {
      let match = true;
      for (let j = 0; j < authDataStr.length; j++) {
        if (attestationObject[i + j] !== authDataStr[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        offset = i + authDataStr.length;
        break;
      }
    }

    if (offset < 0) return null;

    // Skip CBOR byte string header (major type 2)
    const header = attestationObject[offset];
    let authDataStart: number;
    if ((header & 0x1f) < 24) {
      authDataStart = offset + 1;
    } else if ((header & 0x1f) === 24) {
      authDataStart = offset + 2;
    } else if ((header & 0x1f) === 25) {
      authDataStart = offset + 3;
    } else {
      return null;
    }

    // AAGUID is at authData[37..53]
    const aaguidOffset = authDataStart + 37;
    if (aaguidOffset + 16 > attestationObject.length) return null;

    const aaguidBytes = attestationObject.slice(aaguidOffset, aaguidOffset + 16);
    // Check if all zeros (no AAGUID)
    if (aaguidBytes.every(b => b === 0)) return null;

    return bufferToHex(aaguidBytes);
  } catch {
    return null;
  }
}

// ── Base64url helpers ─────────────────────────────────────────────────────────

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Export a PasskeyVC as a signed JSON string for interop with other VC wallets.
 */
export function exportPasskeyVCAsJSON(vc: PasskeyVC): string {
  return JSON.stringify(vc, null, 2);
}

/**
 * Compute SHA-256 hash of a PasskeyVC for backend registry.
 * Uses JCS canonicalization to ensure deterministic hashing.
 */
export async function hashPasskeyVC(vc: PasskeyVC): Promise<string> {
  const canonical = jcsCanonical(vc);
  const bytes = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return bufferToHex(new Uint8Array(hash));
}
