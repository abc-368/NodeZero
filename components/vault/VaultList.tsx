/**
 * VaultList — Main vault screen showing all entries with search,
 * view-mode grouping (All / By Domain / By Login), and virtualized scrolling.
 */

import React, { useState, useCallback, useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Plus, Search, Lock, RefreshCw, Settings, ChevronRight, ChevronDown, Maximize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EntryCard } from './EntryCard';
import { TokenCounter } from './TokenCounter';
import { SyncLimitReached } from './SyncLimitReached';
import { Layout, Header } from '@/components/shared/Layout';
import { VaultEntry } from '@/lib/vault/entry';
import { searchEntries, groupByDomain, groupByLogin, GroupedEntries } from '@/lib/vault/vault';
import { MessageType, MessageFrom } from '@/lib/types';

// ── Types ─────────────────────────────────────────────────────────────────

type ViewMode = 'all' | 'domain' | 'login';

type VirtualRow =
  | { type: 'entry'; entry: VaultEntry }
  | { type: 'header'; key: string; label: string; count: number; collapsed: boolean };

interface VaultListProps {
  entries: VaultEntry[];
  onAddEntry: () => void;
  onEditEntry: (entry: VaultEntry) => void;
  onLock: () => void;
  onSettings: () => void;
  onRefresh: () => void;
  syncing?: boolean;
  syncStatus?: { type: 'success' | 'error', message: string } | null;
}

// ── Row height estimates ──────────────────────────────────────────────────

const HEADER_HEIGHT = 36;
const ENTRY_HEIGHT = 72;

// ── Component ─────────────────────────────────────────────────────────────

export function VaultList({
  entries,
  onAddEntry,
  onEditEntry,
  onLock,
  onSettings,
  onRefresh,
  syncing = false,
  syncStatus = null,
}: VaultListProps) {
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Data pipeline: filter → group → flatten ────────────────────────────

  const filtered = useMemo(() => searchEntries(entries, query), [entries, query]);

  const virtualRows = useMemo<VirtualRow[]>(() => {
    if (viewMode === 'all') {
      return filtered.map(entry => ({ type: 'entry' as const, entry }));
    }

    const groups: GroupedEntries[] =
      viewMode === 'domain' ? groupByDomain(filtered) : groupByLogin(filtered);

    const rows: VirtualRow[] = [];
    for (const group of groups) {
      const isCollapsed = collapsed.has(group.key);
      rows.push({
        type: 'header',
        key: group.key,
        label: group.label,
        count: group.entries.length,
        collapsed: isCollapsed,
      });
      if (!isCollapsed) {
        for (const entry of group.entries) {
          rows.push({ type: 'entry', entry });
        }
      }
    }
    return rows;
  }, [filtered, viewMode, collapsed]);

  // ── Virtualizer ────────────────────────────────────────────────────────

  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      virtualRows[index].type === 'header' ? HEADER_HEIGHT : ENTRY_HEIGHT,
    overscan: 5,
  });

  // ── Handlers ───────────────────────────────────────────────────────────

  const handleDeleteEntry = useCallback(async (entryId: string) => {
    await browser.runtime.sendMessage({
      type: MessageType.deleteVaultEntry,
      from: MessageFrom.popup,
      payload: entryId,
    });
    onRefresh();
  }, [onRefresh]);

  const toggleCollapse = useCallback((key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Reset collapsed state when switching view modes
  const handleViewMode = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    setCollapsed(new Set());
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <Layout>
      <Header
        title="NodeZero"
        left={
          <Button
            variant="ghost"
            size="sm"
            onClick={onSettings}
            className="h-7 w-7 p-0 text-muted-foreground"
            title="Settings"
            aria-label="Settings"
          >
            <Settings className="w-3.5 h-3.5" />
          </Button>
        }
        right={
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={onRefresh}
              className="h-7 w-7 p-0 text-muted-foreground"
              title="Sync"
              disabled={syncing}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                chrome.windows.create({
                  url: chrome.runtime.getURL('popup.html'),
                  type: 'popup',
                  width: 420,
                  height: 720,
                });
                window.close(); // close the popup
              }}
              className="h-7 w-7 p-0 text-muted-foreground"
              title="Pop out to window"
              aria-label="Pop out to resizable window"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onLock}
              className="h-7 w-7 p-0 text-muted-foreground"
              title="Lock vault"
            >
              <Lock className="w-3.5 h-3.5" />
            </Button>
          </div>
        }
      />

      {/* Search bar */}
      <div className="px-3 py-2 border-b border-border relative">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Search credentials…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="pl-8 h-8 text-xs"
          />
        </div>

        {/* Sync status overlay */}
        {syncStatus && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/95 animate-in fade-in zoom-in duration-300">
            <p role="alert" className={`text-[11px] font-medium ${
              syncStatus.type === 'success' ? 'text-green-500' : 'text-destructive'
            }`}>
              {syncStatus.message}
            </p>
          </div>
        )}
      </div>

      {/* View mode toggle */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border bg-card">
        {(['all', 'domain', 'login'] as const).map(mode => (
          <button
            key={mode}
            onClick={() => handleViewMode(mode)}
            className={`
              px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors
              ${viewMode === mode
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'}
            `}
          >
            {mode === 'all' ? 'All' : mode === 'domain' ? 'By Domain' : 'By Login'}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
          {filtered.length} {filtered.length === 1 ? 'entry' : 'entries'}
        </span>
      </div>

      {/* Sync limit alert — shown when daily tokens are depleted or low */}
      <SyncLimitReached />

      {/* Virtualized entry list */}
      {filtered.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 py-16 text-center px-6">
          {query ? (
            <>
              <p className="text-sm text-muted-foreground">No results for "{query}"</p>
              <Button variant="ghost" size="sm" onClick={() => setQuery('')}>
                Clear search
              </Button>
            </>
          ) : (
            <>
              <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center">
                <Lock className="w-6 h-6 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">Your vault is empty</p>
                <p className="text-xs text-muted-foreground">
                  Add your first credential to get started.
                </p>
              </div>
              <Button onClick={onAddEntry} size="sm" className="gap-1.5">
                <Plus className="w-3.5 h-3.5" /> Add Credential
              </Button>
            </>
          )}
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map(virtualItem => {
              const row = virtualRows[virtualItem.index];
              return (
                <div
                  key={virtualItem.key}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualItem.size}px`,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  {row.type === 'header' ? (
                    <GroupHeader
                      label={row.label}
                      count={row.count}
                      collapsed={row.collapsed}
                      onToggle={() => toggleCollapse(row.key)}
                    />
                  ) : (
                    <EntryCard
                      entry={row.entry}
                      onEdit={() => onEditEntry(row.entry)}
                      onDelete={() => handleDeleteEntry(row.entry.id)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="shrink-0 border-t border-border bg-card">
        <div className="px-4 py-3">
          <Button onClick={onAddEntry} className="w-full gap-2" size="sm">
            <Plus className="w-4 h-4" />
            Add Credential
          </Button>
        </div>
        {/* Token balance — inside the footer block so it never clips */}
        <TokenCounter />
      </div>
    </Layout>
  );
}

// ── Group header sub-component ────────────────────────────────────────────

interface GroupHeaderProps {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}

function GroupHeader({ label, count, collapsed, onToggle }: GroupHeaderProps) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-3 py-2 bg-muted/50 hover:bg-muted transition-colors cursor-pointer border-b border-border"
    >
      {collapsed
        ? <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      }
      <span className="text-xs font-medium text-foreground truncate">{label}</span>
      <span className="ml-auto text-[10px] text-muted-foreground tabular-nums shrink-0">
        {count}
      </span>
    </button>
  );
}
