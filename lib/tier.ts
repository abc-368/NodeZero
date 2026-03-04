/**
 * Tier definitions and feature flags.
 *
 * Shared between backend (Worker) and extension.
 * Kept in sync with NodeZero-Backend/shared/tier.ts.
 */

export type Tier = 'free' | 'premium';

export type FeatureFlag =
  | 'attachments'
  | 'sharing'
  | 'security_report'
  | 'delegation_vcs'
  | 'priority_support';

export interface TierLimits {
  maxVaultSize: number;   // bytes
  dailySyncs: number;
}

export const FREE_LIMITS: TierLimits = {
  maxVaultSize: 2 * 1024 * 1024,     // 2 MB
  dailySyncs: 100,
};

export const PREMIUM_LIMITS: TierLimits = {
  maxVaultSize: 50 * 1024 * 1024,    // 50 MB
  dailySyncs: 500,                   // Fallback — actual value is server-authoritative
};

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: FREE_LIMITS,
  premium: PREMIUM_LIMITS,
};

export const PREMIUM_FEATURES: FeatureFlag[] = [
  'attachments',
  'sharing',
  'security_report',
  'delegation_vcs',
  'priority_support',
];

/**
 * Lightweight tier status derived from pool metadata.
 * The single source of truth is `users.tier` on the backend;
 * the extension reads it via the /v2/tokens/balance endpoint
 * and caches it in TokenPoolMeta.
 */
export interface TierStatus {
  tier: Tier;
  premiumExpiresAt: string | null;
}
