/**
 * TierSelector — Plan picker for Settings screen.
 *
 * Shows available tiers as selectable cards. Current tier is highlighted.
 * Selecting a higher tier opens the UpgradePremium payment flow inline.
 * The tier is server-authoritative — the extension reads it from the
 * backend via balance/issuance responses and the cron handles expiry.
 *
 * Designed to scale: add new tiers to the TIERS array and they'll
 * render automatically.
 */

import React, { useState } from 'react';
import { Crown, Star, Check } from 'lucide-react';
import { UpgradePremium } from './UpgradePremium';
import type { TierStatus, Tier } from '@/lib/tier';

// ── Tier definitions (UI-only — add new tiers here) ──────────────────

interface TierDef {
  key: Tier;
  label: string;
  points: string;
  features: string;
  icon: React.ElementType;
}

const TIERS: TierDef[] = [
  {
    key: 'free',
    label: 'Free',
    points: '100 points/day',
    features: 'Vault sync · 2 MB storage',
    icon: Star,
  },
  {
    key: 'premium',
    label: 'Premium',
    points: '500 points/day',
    features: 'All features · 50 MB · Priority support',
    icon: Crown,
  },
  // Future tiers:
  // { key: 'elite', label: 'Elite', points: '2000 points/day', ... },
];

// ── Component ────────────────────────────────────────────────────────

interface TierSelectorProps {
  tierStatus: TierStatus | null;
}

export function TierSelector({ tierStatus }: TierSelectorProps) {
  const currentTier: Tier = tierStatus?.tier ?? 'free';
  const [selectedTier, setSelectedTier] = useState<Tier | null>(null);
  const [showExtend, setShowExtend] = useState(false);
  const isPremiumActive = currentTier === 'premium';

  function handleSelect(tier: Tier) {
    if (tier === currentTier) {
      setSelectedTier(null); // deselect if already current
      return;
    }
    setSelectedTier(tier);
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Plan
      </p>

      {/* Tier cards */}
      <div className="flex gap-2">
        {TIERS.map(tier => {
          const isCurrent = tier.key === currentTier;
          const isSelected = tier.key === selectedTier;
          const Icon = tier.icon;

          return (
            <button
              key={tier.key}
              onClick={() => handleSelect(tier.key)}
              className={`flex-1 rounded-lg border p-3 text-left transition-colors ${
                isCurrent
                  ? 'border-primary bg-primary/5'
                  : isSelected
                    ? 'border-amber-500 bg-amber-500/5'
                    : 'border-border hover:border-muted-foreground/30'
              }`}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <Icon className={`w-3.5 h-3.5 ${isCurrent ? 'text-primary' : 'text-muted-foreground'}`} />
                <span className="text-xs font-semibold">{tier.label}</span>
                {isCurrent && (
                  <span className="ml-auto text-[9px] bg-primary/10 text-primary px-1.5 py-0.5 rounded font-medium">
                    Current
                  </span>
                )}
              </div>
              <p className="text-[11px] font-medium text-foreground">{tier.points}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{tier.features}</p>
            </button>
          );
        })}
      </div>

      {/* Premium expiry info + extend option */}
      {isPremiumActive && tierStatus?.premiumExpiresAt && (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground">
            Premium expires {new Date(tierStatus.premiumExpiresAt).toLocaleDateString('en-US', {
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })}
          </p>
          {!showExtend && (
            <button
              onClick={() => setShowExtend(true)}
              className="text-[11px] text-primary hover:underline font-medium"
            >
              Extend subscription
            </button>
          )}
          {showExtend && (
            <UpgradePremium extendMode />
          )}
        </div>
      )}

      {/* Upgrade flow — shown when free user selects premium */}
      {selectedTier === 'premium' && currentTier === 'free' && (
        <UpgradePremium />
      )}

      {/* Info when premium user taps Free */}
      {selectedTier === 'free' && isPremiumActive && (
        <div className="rounded-lg border border-muted p-3 space-y-1">
          <div className="flex items-center gap-1.5">
            <Check className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">No action needed</span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Your premium plan will revert to Free when it expires on{' '}
            {tierStatus?.premiumExpiresAt
              ? new Date(tierStatus.premiumExpiresAt).toLocaleDateString('en-US', {
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })
              : 'the end of your billing period'}
            . No cancellation needed.
          </p>
        </div>
      )}
    </div>
  );
}
