/**
 * UpgradePremium — Payment method selector + flow for upgrading to Premium.
 *
 * States:
 *   idle      → Method + duration selector with Card / Crypto buttons
 *   pending   → Waiting for crypto payment confirmation (polling)
 *   confirmed → Premium activated, shows expiry date
 *
 * Supports two payment methods:
 *   - LemonSqueezy (card payments) — opens external checkout
 *   - NOWPayments (crypto: BTC, XMR, SOL, etc.) — creates invoice, polls status
 */

import React, { useEffect, useState, useRef } from 'react';
import { Zap, CreditCard, Coins, Loader2, ExternalLink, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SYNC_API_BASE } from '@/lib/constants';
import { MessageType, MessageFrom } from '@/lib/types';
import { browser } from 'wxt/browser';

// ── Types ────────────────────────────────────────────────────────────────

type PaymentMethod = 'lemonsqueezy' | 'nowpayments';
type Duration = '1month' | '3months' | '12months';
type FlowState = 'idle' | 'pending' | 'confirmed' | 'error';

const DURATIONS: { key: Duration; label: string; price: string }[] = [
  { key: '1month',   label: '1 month',   price: '$5' },
  { key: '3months',  label: '3 months',  price: '$12' },
  { key: '12months', label: '12 months', price: '$40' },
];

const POLL_INTERVAL_MS = 10_000;  // 10 seconds
const POLL_TIMEOUT_MS  = 3_600_000; // 1 hour

// ── Helpers ──────────────────────────────────────────────────────────────

/** Proxy API result from background signedApiFetch handler. */
interface ProxyResult {
  ok: boolean;
  status: number;
  body: any;
  error?: string;
}

/**
 * Make a DID-signed fetch via the background service worker.
 * The popup doesn't have access to the signing key — the background
 * handles DID auth and returns the parsed response.
 */
async function signedFetch(path: string, init?: { method?: string; body?: string }): Promise<ProxyResult> {
  const result = await browser.runtime.sendMessage({
    type: MessageType.signedApiFetch,
    from: MessageFrom.popup,
    payload: {
      path,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body) : undefined,
    },
  }) as ProxyResult;

  if (result.error && !result.status) {
    throw new Error(result.error);
  }
  return result;
}

// ── Component ────────────────────────────────────────────────────────────

interface UpgradePremiumProps {
  extendMode?: boolean;
}

export function UpgradePremium({ extendMode = false }: UpgradePremiumProps) {
  const [methods, setMethods] = useState<string[]>([]);
  const [duration, setDuration] = useState<Duration>('1month');
  const [state, setState] = useState<FlowState>('idle');
  const [invoiceUrl, setInvoiceUrl] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [premiumExpiry, setPremiumExpiry] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch available payment methods on mount
  useEffect(() => {
    fetch(`${SYNC_API_BASE}/v2/payment/methods`)
      .then(r => r.json())
      .then(data => setMethods(data.methods ?? []))
      .catch(() => setMethods(['lemonsqueezy']));
  }, []);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  async function handleUpgrade(method: PaymentMethod) {
    if (method === 'lemonsqueezy') {
      chrome.tabs.create({ url: 'https://nodezero.top/upgrade' });
      return;
    }

    // NOWPayments flow
    setState('pending');
    setErrorMsg(null);

    try {
      const response = await signedFetch('/v2/payment/create-invoice', {
        method: 'POST',
        body: JSON.stringify({ method: 'nowpayments', duration }),
      });

      if (!response.ok) {
        throw new Error(response.body?.error ?? `HTTP ${response.status}`);
      }

      const data = response.body;
      setInvoiceUrl(data.invoiceUrl);
      setPaymentId(data.paymentId);

      // Open NOWPayments payment page
      chrome.tabs.create({ url: data.invoiceUrl });

      // Start polling for confirmation
      startPolling(data.paymentId);
    } catch (err: any) {
      setState('error');
      setErrorMsg(err.message ?? 'Failed to create invoice');
    }
  }

  function startPolling(id: string) {
    pollRef.current = setInterval(async () => {
      try {
        const response = await signedFetch(`/v2/payment/status/${id}`);
        const data = response.body;

        if (data?.status === 'confirmed') {
          setState('confirmed');
          setPremiumExpiry(data.premiumExpiresAt ?? null);
          if (pollRef.current) clearInterval(pollRef.current);
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          // Refresh token pool to pick up new allowance
          chrome.runtime.sendMessage({ type: 'refreshTokens' });
        }
      } catch {
        // Silently retry — network hiccups are expected
      }
    }, POLL_INTERVAL_MS);

    // Stop polling after 1 hour
    timeoutRef.current = setTimeout(() => {
      if (pollRef.current) clearInterval(pollRef.current);
    }, POLL_TIMEOUT_MS);
  }

  // ── Render: Confirmed ──────────────────────────────────────────────────

  if (state === 'confirmed') {
    const expiryStr = premiumExpiry
      ? new Date(premiumExpiry).toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })
      : 'your subscription period';

    return (
      <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-green-500" />
          <span className="text-sm font-semibold text-green-600">
            {extendMode ? 'Premium extended!' : 'Premium activated!'}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {extendMode
            ? `Your subscription has been extended. New expiry: ${expiryStr}.`
            : `You now have 500 points/day and access to all premium features. Your premium expires ${expiryStr}.`
          }
        </p>
      </div>
    );
  }

  // ── Render: Pending ────────────────────────────────────────────────────

  if (state === 'pending') {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Loader2 className="w-4 h-4 text-amber-500 animate-spin" />
          <span className="text-sm font-medium">Waiting for payment...</span>
        </div>
        <p className="text-xs text-muted-foreground">
          A payment page has opened in a new tab. Complete your payment there
          and this screen will update automatically.
        </p>
        {invoiceUrl && (
          <Button
            variant="outline"
            size="sm"
            className="w-full h-7 text-[11px] gap-1.5"
            onClick={() => chrome.tabs.create({ url: invoiceUrl })}
          >
            <ExternalLink className="w-3 h-3" />
            Open payment page again
          </Button>
        )}
      </div>
    );
  }

  // ── Render: Error ──────────────────────────────────────────────────────

  if (state === 'error') {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 space-y-3">
        <p className="text-xs font-medium text-red-600">
          {errorMsg ?? 'Something went wrong'}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="w-full h-7 text-[11px]"
          onClick={() => { setState('idle'); setErrorMsg(null); }}
        >
          Try again
        </Button>
      </div>
    );
  }

  // ── Render: Idle — method + duration selector ──────────────────────────

  const hasCrypto = methods.includes('nowpayments');
  const hasCard = methods.includes('lemonsqueezy');

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Zap className="w-4 h-4 text-amber-500" />
        <span className="text-sm font-semibold">
          {extendMode ? 'Extend Premium' : 'Upgrade to Premium'}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        {extendMode
          ? 'Add more time to your current subscription'
          : '500 points/day \u00b7 Attachments \u00b7 Priority support'
        }
      </p>

      {/* Duration selector */}
      {hasCrypto && (
        <div className="flex gap-1.5">
          {DURATIONS.map(d => (
            <button
              key={d.key}
              onClick={() => setDuration(d.key)}
              className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors ${
                duration === d.key
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              {d.label}
              <br />
              <span className="text-[10px] opacity-80">{d.price}</span>
            </button>
          ))}
        </div>
      )}

      {/* Payment method buttons */}
      <div className="flex gap-2">
        {hasCard && (
          <Button
            variant="outline"
            size="sm"
            className="flex-1 h-9 text-xs gap-1.5 opacity-40 cursor-not-allowed"
            disabled
            title="Card payments coming soon"
          >
            <CreditCard className="w-3.5 h-3.5" />
            Card
          </Button>
        )}
        {hasCrypto && (
          <Button
            variant="outline"
            size="sm"
            className="flex-1 h-9 text-xs gap-1.5"
            onClick={() => handleUpgrade('nowpayments')}
          >
            <Coins className="w-3.5 h-3.5" />
            Crypto
          </Button>
        )}
      </div>

      {hasCrypto && (
        <p className="text-[10px] text-muted-foreground text-center">
          BTC &middot; Lightning &middot; XMR &middot; SOL &middot; USDC &middot; 300+ coins
        </p>
      )}
    </div>
  );
}
