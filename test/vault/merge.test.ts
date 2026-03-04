/**
 * Unit tests for lib/vault/merge.ts — LWW conflict resolution.
 *
 * These tests protect against silent data loss during multi-device sync.
 * mergeVaults is the most critical pure function in the codebase: a
 * regression means lost vault entries with no error message.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  mergeVaults,
  pruneTombstones,
  createTombstone,
  type Tombstone,
  type MergeInput,
} from '../../lib/vault/merge';
import type { VaultEntry } from '../../lib/vault/entry';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    id: 'entry-1',
    type: 'login',
    title: 'Test',
    url: 'https://example.com',
    username: 'user',
    password: 'pass',
    notes: '',
    tags: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeTombstone(id: string, deletedAt: number): Tombstone {
  return { id, deletedAt, updatedAt: deletedAt };
}

const EMPTY: MergeInput = { entries: [], tombstones: [] };

// ── mergeVaults ─────────────────────────────────────────────────────────────

describe('mergeVaults', () => {
  it('returns empty when both sides are empty', () => {
    const result = mergeVaults(EMPTY, EMPTY);
    expect(result.entries).toEqual([]);
    expect(result.tombstones).toEqual([]);
  });

  it('preserves local-only entries', () => {
    const entry = makeEntry({ id: 'a', updatedAt: 100 });
    const result = mergeVaults(
      { entries: [entry], tombstones: [] },
      EMPTY
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe('a');
  });

  it('preserves remote-only entries', () => {
    const entry = makeEntry({ id: 'b', updatedAt: 200 });
    const result = mergeVaults(
      EMPTY,
      { entries: [entry], tombstones: [] }
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe('b');
  });

  it('keeps the entry with higher updatedAt (local newer)', () => {
    const local = makeEntry({ id: 'x', updatedAt: 300, title: 'Local' });
    const remote = makeEntry({ id: 'x', updatedAt: 200, title: 'Remote' });
    const result = mergeVaults(
      { entries: [local], tombstones: [] },
      { entries: [remote], tombstones: [] }
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].title).toBe('Local');
  });

  it('keeps the entry with higher updatedAt (remote newer)', () => {
    const local = makeEntry({ id: 'x', updatedAt: 200, title: 'Local' });
    const remote = makeEntry({ id: 'x', updatedAt: 300, title: 'Remote' });
    const result = mergeVaults(
      { entries: [local], tombstones: [] },
      { entries: [remote], tombstones: [] }
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].title).toBe('Remote');
  });

  it('local wins on tie (same updatedAt)', () => {
    const local = makeEntry({ id: 'x', updatedAt: 500, title: 'Local' });
    const remote = makeEntry({ id: 'x', updatedAt: 500, title: 'Remote' });
    const result = mergeVaults(
      { entries: [local], tombstones: [] },
      { entries: [remote], tombstones: [] }
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].title).toBe('Local');
  });

  it('tombstone removes entry when tombstone is newer', () => {
    const entry = makeEntry({ id: 'del', updatedAt: 100 });
    const tombstone = makeTombstone('del', 200);
    const result = mergeVaults(
      { entries: [entry], tombstones: [] },
      { entries: [], tombstones: [tombstone] }
    );
    expect(result.entries).toHaveLength(0);
    expect(result.tombstones).toHaveLength(1);
    expect(result.tombstones[0].id).toBe('del');
  });

  it('tombstone removes entry when timestamps are equal', () => {
    const entry = makeEntry({ id: 'del', updatedAt: 100 });
    const tombstone = makeTombstone('del', 100);
    const result = mergeVaults(
      { entries: [entry], tombstones: [tombstone] },
      EMPTY
    );
    expect(result.entries).toHaveLength(0);
  });

  it('entry survives when tombstone is older', () => {
    const entry = makeEntry({ id: 're-created', updatedAt: 300 });
    const tombstone = makeTombstone('re-created', 200);
    const result = mergeVaults(
      { entries: [entry], tombstones: [] },
      { entries: [], tombstones: [tombstone] }
    );
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe('re-created');
    // Stale tombstone should be removed
    expect(result.tombstones.find(t => t.id === 're-created')).toBeUndefined();
  });

  it('later tombstone wins when both sides have tombstones for same entry', () => {
    const localTombstone = makeTombstone('conflict', 100);
    const remoteTombstone = makeTombstone('conflict', 200);
    const result = mergeVaults(
      { entries: [], tombstones: [localTombstone] },
      { entries: [], tombstones: [remoteTombstone] }
    );
    expect(result.tombstones).toHaveLength(1);
    expect(result.tombstones[0].updatedAt).toBe(200);
  });

  it('merges multiple entries from both sides correctly', () => {
    const localEntries = [
      makeEntry({ id: 'a', updatedAt: 100, title: 'A-local' }),
      makeEntry({ id: 'b', updatedAt: 300, title: 'B-local' }),
      makeEntry({ id: 'c', updatedAt: 200, title: 'C-local-only' }),
    ];
    const remoteEntries = [
      makeEntry({ id: 'a', updatedAt: 200, title: 'A-remote' }),
      makeEntry({ id: 'b', updatedAt: 100, title: 'B-remote' }),
      makeEntry({ id: 'd', updatedAt: 400, title: 'D-remote-only' }),
    ];
    const result = mergeVaults(
      { entries: localEntries, tombstones: [] },
      { entries: remoteEntries, tombstones: [] }
    );
    expect(result.entries).toHaveLength(4);
    const byId = new Map(result.entries.map(e => [e.id, e]));
    expect(byId.get('a')!.title).toBe('A-remote');  // remote newer
    expect(byId.get('b')!.title).toBe('B-local');   // local newer
    expect(byId.get('c')!.title).toBe('C-local-only');
    expect(byId.get('d')!.title).toBe('D-remote-only');
  });
});

// ── pruneTombstones ─────────────────────────────────────────────────────────

describe('pruneTombstones', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps tombstones newer than maxAgeDays', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const recent = makeTombstone('recent', now - 89 * 86_400_000); // 89 days ago
    const result = pruneTombstones([recent], 90);
    expect(result).toHaveLength(1);
  });

  it('removes tombstones older than maxAgeDays', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const old = makeTombstone('old', now - 91 * 86_400_000); // 91 days ago
    const result = pruneTombstones([old], 90);
    expect(result).toHaveLength(0);
  });

  it('handles mixed ages correctly', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const tombstones = [
      makeTombstone('keep', now - 30 * 86_400_000),
      makeTombstone('prune', now - 100 * 86_400_000),
      makeTombstone('borderline', now - 90 * 86_400_000), // exactly 90 days = cutoff
    ];
    const result = pruneTombstones(tombstones, 90);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('keep');
  });
});

// ── createTombstone ─────────────────────────────────────────────────────────

describe('createTombstone', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a tombstone with correct ID and timestamps', () => {
    const now = 1700000000000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const tombstone = createTombstone('test-id');
    expect(tombstone.id).toBe('test-id');
    expect(tombstone.deletedAt).toBe(now);
    expect(tombstone.updatedAt).toBe(now);
  });
});
