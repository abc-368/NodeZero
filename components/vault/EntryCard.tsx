/**
 * EntryCard — Single vault entry row in the list
 */

import React, { useState, useCallback } from 'react';
import { Eye, EyeOff, Copy, Pencil, Trash2, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { VaultEntry, getFaviconUrl, extractHostname } from '@/lib/vault/entry';

interface EntryCardProps {
  entry: VaultEntry;
  onEdit: () => void;
  onDelete: () => void;
}

export function EntryCard({ entry, onEdit, onDelete }: EntryCardProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState<'username' | 'password' | null>(null);

  const handleCopy = useCallback(async (type: 'username' | 'password') => {
    const value = type === 'username' ? entry.username : entry.password;
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  }, [entry]);

  const hostname = extractHostname(entry.url);
  const faviconUrl = getFaviconUrl(entry.url);

  return (
    <div className="flex items-start gap-3 px-3 py-3 hover:bg-accent/50 transition-colors group">
      {/* Favicon */}
      <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0 mt-0.5">
        {faviconUrl ? (
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
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium truncate">{entry.title || hostname || 'Untitled'}</span>
          <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button
              variant="ghost"
              size="sm"
              onClick={onEdit}
              className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
              title="Edit"
            >
              <Pencil className="w-3 h-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
              title="Delete"
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          </div>
        </div>

        {entry.username && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground truncate flex-1">{entry.username}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleCopy('username')}
              className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground shrink-0"
              title="Copy username"
            >
              <Copy className="w-3 h-3" />
            </Button>
          </div>
        )}

        {entry.password && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-mono text-muted-foreground truncate flex-1">
              {showPassword ? entry.password : '••••••••••••'}
            </span>
            <div className="flex items-center gap-0.5 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowPassword(v => !v)}
                className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                title={showPassword ? 'Hide' : 'Show'}
              >
                {showPassword
                  ? <EyeOff className="w-3 h-3" />
                  : <Eye className="w-3 h-3" />
                }
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleCopy('password')}
                className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                title="Copy password"
              >
                <Copy className="w-3 h-3" />
              </Button>
            </div>
          </div>
        )}

        {/* Copied feedback */}
        {copied && (
          <span className="text-xs text-green-600 dark:text-green-400">
            ✓ {copied === 'username' ? 'Username' : 'Password'} copied!
          </span>
        )}
      </div>
    </div>
  );
}
