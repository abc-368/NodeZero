/**
 * Unit tests for lib/email/registry.ts — email normalization and hashing.
 *
 * Tests normalizeEmail (Gmail dots, plus addressing, googlemail unification)
 * and hashEmail (SHA-256 hex output).
 *
 * Note: Cache and lookup functions depend on chrome.storage and network —
 * those are integration-level concerns tested separately.
 */

import { describe, it, expect } from 'vitest';
import { normalizeEmail, hashEmail } from '../../lib/email/registry';

// ── normalizeEmail ───────────────────────────────────────────────────────────

describe('normalizeEmail', () => {
  it('lowercases the entire address', () => {
    expect(normalizeEmail('User@Example.COM')).toBe('user@example.com');
  });

  it('trims whitespace', () => {
    expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com');
  });

  // Gmail-specific rules
  describe('Gmail normalization', () => {
    it('strips dots from local part', () => {
      expect(normalizeEmail('john.doe@gmail.com')).toBe('johndoe@gmail.com');
    });

    it('strips multiple dots', () => {
      expect(normalizeEmail('j.o.h.n@gmail.com')).toBe('john@gmail.com');
    });

    it('strips plus sub-addressing', () => {
      expect(normalizeEmail('user+tag@gmail.com')).toBe('user@gmail.com');
    });

    it('strips dots AND plus addressing', () => {
      expect(normalizeEmail('j.doe+newsletter@gmail.com')).toBe('jdoe@gmail.com');
    });

    it('unifies googlemail.com → gmail.com', () => {
      expect(normalizeEmail('user@googlemail.com')).toBe('user@gmail.com');
    });

    it('applies dot-stripping to googlemail.com too', () => {
      expect(normalizeEmail('j.doe@googlemail.com')).toBe('jdoe@gmail.com');
    });
  });

  // Non-Gmail addresses
  describe('non-Gmail addresses', () => {
    it('preserves dots in non-Gmail local part', () => {
      expect(normalizeEmail('john.doe@outlook.com')).toBe('john.doe@outlook.com');
    });

    it('preserves plus in non-Gmail local part', () => {
      expect(normalizeEmail('user+tag@yahoo.com')).toBe('user+tag@yahoo.com');
    });

    it('lowercases non-Gmail domains', () => {
      expect(normalizeEmail('User@MyCompany.ORG')).toBe('user@mycompany.org');
    });
  });

  // Edge cases
  describe('edge cases', () => {
    it('handles address with no @', () => {
      expect(normalizeEmail('noatsign')).toBe('noatsign');
    });

    it('handles empty string', () => {
      expect(normalizeEmail('')).toBe('');
    });

    it('handles address with only local part and @', () => {
      expect(normalizeEmail('user@')).toBe('user@');
    });
  });
});

// ── hashEmail ────────────────────────────────────────────────────────────────

describe('hashEmail', () => {
  it('returns a 64-char hex string (SHA-256)', async () => {
    const hash = await hashEmail('user@example.com');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', async () => {
    const hash1 = await hashEmail('test@test.com');
    const hash2 = await hashEmail('test@test.com');
    expect(hash1).toBe(hash2);
  });

  it('normalizes before hashing (Gmail dots)', async () => {
    const hash1 = await hashEmail('john.doe@gmail.com');
    const hash2 = await hashEmail('johndoe@gmail.com');
    expect(hash1).toBe(hash2);
  });

  it('normalizes before hashing (case)', async () => {
    const hash1 = await hashEmail('User@Example.COM');
    const hash2 = await hashEmail('user@example.com');
    expect(hash1).toBe(hash2);
  });

  it('normalizes before hashing (googlemail)', async () => {
    const hash1 = await hashEmail('user@googlemail.com');
    const hash2 = await hashEmail('user@gmail.com');
    expect(hash1).toBe(hash2);
  });

  it('different emails produce different hashes', async () => {
    const hash1 = await hashEmail('alice@example.com');
    const hash2 = await hashEmail('bob@example.com');
    expect(hash1).not.toBe(hash2);
  });
});
