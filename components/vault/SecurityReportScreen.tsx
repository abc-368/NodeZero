/**
 * SecurityReportScreen — Vault password health dashboard
 *
 * Shows composite score, weak/reused/old password lists.
 * Tap entry → navigate to editor.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Layout, Header, ScrollableBody } from '@/components/shared/Layout';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  ArrowLeft,
  Shield,
  AlertTriangle,
  Copy,
  Clock,
  ChevronDown,
  ChevronUp,
  Loader2,
} from 'lucide-react';
import type { VaultEntry } from '@/lib/vault/entry';
import {
  generateSecurityReport,
  getGrade,
  type SecurityReport,
  type WeakEntry,
  type ReusedGroup,
  type OldEntry,
} from '@/lib/vault/security-report';

interface SecurityReportScreenProps {
  entries: VaultEntry[];
  onBack: () => void;
  onEditEntry: (entry: VaultEntry) => void;
}

export function SecurityReportScreen({ entries, onBack, onEditEntry }: SecurityReportScreenProps) {
  const [report, setReport] = useState<SecurityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedSection, setExpandedSection] = useState<string | null>(null);

  useEffect(() => {
    // Run analysis async (zxcvbn can be slow on large vaults)
    const timer = setTimeout(() => {
      const r = generateSecurityReport(entries);
      setReport(r);
      setLoading(false);
    }, 50);
    return () => clearTimeout(timer);
  }, [entries]);

  const grade = useMemo(() => report ? getGrade(report.score) : null, [report]);

  const toggleSection = (section: string) => {
    setExpandedSection(prev => prev === section ? null : section);
  };

  const findEntry = (id: string) => entries.find(e => e.id === id);

  if (loading || !report || !grade) {
    return (
      <Layout>
        <Header
          title="Security Report"
          left={
            <Button variant="ghost" size="sm" onClick={onBack} className="h-7 w-7 p-0" aria-label="Back">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          }
        />
        <ScrollableBody className="flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            <p className="text-xs text-muted-foreground">Analyzing {entries.length} entries...</p>
          </div>
        </ScrollableBody>
      </Layout>
    );
  }

  return (
    <Layout>
      <Header
        title="Security Report"
        left={
          <Button variant="ghost" size="sm" onClick={onBack} className="h-7 w-7 p-0" aria-label="Back">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        }
      />
      <ScrollableBody className="p-4 space-y-4">
        {/* Score card */}
        <div className="flex items-center gap-4 p-4 rounded-xl bg-muted/30 border">
          <div className={`text-4xl font-bold ${grade.color}`}>
            {grade.letter}
          </div>
          <div className="flex-1">
            <div className="flex items-baseline gap-2">
              <span className={`text-2xl font-bold ${grade.color}`}>{report.score}</span>
              <span className="text-xs text-muted-foreground">/ 100</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {report.checkedEntries} of {report.totalEntries} entries analysed
            </p>
          </div>
        </div>

        {/* Score bar */}
        <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              report.score >= 75 ? 'bg-green-500' :
              report.score >= 50 ? 'bg-amber-500' : 'bg-red-500'
            }`}
            style={{ width: `${report.score}%` }}
          />
        </div>

        <Separator />

        {/* Weak passwords */}
        <SectionHeader
          icon={<AlertTriangle className="w-3.5 h-3.5" />}
          title="Weak Passwords"
          count={report.weak.length}
          color={report.weak.length > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}
          expanded={expandedSection === 'weak'}
          onToggle={() => toggleSection('weak')}
        />
        {expandedSection === 'weak' && (
          <div className="space-y-1 pl-5">
            {report.weak.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">No weak passwords found.</p>
            ) : (
              report.weak.map(item => (
                <EntryRow
                  key={item.id}
                  title={item.title}
                  subtitle={`Score: ${item.score}/4 — ${item.feedback}`}
                  onClick={() => { const e = findEntry(item.id); if (e) onEditEntry(e); }}
                />
              ))
            )}
          </div>
        )}

        {/* Reused passwords */}
        <SectionHeader
          icon={<Copy className="w-3.5 h-3.5" />}
          title="Reused Passwords"
          count={report.reused.reduce((s, g) => s + g.count, 0)}
          color={report.reused.length > 0 ? 'text-orange-600 dark:text-orange-400' : 'text-green-600 dark:text-green-400'}
          expanded={expandedSection === 'reused'}
          onToggle={() => toggleSection('reused')}
        />
        {expandedSection === 'reused' && (
          <div className="space-y-3 pl-5">
            {report.reused.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">No reused passwords found.</p>
            ) : (
              report.reused.map((group, gi) => (
                <div key={gi} className="space-y-1">
                  <p className="text-[11px] text-muted-foreground font-medium">
                    Shared by {group.count} entries:
                  </p>
                  {group.entries.map(item => (
                    <EntryRow
                      key={item.id}
                      title={item.title}
                      subtitle={item.url}
                      onClick={() => { const e = findEntry(item.id); if (e) onEditEntry(e); }}
                    />
                  ))}
                </div>
              ))
            )}
          </div>
        )}

        {/* Old passwords */}
        <SectionHeader
          icon={<Clock className="w-3.5 h-3.5" />}
          title="Old Passwords"
          count={report.old.length}
          color={report.old.length > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}
          expanded={expandedSection === 'old'}
          onToggle={() => toggleSection('old')}
        />
        {expandedSection === 'old' && (
          <div className="space-y-1 pl-5">
            {report.old.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">No old passwords found.</p>
            ) : (
              report.old.map(item => (
                <EntryRow
                  key={item.id}
                  title={item.title}
                  subtitle={`Last updated ${item.daysSinceUpdate} days ago`}
                  onClick={() => { const e = findEntry(item.id); if (e) onEditEntry(e); }}
                />
              ))
            )}
          </div>
        )}
      </ScrollableBody>
    </Layout>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({
  icon,
  title,
  count,
  color,
  expanded,
  onToggle,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  color: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-2 py-1 text-left"
    >
      <span className={color}>{icon}</span>
      <span className="text-xs font-medium flex-1">{title}</span>
      <span className={`text-xs font-bold ${color}`}>{count}</span>
      {expanded
        ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
        : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
      }
    </button>
  );
}

function EntryRow({
  title,
  subtitle,
  onClick,
}: {
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex flex-col px-2 py-1.5 rounded hover:bg-muted/50 transition-colors text-left"
    >
      <span className="text-xs font-medium truncate">{title}</span>
      <span className="text-[11px] text-muted-foreground truncate">{subtitle}</span>
    </button>
  );
}
