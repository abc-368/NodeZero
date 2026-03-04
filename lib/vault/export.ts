/**
 * CSV exporters for popular password managers.
 *
 * Mirrors the import parsers in import.ts — same column names per format
 * to ensure round-trip compatibility (export → import → same entries).
 *
 * Supported: Chrome, LastPass, 1Password, Bitwarden
 */

import { VaultEntry } from './entry';

// ── CSV helpers (RFC 4180) ──────────────────────────────────────────────────

/**
 * Escape a single CSV field per RFC 4180.
 * Wraps in double quotes if the value contains commas, quotes, or newlines.
 */
function escapeCSVField(value: string | undefined): string {
  const str = value ?? '';
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Join fields into a single CSV row. */
function toCSVRow(fields: string[]): string {
  return fields.map(escapeCSVField).join(',');
}

// ── Export formats ──────────────────────────────────────────────────────────

export type ExportFormat = 'chrome' | 'lastpass' | '1password' | 'bitwarden';

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  chrome: 'Chrome',
  lastpass: 'LastPass',
  '1password': '1Password',
  bitwarden: 'Bitwarden',
};

/**
 * Export vault entries to a CSV string in the specified format.
 *
 * Only `type: 'login'` entries are exported (note/card/identity entries
 * don't map cleanly to password manager CSV formats).
 */
export function exportToCSV(entries: VaultEntry[], format: ExportFormat): string {
  const logins = entries.filter(e => e.type === 'login');

  switch (format) {
    case 'chrome':    return exportChrome(logins);
    case 'lastpass':  return exportLastPass(logins);
    case '1password': return export1Password(logins);
    case 'bitwarden': return exportBitwarden(logins);
  }
}

// ── Chrome: name,url,username,password,note ─────────────────────────────────

function exportChrome(entries: VaultEntry[]): string {
  const header = 'name,url,username,password,note';
  const rows = entries.map(e => toCSVRow([
    e.title,
    e.url,
    e.username,
    e.password,
    e.notes,
  ]));
  return [header, ...rows].join('\n');
}

// ── LastPass: url,username,password,totp,extra,name,grouping,fav ────────────

function exportLastPass(entries: VaultEntry[]): string {
  const header = 'url,username,password,totp,extra,name,grouping,fav';
  const rows = entries.map(e => toCSVRow([
    e.url,
    e.username,
    e.password,
    '',              // totp — not stored in NodeZero
    e.notes,
    e.title,
    e.tags[0] ?? '', // grouping = first tag
    '0',             // fav
  ]));
  return [header, ...rows].join('\n');
}

// ── 1Password: Title,Username,Password,OTPAuth,URL,Notes,Type ───────────────

function export1Password(entries: VaultEntry[]): string {
  const header = 'Title,Username,Password,OTPAuth,URL,Notes,Type';
  const rows = entries.map(e => toCSVRow([
    e.title,
    e.username,
    e.password,
    '',              // OTPAuth — not stored
    e.url,
    e.notes,
    'Login',
  ]));
  return [header, ...rows].join('\n');
}

// ── Bitwarden: folder,favorite,type,name,notes,fields,reprompt,login_uri,
//               login_username,login_password,login_totp ─────────────────────

function exportBitwarden(entries: VaultEntry[]): string {
  const header = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp';
  const rows = entries.map(e => toCSVRow([
    e.tags[0] ?? '', // folder = first tag
    '',              // favorite
    'login',
    e.title,
    e.notes,
    '',              // fields (custom fields — not stored)
    '',              // reprompt
    e.url,
    e.username,
    e.password,
    '',              // login_totp — not stored
  ]));
  return [header, ...rows].join('\n');
}

// ── Download helper ─────────────────────────────────────────────────────────

/**
 * Generate a timestamped filename for the export.
 * Example: NodeZero-export-chrome-2026-03-02.csv
 */
export function getExportFilename(format: ExportFormat): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `NodeZero-export-${format}-${date}.csv`;
}

/**
 * Trigger a CSV file download in the browser.
 * Creates a temporary <a> element with a Blob URL and clicks it.
 */
export function downloadCSV(csvContent: string, filename: string): void {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
