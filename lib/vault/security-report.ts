/**
 * security-report.ts — Vault security health scoring
 *
 * Three checks:
 *   1. Weak passwords — zxcvbn score < 2 (out of 4)
 *   2. Reused passwords — same password across multiple sites
 *   3. Old passwords — updatedAt > 365 days ago
 *
 * Composite score 0–100 (higher is better).
 */

import { zxcvbn, zxcvbnOptions } from '@zxcvbn-ts/core';
import * as zxcvbnCommonPackage from '@zxcvbn-ts/language-common';
import * as zxcvbnEnPackage from '@zxcvbn-ts/language-en';
import type { VaultEntry } from '@/lib/vault/entry';

// ── Initialize zxcvbn ─────────────────────────────────────────────────────────

const options = {
  translations: zxcvbnEnPackage.translations,
  graphs: zxcvbnCommonPackage.adjacencyGraphs,
  dictionary: {
    ...zxcvbnCommonPackage.dictionary,
    ...zxcvbnEnPackage.dictionary,
  },
};
zxcvbnOptions.setOptions(options);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WeakEntry {
  id: string;
  title: string;
  url: string;
  score: number;          // 0–4 (zxcvbn)
  feedback: string;       // human-readable suggestion
}

export interface ReusedGroup {
  entries: { id: string; title: string; url: string }[];
  count: number;          // how many share this password
}

export interface OldEntry {
  id: string;
  title: string;
  url: string;
  daysSinceUpdate: number;
}

export interface SecurityReport {
  score: number;          // 0–100 (higher = better)
  weak: WeakEntry[];
  reused: ReusedGroup[];
  old: OldEntry[];
  totalEntries: number;
  checkedEntries: number; // entries with non-empty passwords
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Passwords with zxcvbn score below this are "weak" */
const WEAK_THRESHOLD = 2;

/** Passwords unchanged for this many days are "old" */
const OLD_DAYS_THRESHOLD = 365;

// ── Report generation ─────────────────────────────────────────────────────────

/**
 * Generate a security report from decrypted vault entries.
 *
 * Only analyses entries with non-empty passwords (skips notes-only entries).
 */
export function generateSecurityReport(entries: VaultEntry[]): SecurityReport {
  const now = Date.now();
  const withPasswords = entries.filter(e => e.password && e.password.length > 0);

  const weak: WeakEntry[] = [];
  const old: OldEntry[] = [];
  const passwordMap = new Map<string, { id: string; title: string; url: string }[]>();

  for (const entry of withPasswords) {
    // ── Weak password check ───────────────────────────────────────────────
    const result = zxcvbn(entry.password, [entry.username, entry.title, entry.url].filter(Boolean));
    if (result.score < WEAK_THRESHOLD) {
      const suggestion = result.feedback.suggestions?.[0]
        ?? result.feedback.warning
        ?? 'Use a longer, more complex password';
      weak.push({
        id: entry.id,
        title: entry.title || entry.url || 'Untitled',
        url: entry.url,
        score: result.score,
        feedback: suggestion,
      });
    }

    // ── Reuse tracking ────────────────────────────────────────────────────
    const existing = passwordMap.get(entry.password);
    if (existing) {
      existing.push({
        id: entry.id,
        title: entry.title || entry.url || 'Untitled',
        url: entry.url,
      });
    } else {
      passwordMap.set(entry.password, [{
        id: entry.id,
        title: entry.title || entry.url || 'Untitled',
        url: entry.url,
      }]);
    }

    // ── Old password check ────────────────────────────────────────────────
    const daysSinceUpdate = Math.floor((now - entry.updatedAt) / (24 * 60 * 60 * 1000));
    if (daysSinceUpdate >= OLD_DAYS_THRESHOLD) {
      old.push({
        id: entry.id,
        title: entry.title || entry.url || 'Untitled',
        url: entry.url,
        daysSinceUpdate,
      });
    }
  }

  // ── Build reused groups ─────────────────────────────────────────────────
  const reused: ReusedGroup[] = [];
  for (const [, group] of passwordMap) {
    if (group.length >= 2) {
      reused.push({ entries: group, count: group.length });
    }
  }
  reused.sort((a, b) => b.count - a.count);

  // ── Composite score ─────────────────────────────────────────────────────
  const score = computeScore(withPasswords.length, weak.length, reused, old.length);

  return {
    score,
    weak,
    reused,
    old,
    totalEntries: entries.length,
    checkedEntries: withPasswords.length,
  };
}

/**
 * Compute composite score 0–100.
 *
 * Scoring:
 *   - Start at 100
 *   - Lose up to 40 points for weak passwords (proportional)
 *   - Lose up to 35 points for reused passwords (proportional)
 *   - Lose up to 25 points for old passwords (proportional)
 */
function computeScore(
  total: number,
  weakCount: number,
  reusedGroups: ReusedGroup[],
  oldCount: number,
): number {
  if (total === 0) return 100; // No passwords to check

  const weakRatio = weakCount / total;
  const reusedCount = reusedGroups.reduce((sum, g) => sum + g.count, 0);
  const reusedRatio = reusedCount / total;
  const oldRatio = oldCount / total;

  const weakPenalty = Math.min(40, Math.round(weakRatio * 40));
  const reusedPenalty = Math.min(35, Math.round(reusedRatio * 35));
  const oldPenalty = Math.min(25, Math.round(oldRatio * 25));

  return Math.max(0, 100 - weakPenalty - reusedPenalty - oldPenalty);
}

/**
 * Get a human-readable grade from a score.
 */
export function getGrade(score: number): { letter: string; color: string } {
  if (score >= 90) return { letter: 'A', color: 'text-green-600 dark:text-green-400' };
  if (score >= 75) return { letter: 'B', color: 'text-lime-600 dark:text-lime-400' };
  if (score >= 60) return { letter: 'C', color: 'text-amber-600 dark:text-amber-400' };
  if (score >= 40) return { letter: 'D', color: 'text-orange-600 dark:text-orange-400' };
  return { letter: 'F', color: 'text-red-600 dark:text-red-400' };
}
