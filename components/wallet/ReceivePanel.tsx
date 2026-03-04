/**
 * ReceivePanel — MetaMask-style "Receive" panel for the NodeZero wallet.
 *
 * Shows the user's address with copy-to-clipboard, chain badge, explorer link,
 * and a safety warning about which network to use.
 */

import React, { useState, useCallback, useMemo } from 'react';
import { Copy, Check, ExternalLink, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getChainConfig, type Chain } from '@/lib/wallet/types';

interface ReceivePanelProps {
  address: string;
  chain: Chain;
  testnet: boolean;
}

/**
 * Format an address into groups of 4 characters for readability.
 * e.g. "0x1234...abcd" → "0x12 34AB CDEF ..."
 */
function formatAddressGroups(address: string): string[] {
  // Strip "0x" prefix, then chunk into groups of 4
  const raw = address.startsWith('0x') ? address.slice(2) : address;
  const groups: string[] = [];
  if (address.startsWith('0x')) {
    groups.push('0x');
  }
  for (let i = 0; i < raw.length; i += 4) {
    groups.push(raw.slice(i, i + 4));
  }
  return groups;
}

export function ReceivePanel({ address, chain, testnet }: ReceivePanelProps) {
  const [copied, setCopied] = useState(false);

  const config = useMemo(() => getChainConfig(chain, testnet), [chain, testnet]);
  const addressGroups = useMemo(() => formatAddressGroups(address), [address]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for environments where clipboard API is unavailable
      const textarea = document.createElement('textarea');
      textarea.value = address;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [address]);

  const explorerUrl = `${config.explorerUrl}/address/${address}`;

  return (
    <div className="flex flex-col items-center space-y-4">
      {/* Chain badge */}
      <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-muted text-xs font-medium">
        <span className={`w-2 h-2 rounded-full ${config.iconColor.replace('text-', 'bg-')}`} />
        <span>{config.name}</span>
        {testnet && (
          <span className="text-[10px] text-muted-foreground ml-0.5">(Testnet)</span>
        )}
      </div>

      {/* Address display card */}
      <div className="w-full rounded-xl border border-border bg-muted/30 p-4">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2 text-center">
          Your Address
        </p>
        <div className="flex flex-wrap justify-center gap-x-1.5 gap-y-1">
          {addressGroups.map((group, i) => (
            <span
              key={i}
              className={`font-mono text-xs ${
                i === 0 ? 'text-muted-foreground' : 'text-foreground'
              }`}
            >
              {group}
            </span>
          ))}
        </div>
      </div>

      {/* Copy button */}
      <Button
        onClick={handleCopy}
        className="w-full rounded-xl h-10 text-sm font-medium gap-2"
        variant={copied ? 'outline' : 'default'}
      >
        {copied ? (
          <>
            <Check className="w-4 h-4 text-green-500" />
            Copied!
          </>
        ) : (
          <>
            <Copy className="w-4 h-4" />
            Copy Address
          </>
        )}
      </Button>

      {/* Explorer link */}
      <a
        href={explorerUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ExternalLink className="w-3 h-3" />
        View on {config.explorerUrl.replace('https://', '').split('/')[0]}
      </a>

      {/* Safety warning */}
      <div className="w-full rounded-xl border border-border bg-muted/20 p-3 flex gap-2.5">
        <Shield className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Send only <span className="font-medium text-foreground">{config.symbol}</span> and
          tokens on <span className="font-medium text-foreground">{config.name}</span> to
          this address. Sending assets on other networks may result in permanent loss.
        </p>
      </div>
    </div>
  );
}
