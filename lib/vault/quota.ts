/**
 * Vault storage quota utilities.
 *
 * Computes the vault size in bytes as the CBOR-serialized bundle length —
 * this matches exactly what the backend receives during upload and checks
 * against tier limits.
 */

import { serializeBundle, loadVaultFromStorage, type VaultBundle } from './vault';

/** Tier limits in bytes (must match shared/tier.ts on the backend). */
export const QUOTA_LIMITS = {
  free:    2 * 1024 * 1024,   // 2 MB
  premium: 50 * 1024 * 1024,  // 50 MB
} as const;

export type QuotaTier = keyof typeof QUOTA_LIMITS;

export interface QuotaInfo {
  /** Current vault size in bytes (CBOR-serialized). */
  usedBytes: number;
  /** Tier limit in bytes. */
  limitBytes: number;
  /** Usage as 0–100 percentage. */
  percent: number;
  /** Severity level for UI coloring. */
  severity: 'ok' | 'warning' | 'critical';
  /** Human-readable label, e.g. "1.2 MB / 2 MB". */
  label: string;
}

/**
 * Compute the vault size in bytes from the current bundle in storage.
 * Returns 0 if no vault exists yet.
 */
export async function getVaultSizeBytes(): Promise<number> {
  const bundle = await loadVaultFromStorage();
  if (!bundle) return 0;
  return serializeBundle(bundle).byteLength;
}

/**
 * Get full quota info for the current vault.
 */
export async function getQuotaInfo(tier: QuotaTier = 'free'): Promise<QuotaInfo> {
  const usedBytes = await getVaultSizeBytes();
  const limitBytes = QUOTA_LIMITS[tier];
  const percent = limitBytes > 0 ? Math.min(100, Math.round((usedBytes / limitBytes) * 100)) : 0;

  let severity: QuotaInfo['severity'] = 'ok';
  if (percent >= 95) severity = 'critical';
  else if (percent >= 80) severity = 'warning';

  return {
    usedBytes,
    limitBytes,
    percent,
    severity,
    label: `${formatBytes(usedBytes)} / ${formatBytes(limitBytes)}`,
  };
}

/** Format bytes as human-readable string. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
