/**
 * SharingScreen — Issue a delegation VC to share vault entries.
 *
 * Flow:
 *   1. Paste delegatee DID
 *   2. Select entries to share
 *   3. Choose TTL (7/30/90 days)
 *   4. Issue VC → POST to backend
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Layout, Header, ScrollableBody } from '@/components/shared/Layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { ArrowLeft, Share2, Check, Loader2, AlertCircle } from 'lucide-react';
import type { VaultEntry } from '@/lib/vault/entry';
import {
  issueDelegationVC,
  buildDelegationCreatePayload,
} from '@/lib/did/delegation';
import { signBundle, getActiveDid } from '@/lib/did/provider';
import { bufferToBase64 } from '@/lib/crypto/field-encrypt';

interface SharingScreenProps {
  entries: VaultEntry[];
  vaultKey: Uint8Array | null;
  onBack: () => void;
}

const TTL_OPTIONS = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
] as const;

export function SharingScreen({ entries, vaultKey, onBack }: SharingScreenProps) {
  const [delegateeDid, setDelegateeDid] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [ttlDays, setTtlDays] = useState(30);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const isValidDid = delegateeDid.startsWith('did:key:z') && delegateeDid.length > 20;
  const canSubmit = isValidDid && selectedIds.size > 0 && vaultKey && !sending;

  const toggleEntry = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    if (selectedIds.size === entries.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(entries.map(e => e.id)));
    }
  }, [entries, selectedIds.size]);

  const handleShare = useCallback(async () => {
    if (!canSubmit || !vaultKey) return;
    setSending(true);
    setError(null);

    try {
      // Look up delegatee's X25519 public key from email registry
      // For now, we need the delegatee to have registered their email+X25519 key.
      // In a future iteration, we could derive X25519 from the DID directly.
      // For this version, we'll look up via the backend.
      const lookupRes = await fetch(
        `${import.meta.env.VITE_API_URL ?? 'https://api.nodezero.top'}/v2/email/lookup?did=${encodeURIComponent(delegateeDid)}`,
      );

      // Fallback: if email lookup doesn't work by DID, try getting X25519 from DID key exchange
      // TODO: Add DID→X25519 lookup endpoint or derive from Ed25519 via birational map
      let delegateeX25519Pub: Uint8Array;

      if (lookupRes.ok) {
        const data = await lookupRes.json();
        delegateeX25519Pub = base64Decode(data.x25519_pub);
      } else {
        throw new Error(
          'Could not find the delegatee\'s encryption key. ' +
          'They must register their email in NodeZero first.'
        );
      }

      // Issue the VC
      const vc = await issueDelegationVC(
        delegateeDid,
        delegateeX25519Pub,
        vaultKey,
        [...selectedIds],
        ttlDays,
      );

      // CBOR-encode the VC (use JSON for now — CBOR encoding can be swapped later)
      const vcJson = JSON.stringify(vc);
      const vcBytes = new TextEncoder().encode(vcJson);
      const vcBase64 = btoa(String.fromCharCode(...vcBytes));

      // Build DID-signed request to backend
      const delegatorDid = getActiveDid()!;
      const timestamp = Date.now();
      const validUntil = Math.floor(new Date(vc.expirationDate).getTime() / 1000);

      const payload = buildDelegationCreatePayload(delegatorDid, delegateeDid, timestamp);
      const signature = await signBundle(payload);

      const res = await fetch(
        `${import.meta.env.VITE_API_URL ?? 'https://api.nodezero.top'}/v1/delegation`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-DID': delegatorDid,
            'X-Timestamp': String(timestamp),
            'X-Signature': signature,
          },
          body: JSON.stringify({
            delegatee: delegateeDid,
            vc_cbor: vcBase64,
            valid_until: validUntil,
          }),
        },
      );

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `Server error ${res.status}`);
      }

      setSuccess(true);
    } catch (err: any) {
      setError(err.message ?? 'Failed to create delegation');
    } finally {
      setSending(false);
    }
  }, [canSubmit, vaultKey, delegateeDid, selectedIds, ttlDays]);

  if (success) {
    return (
      <Layout>
        <Header
          title="Shared!"
          left={
            <Button variant="ghost" size="sm" onClick={onBack} className="h-7 w-7 p-0" aria-label="Back">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          }
        />
        <ScrollableBody className="p-4 flex flex-col items-center justify-center gap-4">
          <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
            <Check className="w-6 h-6 text-green-600 dark:text-green-400" />
          </div>
          <p className="text-sm text-center">
            Shared {selectedIds.size} {selectedIds.size === 1 ? 'entry' : 'entries'} for {ttlDays} days.
          </p>
          <p className="text-xs text-muted-foreground text-center">
            The delegatee will see the shared entries next time they open NodeZero.
          </p>
          <Button variant="outline" size="sm" onClick={onBack}>Done</Button>
        </ScrollableBody>
      </Layout>
    );
  }

  return (
    <Layout>
      <Header
        title="Share Entries"
        left={
          <Button variant="ghost" size="sm" onClick={onBack} className="h-7 w-7 p-0" aria-label="Back">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        }
      />
      <ScrollableBody className="p-4 space-y-4">
        {/* Delegatee DID */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Recipient DID
          </label>
          <Input
            placeholder="did:key:z6Mk..."
            value={delegateeDid}
            onChange={e => setDelegateeDid(e.target.value.trim())}
            className="text-xs font-mono"
          />
          {delegateeDid && !isValidDid && (
            <p className="text-[11px] text-destructive">Must be a valid did:key identifier</p>
          )}
        </div>

        <Separator />

        {/* Entry selection */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Entries to share ({selectedIds.size}/{entries.length})
            </label>
            <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={selectAll}>
              {selectedIds.size === entries.length ? 'Deselect all' : 'Select all'}
            </Button>
          </div>
          <div className="max-h-[180px] overflow-y-auto space-y-1 border rounded-lg p-1">
            {entries.map(entry => (
              <button
                key={entry.id}
                onClick={() => toggleEntry(entry.id)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs transition-colors ${
                  selectedIds.has(entry.id)
                    ? 'bg-primary/10 text-primary'
                    : 'hover:bg-muted/50'
                }`}
              >
                <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                  selectedIds.has(entry.id) ? 'bg-primary border-primary' : 'border-muted-foreground/30'
                }`}>
                  {selectedIds.has(entry.id) && <Check className="w-3 h-3 text-primary-foreground" />}
                </div>
                <div className="truncate">
                  <span className="font-medium">{entry.title || entry.url || 'Untitled'}</span>
                  {entry.username && (
                    <span className="text-muted-foreground ml-1">({entry.username})</span>
                  )}
                </div>
              </button>
            ))}
            {entries.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">No entries in vault</p>
            )}
          </div>
        </div>

        <Separator />

        {/* TTL selection */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Access Duration
          </label>
          <div className="flex gap-2">
            {TTL_OPTIONS.map(opt => (
              <Button
                key={opt.value}
                variant={ttlDays === opt.value ? 'default' : 'outline'}
                size="sm"
                className="text-xs flex-1"
                onClick={() => setTtlDays(opt.value)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 p-2 rounded-lg bg-destructive/10 text-destructive text-xs">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Submit */}
        <Button
          className="w-full"
          disabled={!canSubmit}
          onClick={handleShare}
        >
          {sending ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Sharing...
            </>
          ) : (
            <>
              <Share2 className="w-4 h-4 mr-2" />
              Share {selectedIds.size > 0 ? `${selectedIds.size} ${selectedIds.size === 1 ? 'entry' : 'entries'}` : 'Entries'}
            </>
          )}
        </Button>
      </ScrollableBody>
    </Layout>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function base64Decode(str: string): Uint8Array {
  const raw = atob(str);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
