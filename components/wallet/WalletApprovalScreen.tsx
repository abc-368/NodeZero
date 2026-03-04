/**
 * WalletApprovalScreen — Transaction & signature approval UI
 *
 * Shows pending wallet actions (eth_sendTransaction, eth_signTypedData_v4,
 * personal_sign) with details and Approve/Reject buttons.
 */

import React, { useState, useEffect } from 'react';
import { Layout, Header, ScrollableBody } from '@/components/shared/Layout';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  ArrowLeft,
  Send,
  FileSignature,
  MessageSquare,
  AlertTriangle,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import { MessageType, MessageFrom } from '@/lib/types';
import { CHAIN_CONFIGS, type Chain } from '@/lib/wallet/types';
import { browser } from 'wxt/browser';

interface PendingApproval {
  id: string;
  type: 'eth_sendTransaction' | 'eth_signTypedData_v4' | 'personal_sign';
  params: any;
  origin?: string;
  chain: Chain;
}

interface WalletApprovalScreenProps {
  onBack: () => void;
}

export function WalletApprovalScreen({ onBack }: WalletApprovalScreenProps) {
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    chrome.storage.session.get('pendingWalletApproval').then((data) => {
      setPending(data.pendingWalletApproval || null);
      setLoading(false);
    });
  }, []);

  const handleApprove = async () => {
    if (!pending) return;
    setSubmitting(true);
    setError(null);

    try {
      if (pending.type === 'eth_sendTransaction') {
        // Sign and broadcast
        const result = await browser.runtime.sendMessage({
          type: MessageType.signTransaction,
          from: MessageFrom.popup,
          payload: { tx: pending.params, approvalId: pending.id },
        });
        if (result?.error) {
          setError(result.error);
          setSubmitting(false);
          return;
        }
      } else {
        // For signing requests, just approve and let background handle
        await browser.runtime.sendMessage({
          type: MessageType.approveWalletAction,
          from: MessageFrom.popup,
          payload: { id: pending.id },
        });
      }
      await chrome.storage.session.remove('pendingWalletApproval');
      onBack();
    } catch (err: any) {
      setError(err?.message || 'Failed');
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (!pending) return;
    await browser.runtime.sendMessage({
      type: MessageType.rejectWalletAction,
      from: MessageFrom.popup,
      payload: { id: pending.id },
    });
    await chrome.storage.session.remove('pendingWalletApproval');
    onBack();
  };

  if (loading) {
    return (
      <Layout>
        <Header title="Approve" left={<BackBtn onClick={onBack} />} />
        <ScrollableBody className="flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </ScrollableBody>
      </Layout>
    );
  }

  if (!pending) {
    return (
      <Layout>
        <Header title="Approve" left={<BackBtn onClick={onBack} />} />
        <ScrollableBody className="flex items-center justify-center">
          <p className="text-xs text-muted-foreground">No pending approval</p>
        </ScrollableBody>
      </Layout>
    );
  }

  const chainConfig = CHAIN_CONFIGS[pending.chain];

  return (
    <Layout>
      <Header
        title={getTitle(pending.type)}
        left={<BackBtn onClick={onBack} />}
      />
      <ScrollableBody className="p-4 space-y-3">
        {/* Origin */}
        {pending.origin && (
          <div className="text-[11px] text-muted-foreground text-center truncate">
            {pending.origin}
          </div>
        )}

        {/* Chain badge */}
        <div className="flex justify-center">
          <span className={`text-[10px] px-2 py-0.5 rounded-full bg-muted ${chainConfig.iconColor}`}>
            {chainConfig.name}
          </span>
        </div>

        <Separator />

        {/* Type-specific content */}
        {pending.type === 'eth_sendTransaction' && (
          <TxDetails params={pending.params} chain={pending.chain} />
        )}
        {pending.type === 'eth_signTypedData_v4' && (
          <TypedDataDetails params={pending.params} />
        )}
        {pending.type === 'personal_sign' && (
          <PersonalSignDetails params={pending.params} />
        )}

        {error && (
          <div className="text-[11px] text-red-500 bg-red-500/10 rounded p-2">
            {error}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={handleReject}
            disabled={submitting}
          >
            Reject
          </Button>
          <Button
            size="sm"
            className="flex-1"
            onClick={handleApprove}
            disabled={submitting}
          >
            {submitting ? (
              <Loader2 className="w-3 h-3 animate-spin mr-1" />
            ) : null}
            {pending.type === 'eth_sendTransaction' ? 'Send' : 'Sign'}
          </Button>
        </div>
      </ScrollableBody>
    </Layout>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────

function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} className="h-7 w-7 p-0" aria-label="Back">
      <ArrowLeft className="w-4 h-4" />
    </Button>
  );
}

function getTitle(type: string): string {
  switch (type) {
    case 'eth_sendTransaction': return 'Send Transaction';
    case 'eth_signTypedData_v4': return 'Sign Typed Data';
    case 'personal_sign': return 'Sign Message';
    default: return 'Approve';
  }
}

function TxDetails({ params, chain }: { params: any; chain: Chain }) {
  const chainConfig = CHAIN_CONFIGS[chain];
  const value = params.value ? formatWei(params.value, chainConfig.symbol) : '0 ' + chainConfig.symbol;
  const to = params.to || 'Contract Creation';
  const data = params.data || '0x';
  const hasData = data !== '0x' && data.length > 2;
  const selector = hasData ? data.slice(0, 10) : null;

  return (
    <div className="space-y-2">
      <DetailRow label="To" value={truncateAddress(to)} />
      <DetailRow label="Value" value={value} highlight />
      {selector && <DetailRow label="Method" value={selector} />}
      {params.gasLimit && <DetailRow label="Gas Limit" value={parseInt(params.gasLimit, 16).toLocaleString()} />}

      {hasData && (
        <div className="mt-2">
          <p className="text-[10px] text-muted-foreground mb-1">Data</p>
          <div className="bg-muted/50 rounded p-2 text-[10px] font-mono break-all max-h-20 overflow-y-auto">
            {data.length > 200 ? data.slice(0, 200) + '…' : data}
          </div>
        </div>
      )}

      {hasData && (
        <div className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="w-3 h-3" />
          <span>Contract interaction — verify the details</span>
        </div>
      )}
    </div>
  );
}

function TypedDataDetails({ params }: { params: any }) {
  const typedData = params.typedData;
  const domain = typedData?.domain;

  return (
    <div className="space-y-2">
      {domain?.name && <DetailRow label="Contract" value={domain.name} />}
      {domain?.verifyingContract && (
        <DetailRow label="Address" value={truncateAddress(domain.verifyingContract)} />
      )}

      <div className="mt-2">
        <p className="text-[10px] text-muted-foreground mb-1">Message</p>
        <div className="bg-muted/50 rounded p-2 text-[10px] font-mono break-all max-h-32 overflow-y-auto">
          <JsonTree data={typedData?.message || {}} />
        </div>
      </div>
    </div>
  );
}

function PersonalSignDetails({ params }: { params: any }) {
  const msgHex = params.message || '';
  let decoded: string;

  try {
    // Try to decode as UTF-8
    const bytes = hexToBytes(msgHex);
    decoded = new TextDecoder().decode(bytes);
    // Check if it's printable
    if (!/^[\x20-\x7E\n\r\t]+$/.test(decoded)) throw new Error('binary');
  } catch {
    decoded = msgHex; // Show hex fallback
  }

  return (
    <div className="space-y-2">
      <div>
        <p className="text-[10px] text-muted-foreground mb-1">Message</p>
        <div className="bg-muted/50 rounded p-2 text-xs break-all max-h-40 overflow-y-auto whitespace-pre-wrap">
          {decoded}
        </div>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function DetailRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className={`text-xs font-mono truncate max-w-[60%] ${highlight ? 'font-bold' : ''}`}>
        {value}
      </span>
    </div>
  );
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function formatWei(hex: string, symbol: string): string {
  const wei = BigInt(hex);
  const eth = Number(wei) / 1e18;
  return eth.toFixed(eth < 0.001 ? 6 : 4) + ' ' + symbol;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length === 0) return new Uint8Array(0);
  const padded = h.length % 2 ? '0' + h : h;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.substr(i * 2, 2), 16);
  }
  return bytes;
}

function JsonTree({ data, depth = 0 }: { data: any; depth?: number }) {
  if (depth > 4) return <span>…</span>;
  if (typeof data !== 'object' || data === null) {
    return <span>{String(data)}</span>;
  }
  return (
    <div className="pl-2">
      {Object.entries(data).map(([key, val]) => (
        <div key={key}>
          <span className="text-muted-foreground">{key}: </span>
          {typeof val === 'object' && val !== null ? (
            <JsonTree data={val} depth={depth + 1} />
          ) : (
            <span>{typeof val === 'string' && val.length > 40 ? val.slice(0, 20) + '…' + val.slice(-8) : String(val)}</span>
          )}
        </div>
      ))}
    </div>
  );
}
