/**
 * ImportScreen — One-Click Migration
 *
 * Guided workflow to import passwords from Chrome, LastPass, 1Password,
 * or Bitwarden via CSV export. Designed to complete in under 60 seconds.
 *
 * Phase 1: CSV file import.
 * Phase 2: Native Chrome passwords API (if ever exposed by browser).
 */

import React, { useState, useRef, useCallback } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollableBody, Header, Layout } from '@/components/shared/Layout';
import { VaultEntry } from '@/lib/vault/entry';
import { importCSV, ImportFormat } from '@/lib/vault/import';
import { MessageType, MessageFrom } from '@/lib/types';

interface ImportScreenProps {
  onImported: (count: number) => void;
  onBack: () => void;
}

type Step = 'select-source' | 'upload' | 'preview' | 'done';

const SOURCE_LABELS: Record<ImportFormat, string> = {
  chrome: 'Chrome',
  lastpass: 'LastPass',
  '1password': '1Password',
  bitwarden: 'Bitwarden',
  unknown: 'Other',
};

const SOURCE_INSTRUCTIONS: Record<ImportFormat, string> = {
  chrome: 'Go to chrome://settings/passwords → click ⋮ → Export passwords → Save CSV.',
  lastpass: 'LastPass → Advanced Options → Export → LastPass CSV File.',
  '1password': '1Password → File → Export → All Items → 1PIF or CSV.',
  bitwarden: 'Bitwarden → Tools → Export Vault → File Format: .csv.',
  unknown: 'Export a CSV from your password manager and upload it here.',
};

const ALL_SOURCES: ImportFormat[] = ['chrome', 'lastpass', 'bitwarden', '1password', 'unknown'];

export function ImportScreen({ onImported, onBack }: ImportScreenProps) {
  const [step, setStep] = useState<Step>('select-source');
  const [selectedSource, setSelectedSource] = useState<ImportFormat>('chrome');
  const [parsedEntries, setParsedEntries] = useState<VaultEntry[]>([]);
  const [detectedFormat, setDetectedFormat] = useState<ImportFormat>('unknown');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importedCount, setImportedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileContent = useCallback((content: string) => {
    setError(null);
    try {
      const { entries, format } = importCSV(content);
      if (entries.length === 0) {
        setError('No valid password entries found in this file.');
        return;
      }
      setParsedEntries(entries);
      setDetectedFormat(format);
      setSelectedIds(new Set(entries.map(e => e.id)));
      setStep('preview');
    } catch (err) {
      setError(`Failed to parse file: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, []);

  const handleFile = useCallback((file: File) => {
    if (!file.name.endsWith('.csv') && file.type !== 'text/csv') {
      setError('Please upload a .csv file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => handleFileContent(e.target?.result as string);
    reader.onerror = () => setError('Failed to read file.');
    reader.readAsText(file);
  }, [handleFileContent]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const toggleEntry = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === parsedEntries.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(parsedEntries.map(e => e.id)));
    }
  };

  const handleImport = async () => {
    const toImport = parsedEntries.filter(e => selectedIds.has(e.id));
    if (toImport.length === 0) return;

    setImporting(true);
    setError(null);
    try {
      const response = await browser.runtime.sendMessage({
        type: MessageType.importEntries,
        from: MessageFrom.popup,
        payload: toImport,
      }) as { success?: boolean; imported?: number; skipped?: number; error?: string };

      if (response.error) throw new Error(response.error);
      setImportedCount(response.imported ?? toImport.length);
      setSkippedCount(response.skipped ?? 0);
      setStep('done');
      onImported(response.imported ?? toImport.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed. Is the vault unlocked?');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Layout>
      <Header
        title="Import Credentials"
        left={
          <Button variant="ghost" size="sm" onClick={onBack} className="h-7 w-7 p-0" aria-label="Back">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        }
      />

      <ScrollableBody className="p-4">
        {/* ── Step: select source ─────────────────────────────────────── */}
        {step === 'select-source' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Where are you importing from?
            </p>
            <div className="grid grid-cols-2 gap-2">
              {ALL_SOURCES.map(src => (
                <Button
                  key={src}
                  variant={selectedSource === src ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSelectedSource(src)}
                  className="justify-start"
                >
                  {SOURCE_LABELS[src]}
                </Button>
              ))}
            </div>

            <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">How to export:</p>
              <p>{SOURCE_INSTRUCTIONS[selectedSource]}</p>
            </div>

            <Button
              className="w-full"
              onClick={() => setStep('upload')}
            >
              Next <ArrowRight className="w-3.5 h-3.5 ml-1" />
            </Button>
          </div>
        )}

        {/* ── Step: upload ─────────────────────────────────────────────── */}
        {step === 'upload' && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Badge variant="outline">{SOURCE_LABELS[selectedSource]}</Badge>
              <span className="text-xs text-muted-foreground">CSV export</span>
            </div>

            {/* Drop zone */}
            <div
              role="button"
              tabIndex={0}
              className={`
                border-2 border-dashed rounded-lg p-6 text-center cursor-pointer
                transition-colors select-none
                ${dragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/30 hover:border-primary/60'}
              `}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
            >
              <p className="text-sm font-medium">Drop CSV here</p>
              <p className="text-xs text-muted-foreground mt-1">or click to browse</p>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />

            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}

            <Button variant="ghost" size="sm" onClick={() => setStep('select-source')} className="w-full gap-1.5">
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </Button>
          </div>
        )}

        {/* ── Step: preview ─────────────────────────────────────────────── */}
        {step === 'preview' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge variant="outline">{SOURCE_LABELS[detectedFormat]}</Badge>
                <span className="text-xs text-muted-foreground">
                  {selectedIds.size} of {parsedEntries.length} selected
                </span>
              </div>
              <Button variant="ghost" size="sm" onClick={toggleAll} className="h-6 text-xs px-2">
                {selectedIds.size === parsedEntries.length ? 'Deselect all' : 'Select all'}
              </Button>
            </div>

            {/* Entry list */}
            <div className="space-y-1 max-h-48 overflow-y-auto rounded border">
              {parsedEntries.map(entry => (
                <label
                  key={entry.id}
                  className="flex items-center gap-2 px-3 py-2 hover:bg-muted/40 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(entry.id)}
                    onChange={() => toggleEntry(entry.id)}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">{entry.title}</p>
                    <p className="text-xs text-muted-foreground truncate">{entry.username}</p>
                  </div>
                </label>
              ))}
            </div>

            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}

            <Button
              className="w-full"
              onClick={handleImport}
              disabled={importing || selectedIds.size === 0}
            >
              {importing
                ? 'Importing…'
                : `Import ${selectedIds.size} entr${selectedIds.size === 1 ? 'y' : 'ies'}`}
            </Button>

            <Button variant="ghost" size="sm" onClick={() => setStep('upload')} className="w-full gap-1.5">
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </Button>
          </div>
        )}

        {/* ── Step: done ───────────────────────────────────────────────── */}
        {step === 'done' && (
          <div className="flex flex-col items-center justify-center py-8 space-y-4 text-center">
            <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <CheckCircle className="w-6 h-6 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <p className="text-base font-semibold">
                {importedCount} {importedCount === 1 ? 'entry' : 'entries'} imported!
              </p>
              {skippedCount > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  {skippedCount} duplicate{skippedCount === 1 ? '' : 's'} skipped
                </p>
              )}
            </div>
            <Button className="w-full" onClick={onBack}>
              Back to Vault
            </Button>
          </div>
        )}
      </ScrollableBody>
    </Layout>
  );
}
