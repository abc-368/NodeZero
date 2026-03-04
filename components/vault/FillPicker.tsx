/**
 * FillPicker — Select which credential to fill on the active page
 *
 * Shown when "Fill Credentials" context menu finds matches for the
 * current domain. Each row shows title, username, and last updated date.
 *
 * Two interaction modes:
 *   1. Click the entry row → auto-fill username + password on the page
 *   2. Click the copy icon next to username/password → copy to clipboard
 *      (fallback when auto-fill doesn't work on unrecognized fields)
 */

import React, { useState, useCallback } from 'react';
import { ArrowLeft, Globe, CheckCircle, Copy, Check, User, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Layout, Header, ScrollableBody } from '@/components/shared/Layout';
import { VaultEntry, getFaviconUrl, extractHostname } from '@/lib/vault/entry';
import { MessageType, MessageFrom } from '@/lib/types';

interface FillPickerProps {
  entries: VaultEntry[];
  tabId: number;
  onFilled: () => void;
  onCancel: () => void;
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function FillPicker({ entries, tabId, onFilled, onCancel }: FillPickerProps) {
  const [filledId, setFilledId] = useState<string | null>(null);
  const [filling, setFilling] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null); // "user:entryId" or "pass:entryId"

  const handleFill = useCallback(async (entry: VaultEntry) => {
    setFilling(true);
    try {
      // Route fill through background — background has guaranteed activeTab
      // from the context menu click and handles content script injection.
      await browser.runtime.sendMessage({
        type: MessageType.fillCredentials,
        from: MessageFrom.popup,
        payload: { tabId, username: entry.username, password: entry.password },
      });
      setFilledId(entry.id);
      // Brief success feedback before closing
      setTimeout(() => onFilled(), 600);
    } catch (err) {
      console.error('[NodeZero] Fill from picker failed:', err);
      setFilling(false);
    }
  }, [tabId, onFilled]);

  const handleCopy = useCallback(async (text: string, fieldKey: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger the row's fill action
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopiedField(fieldKey);
    setTimeout(() => setCopiedField(null), 2000);
  }, []);

  return (
    <Layout>
      <Header
        title="Fill Credentials"
        left={
          <Button variant="ghost" size="sm" onClick={onCancel} className="h-7 w-7 p-0">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        }
      />
      <ScrollableBody className="divide-y">
        {entries.map(entry => {
          const hostname = extractHostname(entry.url);
          const faviconUrl = getFaviconUrl(entry.url);
          const isFilled = filledId === entry.id;

          return (
            <div key={entry.id} className="px-3 py-3 space-y-2">
              {/* Main row — click to auto-fill */}
              <button
                onClick={() => handleFill(entry)}
                disabled={filling}
                className="w-full flex items-start gap-3 text-left hover:bg-accent/50 rounded-md px-1 py-1 transition-colors disabled:opacity-50"
              >
                {/* Favicon */}
                <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0 mt-0.5">
                  {isFilled ? (
                    <CheckCircle className="w-5 h-5 text-green-500" />
                  ) : faviconUrl ? (
                    <img
                      src={faviconUrl}
                      alt=""
                      className="w-5 h-5 rounded"
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <Globe className="w-4 h-4 text-muted-foreground" />
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0 space-y-0.5">
                  <span className="text-sm font-medium truncate block">
                    {entry.title || hostname || 'Untitled'}
                  </span>
                  {entry.username && (
                    <span className="text-xs text-muted-foreground truncate block">
                      {entry.username}
                    </span>
                  )}
                  <span className="text-[10px] text-muted-foreground/60 block">
                    {formatDate(entry.updatedAt)}
                  </span>
                </div>
              </button>

              {/* Copy buttons — fallback when auto-fill can't match fields */}
              <div className="flex gap-2 pl-12">
                {entry.username && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={(e) => handleCopy(entry.username, `user:${entry.id}`, e)}
                    className="h-7 gap-1.5 text-xs flex-1"
                  >
                    {copiedField === `user:${entry.id}`
                      ? <><Check className="w-3 h-3 text-green-500" /> Copied</>
                      : <><User className="w-3 h-3" /> Copy user</>
                    }
                  </Button>
                )}
                {entry.password && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={(e) => handleCopy(entry.password, `pass:${entry.id}`, e)}
                    className="h-7 gap-1.5 text-xs flex-1"
                  >
                    {copiedField === `pass:${entry.id}`
                      ? <><Check className="w-3 h-3 text-green-500" /> Copied</>
                      : <><KeyRound className="w-3 h-3" /> Copy pass</>
                    }
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </ScrollableBody>
    </Layout>
  );
}
