/**
 * Onboarding flow — first-time setup
 *
 * Steps (PRF path — hardware key with PRF support):
 * 1. Welcome
 * 2. Register WebAuthn passkey → PRF confirmed
 * 3. Display 12-word mnemonic
 * 4. Verify 3 words → seal vault
 *
 * Steps (PIN path — Windows Hello / no PRF support):
 * 1. Welcome
 * 2. Register WebAuthn passkey → PRF NOT supported → show info
 * 3. Set vault PIN (replaces PRF as daily key)
 * 4. Display 12-word mnemonic
 * 5. Verify 3 words → seal vault
 *
 * Security: mnemonic is wiped from memory after the 3-word challenge passes.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  KeyRound, Shield, ChevronRight, Copy, CheckCircle, AlertCircle,
  Eye, EyeOff, Lock, RotateCcw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Layout, Header, ScrollableBody, Footer } from '@/components/shared/Layout';
import { generateVaultMnemonic, pickVerifyIndices, wipeMnemonic } from '@/lib/crypto/mnemonic';
import { registerWebAuthnCredential, derivePrimaryKey } from '@/lib/crypto/primary-key';
import { derivePinKey, validatePin, PIN_MIN_LENGTH } from '@/lib/crypto/pin-key';
import { wrapPrimaryKeyForBiometric } from '@/lib/crypto/biometric-wrap';
import { initializeDID, storeWrappedRecoveryKey } from '@/lib/did/storage';
import { deriveDIDFromMnemonic } from '@/lib/did/provider';
import { createVaultBundle, sealVault, saveVaultToStorage } from '@/lib/vault/vault';
import { deriveRecoveryKey } from '@/lib/crypto/recovery-key';
import { MessageType, MessageFrom } from '@/lib/types';
import { bufferToBase64 } from '@/lib/crypto/field-encrypt';

type OnboardingStep =
  | 'welcome'
  | 'passkey'
  | 'pin-info'    // shown when PRF not supported
  | 'pin-setup'   // set vault PIN
  | 'mnemonic'
  | 'verify'
  | 'creating'
  | 'done';

interface OnboardingProps {
  onComplete: () => void;
  onRecover?: () => void;
}

const PRF_STEPS: OnboardingStep[] = ['welcome', 'passkey', 'mnemonic', 'verify'];
const PIN_STEPS: OnboardingStep[] = ['welcome', 'passkey', 'pin-info', 'pin-setup', 'mnemonic', 'verify'];

function stepProgress(step: OnboardingStep, hasPrf: boolean | null): number {
  const steps = hasPrf === false ? PIN_STEPS : PRF_STEPS;
  const idx = steps.indexOf(step);
  if (idx < 0) return 100;
  return ((idx + 1) / steps.length) * 100;
}

export function Onboarding({ onComplete, onRecover }: OnboardingProps) {
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const [credentialId, setCredentialId] = useState<Uint8Array | null>(null);
  const [prfSupported, setPrfSupported] = useState<boolean | null>(null);

  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [showPin, setShowPin] = useState(false);

  const [mnemonic, setMnemonic] = useState<string[]>([]);
  const [verifyIndices, setVerifyIndices] = useState<number[]>([]);
  const [verifyAnswers, setVerifyAnswers] = useState<Record<number, string>>({});
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [copied, setCopied] = useState(false);

  const mnemonicRef = useRef<string[]>([]);

  useEffect(() => {
    return () => {
      if (mnemonicRef.current.length > 0) {
        wipeMnemonic(mnemonicRef.current);
        mnemonicRef.current = [];
      }
    };
  }, []);

  // ── Passkey registration ──────────────────────────────────────────────────

  const handleRegisterPasskey = useCallback(async () => {
    setError(null);
    setStatus('Registering passkey…');
    try {
      const result = await registerWebAuthnCredential();
      setCredentialId(result.credentialId);
      setPrfSupported(result.prfSupported);

      const words = generateVaultMnemonic();
      mnemonicRef.current = words;
      setMnemonic([...words]);

      setStep(result.prfSupported ? 'mnemonic' : 'pin-info');
      setStatus('');
    } catch (err: any) {
      setError(err?.message ?? 'Passkey registration failed.');
      setStatus('');
    }
  }, []);

  // ── PIN validation ────────────────────────────────────────────────────────

  const handlePinContinue = useCallback(() => {
    const pinError = validatePin(pin);
    if (pinError) { setError(pinError); return; }
    if (pin !== pinConfirm) { setError('Passphrases do not match.'); return; }
    setError(null);
    setStep('mnemonic');
  }, [pin, pinConfirm]);

  // ── Mnemonic ──────────────────────────────────────────────────────────────

  const handleMnemonicContinue = useCallback(() => {
    setVerifyIndices(pickVerifyIndices(12, 3));
    setVerifyAnswers({});
    setStep('verify');
  }, []);

  const handleCopyMnemonic = useCallback(async () => {
    await navigator.clipboard.writeText(mnemonic.join(' '));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [mnemonic]);

  // ── Verify + create vault ─────────────────────────────────────────────────

  const handleVerify = useCallback(async () => {
    setError(null);

    for (const idx of verifyIndices) {
      const entered = (verifyAnswers[idx] ?? '').trim().toLowerCase();
      if (entered !== mnemonicRef.current[idx].toLowerCase()) {
        setError(`Word #${idx + 1} is incorrect. Check your recovery phrase.`);
        return;
      }
    }

    setStep('creating');
    setStatus('Creating your vault…');

    try {
      let primaryKey: CryptoKey;
      // When PRF is not supported but we have a credential (Windows Hello),
      // use 'biometric' mode: passphrase-derived key wrapped for biometric unlock
      const primaryMode: 'prf' | 'pin' | 'biometric' =
        prfSupported ? 'prf' : credentialId ? 'biometric' : 'pin';

      // Derive DID deterministically from mnemonic (fast, <10ms)
      // This ensures the same mnemonic always produces the same DID,
      // enabling cross-device recovery via pointer service lookup.
      setStatus('Generating your identity…');
      const mnemonicPhrase = mnemonicRef.current.join(' ');
      const derivedKeyPair = await deriveDIDFromMnemonic(mnemonicPhrase);
      const did = derivedKeyPair.did;

      if (prfSupported && credentialId) {
        // PRF path: WebAuthn ceremony derives the key
        setStatus('Authenticating with passkey…');
        primaryKey = await derivePrimaryKey(credentialId);

        setStatus('Storing identity…');
        await initializeDID(primaryKey, derivedKeyPair, derivedKeyPair.bipSeed);
      } else {
        // PIN path: DID is already known from mnemonic, derive PIN key directly
        setStatus('Deriving key from passphrase…');
        primaryKey = await derivePinKey(pin, did);

        await initializeDID(primaryKey, derivedKeyPair, derivedKeyPair.bipSeed);
      }

      // Zero-fill BIP-39 seed
      derivedKeyPair.bipSeed.fill(0);

      // Derive recovery key (~30s)
      setStatus('Deriving recovery key (~30s)…');
      const recoveryKey = await deriveRecoveryKey(mnemonicRef.current.join(' '), did);

      // Wipe secrets from memory
      wipeMnemonic(mnemonicRef.current);
      mnemonicRef.current = [];
      setMnemonic([]);
      setPin('');
      setPinConfirm('');

      // Seal vault with both tiers
      setStatus('Sealing vault…');
      const rpId = new URL(window.location.href).hostname;
      const bundle = createVaultBundle(did, rpId, credentialId ?? undefined, primaryMode);
      const session = { bundle, entries: [], primaryKey, recoveryKey };
      const sealed = await sealVault(session);
      await saveVaultToStorage(sealed);

      // Wrap recovery key with primary key so normal unlock can access both
      await storeWrappedRecoveryKey(primaryKey, recoveryKey);

      // For biometric mode: wrap the primary key so face/fingerprint can unlock
      if (primaryMode === 'biometric' && credentialId) {
        setStatus('Setting up biometric unlock…');
        await wrapPrimaryKeyForBiometric(primaryKey, credentialId);
      }

      // Export keys for background (CryptoKey is not JSON-serializable)
      const [primaryKeyRaw, recoveryKeyRaw] = await Promise.all([
        crypto.subtle.exportKey('raw', primaryKey).then(b => bufferToBase64(new Uint8Array(b))),
        crypto.subtle.exportKey('raw', recoveryKey).then(b => bufferToBase64(new Uint8Array(b))),
      ]);

      await browser.runtime.sendMessage({
        type: MessageType.unlockVault,
        from: MessageFrom.popup,
        payload: {
          vaultSession: { ...session, bundle: sealed },
          primaryKeyRaw,
          recoveryKeyRaw,
        },
      });

      setStep('done');
      setStatus('');
      setTimeout(onComplete, 1200);
    } catch (err: any) {
      console.error('[NodeZero] Onboarding error:', err);
      setError(err?.message ?? 'Setup failed. Please try again.');
      setStep('verify');
      setStatus('');
    }
  }, [credentialId, prfSupported, pin, verifyIndices, verifyAnswers, onComplete]);

  // ── Render ────────────────────────────────────────────────────────────────

  const showProgress = !['welcome', 'creating', 'done'].includes(step);
  const progress = stepProgress(step, prfSupported);

  return (
    <Layout>
      <Header
        title="Setup NodeZero"
        right={showProgress ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {Math.round(progress)}%
          </span>
        ) : undefined}
      />
      {showProgress && <Progress value={progress} className="h-0.5 rounded-none" />}

      {step === 'welcome' && <WelcomeStep onNext={() => setStep('passkey')} onRecover={onRecover} />}
      {step === 'passkey' && (
        <PasskeyStep onRegister={handleRegisterPasskey} error={error} status={status} />
      )}
      {step === 'pin-info' && <PinInfoStep onNext={() => setStep('pin-setup')} />}
      {step === 'pin-setup' && (
        <PinSetupStep
          pin={pin} pinConfirm={pinConfirm} showPin={showPin}
          onPinChange={setPin} onConfirmChange={setPinConfirm}
          onToggleShow={() => setShowPin(v => !v)}
          onContinue={handlePinContinue} error={error}
        />
      )}
      {step === 'mnemonic' && (
        <MnemonicStep
          mnemonic={mnemonic} show={showMnemonic}
          onToggleShow={() => setShowMnemonic(v => !v)}
          copied={copied} onCopy={handleCopyMnemonic}
          onContinue={handleMnemonicContinue}
        />
      )}
      {step === 'verify' && (
        <VerifyStep
          indices={verifyIndices} answers={verifyAnswers}
          onAnswer={(idx, val) => setVerifyAnswers(a => ({ ...a, [idx]: val }))}
          onVerify={handleVerify} error={error}
        />
      )}
      {(step === 'creating' || step === 'done') && (
        <CreatingStep status={status} done={step === 'done'} />
      )}
    </Layout>
  );
}

// ── Sub-screens ────────────────────────────────────────────────────────────

function WelcomeStep({ onNext, onRecover }: { onNext: () => void; onRecover?: () => void }) {
  return (
    <ScrollableBody className="flex flex-col items-center justify-center gap-6 p-8">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
        <Shield className="w-8 h-8 text-primary" />
      </div>
      <div className="text-center space-y-2">
        <h2 className="text-lg font-semibold">Welcome to NodeZero</h2>
        <p className="text-sm text-muted-foreground">
          A decentralized password manager. Your vault is encrypted and stored
          remotely — only you hold the keys.
        </p>
      </div>
      <ul className="w-full space-y-2 text-sm">
        {[
          'Hardware-bound encryption via passkey',
          'No master password to crack',
          '12-word recovery phrase you control',
          'Vault synced to the cloud — no single server',
        ].map((item, i) => (
          <li key={i} className="flex items-center gap-2 text-muted-foreground">
            <CheckCircle className="w-4 h-4 text-primary shrink-0" />{item}
          </li>
        ))}
      </ul>
      <div className="w-full space-y-2">
        <Button onClick={onNext} className="w-full gap-2">
          Create New Vault <ChevronRight className="w-4 h-4" />
        </Button>
        {onRecover && (
          <Button variant="ghost" onClick={onRecover} className="w-full text-sm text-muted-foreground gap-2">
            <RotateCcw className="w-3.5 h-3.5" />
            Recover existing vault
          </Button>
        )}
      </div>
    </ScrollableBody>
  );
}

function PasskeyStep({ onRegister, error, status }: {
  onRegister: () => void; error: string | null; status: string;
}) {
  return (
    <ScrollableBody className="flex flex-col items-center justify-center gap-6 p-8">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
        <KeyRound className="w-8 h-8 text-primary" />
      </div>
      <div className="text-center space-y-1">
        <h2 className="text-base font-semibold">Create Your Passkey</h2>
        <p className="text-xs text-muted-foreground">
          NodeZero will register a passkey and check if your authenticator
          supports hardware key derivation (PRF).
        </p>
      </div>
      <div className="w-full bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md px-3 py-2">
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          <strong>Tip:</strong> Choose your device's built-in authenticator
          (Windows Hello, Touch ID, etc.) or a hardware security key.
          Do <strong>not</strong> select Google Password Manager —
          it is incompatible with extension passkeys and may crash Chrome.
        </p>
      </div>
      {error && (
        <div className="flex items-start gap-2 w-full bg-destructive/10 text-destructive border border-destructive/20 rounded-md px-3 py-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="text-xs">{error}</p>
        </div>
      )}
      <Button onClick={onRegister} className="w-full" disabled={!!status}>
        {status || 'Register Passkey'}
      </Button>
    </ScrollableBody>
  );
}

function PinInfoStep({ onNext }: { onNext: () => void }) {
  return (
    <ScrollableBody className="flex flex-col items-center justify-center gap-6 p-8">
      <div className="w-16 h-16 rounded-2xl bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
        <Lock className="w-8 h-8 text-amber-600 dark:text-amber-400" />
      </div>
      <div className="text-center space-y-2">
        <h2 className="text-base font-semibold">Set a Backup Passphrase</h2>
        <p className="text-sm text-muted-foreground">
          Your face/fingerprint verified your identity — and will be used for
          daily unlock. NodeZero also needs a <strong>backup passphrase</strong> for
          recovery and cross-device setup.
        </p>
      </div>
      <div className="w-full space-y-1.5 text-xs text-muted-foreground bg-muted rounded-md p-3">
        <p>✓ Daily unlock uses biometrics (face/fingerprint)</p>
        <p>✓ Vault is encrypted with AES-256-GCM</p>
        <p>✓ 12-word recovery phrase still protects your vault</p>
        <p>⚠ Use 8+ chars with mixed case and a digit</p>
      </div>
      <Button onClick={onNext} className="w-full gap-2">
        Set Up Passphrase <ChevronRight className="w-4 h-4" />
      </Button>
    </ScrollableBody>
  );
}

function PinSetupStep({ pin, pinConfirm, showPin, onPinChange, onConfirmChange, onToggleShow, onContinue, error }: {
  pin: string; pinConfirm: string; showPin: boolean;
  onPinChange: (v: string) => void; onConfirmChange: (v: string) => void;
  onToggleShow: () => void; onContinue: () => void; error: string | null;
}) {
  return (
    <>
      <ScrollableBody className="p-4 space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Set Your Backup Passphrase</h2>
          <p className="text-xs text-muted-foreground">
            This passphrase is your backup unlock method. Daily unlock uses
            your face/fingerprint. Min {PIN_MIN_LENGTH} chars, mixed case + digit.
          </p>
        </div>
        {error && (
          <div className="flex items-start gap-2 bg-destructive/10 text-destructive border border-destructive/20 rounded-md px-3 py-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="text-xs">{error}</p>
          </div>
        )}
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Vault Passphrase</label>
            <div className="relative">
              <Input
                type={showPin ? 'text' : 'password'}
                placeholder={`Min ${PIN_MIN_LENGTH} chars, mixed case + digit`}
                value={pin}
                onChange={e => onPinChange(e.target.value)}
                autoComplete="new-password"
                className="pr-9"
              />
              <Button type="button" variant="ghost" size="sm" onClick={onToggleShow}
                className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 p-0">
                {showPin ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Confirm Passphrase</label>
            <Input
              type={showPin ? 'text' : 'password'}
              placeholder="Re-enter passphrase"
              value={pinConfirm}
              onChange={e => onConfirmChange(e.target.value)}
              autoComplete="new-password"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Forgot your passphrase? You can always recover using your 12-word phrase.
        </p>
      </ScrollableBody>
      <Footer>
        <Button onClick={onContinue} className="w-full"
          disabled={pin.length < PIN_MIN_LENGTH || !pinConfirm}>
          Continue
        </Button>
      </Footer>
    </>
  );
}

function MnemonicStep({ mnemonic, show, onToggleShow, copied, onCopy, onContinue }: {
  mnemonic: string[]; show: boolean; onToggleShow: () => void;
  copied: boolean; onCopy: () => void; onContinue: () => void;
}) {
  return (
    <>
      <ScrollableBody className="p-4 space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Your Recovery Phrase</h2>
          <p className="text-xs text-muted-foreground">
            Write down these 12 words in order — the{' '}
            <strong>only way to recover your vault</strong> on a new device.
          </p>
        </div>
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md px-3 py-2">
          <p className="text-xs text-amber-700 dark:text-amber-400">
            ⚠️ Never share these words. NodeZero cannot recover them for you.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {mnemonic.map((word, i) => (
            <div key={i} className="flex items-center gap-1.5 bg-muted rounded-md px-2 py-1.5">
              <span className="text-xs text-muted-foreground w-4 shrink-0">{i + 1}.</span>
              <span className="text-xs font-mono font-medium">{show ? word : '••••'}</span>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onToggleShow} className="gap-1.5 flex-1">
            {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {show ? 'Hide' : 'Reveal'}
          </Button>
          <Button variant="outline" size="sm" onClick={onCopy} className="gap-1.5 flex-1">
            <Copy className="w-3.5 h-3.5" />
            {copied ? 'Copied!' : 'Copy'}
          </Button>
        </div>
      </ScrollableBody>
      <Footer>
        <Button onClick={onContinue} className="w-full">
          I've Saved My Phrase <ChevronRight className="w-4 h-4 ml-1" />
        </Button>
      </Footer>
    </>
  );
}

function VerifyStep({ indices, answers, onAnswer, onVerify, error }: {
  indices: number[]; answers: Record<number, string>;
  onAnswer: (idx: number, val: string) => void;
  onVerify: () => void; error: string | null;
}) {
  const allFilled = indices.every(idx => (answers[idx] ?? '').trim().length > 0);
  return (
    <>
      <ScrollableBody className="p-4 space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Verify Recovery Phrase</h2>
          <p className="text-xs text-muted-foreground">
            Enter the following words from your recovery phrase.
          </p>
        </div>
        {error && (
          <div className="flex items-start gap-2 bg-destructive/10 text-destructive border border-destructive/20 rounded-md px-3 py-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="text-xs">{error}</p>
          </div>
        )}
        <div className="space-y-3">
          {indices.map(idx => (
            <div key={idx} className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Word #{idx + 1}</label>
              <Input
                type="text" placeholder={`Enter word #${idx + 1}…`}
                value={answers[idx] ?? ''} onChange={e => onAnswer(idx, e.target.value)}
                autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              />
            </div>
          ))}
        </div>
      </ScrollableBody>
      <Footer>
        <Button onClick={onVerify} className="w-full" disabled={!allFilled}>
          Verify & Create Vault
        </Button>
      </Footer>
    </>
  );
}

function CreatingStep({ status, done }: { status: string; done: boolean }) {
  return (
    <ScrollableBody className="flex flex-col items-center justify-center gap-6 p-8">
      <div className={`w-16 h-16 rounded-2xl flex items-center justify-center transition-colors ${
        done ? 'bg-green-100 dark:bg-green-900/30' : 'bg-primary/10'
      }`}>
        {done
          ? <CheckCircle className="w-8 h-8 text-green-600 dark:text-green-400" />
          : <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        }
      </div>
      <div className="text-center">
        <h2 className="text-base font-semibold">{done ? 'Vault Ready!' : 'Creating Your Vault'}</h2>
        {status && <p className="text-xs text-muted-foreground mt-1">{status}</p>}
      </div>
    </ScrollableBody>
  );
}
