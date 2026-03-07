/**
 * CSV importers for popular password managers.
 *
 * Patterns adapted from Padloc (AGPL-3.0).
 * Supports: LastPass, 1Password, Bitwarden
 */

import { VaultEntry, createEntry } from './entry';
import { truncateField } from './validation';

// ── Generic CSV parser ─────────────────────────────────────────────────────

function parseCSV(csv: string): Record<string, string>[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1)
    .filter(line => line.trim())
    .map(line => {
      const values = parseCsvLine(line);
      const record: Record<string, string> = {};
      headers.forEach((header, i) => {
        record[header.trim()] = (values[i] ?? '').trim();
      });
      return record;
    });
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

// ── LastPass CSV ──────────────────────────────────────────────────────────

/**
 * Import from LastPass CSV export.
 * Columns: url, username, password, totp, extra, name, grouping, fav
 */
export function importFromLastPass(csv: string): VaultEntry[] {
  const rows = parseCSV(csv);
  return rows
    .filter(row => row['url'] && row['url'] !== 'http://sn')
    .map(row =>
      createEntry({
        title: row['name'] || row['url'],
        url: row['url'] || '',
        username: row['username'] || '',
        password: row['password'] || '',
        notes: row['extra'] || '',
        tags: row['grouping'] ? [row['grouping']] : [],
      })
    );
}

// ── 1Password CSV ─────────────────────────────────────────────────────────

/**
 * Import from 1Password CSV export.
 * Columns: Title, Username, Password, OTPAuth, URL, Notes, Type
 */
export function importFrom1Password(csv: string): VaultEntry[] {
  const rows = parseCSV(csv);
  return rows
    .filter(row => row['Type'] === 'Login' || !row['Type'])
    .map(row =>
      createEntry({
        title: row['Title'] || row['URL'] || '',
        url: row['URL'] || '',
        username: row['Username'] || '',
        password: row['Password'] || '',
        notes: row['Notes'] || '',
      })
    );
}

// ── Bitwarden CSV ─────────────────────────────────────────────────────────

/**
 * Import from Bitwarden CSV export.
 * Columns: folder, favorite, type, name, notes, fields, reprompt, login_uri, login_username, login_password, login_totp
 */
export function importFromBitwarden(csv: string): VaultEntry[] {
  const rows = parseCSV(csv);
  return rows
    .filter(row => row['type'] === 'login' || !row['type'])
    .map(row =>
      createEntry({
        title: row['name'] || row['login_uri'] || '',
        url: row['login_uri'] || '',
        username: row['login_username'] || '',
        password: row['login_password'] || '',
        notes: row['notes'] || '',
        tags: row['folder'] ? [row['folder']] : [],
      })
    );
}

// ── Chrome exported passwords CSV ─────────────────────────────────────────

/**
 * Import from Chrome's built-in password manager CSV export.
 * Navigate to chrome://settings/passwords → Export passwords.
 * Columns: name, url, username, password
 */
export function importFromChrome(csv: string): VaultEntry[] {
  const rows = parseCSV(csv);
  return rows
    .filter(row => row['url'] && row['url'].startsWith('http'))
    .map(row =>
      createEntry({
        title: row['name'] || new URL(row['url']).hostname,
        url: row['url'] || '',
        username: row['username'] || '',
        password: row['password'] || '',
        notes: row['note'] || '',
      })
    );
}

// ── Auto-detect format ────────────────────────────────────────────────────

export type ImportFormat = 'chrome' | 'lastpass' | '1password' | 'bitwarden' | 'unknown';

/**
 * Auto-detect the CSV format from the header row.
 */
export function detectImportFormat(csv: string): ImportFormat {
  const firstLine = csv.split(/\r?\n/)[0].toLowerCase();
  if (firstLine.includes('grouping') && firstLine.includes('extra')) return 'lastpass';
  if (firstLine.includes('otpauth') || firstLine.includes('otp auth')) return '1password';
  if (firstLine.includes('login_uri') || firstLine.includes('reprompt')) return 'bitwarden';
  // Chrome: header usually starts with "name,url,username,password"
  if (firstLine.startsWith('name,url,username,password')) return 'chrome';
  return 'unknown';
}

/**
 * Import from any supported format, auto-detecting the format.
 */
export function importCSV(csv: string): { entries: VaultEntry[]; format: ImportFormat } {
  const format = detectImportFormat(csv);
  let entries: VaultEntry[] = [];

  switch (format) {
    case 'chrome':
      entries = importFromChrome(csv);
      break;
    case 'lastpass':
      entries = importFromLastPass(csv);
      break;
    case '1password':
      entries = importFrom1Password(csv);
      break;
    case 'bitwarden':
      entries = importFromBitwarden(csv);
      break;
    default:
      // Best-effort parse: try to find common field names
      entries = importGeneric(csv);
  }

  // Enforce per-field character limits on all imported entries
  entries = entries.map(e => ({
    ...e,
    title:    truncateField('title', e.title),
    url:      truncateField('url', e.url),
    username: truncateField('username', e.username),
    password: truncateField('password', e.password),
    notes:    truncateField('notes', e.notes),
    tags:     truncateField('tags', e.tags.join(', ')).split(',').map(t => t.trim()).filter(Boolean),
  }));

  return { entries, format };
}

function importGeneric(csv: string): VaultEntry[] {
  const rows = parseCSV(csv);
  return rows.map(row => {
    const urlKey = Object.keys(row).find(k => /url|site|website/i.test(k)) || '';
    const userKey = Object.keys(row).find(k => /user|email|login/i.test(k)) || '';
    const passKey = Object.keys(row).find(k => /pass|pwd/i.test(k)) || '';
    const titleKey = Object.keys(row).find(k => /name|title/i.test(k)) || '';
    return createEntry({
      title: row[titleKey] || row[urlKey] || 'Imported entry',
      url: row[urlKey] || '',
      username: row[userKey] || '',
      password: row[passKey] || '',
    });
  });
}
