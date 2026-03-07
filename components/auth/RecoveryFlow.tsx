/**
 * RecoveryFlow — Recover vault using mnemonic + PBKDF2
 *
 * Supports both:
 *   1. Same-device recovery (vault exists in chrome.storage.local)
 *   2. Cross-device recovery (vault fetched from R2 via pointer service)
 *
 * Cross-device flow:
 *   Enter mnemonic → derive DID from mnemonic (fast, HKDF) →
 *   query pointer service for DID → download vault from R2 →
 *   PBKDF2 (2M iter, ~30s) → decrypt recovery vault →
 *   store DID + vault locally → unlock
 *
 * Security:
 * - 2M PBKDF2 iterations (~30s) prevents brute-force on stolen mnemonic
 * - Mnemonic is cleared from input field after derivation starts
 * - DID is derived deterministically from mnemonic via HKDF (domain-separated)
 */

import React, { useState, useCallback, useRef } from 'react';
import { RotateCcw, AlertCircle, Clock, CloudDownload, Lock, Eye, EyeOff, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { Layout, Header, ScrollableBody, Footer } from '@/components/shared/Layout';
import { isValidMnemonic } from '@/lib/crypto/mnemonic';
import { loadVaultFromStorage, unsealWithRecoveryKey, sealVault, saveVaultToStorage } from '@/lib/vault/vault';
import type { VaultSession } from '@/lib/vault/vault';
import { initializeDID, storeWrappedRecoveryKey } from '@/lib/did/storage';
import { deriveDIDFromMnemonic, setActiveKeyPair } from '@/lib/did/provider';
import { lookupAndDownloadVault } from '@/lib/vault/sync';
import { derivePinKey, validatePin, PIN_MIN_LENGTH, PIN_PBKDF2_ITERATIONS } from '@/lib/crypto/pin-key';
import { registerWebAuthnCredential } from '@/lib/crypto/primary-key';
import { wrapPrimaryKeyForBiometric } from '@/lib/crypto/biometric-wrap';
import { MessageType, MessageFrom } from '@/lib/types';
import { bufferToBase64 } from '@/lib/crypto/field-encrypt';
import { ReactivationRequired } from './ReactivationRequired';

type RecoveryState = 'input' | 'looking-up' | 'deriving' | 'pin-setup' | 'done' | 'error' | 'archived';

interface RecoveryFlowProps {
  onRecovered: () => void;
  onBack: () => void;
}

export function RecoveryFlow({ onRecovered, onBack }: RecoveryFlowProps) {
  const [phrase, setPhrase] = useState('');
  const [state, setState] = useState<RecoveryState>('input');
  const [statusMsg, setStatusMsg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [estimatedMs, setEstimatedMs] = useState<number | null>(null);
  const [archivalInfo, setArchivalInfo] = useState<{
    reactivateUrl: string;
    archivedSince: string;
  } | null>(null);

  // PIN setup after recovery (for vaults using PIN mode)
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const pendingSessionRef = useRef<{
    vaultSession: VaultSession;
    recoveryKey: CryptoKey;
    derivedKeyPair: { keyPair: CryptoKeyPair; did: string };
    bipSeed?: Uint8Array;
  } | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const startTimeRef = useRef<number>(0);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanupWorker = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  /** Send vault session to background and complete recovery */
  const finalizeRecovery = useCallback(async (
    vaultSession: VaultSession,
    recoveryKey: CryptoKey,
    primaryKey?: CryptoKey
  ) => {
    const recoveryKeyRaw = bufferToBase64(
      new Uint8Array(await crypto.subtle.exportKey('raw', recoveryKey))
    );
    const primaryKeyRaw = primaryKey
      ? bufferToBase64(new Uint8Array(await crypto.subtle.exportKey('raw', primaryKey)))
      : null;

    await browser.runtime.sendMessage({
      type: MessageType.unlockVault,
      from: MessageFrom.popup,
      payload: { vaultSession, primaryKeyRaw, recoveryKeyRaw },
    });
  }, []);

  /** After PIN setup: derive new primary key, re-seal vault, finalize */
  const handlePinSetup = useCallback(async () => {
    setPinError(null);
    const err = validatePin(pin);
    if (err) { setPinError(err); return; }
    if (pin !== pinConfirm) { setPinError('Passphrases do not match.'); return; }

    const pending = pendingSessionRef.current;
    if (!pending) return;

    try {
      setStatusMsg('Deriving key from passphrase\u2026');
      setState('deriving');
      setProgress(96);

      const { vaultSession, recoveryKey, derivedKeyPair, bipSeed } = pending;
      const primaryKey = await derivePinKey(pin, vaultSession.bundle.did);

      // Re-encrypt DID with PIN key (was encrypted with recovery key during recovery)
      // so that normal PIN unlock can load the DID signing key
      await initializeDID(primaryKey, derivedKeyPair, bipSeed);

      // Zero-fill BIP-39 seed after use
      if (bipSeed) bipSeed.fill(0);

      // Store recovery key wrapped by PIN key — needed for cross-device sync
      // so that normal PIN unlock can decrypt the remote recoveryVault tier
      await storeWrappedRecoveryKey(primaryKey, recoveryKey);

      // Recovery starts with a 'pin' vault, then attempts biometric upgrade.
      setStatusMsg('Re-encrypting vault\u2026');
      setProgress(96);
      let updatedSession: VaultSession = {
        ...vaultSession,
        primaryKey,
        recoveryKey,
        bundle: {
          ...vaultSession.bundle,
          kdfParams: {
            ...vaultSession.bundle.kdfParams,
            primary: { type: 'pin' as const, iterations: PIN_PBKDF2_ITERATIONS },
          },
        },
      };
      const sealed = await sealVault(updatedSession);
      await saveVaultToStorage(sealed);
      updatedSession = { ...updatedSession, bundle: sealed };

      setProgress(97);

      // Attempt biometric upgrade: register WebAuthn credential, then wrap
      // the primary key for face/fingerprint unlock. If this fails (user
      // cancels Windows Hello, no WebAuthn support, etc.) we silently fall
      // back to PIN-only — the vault is already safely saved above.
      try {
        if (window.PublicKeyCredential) {
          setStatusMsg('Setting up biometric unlock\u2026');
          const webauthn = await registerWebAuthnCredential();
          await wrapPrimaryKeyForBiometric(primaryKey, webauthn.credentialId);

          // Upgrade vault type from 'pin' → 'biometric' and store credential ID
          const biometricBundle = {
            ...sealed,
            kdfParams: {
              ...sealed.kdfParams,
              primary: { type: 'biometric' as const, iterations: PIN_PBKDF2_ITERATIONS },
            },
            credentialId: bufferToBase64(webauthn.credentialId),
          };
          await saveVaultToStorage(biometricBundle);
          updatedSession = { ...updatedSession, bundle: biometricBundle };
          console.log('[NodeZero] Recovery: biometric upgrade successful');
        }
      } catch (bioErr) {
        // Non-fatal — user cancelled or WebAuthn unsupported. PIN vault works fine.
        console.log('[NodeZero] Recovery: biometric upgrade skipped:', (bioErr as Error)?.message);
      }

      setProgress(100);
      setPin('');
      setPinConfirm('');

      await finalizeRecovery(
        updatedSession,
        recoveryKey,
        primaryKey
      );

      setState('done');
      setStatusMsg('');
      setTimeout(onRecovered, 500);
    } catch (err: any) {
      console.error('[NodeZero] PIN setup after recovery failed:', err);
      setPinError(err?.message ?? 'Passphrase setup failed.');
      setState('pin-setup');
    }
  }, [pin, pinConfirm, onRecovered, finalizeRecovery]);

  const handleRecover = useCallback(async () => {
    setError(null);

    const cleaned = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!isValidMnemonic(cleaned)) {
      setError('Invalid recovery phrase. Check your 12 words and try again.');
      return;
    }

    setState('looking-up');
    setProgress(5);

    try {
      // Step 1: Derive DID + full key pair from mnemonic (fast, <10ms via HKDF)
      // Key pair is needed immediately: the signing key authenticates download
      // requests, and the verifying key is used for vault signature checks.
      setStatusMsg('Deriving identity from phrase\u2026');
      const derivedKeyPair = await deriveDIDFromMnemonic(cleaned);
      const did = derivedKeyPair.did;
      setProgress(10);

      // Activate signing + verifying key so authenticated downloads work
      setActiveKeyPair(
        derivedKeyPair.keyPair.privateKey,
        derivedKeyPair.keyPair.publicKey,
        derivedKeyPair.did
      );

      // Step 2: Try local vault first, then remote (authenticated download)
      let bundle = await loadVaultFromStorage();
      let source: 'local' | 'remote' = 'local';

      if (!bundle) {
        setStatusMsg('Looking up vault on remote storage\u2026');
        bundle = await lookupAndDownloadVault(did);
        source = 'remote';
      }

      if (!bundle) {
        setError(
          'No vault found for this recovery phrase. ' +
          'Make sure you have synced your vault at least once.'
        );
        setState('error');
        return;
      }

      // Verify the DID matches the vault
      if (bundle.did !== did) {
        setError(
          'Recovery phrase does not match this vault. ' +
          'The vault may have been created with a different phrase.'
        );
        setState('error');
        return;
      }

      console.log(`[NodeZero] Vault found (${source}). Starting PBKDF2 derivation\u2026`);
      setProgress(15);

      // Step 4: PBKDF2 in Web Worker (~30s)
      setState('deriving');
      setStatusMsg('Deriving encryption key (~30s)\u2026');

      startTimeRef.current = Date.now();
      const EXPECTED_MS = 30_000;
      setEstimatedMs(EXPECTED_MS);

      progressTimerRef.current = setInterval(() => {
        const elapsed = Date.now() - startTimeRef.current;
        const pct = Math.min(90, 15 + (elapsed / EXPECTED_MS) * 75);
        setProgress(pct);
      }, 500);

      const rawKey = await runKdfWorker(cleaned, did);
      cleanupWorker();
      setProgress(92);

      // Import raw key as extractable (for message bus transport)
      const recoveryKey = await crypto.subtle.importKey(
        'raw', rawKey,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );

      // Clear phrase from UI
      setPhrase('');

      // Step 5: Unseal vault with recovery key
      setStatusMsg('Decrypting vault\u2026');
      const vaultSession = await unsealWithRecoveryKey(bundle, recoveryKey);
      setProgress(95);

      // Step 6: Store DID key pair on this device (encrypted with recovery key)
      // This enables signing for sync/uploads even in recovery mode
      await initializeDID(recoveryKey, derivedKeyPair, derivedKeyPair.bipSeed);

      // Step 7: Save vault to local storage (for future unlocks)
      if (source === 'remote') {
        await saveVaultToStorage(bundle);
      }

      setProgress(100);

      // Step 8: If vault uses PIN or biometric mode, prompt user to set a passphrase
      // for this device before finalizing. The original passphrase doesn't transfer.
      if (bundle.kdfParams.primary.type === 'pin' || bundle.kdfParams.primary.type === 'biometric') {
        pendingSessionRef.current = { vaultSession, recoveryKey, derivedKeyPair, bipSeed: derivedKeyPair.bipSeed };
        setState('pin-setup');
        setStatusMsg('');
        return;
      }

      // Non-PIN vaults: finalize immediately
      derivedKeyPair.bipSeed.fill(0);  // Zero-fill BIP-39 seed
      await finalizeRecovery(vaultSession, recoveryKey);
      setState('done');
      setStatusMsg('');
      setTimeout(onRecovered, 500);
    } catch (err: any) {
      cleanupWorker();

      // Handle vault archived (402) — show reactivation screen
      if (err?.message === 'vault_archived') {
        setArchivalInfo({
          reactivateUrl: err.reactivateUrl ?? 'https://nodezero.top/reactivate',
          archivedSince: err.archivedSince ?? '',
        });
        setState('archived');
        setProgress(0);
        return;
      }

      console.error('[NodeZero] Recovery error:', err);
      setError(err?.message ?? 'Recovery failed. Check your phrase and try again.');
      setState('error');
      setProgress(0);
    }
  }, [phrase, onRecovered, cleanupWorker, finalizeRecovery]);

  const wordCount = phrase.trim() ? phrase.trim().split(/\s+/).length : 0;
  const isValid = wordCount === 12 && isValidMnemonic(phrase.trim().toLowerCase());
  const elapsedSec = estimatedMs ? Math.round(estimatedMs / 1000) : 30;

  // Archived vault — show reactivation screen (full layout)
  if (state === 'archived' && archivalInfo) {
    return (
      <ReactivationRequired
        reactivateUrl={archivalInfo.reactivateUrl}
        archivedSince={archivalInfo.archivedSince}
        onBack={() => { setState('input'); setArchivalInfo(null); }}
      />
    );
  }

  return (
    <Layout>
      <Header
        title="Recover Vault"
        left={
          state === 'input' || state === 'error' ? (
            <Button variant="ghost" size="sm" onClick={onBack} className="h-6 w-6 p-0" aria-label="Back">
              <ArrowLeft className="w-4 h-4" />
            </Button>
          ) : undefined
        }
      />
      {state === 'pin-setup' ? (
        /* ── PIN setup after recovery ──────────────────────────────────── */
        <>
          <ScrollableBody className="p-4 space-y-4">
            <div className="w-full flex justify-center">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                <Lock className="w-6 h-6 text-primary" />
              </div>
            </div>
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">Set Your Vault Passphrase</h2>
              <p className="text-xs text-muted-foreground">
                Your vault uses a passphrase for daily unlocking.
                Set a passphrase for this device to continue.
              </p>
            </div>
            {pinError && (
              <div className="flex items-start gap-2 bg-destructive/10 text-destructive border border-destructive/20 rounded-md px-3 py-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <p className="text-xs">{pinError}</p>
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
                    onChange={e => setPin(e.target.value)}
                    autoComplete="new-password"
                    autoFocus
                    className="pr-9"
                  />
                  <Button type="button" variant="ghost" size="sm"
                    onClick={() => setShowPin(v => !v)}
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
                  onChange={e => setPinConfirm(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && pin.length >= PIN_MIN_LENGTH && pinConfirm) handlePinSetup();
                  }}
                  autoComplete="new-password"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              You can use the same passphrase as your original device, or choose a new one.
            </p>
          </ScrollableBody>
          <Footer>
            <Button
              onClick={handlePinSetup}
              className="w-full"
              disabled={pin.length < PIN_MIN_LENGTH || !pinConfirm}
            >
              Set Passphrase & Continue
            </Button>
          </Footer>
        </>
      ) : (
        /* ── All other states ──────────────────────────────────────────── */
        <>
          <ScrollableBody className="p-4 space-y-4">
            {state === 'input' || state === 'error' ? (
              <>
                <div className="space-y-1">
                  <h2 className="text-sm font-semibold">Enter Recovery Phrase</h2>
                  <p className="text-xs text-muted-foreground">
                    Enter your 12-word recovery phrase to restore your vault.
                    Works on any device — your vault will be downloaded from the cloud.
                  </p>
                </div>

                {error && (
                  <div className="flex items-start gap-2 bg-destructive/10 text-destructive border border-destructive/20 rounded-md px-3 py-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <p className="text-xs">{error}</p>
                  </div>
                )}

                <Textarea
                  placeholder="word1 word2 word3 ... word12"
                  value={phrase}
                  onChange={e => setPhrase(e.target.value)}
                  className="font-mono text-sm resize-none h-24"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />

                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{wordCount}/12 words</span>
                  {wordCount > 0 && wordCount === 12 && (
                    <span className={isValid ? 'text-green-600 dark:text-green-400' : 'text-destructive'}>
                      {isValid ? '\u2713 Valid phrase' : '\u2717 Invalid phrase'}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted rounded-md px-3 py-2">
                  <Clock className="w-3.5 h-3.5 shrink-0" />
                  <span>Key derivation takes ~30s (2M iterations). This is by design.</span>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center gap-6 py-8">
                <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
                  {state === 'looking-up' ? (
                    <CloudDownload className="w-8 h-8 text-primary animate-pulse" />
                  ) : state === 'done' ? (
                    <RotateCcw className="w-8 h-8 text-primary" />
                  ) : (
                    <RotateCcw className="w-8 h-8 text-primary animate-spin" style={{
                      animationDuration: '3s',
                      animationTimingFunction: 'linear',
                    }} />
                  )}
                </div>
                <div className="text-center space-y-1">
                  <h2 className="text-sm font-semibold">
                    {state === 'done' ? 'Recovery Complete!' :
                     state === 'looking-up' ? 'Finding Your Vault\u2026' :
                     'Deriving Key\u2026'}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {state === 'done'
                      ? 'Your vault has been restored.'
                      : statusMsg || 'Please wait\u2026'
                    }
                  </p>
                </div>
                <div className="w-full space-y-1">
                  <Progress value={progress} />
                  <p className="text-xs text-muted-foreground text-right">{Math.round(progress)}%</p>
                </div>
              </div>
            )}
          </ScrollableBody>

          {(state === 'input' || state === 'error') && (
            <Footer>
              <Button
                onClick={handleRecover}
                className="w-full"
                disabled={!isValid}
              >
                Recover Vault
              </Button>
            </Footer>
          )}
        </>
      )}
    </Layout>
  );
}

/**
 * Run the PBKDF2 derivation in a Web Worker.
 * Returns raw key bytes as ArrayBuffer.
 */
function runKdfWorker(mnemonic: string, didSalt: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    // In WXT, workers in entrypoints/ are built to /<name>.js
    const worker = new Worker(
      '/kdf-worker.js',
      { type: 'module' }
    );

    worker.onmessage = (e: MessageEvent) => {
      const { type } = e.data;
      if (type === 'done') {
        worker.terminate();
        resolve(e.data.keyMaterial as ArrayBuffer);
      } else if (type === 'error') {
        worker.terminate();
        reject(new Error(e.data.message));
      }
    };

    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Worker error'));
    };

    worker.postMessage({ type: 'derive', mnemonic, didSalt });
  });
}
