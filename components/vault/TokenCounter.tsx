/**
 * TokenCounter — Persistent footer showing sync token balance.
 *
 * Always visible at the bottom of the popup (vault + settings screens)
 * once the token system has been initialized (first issuance).
 *
 * Reacts to chrome.storage.onChanged for real-time updates as tokens
 * are consumed, refilled, or expire.
 *
 * Display states:
 *   Hidden:     before first issuance (initialized === false)
 *   Normal:     "42 points available · 100 daily · 50 unclaimed"
 *   Low:        "⚠ 5 points available · 100 daily · 50 unclaimed"
 *   Depleted:   "No points remaining today · Resets at 00:00"
 */

import React, { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  getTokenBalance,
  POOL_KEY,
  META_KEY,
  type TokenBalance,
} from '@/lib/tokens/pool';
import { MessageType, MessageFrom } from '@/lib/types';


export function TokenCounter() {
  const [balance, setBalance] = useState<TokenBalance | null>(null);

  useEffect(() => {
    // Initial load — show cached balance immediately
    getTokenBalance().then(setBalance);

    // Trigger a background meta refresh on popup open.
    // refillPool() checks meta staleness internally — if meta is fresh
    // (< 5 min old), it skips the server call entirely. If stale, it
    // requests 1 token to get fresh remaining/dailyAllowance from the
    // server. The updated meta writes to chrome.storage → onChanged
    // fires → balance re-reads automatically below.
    browser.runtime.sendMessage({
      type: MessageType.refreshTokens,
      from: MessageFrom.popup,
    }).catch(() => {}); // Silently ignore if vault is locked

    // Reactive: listen for pool or meta changes across all contexts.
    // IMPORTANT: use chrome.storage.onChanged (global), NOT
    // chrome.storage.local.onChanged — the local-scoped variant does NOT
    // pass an `area` parameter, so the area guard would silently suppress
    // every event.
    const listener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string,
    ) => {
      if (area !== 'local') return;
      if (changes[POOL_KEY] || changes[META_KEY]) {
        getTokenBalance().then(setBalance);
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  // Don't render until loaded
  if (!balance) return null;

  // Don't render before the first issuance has populated server meta
  if (!balance.initialized) return null;

  const isDepleted = balance.held === 0 && balance.remaining === 0;
  const isLow = !isDepleted && balance.held < 10;

  if (isDepleted) {
    const resetStr = balance.resetsAt
      ? new Date(balance.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : 'midnight UTC';

    return (
      <div className="shrink-0 px-3 py-2 border-t border-border text-[11px] text-amber-500">
        No points remaining today · Resets at {resetStr}
      </div>
    );
  }

  return (
    <div className={`shrink-0 px-3 py-2 border-t border-border text-[11px] ${
      isLow ? 'text-amber-500' : 'text-muted-foreground'
    }`}>
      {isLow && '\u26A0 '}{balance.held} points available · {balance.dailyAllowance} daily · {balance.remaining} unclaimed
    </div>
  );
}
