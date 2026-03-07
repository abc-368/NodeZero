/**
 * Per-Entry Last-Write-Wins (LWW) Merge with Tombstones
 *
 * Merges two decrypted vault entry sets (local + remote) by comparing
 * each entry's `updatedAt` timestamp. Deleted entries leave tombstone
 * markers that prevent resurrection by stale devices.
 *
 * Pure function — no browser APIs, no side effects, easily testable.
 *
 * Algorithm:
 *   1. Build entry maps (by ID) for both sides
 *   2. Build union tombstone map (later updatedAt wins duplicates)
 *   3. For each unique entry ID:
 *      - Tombstone wins if its updatedAt >= entry's updatedAt
 *      - Otherwise, later updatedAt wins (tie → local wins)
 *   4. Return merged entries + merged tombstones
 */

import type { VaultEntry } from './entry';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Tombstone {
  /** Entry UUID that was deleted */
  id: string;
  /** When the deletion happened (Unix ms) */
  deletedAt: number;
  /** LWW comparison timestamp — same as deletedAt at creation */
  updatedAt: number;
}

export interface MergeInput {
  entries: VaultEntry[];
  tombstones: Tombstone[];
}

export interface MergeResult {
  entries: VaultEntry[];
  tombstones: Tombstone[];
}

// ── Tombstone helpers ────────────────────────────────────────────────────────

export function createTombstone(entryId: string): Tombstone {
  const now = Date.now();
  return { id: entryId, deletedAt: now, updatedAt: now };
}

/**
 * Remove tombstones older than `maxAgeDays` days.
 * Called during sealVault to prevent unbounded growth.
 *
 * Risk: if a device is offline longer than maxAgeDays, pruned tombstones
 * may allow deleted entries to be resurrected. Acceptable per the
 * always-online assumption in CLAUDE.md.
 */
export function pruneTombstones(
  tombstones: Tombstone[],
  maxAgeDays = 90
): Tombstone[] {
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  return tombstones.filter(t => t.deletedAt > cutoff);
}

// ── Core merge ───────────────────────────────────────────────────────────────

export function mergeVaults(local: MergeInput, remote: MergeInput): MergeResult {
  // 1. Build entry maps
  const localEntries = new Map<string, VaultEntry>();
  for (const e of local.entries) localEntries.set(e.id, e);

  const remoteEntries = new Map<string, VaultEntry>();
  for (const e of remote.entries) remoteEntries.set(e.id, e);

  // 2. Build union tombstone map (keep later updatedAt for duplicates)
  const tombstoneMap = new Map<string, Tombstone>();
  for (const t of local.tombstones) {
    tombstoneMap.set(t.id, t);
  }
  for (const t of remote.tombstones) {
    const existing = tombstoneMap.get(t.id);
    if (!existing || t.updatedAt > existing.updatedAt) {
      tombstoneMap.set(t.id, t);
    }
  }

  // 3. Collect all entry IDs from both sides
  const allEntryIds = new Set<string>([
    ...localEntries.keys(),
    ...remoteEntries.keys(),
  ]);

  // 4. Merge each entry
  const mergedEntries: VaultEntry[] = [];

  for (const id of allEntryIds) {
    const localEntry = localEntries.get(id);
    const remoteEntry = remoteEntries.get(id);
    const tombstone = tombstoneMap.get(id);

    // Pick the best entry (the one with higher updatedAt, or whichever exists)
    const bestEntry = pickEntry(localEntry, remoteEntry);
    if (!bestEntry) continue; // shouldn't happen since ID came from one of the maps

    // Check tombstone vs entry
    if (tombstone) {
      if (tombstone.updatedAt >= bestEntry.updatedAt) {
        // Tombstone wins — entry stays dead
        continue;
      } else {
        // Entry is newer than tombstone (re-created after deletion)
        // Remove the stale tombstone, keep the entry
        tombstoneMap.delete(id);
      }
    }

    mergedEntries.push(bestEntry);
  }

  return {
    entries: mergedEntries,
    tombstones: Array.from(tombstoneMap.values()),
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Pick the winning entry between local and remote using LWW.
 * Tie → local wins (deterministic: local is the freshly-edited copy).
 */
function pickEntry(
  local: VaultEntry | undefined,
  remote: VaultEntry | undefined
): VaultEntry | undefined {
  if (!local) return remote;
  if (!remote) return local;

  // LWW: higher updatedAt wins. Tie → local.
  if (remote.updatedAt > local.updatedAt) return remote;
  return local;
}
