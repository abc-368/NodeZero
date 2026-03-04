/**
 * ExportScreen — CSV Export
 *
 * Simple two-step flow: pick format → download CSV.
 * Mirrors ImportScreen's layout patterns.
 */

import React, { useState, useCallback } from 'react';
import { ArrowLeft, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollableBody, Header, Layout } from '@/components/shared/Layout';
import { VaultEntry } from '@/lib/vault/entry';
import {
  ExportFormat,
  EXPORT_FORMAT_LABELS,
  exportToCSV,
  getExportFilename,
  downloadCSV,
} from '@/lib/vault/export';

interface ExportScreenProps {
  entries: VaultEntry[];
  onBack: () => void;
}

type Step = 'select-format' | 'done';

const ALL_FORMATS: ExportFormat[] = ['chrome', 'lastpass', 'bitwarden', '1password'];

export function ExportScreen({ entries, onBack }: ExportScreenProps) {
  const [step, setStep] = useState<Step>('select-format');
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>('chrome');
  const [exportedCount, setExportedCount] = useState(0);

  const loginCount = entries.filter(e => e.type === 'login').length;

  const handleExport = useCallback(() => {
    const csv = exportToCSV(entries, selectedFormat);
    const filename = getExportFilename(selectedFormat);
    downloadCSV(csv, filename);

    setExportedCount(loginCount);
    setStep('done');
  }, [entries, selectedFormat, loginCount]);

  return (
    <Layout>
      <Header
        title="Export Credentials"
        left={
          <Button variant="ghost" size="sm" onClick={onBack} className="h-7 w-7 p-0" aria-label="Back">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        }
      />

      <ScrollableBody className="p-4">
        {/* ── Step: select format ──────────────────────────────────────── */}
        {step === 'select-format' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Export format:
            </p>
            <div className="grid grid-cols-2 gap-2">
              {ALL_FORMATS.map(fmt => (
                <Button
                  key={fmt}
                  variant={selectedFormat === fmt ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSelectedFormat(fmt)}
                  className="justify-start"
                >
                  {EXPORT_FORMAT_LABELS[fmt]}
                </Button>
              ))}
            </div>

            <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1">
              <p className="text-muted-foreground">
                {loginCount} {loginCount === 1 ? 'credential' : 'credentials'} will be exported
                as a <span className="font-medium text-foreground">{EXPORT_FORMAT_LABELS[selectedFormat]}</span> CSV file.
              </p>
              {entries.length > loginCount && (
                <p className="text-muted-foreground">
                  {entries.length - loginCount} non-login {entries.length - loginCount === 1 ? 'entry' : 'entries'} (notes, cards) will be skipped.
                </p>
              )}
            </div>

            {/* Warning */}
            <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3 text-xs text-yellow-600 dark:text-yellow-400">
              Your passwords will be saved as an unencrypted CSV file. Delete it after importing into your target manager.
            </div>

            <Button
              className="w-full"
              onClick={handleExport}
              disabled={loginCount === 0}
            >
              {loginCount === 0
                ? 'No credentials to export'
                : `Export ${loginCount} ${loginCount === 1 ? 'credential' : 'credentials'}`}
            </Button>
          </div>
        )}

        {/* ── Step: done ──────────────────────────────────────────────── */}
        {step === 'done' && (
          <div className="flex flex-col items-center justify-center py-8 space-y-4 text-center">
            <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <CheckCircle className="w-6 h-6 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <p className="text-base font-semibold">
                {exportedCount} {exportedCount === 1 ? 'credential' : 'credentials'} exported!
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Saved as {EXPORT_FORMAT_LABELS[selectedFormat]} CSV
              </p>
            </div>

            <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3 text-xs text-yellow-600 dark:text-yellow-400 w-full">
              Remember to delete the CSV file after importing it into your target password manager.
            </div>

            <Button className="w-full" onClick={onBack}>
              Back to Settings
            </Button>
          </div>
        )}
      </ScrollableBody>
    </Layout>
  );
}
