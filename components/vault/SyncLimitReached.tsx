/**
 * SyncLimitReached — Dismissible alert card shown when the daily
 * sync token pool is depleted.
 *
 * Display states:
 *   - Daily limit hit:  "Daily points limit reached" + reset time
 *   - Low tokens:       "Running low on points" + remaining count
 */

import React, { useEffect, useState } from 'react';
import {
  getTokenBalance,
  POOL_KEY,
  META_KEY,
  type TokenBalance,
} from '@/lib/tokens/pool';
import { AlertTriangle, X } from 'lucide-react';

export function SyncLimitReached() {
  const [balance, setBalance] = useState<TokenBalance | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    getTokenBalance().then(setBalance);

    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area !== 'local') return;
      if (changes[POOL_KEY] || changes[META_KEY]) {
        getTokenBalance().then(b => {
          setBalance(b);
          // Auto-show again if state transitions from ok → depleted
          setDismissed(false);
        });
      }
    };

    // Use global onChanged (not chrome.storage.local.onChanged) — the
    // local-scoped variant omits the `area` param, breaking the area guard.
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  if (!balance || dismissed) return null;

  // Don't show before token system is initialized (first issuance)
  if (!balance.initialized) return null;

  const isDepleted = balance.held === 0 && balance.remaining === 0;
  const isLow = !isDepleted && balance.held < 10 && balance.remaining === 0;

  // Only show when depleted or low
  if (!isDepleted && !isLow) return null;

  const resetStr = balance.resetsAt
    ? new Date(balance.resetsAt * 1000).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'midnight UTC';

  return (
    <div className={`mx-3 mb-2 rounded-lg border p-3 space-y-2 ${
      isDepleted
        ? 'border-amber-500/30 bg-amber-500/5'
        : 'border-amber-500/20 bg-amber-500/5'
    }`}>
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-foreground">
            {isDepleted ? 'Daily points limit reached' : 'Running low on points'}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {isDepleted
              ? `Changes are saved locally. Points reset at ${resetStr}.`
              : `${balance.held} point${balance.held === 1 ? '' : 's'} remaining on this device today.`}
          </p>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

    </div>
  );
}
