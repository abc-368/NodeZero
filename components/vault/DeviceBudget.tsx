/**
 * DeviceBudget — Settings slider for per-device token budget.
 *
 * Controls how many sync tokens this device requests from the daily pool.
 * Lowering the budget on one device leaves more tokens for other devices.
 *
 * Range: MIN_DEVICE_BUDGET (10) to dailyAllowance (server-provided).
 * Default: server-provided defaultDeviceBudget, or FALLBACK_DEVICE_BUDGET before first contact.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  getDeviceBudget,
  setDeviceBudget,
  getPoolMeta,
  type TokenPoolMeta,
} from '@/lib/tokens/pool';
import {
  MIN_DEVICE_BUDGET,
  FALLBACK_DEVICE_BUDGET,
} from '@/lib/constants';
import { Slider } from '@/components/ui/slider';
import { Cpu } from 'lucide-react';

export function DeviceBudget() {
  const [budget, setBudget] = useState<number>(FALLBACK_DEVICE_BUDGET);
  const [meta, setMeta] = useState<TokenPoolMeta | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getDeviceBudget().then(setBudget);
    getPoolMeta().then(setMeta);
  }, []);

  const dailyAllowance = meta?.dailyAllowance ?? 100;
  const maxBudget = dailyAllowance;
  const isPremium = dailyAllowance > 100;

  const handleChange = useCallback(async (value: number[]) => {
    const newBudget = value[0];
    setBudget(newBudget);
    setSaving(true);
    await setDeviceBudget(newBudget);
    setSaving(false);
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <Cpu className="w-3.5 h-3.5 text-muted-foreground" />
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Device Points Budget
        </p>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Max points this device can claim per day. Lower this if you use
        multiple devices.
      </p>

      <div className="space-y-2">
        <Slider
          value={[budget]}
          onValueChange={handleChange}
          min={MIN_DEVICE_BUDGET}
          max={maxBudget}
          step={isPremium ? 10 : 5}
          className="w-full"
        />
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground">
            {MIN_DEVICE_BUDGET}
          </span>
          <span className="text-xs font-medium tabular-nums">
            {budget} / {dailyAllowance}
            {saving && (
              <span className="text-muted-foreground ml-1 text-[10px]">saving…</span>
            )}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {maxBudget}
          </span>
        </div>
      </div>

      <p className="text-[10px] text-muted-foreground italic">
        {budget === maxBudget
          ? 'This device will use the full daily allowance.'
          : `Reserves ${maxBudget - budget} points for other devices.`}
      </p>
    </div>
  );
}
