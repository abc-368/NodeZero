/**
 * StorageQuota — Vault storage usage progress bar for Settings screen.
 *
 * Displays current vault size vs tier limit with color-coded severity:
 *   - Green (<80%): healthy
 *   - Yellow (80–95%): nearing limit
 *   - Red (>95%): critical, show upgrade CTA
 */

import React, { useState, useEffect } from 'react';
import { HardDrive } from 'lucide-react';
import { getQuotaInfo, type QuotaInfo, type QuotaTier } from '@/lib/vault/quota';

interface StorageQuotaProps {
  tier?: QuotaTier;
}

export function StorageQuota({ tier = 'free' }: StorageQuotaProps) {
  const [quota, setQuota] = useState<QuotaInfo | null>(null);

  useEffect(() => {
    getQuotaInfo(tier).then(setQuota);
  }, [tier]);

  if (!quota) return null;

  const barColor =
    quota.severity === 'critical'
      ? 'bg-red-500'
      : quota.severity === 'warning'
      ? 'bg-amber-500'
      : 'bg-emerald-500';

  const textColor =
    quota.severity === 'critical'
      ? 'text-red-500'
      : quota.severity === 'warning'
      ? 'text-amber-500'
      : 'text-muted-foreground';

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <HardDrive className="w-3.5 h-3.5 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Storage
        </p>
      </div>

      {/* Progress bar */}
      <div className="space-y-1.5">
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={`h-full rounded-full transition-all duration-500 ${barColor}`}
            style={{ width: `${Math.max(1, quota.percent)}%` }}
          />
        </div>
        <div className="flex items-center justify-between">
          <span className={`text-[11px] font-medium ${textColor}`}>
            {quota.label}
          </span>
          <span className={`text-[11px] ${textColor}`}>
            {quota.percent}%
          </span>
        </div>
      </div>

      {/* Upgrade CTA when critical */}
      {quota.severity === 'critical' && tier === 'free' && (
        <p className="text-[11px] text-red-500">
          Storage nearly full. Upgrade to Premium for 50 MB.
        </p>
      )}
      {quota.severity === 'warning' && tier === 'free' && (
        <p className="text-[11px] text-amber-500">
          Approaching storage limit. Consider upgrading to Premium.
        </p>
      )}
    </div>
  );
}
