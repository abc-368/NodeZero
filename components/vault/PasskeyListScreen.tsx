/**
 * PasskeyListScreen — Displays captured passkeys from the vault
 *
 * Shows passkey entries with RP info, credential ID preview, and
 * actions for viewing details and exporting VCs.
 */

import React, { useState, useCallback } from 'react';
import { ArrowLeft, Key, Copy, Download, Globe, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Layout, Header, ScrollableBody } from '@/components/shared/Layout';
import { VaultEntry, getFaviconUrl } from '@/lib/vault/entry';

interface PasskeyListScreenProps {
  entries: VaultEntry[];
  onBack: () => void;
  onExportVC: (entry: VaultEntry) => void;
}

export function PasskeyListScreen({ entries, onBack, onExportVC }: PasskeyListScreenProps) {
  const passkeyEntries = entries.filter(e => e.type === 'passkey' && e.passkey);

  return (
    <Layout>
      <Header
        title="Passkeys"
        left={
          <Button variant="ghost" size="sm" onClick={onBack} className="h-7 w-7 p-0" aria-label="Back">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        }
      />
      <ScrollableBody className="p-4">
        {passkeyEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center space-y-3">
            <Key className="w-8 h-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No passkeys captured yet</p>
            <p className="text-xs text-muted-foreground max-w-[250px]">
              When you register a passkey on a website, NodeZero will
              automatically capture it and store it here.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground mb-3">
              {passkeyEntries.length} passkey{passkeyEntries.length !== 1 ? 's' : ''} captured
            </p>
            {passkeyEntries.map(entry => (
              <PasskeyCard
                key={entry.id}
                entry={entry}
                onExportVC={() => onExportVC(entry)}
              />
            ))}
          </div>
        )}
      </ScrollableBody>
    </Layout>
  );
}

interface PasskeyCardProps {
  entry: VaultEntry;
  onExportVC: () => void;
}

function PasskeyCard({ entry, onExportVC }: PasskeyCardProps) {
  const [copied, setCopied] = useState(false);
  const passkey = entry.passkey!;

  const faviconUrl = getFaviconUrl(entry.url);
  const credIdPreview = passkey.credentialId.length > 16
    ? `${passkey.credentialId.slice(0, 16)}...`
    : passkey.credentialId;

  const algorithmName = getAlgorithmName(passkey.publicKeyAlgorithm);

  const handleCopyCredentialId = useCallback(async () => {
    await navigator.clipboard.writeText(passkey.credentialId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [passkey.credentialId]);

  return (
    <div className="border rounded-lg p-3 space-y-2 hover:bg-accent/30 transition-colors">
      {/* Header row */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
          {faviconUrl ? (
            <img
              src={faviconUrl}
              alt=""
              className="w-5 h-5 rounded"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <Globe className="w-4 h-4 text-muted-foreground" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{passkey.rpName}</p>
          <p className="text-xs text-muted-foreground truncate">{passkey.rpId}</p>
        </div>
        <Shield className="w-4 h-4 text-green-500 shrink-0" aria-label="Passkey verified" />
      </div>

      {/* Details */}
      <div className="space-y-1 pl-11">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">Credential:</span>
          <code className="text-[11px] font-mono truncate flex-1">{credIdPreview}</code>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 w-5 p-0"
            onClick={handleCopyCredentialId}
            aria-label="Copy credential ID"
          >
            <Copy className="w-3 h-3" />
          </Button>
          {copied && <span className="text-[10px] text-green-500">Copied</span>}
        </div>
        <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
          <span>Algorithm: {algorithmName}</span>
          {passkey.transports && (
            <span>Transports: {passkey.transports.join(', ')}</span>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground">
          Registered: {new Date(entry.createdAt).toLocaleDateString()}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pl-11">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs gap-1"
          onClick={onExportVC}
        >
          <Download className="w-3 h-3" />
          Export VC
        </Button>
      </div>
    </div>
  );
}

function getAlgorithmName(alg: number): string {
  switch (alg) {
    case -7: return 'ES256';
    case -8: return 'EdDSA';
    case -257: return 'RS256';
    case -35: return 'ES384';
    case -36: return 'ES512';
    default: return `COSE ${alg}`;
  }
}
