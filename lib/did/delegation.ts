/**
 * Delegation Verifiable Credentials (Phase 2 stub)
 *
 * Allows a user to authorize a new browser/device to access their vault
 * by issuing a time-limited, revocable delegation VC.
 *
 * Phase 1: Stub — structure defined, implementation deferred to Phase 2.
 * Phase 2: Full UCAN + W3C VC implementation with QR code pairing.
 */

import { getActiveDid, signVC } from '@/lib/did/provider';
import { v4 as uuidv4 } from 'uuid';

export interface DelegationVC {
  id: string;
  issuer: string;        // DID of the authorizing device
  subject: string;       // DID of the authorized device
  issuedAt: number;      // Unix ms
  expiresAt: number;     // Unix ms (time-limited)
  capabilities: string[]; // e.g. ['vault:read', 'vault:write']
  revoked: boolean;
  signature: string;     // Ed25519 signature by issuer
}

/**
 * Issue a delegation VC to authorize a new device.
 * Phase 2: uses UCAN-style delegation.
 */
export async function issueDelegation(
  subjectDid: string,
  capabilities: string[],
  ttlMs: number = 24 * 60 * 60 * 1000 // 24 hours default
): Promise<DelegationVC> {
  const issuerDid = getActiveDid();
  if (!issuerDid) throw new Error('Unlock vault to issue delegation');

  const now = Date.now();
  const vc: Omit<DelegationVC, 'signature'> = {
    id: `urn:uuid:${uuidv4()}`,
    issuer: issuerDid,
    subject: subjectDid,
    issuedAt: now,
    expiresAt: now + ttlMs,
    capabilities,
    revoked: false,
  };

  const signature = await signVC(vc);
  return { ...vc, signature };
}

/**
 * Verify a delegation VC.
 */
export async function verifyDelegation(_vc: DelegationVC): Promise<boolean> {
  // TODO: Implement VC verification against the issuer's public key (did:key)
  return true;
}

/**
 * Revoke a delegation VC.
 */
export async function revokeDelegation(_vcId: string): Promise<void> {
  throw new Error('Delegation revocation not yet implemented (Phase 2)');
}
