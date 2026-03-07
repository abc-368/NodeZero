/**
 * validation.ts — Vault entry and field size limits
 *
 * Enforced client-side before encryption (backend sees only ciphertext).
 * The backend's vault size limit (2 MB free / 50 MB premium) is the hard backstop.
 * These limits are UX guardrails to prevent individual entries from becoming unwieldy.
 */

export const LIMITS = {
  /** Maximum bytes per individual field value. */
  MAX_FIELD_BYTES: 10_240,       // 10 KB per field
  /** Maximum vault entries for free tier. */
  MAX_ENTRIES_FREE: 500,
  /** Maximum vault entries for premium tier. */
  MAX_ENTRIES_PREMIUM: 10_000,
} as const;

/**
 * Per-field character limits.
 * Keeps entries compact and prevents pasting full documents into fields.
 */
export const FIELD_CHAR_LIMITS: Record<string, number> = {
  title:    128,
  url:      2048,
  username: 256,
  password: 512,
  notes:    2000,
  tags:     256,    // the raw comma-separated string
} as const;

/**
 * Check if a field value exceeds the size limit.
 * @returns Error message if too large, null if OK.
 */
export function validateFieldSize(value: string): string | null {
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > LIMITS.MAX_FIELD_BYTES) {
    const kb = Math.round(bytes / 1024 * 10) / 10;
    return `Field value too large (${kb} KB, max ${LIMITS.MAX_FIELD_BYTES / 1024} KB)`;
  }
  return null;
}

/**
 * Check a field value against its character limit.
 * @returns Warning message if over limit, null if OK.
 */
export function validateFieldLength(field: string, value: string): string | null {
  const limit = FIELD_CHAR_LIMITS[field];
  if (!limit) return null;
  if (value.length > limit) {
    return `${value.length - limit} characters over the ${limit} character limit`;
  }
  return null;
}

/**
 * Truncate a value to its field's character limit.
 */
export function truncateField(field: string, value: string): string {
  const limit = FIELD_CHAR_LIMITS[field];
  if (!limit || value.length <= limit) return value;
  return value.slice(0, limit);
}

/**
 * Sanitize all fields of a partial entry to their character limits.
 * Used when importing data from page capture or CSV to prevent oversized values.
 * Returns the sanitized partial + a list of fields that were truncated.
 */
export function sanitizeEntryFields(
  partial: Record<string, unknown>,
): { sanitized: Record<string, unknown>; truncatedFields: string[] } {
  const sanitized = { ...partial };
  const truncatedFields: string[] = [];

  for (const [field, limit] of Object.entries(FIELD_CHAR_LIMITS)) {
    const value = sanitized[field];
    if (typeof value === 'string' && value.length > limit) {
      sanitized[field] = value.slice(0, limit);
      truncatedFields.push(field);
    }
  }

  return { sanitized, truncatedFields };
}

/**
 * Check if the vault has reached its entry limit.
 * @returns Error message if at limit, null if OK.
 */
export function validateEntryCount(
  currentCount: number,
  isPremium: boolean,
): string | null {
  const limit = isPremium ? LIMITS.MAX_ENTRIES_PREMIUM : LIMITS.MAX_ENTRIES_FREE;
  if (currentCount >= limit) {
    return `Vault entry limit reached (${limit} entries for ${isPremium ? 'premium' : 'free'} tier)`;
  }
  return null;
}
