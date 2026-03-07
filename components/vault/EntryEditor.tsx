/**
 * EntryEditor — Add/edit a credential entry
 *
 * Field character limits are enforced inline (live counter + warning).
 * On save, any field still over limit is truncated automatically.
 */

import React, { useState, useCallback, useMemo } from 'react';
import { Eye, EyeOff, RefreshCw, ArrowLeft, Save, Trash2, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Layout, Header, ScrollableBody, Footer } from '@/components/shared/Layout';
import { VaultEntry, createEntry } from '@/lib/vault/entry';
import { MessageType, MessageFrom } from '@/lib/types';
import {
  FIELD_CHAR_LIMITS,
  validateFieldLength,
  truncateField,
} from '@/lib/vault/validation';

interface EntryEditorProps {
  entry?: VaultEntry;          // undefined = new entry
  defaultUrl?: string;         // pre-filled from "Save this login"
  defaultUsername?: string;
  defaultPassword?: string;
  defaultTitle?: string;
  onSaved: () => void;
  onCancel: () => void;
}

export function EntryEditor({
  entry,
  defaultUrl = '',
  defaultUsername = '',
  defaultPassword = '',
  defaultTitle = '',
  onSaved,
  onCancel,
}: EntryEditorProps) {
  const isNew = !entry;
  const [form, setForm] = useState<VaultEntry>(
    entry ?? createEntry({
      url: defaultUrl,
      username: defaultUsername,
      password: defaultPassword,
      title: defaultTitle,
    })
  );
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof VaultEntry, string>>>({});
  const [truncatedOnSave, setTruncatedOnSave] = useState<string[]>([]);

  const update = useCallback(<K extends keyof VaultEntry>(key: K, value: VaultEntry[K]) => {
    setForm(f => ({ ...f, [key]: value }));
    setErrors(e => ({ ...e, [key]: undefined }));
    setTruncatedOnSave([]);
  }, []);

  // Live field warnings — computed on every render (cheap string length checks)
  const fieldWarnings = useMemo(() => {
    const warnings: Partial<Record<string, string>> = {};
    const tagsStr = form.tags.join(', ');
    for (const [field, value] of Object.entries({
      title: form.title,
      url: form.url,
      username: form.username,
      password: form.password,
      notes: form.notes,
      tags: tagsStr,
    })) {
      const warning = validateFieldLength(field, value);
      if (warning) warnings[field] = warning;
    }
    return warnings;
  }, [form]);

  const hasWarnings = Object.keys(fieldWarnings).length > 0;

  const validate = (): boolean => {
    const newErrors: typeof errors = {};
    if (!form.title.trim() && !form.url.trim()) {
      newErrors.title = 'Title or URL is required';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = useCallback(async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      // Truncate any over-limit fields before saving
      const truncated: string[] = [];
      const title = truncateField('title', form.title.trim() || form.url || 'Untitled');
      const url = truncateField('url', form.url);
      const username = truncateField('username', form.username);
      const password = truncateField('password', form.password);
      const notes = truncateField('notes', form.notes);
      const tagsStr = truncateField('tags', form.tags.join(', '));
      const tags = tagsStr.split(',').map(t => t.trim()).filter(Boolean);

      if (title !== (form.title.trim() || form.url || 'Untitled')) truncated.push('title');
      if (url !== form.url) truncated.push('url');
      if (username !== form.username) truncated.push('username');
      if (password !== form.password) truncated.push('password');
      if (notes !== form.notes) truncated.push('notes');
      if (tagsStr !== form.tags.join(', ')) truncated.push('tags');

      const toSave: VaultEntry = {
        ...form,
        title,
        url,
        username,
        password,
        notes,
        tags,
        updatedAt: Date.now(),
      };

      const response = await browser.runtime.sendMessage({
        type: MessageType.saveVaultEntry,
        from: MessageFrom.popup,
        payload: toSave,
      }) as { success?: boolean; error?: string };

      if (response?.error) {
        setErrors({ title: response.error });
        return;
      }

      if (truncated.length > 0) {
        setTruncatedOnSave(truncated);
        // Brief flash — then navigate away
        setTimeout(() => onSaved(), 1200);
      } else {
        onSaved();
      }
    } catch (err: any) {
      console.error('[NodeZero] Save entry error:', err);
    } finally {
      setSaving(false);
    }
  }, [form, onSaved]);

  const [copiedField, setCopiedField] = useState<string | null>(null);

  const handleGeneratePassword = useCallback(() => {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=';
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    let password = '';
    for (const byte of bytes) {
      password += charset[byte % charset.length];
    }
    update('password', password);
    setShowPassword(true);
  }, [update]);

  const handleCopyPassword = useCallback(async () => {
    if (!form.password) return;
    await navigator.clipboard.writeText(form.password);
    setCopiedField('password');
    setTimeout(() => setCopiedField(null), 2000);
  }, [form.password]);

  return (
    <Layout>
      <Header
        title={isNew ? 'New Credential' : 'Edit Credential'}
        left={
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="h-7 w-7 p-0"
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
        }
      />

      <ScrollableBody className="p-4 space-y-4">
        {/* Truncation notice (shows briefly after save) */}
        {truncatedOnSave.length > 0 && (
          <div className="rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">
            Truncated: {truncatedOnSave.join(', ')}. Saved successfully.
          </div>
        )}

        {/* Title */}
        <div className="space-y-1.5">
          <FieldLabel htmlFor="title" label="Title" field="title" value={form.title} />
          <Input
            id="title"
            placeholder="e.g. GitHub, Gmail, Work VPN"
            value={form.title}
            onChange={e => update('title', e.target.value)}
          />
          {errors.title && <p className="text-xs text-destructive">{errors.title}</p>}
          {fieldWarnings.title && <p className="text-[11px] text-amber-500">{fieldWarnings.title}</p>}
        </div>

        {/* URL */}
        <div className="space-y-1.5">
          <FieldLabel htmlFor="url" label="URL / Website" field="url" value={form.url} />
          <Input
            id="url"
            type="url"
            placeholder="https://example.com"
            value={form.url}
            onChange={e => update('url', e.target.value)}
          />
          {fieldWarnings.url && <p className="text-[11px] text-amber-500">{fieldWarnings.url}</p>}
        </div>

        <Separator />

        {/* Username */}
        <div className="space-y-1.5">
          <FieldLabel htmlFor="username" label="Username / Email" field="username" value={form.username} />
          <Input
            id="username"
            placeholder="user@example.com"
            value={form.username}
            onChange={e => update('username', e.target.value)}
            autoComplete="off"
          />
          {fieldWarnings.username && <p className="text-[11px] text-amber-500">{fieldWarnings.username}</p>}
        </div>

        {/* Password */}
        <div className="space-y-1.5">
          <FieldLabel htmlFor="password" label="Password" field="password" value={form.password} />
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                placeholder="Enter or generate a password"
                value={form.password}
                onChange={e => update('password', e.target.value)}
                autoComplete="new-password"
                className="pr-8 font-mono"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowPassword(v => !v)}
                className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 p-0"
              >
                {showPassword ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </Button>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleGeneratePassword}
              className="gap-1.5 shrink-0"
              title="Generate password"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopyPassword}
              disabled={!form.password}
              className="gap-1.5 shrink-0"
              title="Copy password"
            >
              {copiedField === 'password'
                ? <Check className="w-3.5 h-3.5 text-green-500" />
                : <Copy className="w-3.5 h-3.5" />
              }
            </Button>
          </div>
          {fieldWarnings.password && <p className="text-[11px] text-amber-500">{fieldWarnings.password}</p>}
          {form.password && !fieldWarnings.password && (
            <PasswordStrengthBar password={form.password} />
          )}
        </div>

        <Separator />

        {/* Notes */}
        <div className="space-y-1.5">
          <FieldLabel htmlFor="notes" label="Notes" field="notes" value={form.notes} />
          <Textarea
            id="notes"
            placeholder="Optional notes (encrypted)"
            value={form.notes}
            onChange={e => update('notes', e.target.value)}
            rows={3}
          />
          {fieldWarnings.notes && <p className="text-[11px] text-amber-500">{fieldWarnings.notes}</p>}
        </div>

        {/* Tags */}
        <div className="space-y-1.5">
          <FieldLabel htmlFor="tags" label="Tags" field="tags" value={form.tags.join(', ')} />
          <Input
            id="tags"
            placeholder="work, personal, banking (comma-separated)"
            value={form.tags.join(', ')}
            onChange={e =>
              update(
                'tags',
                e.target.value
                  .split(',')
                  .map(t => t.trim())
                  .filter(Boolean)
              )
            }
          />
          {fieldWarnings.tags && <p className="text-[11px] text-amber-500">{fieldWarnings.tags}</p>}
        </div>
      </ScrollableBody>

      <Footer>
        {/* Save warning banner */}
        {hasWarnings && (
          <p className="text-[11px] text-amber-500 px-1 pb-2">
            Fields over limit will be truncated on save.
          </p>
        )}
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={onCancel}
            className="flex-1"
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            className="flex-1 gap-2"
            disabled={saving}
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving\u2026' : 'Save'}
          </Button>
        </div>
      </Footer>
    </Layout>
  );
}

// ── Field label with character counter ──────────────────────────────────────

function FieldLabel({
  htmlFor,
  label,
  field,
  value,
}: {
  htmlFor: string;
  label: string;
  field: string;
  value: string;
}) {
  const limit = FIELD_CHAR_LIMITS[field];
  if (!limit) {
    return <Label htmlFor={htmlFor} className="text-xs">{label}</Label>;
  }

  const isOver = value.length > limit;
  const isNear = !isOver && value.length > limit * 0.85;

  return (
    <div className="flex items-baseline justify-between">
      <Label htmlFor={htmlFor} className="text-xs">{label}</Label>
      {(value.length > 0) && (
        <span className={`text-[10px] tabular-nums ${
          isOver ? 'text-amber-500 font-medium' : isNear ? 'text-muted-foreground' : 'text-muted-foreground/50'
        }`}>
          {value.length}/{limit}
        </span>
      )}
    </div>
  );
}

// ── Password strength indicator ────────────────────────────────────────────

function PasswordStrengthBar({ password }: { password: string }) {
  const strength = calculateStrength(password);
  const labels = ['Very Weak', 'Weak', 'Fair', 'Strong', 'Very Strong'];
  const colors = [
    'bg-red-500',
    'bg-orange-500',
    'bg-yellow-500',
    'bg-green-500',
    'bg-emerald-500',
  ];

  return (
    <div className="space-y-1">
      <div className="flex gap-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i < strength ? colors[strength - 1] : 'bg-muted'
            }`}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{labels[strength - 1]}</p>
    </div>
  );
}

function calculateStrength(password: string): number {
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 16) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  return Math.max(1, Math.min(5, score));
}
