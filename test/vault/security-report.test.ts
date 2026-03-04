/**
 * Security report tests
 *
 * Tests weak password detection, reuse grouping, old password flagging,
 * and composite score calculation.
 */

import { describe, it, expect } from 'vitest';
import {
  generateSecurityReport,
  getGrade,
  type SecurityReport,
} from '@/lib/vault/security-report';
import type { VaultEntry } from '@/lib/vault/entry';

// ── Test helpers ──────────────────────────────────────────────────────────────

const NOW = Date.now();
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function makeEntry(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: crypto.randomUUID(),
    type: 'login',
    title: 'Test Site',
    url: 'https://example.com',
    username: 'user@example.com',
    password: 'CorrectHorseBatteryStaple42!',  // strong by default
    notes: '',
    tags: [],
    createdAt: NOW - 30 * ONE_DAY_MS,
    updatedAt: NOW - 30 * ONE_DAY_MS,
    ...overrides,
  };
}

// ── Weak password detection ───────────────────────────────────────────────────

describe('weak password detection', () => {
  it('flags known-weak passwords (score < 2)', () => {
    const entries = [
      makeEntry({ password: 'password', title: 'Weak Site 1' }),
      makeEntry({ password: '123456', title: 'Weak Site 2' }),
      makeEntry({ password: 'qwerty', title: 'Weak Site 3' }),
    ];

    const report = generateSecurityReport(entries);
    expect(report.weak.length).toBe(3);
    report.weak.forEach(w => expect(w.score).toBeLessThan(2));
  });

  it('does not flag strong passwords', () => {
    const entries = [
      makeEntry({ password: 'xK9$mP2vL!qR7nW3', title: 'Strong 1' }),
      makeEntry({ password: 'CorrectHorseBatteryStaple42!', title: 'Strong 2' }),
      makeEntry({ password: 'j8#Fm@9kLp$2wN!x', title: 'Strong 3' }),
    ];

    const report = generateSecurityReport(entries);
    expect(report.weak.length).toBe(0);
  });

  it('provides feedback for weak passwords', () => {
    const report = generateSecurityReport([
      makeEntry({ password: 'password' }),
    ]);
    expect(report.weak[0].feedback.length).toBeGreaterThan(0);
  });
});

// ── Reuse detection ───────────────────────────────────────────────────────────

describe('reuse detection', () => {
  it('groups entries sharing the same password', () => {
    const sharedPassword = 'SharedPass123!@#xyz';
    const entries = [
      makeEntry({ password: sharedPassword, title: 'Site A', url: 'https://a.com' }),
      makeEntry({ password: sharedPassword, title: 'Site B', url: 'https://b.com' }),
      makeEntry({ password: sharedPassword, title: 'Site C', url: 'https://c.com' }),
      makeEntry({ password: 'UniquePa$$w0rd!xyz', title: 'Unique Site' }),
    ];

    const report = generateSecurityReport(entries);
    expect(report.reused.length).toBe(1);
    expect(report.reused[0].count).toBe(3);
    expect(report.reused[0].entries).toHaveLength(3);
  });

  it('creates separate groups for different shared passwords', () => {
    const entries = [
      makeEntry({ password: 'GroupA_Pass!123xyz', title: 'A1' }),
      makeEntry({ password: 'GroupA_Pass!123xyz', title: 'A2' }),
      makeEntry({ password: 'GroupB_Pass!456xyz', title: 'B1' }),
      makeEntry({ password: 'GroupB_Pass!456xyz', title: 'B2' }),
    ];

    const report = generateSecurityReport(entries);
    expect(report.reused.length).toBe(2);
    expect(report.reused.every(g => g.count === 2)).toBe(true);
  });

  it('does not flag unique passwords as reused', () => {
    const entries = [
      makeEntry({ password: 'Unique1!@#xyzAbc', title: 'Site 1' }),
      makeEntry({ password: 'Unique2!@#xyzDef', title: 'Site 2' }),
      makeEntry({ password: 'Unique3!@#xyzGhi', title: 'Site 3' }),
    ];

    const report = generateSecurityReport(entries);
    expect(report.reused.length).toBe(0);
  });

  it('sorts reused groups by count (highest first)', () => {
    const entries = [
      makeEntry({ password: 'SmallGroup!xyzAbc' }),
      makeEntry({ password: 'SmallGroup!xyzAbc' }),
      makeEntry({ password: 'BigGroup!!xyzDef' }),
      makeEntry({ password: 'BigGroup!!xyzDef' }),
      makeEntry({ password: 'BigGroup!!xyzDef' }),
    ];

    const report = generateSecurityReport(entries);
    expect(report.reused[0].count).toBeGreaterThanOrEqual(report.reused[1].count);
  });
});

// ── Old password detection ────────────────────────────────────────────────────

describe('old password detection', () => {
  it('flags passwords older than 365 days', () => {
    const entries = [
      makeEntry({ updatedAt: NOW - 400 * ONE_DAY_MS, title: 'Old' }),
      makeEntry({ updatedAt: NOW - 366 * ONE_DAY_MS, title: 'Barely Old' }),
    ];

    const report = generateSecurityReport(entries);
    expect(report.old.length).toBe(2);
    expect(report.old[0].daysSinceUpdate).toBeGreaterThanOrEqual(365);
  });

  it('does not flag passwords updated within 365 days', () => {
    const entries = [
      makeEntry({ updatedAt: NOW - 364 * ONE_DAY_MS, title: 'Recent' }),
      makeEntry({ updatedAt: NOW - 30 * ONE_DAY_MS, title: 'Fresh' }),
      makeEntry({ updatedAt: NOW, title: 'Just Updated' }),
    ];

    const report = generateSecurityReport(entries);
    expect(report.old.length).toBe(0);
  });

  it('reports correct days since update', () => {
    const entries = [
      makeEntry({ updatedAt: NOW - 500 * ONE_DAY_MS }),
    ];

    const report = generateSecurityReport(entries);
    expect(report.old[0].daysSinceUpdate).toBe(500);
  });
});

// ── Composite score ───────────────────────────────────────────────────────────

describe('composite score', () => {
  it('perfect score (100) for all strong, unique, recent passwords', () => {
    const entries = [
      makeEntry({ password: 'xK9$mP2vL!qR7nW3_a', updatedAt: NOW }),
      makeEntry({ password: 'j8#Fm@9kLp$2wN!x_b', updatedAt: NOW }),
      makeEntry({ password: 'rT5%hY1nQ!sB4mK8_c', updatedAt: NOW }),
    ];

    const report = generateSecurityReport(entries);
    expect(report.score).toBe(100);
  });

  it('zero score for all weak, reused, old passwords', () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({
        password: '123456',
        title: `Bad ${i}`,
        updatedAt: NOW - 500 * ONE_DAY_MS,
      }),
    );

    const report = generateSecurityReport(entries);
    expect(report.score).toBe(0);
  });

  it('empty vault gets score 100', () => {
    const report = generateSecurityReport([]);
    expect(report.score).toBe(100);
  });

  it('entries without passwords are skipped', () => {
    const entries = [
      makeEntry({ password: '', title: 'Note only' }),
      makeEntry({ password: 'xK9$mP2vL!qR7nW3_d', updatedAt: NOW }),
    ];

    const report = generateSecurityReport(entries);
    expect(report.totalEntries).toBe(2);
    expect(report.checkedEntries).toBe(1);
    expect(report.score).toBe(100);
  });

  it('score is between 0 and 100', () => {
    const entries = [
      makeEntry({ password: 'password', updatedAt: NOW - 500 * ONE_DAY_MS }),
      makeEntry({ password: 'xK9$mP2vL!qR7nW3_e', updatedAt: NOW }),
    ];

    const report = generateSecurityReport(entries);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });
});

// ── Grade mapping ─────────────────────────────────────────────────────────────

describe('getGrade', () => {
  it('maps scores to correct letter grades', () => {
    expect(getGrade(95).letter).toBe('A');
    expect(getGrade(90).letter).toBe('A');
    expect(getGrade(80).letter).toBe('B');
    expect(getGrade(75).letter).toBe('B');
    expect(getGrade(65).letter).toBe('C');
    expect(getGrade(60).letter).toBe('C');
    expect(getGrade(50).letter).toBe('D');
    expect(getGrade(40).letter).toBe('D');
    expect(getGrade(30).letter).toBe('F');
    expect(getGrade(0).letter).toBe('F');
  });

  it('includes color classes for each grade', () => {
    expect(getGrade(95).color).toContain('green');
    expect(getGrade(80).color).toContain('lime');
    expect(getGrade(65).color).toContain('amber');
    expect(getGrade(50).color).toContain('orange');
    expect(getGrade(20).color).toContain('red');
  });
});
