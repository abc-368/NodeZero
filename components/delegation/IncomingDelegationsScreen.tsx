/**
 * IncomingDelegationsScreen — View and accept incoming delegation VCs.
 *
 * Flow:
 *   1. Poll GET /v1/delegation/incoming
 *   2. Verify each VC signature + expiry
 *   3. Show grants with delegator DID, scope, expiry
 *   4. Accept → unwrap vault key → decrypt authorized entries
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Layout, Header, ScrollableBody } from '@/components/shared/Layout';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ArrowLeft, Download, Shield, Clock, User, Loader2, AlertCircle, CheckCircle2, XCircle } from 'lucide-react';
import type { VaultEntry } from '@/lib/vault/entry';
import {
  verifyDelegationVC,
  unwrapVaultKey,
  buildDelegationListPayload,
  base64UrlDecode,
  type DelegationVC,
} from '@/lib/did/delegation';
import { signBundle, getActiveDid } from '@/lib/did/provider';
import { deriveX25519Seed } from '@/lib/email/crypto';

interface IncomingDelegationsScreenProps {
  onBack: () => void;
  bipSeed: Uint8Array | null;   // BIP-39 seed for X25519 derivation
}

interface DelegationGrant {
  id: string;
  delegator: string;
  vc: DelegationVC;
  verified: boolean;
  reason?: string;
  expiresIn: string;
  scopeCount: number;
}

export function IncomingDelegationsScreen({ onBack, bipSeed }: IncomingDelegationsScreenProps) {
  const [grants, setGrants] = useState<DelegationGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [decryptedEntries, setDecryptedEntries] = useState<Map<string, VaultEntry[]>>(new Map());
  const [decrypting, setDecrypting] = useState<string | null>(null);

  const fetchIncoming = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const delegateeDid = getActiveDid();
      if (!delegateeDid) throw new Error('Vault must be unlocked');

      const timestamp = Date.now();
      const payload = buildDelegationListPayload(delegateeDid, timestamp);
      const signature = await signBundle(payload);

      const res = await fetch(
        `${import.meta.env.VITE_API_URL ?? 'https://api.nodezero.top'}/v1/delegation/incoming`,
        {
          headers: {
            'X-DID': delegateeDid,
            'X-Timestamp': String(timestamp),
            'X-Signature': signature,
          },
        },
      );

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `Server error ${res.status}`);
      }

      const data = await res.json();
      const delegations: DelegationGrant[] = [];

      for (const item of data.delegations ?? []) {
        try {
          // Decode VC from base64
          const vcJson = atob(item.vc_cbor);
          const vc: DelegationVC = JSON.parse(
            new TextDecoder().decode(
              new Uint8Array(vcJson.split('').map((c: string) => c.charCodeAt(0)))
            )
          );

          // Verify signature + expiry
          const result = await verifyDelegationVC(vc, delegateeDid);

          // Human-readable expiry
          const expiresAt = new Date(vc.expirationDate);
          const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));

          delegations.push({
            id: item.id,
            delegator: item.delegator,
            vc,
            verified: result.valid,
            reason: result.reason,
            expiresIn: daysLeft === 0 ? 'Expires today' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`,
            scopeCount: vc.credentialSubject?.scope?.length ?? 0,
          });
        } catch (e: any) {
          console.warn('[NodeZero] Failed to parse delegation:', e);
        }
      }

      setGrants(delegations);
    } catch (err: any) {
      setError(err.message ?? 'Failed to load delegations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchIncoming();
  }, [fetchIncoming]);

  const handleAccept = useCallback(async (grant: DelegationGrant) => {
    if (!bipSeed || !grant.verified) return;
    setDecrypting(grant.id);

    try {
      // Derive our X25519 private key
      const x25519Priv = deriveX25519Seed(bipSeed);

      // Unwrap the vault key
      const wrappedKeyBytes = base64UrlDecode(grant.vc.credentialSubject.wrappedVaultKey);
      const _vaultKey = await unwrapVaultKey(wrappedKeyBytes, x25519Priv);

      // TODO: Use vaultKey to decrypt the delegator's vault entries matching scope
      // For now, we show a success state indicating the key was unwrapped
      // Full decryption requires fetching the delegator's vault blob and decrypting
      // only the entries listed in the scope array.

      // Zero sensitive material
      x25519Priv.fill(0);
      _vaultKey.fill(0);

      setDecryptedEntries(prev => new Map(prev).set(grant.id, []));
    } catch (err: any) {
      setError(`Failed to decrypt: ${err.message}`);
    } finally {
      setDecrypting(null);
    }
  }, [bipSeed]);

  return (
    <Layout>
      <Header
        title="Shared With Me"
        left={
          <Button variant="ghost" size="sm" onClick={onBack} className="h-7 w-7 p-0" aria-label="Back">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        }
        right={
          <Button variant="ghost" size="sm" onClick={fetchIncoming} disabled={loading} className="h-7 px-2 text-xs">
            Refresh
          </Button>
        }
      />
      <ScrollableBody className="p-4 space-y-3">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 p-2 rounded-lg bg-destructive/10 text-destructive text-xs">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {!loading && grants.length === 0 && !error && (
          <div className="text-center py-8 space-y-2">
            <Download className="w-8 h-8 mx-auto text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">No shared entries yet</p>
            <p className="text-xs text-muted-foreground/70">
              When someone shares vault entries with you, they'll appear here.
            </p>
          </div>
        )}

        {grants.map(grant => (
          <div
            key={grant.id}
            className="border rounded-lg overflow-hidden"
          >
            {/* Grant header */}
            <button
              onClick={() => setExpandedId(expandedId === grant.id ? null : grant.id)}
              className="w-full flex items-center gap-3 p-3 text-left hover:bg-muted/30 transition-colors"
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                grant.verified ? 'bg-green-100 dark:bg-green-900/30' : 'bg-red-100 dark:bg-red-900/30'
              }`}>
                {grant.verified
                  ? <Shield className="w-4 h-4 text-green-600 dark:text-green-400" />
                  : <XCircle className="w-4 h-4 text-red-600 dark:text-red-400" />
                }
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">
                  From: {grant.delegator.slice(0, 20)}...{grant.delegator.slice(-8)}
                </p>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{grant.scopeCount} {grant.scopeCount === 1 ? 'entry' : 'entries'}</span>
                  <span>·</span>
                  <span className="flex items-center gap-0.5">
                    <Clock className="w-3 h-3" />
                    {grant.expiresIn}
                  </span>
                </div>
              </div>
            </button>

            {/* Expanded details */}
            {expandedId === grant.id && (
              <div className="border-t px-3 py-2 space-y-2 bg-muted/20">
                {!grant.verified && (
                  <p className="text-[11px] text-destructive">
                    Verification failed: {grant.reason}
                  </p>
                )}

                <div className="text-[11px] text-muted-foreground space-y-1">
                  <p>Issued: {new Date(grant.vc.issuanceDate).toLocaleDateString()}</p>
                  <p>Expires: {new Date(grant.vc.expirationDate).toLocaleDateString()}</p>
                  <p>Entries: {grant.vc.credentialSubject.scope.length}</p>
                </div>

                {grant.verified && !decryptedEntries.has(grant.id) && (
                  <Button
                    size="sm"
                    className="w-full text-xs"
                    disabled={decrypting === grant.id || !bipSeed}
                    onClick={() => handleAccept(grant)}
                  >
                    {decrypting === grant.id ? (
                      <>
                        <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
                        Decrypting...
                      </>
                    ) : (
                      <>
                        <Download className="w-3 h-3 mr-1.5" />
                        Accept & Decrypt
                      </>
                    )}
                  </Button>
                )}

                {decryptedEntries.has(grant.id) && (
                  <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    Key unwrapped successfully
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </ScrollableBody>
    </Layout>
  );
}
