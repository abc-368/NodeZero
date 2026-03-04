/**
 * PasswordGenerator — Standalone password generator panel
 *
 * Ported/inspired by Padloc's generator (AGPL-3.0).
 */

import React, { useState, useCallback, useEffect } from 'react';
import { RefreshCw, Copy, Check, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Layout, Header, ScrollableBody } from '@/components/shared/Layout';

interface GeneratorOptions {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  symbols: boolean;
}

const DEFAULT_OPTIONS: GeneratorOptions = {
  length: 20,
  uppercase: true,
  lowercase: true,
  numbers: true,
  symbols: true,
};

interface PasswordGeneratorProps {
  onBack: () => void;
  onUse?: (password: string) => void; // if called from EntryEditor
}

export function PasswordGenerator({ onBack, onUse }: PasswordGeneratorProps) {
  const [options, setOptions] = useState<GeneratorOptions>(DEFAULT_OPTIONS);
  const [password, setPassword] = useState('');
  const [copied, setCopied] = useState(false);

  const generate = useCallback(() => {
    setPassword(generatePassword(options));
  }, [options]);

  // Re-generate when options change
  useEffect(() => {
    generate();
  }, [generate]);

  const handleCopy = useCallback(async () => {
    if (!password) return;
    await navigator.clipboard.writeText(password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [password]);

  const updateOption = <K extends keyof GeneratorOptions>(key: K, value: GeneratorOptions[K]) => {
    setOptions(o => ({ ...o, [key]: value }));
  };

  const strength = getStrength(password);
  const strengthColors = ['bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-green-500', 'bg-emerald-500'];
  const strengthLabels = ['Very Weak', 'Weak', 'Fair', 'Strong', 'Very Strong'];

  return (
    <Layout>
      <Header
        title="Password Generator"
        left={
          <Button variant="ghost" size="sm" onClick={onBack} className="h-7 w-7 p-0">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        }
      />

      <ScrollableBody className="p-4 space-y-5">
        {/* Generated password display */}
        <div className="space-y-2">
          <div className="bg-muted rounded-lg p-3 font-mono text-sm break-all min-h-[60px] flex items-center">
            {password || <span className="text-muted-foreground">Generating…</span>}
          </div>

          {/* Strength indicator */}
          <div className="space-y-1">
            <div className="flex gap-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className={`h-1 flex-1 rounded-full transition-colors ${
                    i < strength ? strengthColors[strength - 1] : 'bg-border'
                  }`}
                />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Strength: <span className="font-medium">{strengthLabels[strength - 1]}</span>
              {' · '}{password.length} characters
            </p>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={generate}
              className="flex-1 gap-2"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Regenerate
            </Button>
            <Button
              variant="outline"
              onClick={handleCopy}
              className="flex-1 gap-2"
            >
              {copied
                ? <><Check className="w-3.5 h-3.5" /> Copied!</>
                : <><Copy className="w-3.5 h-3.5" /> Copy</>
              }
            </Button>
          </div>

          {onUse && (
            <Button onClick={() => onUse(password)} className="w-full">
              Use This Password
            </Button>
          )}
        </div>

        {/* Options */}
        <div className="space-y-4">
          {/* Length slider */}
          <div className="space-y-3">
            <div className="flex justify-between">
              <Label className="text-xs">Length</Label>
              <span className="text-xs font-mono font-medium tabular-nums">{options.length}</span>
            </div>
            <Slider
              min={8}
              max={64}
              step={1}
              value={[options.length]}
              onValueChange={([v]) => updateOption('length', v)}
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>8</span>
              <span>64</span>
            </div>
          </div>

          {/* Character set toggles */}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground uppercase tracking-wide">
              Characters
            </Label>
            {([
              ['uppercase', 'Uppercase (A–Z)'],
              ['lowercase', 'Lowercase (a–z)'],
              ['numbers', 'Numbers (0–9)'],
              ['symbols', 'Symbols (!@#…)'],
            ] as [keyof GeneratorOptions, string][]).map(([key, label]) => {
              const isChecked = !!options[key as keyof GeneratorOptions];
              const wouldLeaveNone = [
                options.uppercase,
                options.lowercase,
                options.numbers,
                options.symbols,
              ].filter(Boolean).length === 1 && isChecked;

              return (
                <div
                  key={key}
                  className="flex items-center justify-between py-1"
                >
                  <Label htmlFor={`opt-${key}`} className="text-sm cursor-pointer">{label}</Label>
                  <Switch
                    id={`opt-${key}`}
                    checked={isChecked}
                    disabled={wouldLeaveNone}
                    onCheckedChange={(checked) => updateOption(key, checked as any)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </ScrollableBody>
    </Layout>
  );
}

// ── Generator logic ────────────────────────────────────────────────────────

function generatePassword(opts: GeneratorOptions): string {
  let charset = '';
  if (opts.uppercase) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (opts.lowercase) charset += 'abcdefghijklmnopqrstuvwxyz';
  if (opts.numbers) charset += '0123456789';
  if (opts.symbols) charset += '!@#$%^&*()_+-=[]{}|;:,.<>?';
  if (!charset) charset = 'abcdefghijklmnopqrstuvwxyz';

  // Ensure at least one character from each selected set
  let password = '';
  const required: string[] = [];
  if (opts.uppercase) required.push(randomChar('ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
  if (opts.lowercase) required.push(randomChar('abcdefghijklmnopqrstuvwxyz'));
  if (opts.numbers) required.push(randomChar('0123456789'));
  if (opts.symbols) required.push(randomChar('!@#$%^&*()_+-=[]{}|;:,.<>?'));

  // Fill the rest
  const remaining = opts.length - required.length;
  const bytes = crypto.getRandomValues(new Uint8Array(remaining));
  for (const byte of bytes) {
    password += charset[byte % charset.length];
  }

  // Shuffle required + generated characters
  const all = [...required, ...password.split('')];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }

  return all.join('');
}

function randomChar(charset: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(1));
  return charset[bytes[0] % charset.length];
}

function getStrength(password: string): number {
  if (!password) return 1;
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 16) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  return Math.max(1, Math.min(5, score));
}
