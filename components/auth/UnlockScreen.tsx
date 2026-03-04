/**
 * UnlockScreen — handles PRF, passphrase, and biometric unlock modes
 *
 * PRF mode (hardware key):    WebAuthn assertion → PRF → HKDF → AES key
 * Passphrase mode (no cred):  enter passphrase → PBKDF2 → AES key
 * Biometric mode (Win Hello):  WebAuthn assertion (face/fingerprint) → unwrap stored key
 *
 * The vault bundle's kdfParams.primary.type determines the primary UI.
 * Biometric mode also offers passphrase as a fallback (e.g. if face scan fails).
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Fingerprint, KeyRound, RotateCcw, AlertCircle, Eye, EyeOff, Lock, ScanFace, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Layout, Header, ScrollableBody } from '@/components/shared/Layout';
import { derivePrimaryKey } from '@/lib/crypto/primary-key';
import { derivePinKey, PIN_PBKDF2_ITERATIONS_LEGACY } from '@/lib/crypto/pin-key';
import { unwrapPrimaryKeyWithBiometric, hasBiometricWrapKey } from '@/lib/crypto/biometric-wrap';
import { loadVaultFromStorage, unsealWithPrimaryKey } from '@/lib/vault/vault';
import { loadAndActivateDID, loadWrappedRecoveryKey } from '@/lib/did/storage';
import { MessageType, MessageFrom } from '@/lib/types';
import { base64ToBuffer, bufferToBase64 } from '@/lib/crypto/field-encrypt';
import { getUnlockMode } from '@/lib/settings/unlock-preference';
import type { UnlockMode } from '@/lib/settings/unlock-preference';
import { escapePopupForWebAuthn } from '@/lib/popout';

interface UnlockScreenProps {
  onUnlocked: () => void;
  onRecovery: () => void;
  onCreateNew: () => void;
}

type UnlockState = 'idle' | 'waiting' | 'decrypting' | 'error';

export function UnlockScreen({ onUnlocked, onRecovery, onCreateNew }: UnlockScreenProps) {
  const [showCreateConfirm, setShowCreateConfirm] = useState(false);
  const [primaryMode, setPrimaryMode] = useState<'prf' | 'pin' | 'biometric' | null>(null);
  const [unlockPref, setUnlockPref] = useState<UnlockMode>('biometric');
  const [state, setState] = useState<UnlockState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [showPassphraseFallback, setShowPassphraseFallback] = useState(false);

  // Load vault to determine which unlock mode to display
  useEffect(() => {
    // Load user's unlock preference (biometric vs passphrase-first)
    getUnlockMode().then(setUnlockPref);

    loadVaultFromStorage().then(async bundle => {
      if (bundle) {
        const type = bundle.kdfParams.primary.type as 'prf' | 'pin' | 'biometric';
        // Verify biometric wrap key still exists (could have been cleared)
        if (type === 'biometric') {
          const hasWrap = await hasBiometricWrapKey();
          setPrimaryMode(hasWrap ? 'biometric' : 'pin');
        } else {
          setPrimaryMode(type);
        }
      }
    });
  }, []);

  // ── Helper: finalize unlock (send keys to background) ────────────────────

  const finalizeUnlock = useCallback(async (
    primaryKey: CryptoKey,
    bundle: Awaited<ReturnType<typeof loadVaultFromStorage>>,
  ) => {
    if (!bundle) throw new Error('No vault found.');

    await loadAndActivateDID(primaryKey);
    const vaultSession = await unsealWithPrimaryKey(bundle, primaryKey);
    const recoveryKey = await loadWrappedRecoveryKey(primaryKey);

    const primaryKeyRaw = bufferToBase64(
      new Uint8Array(await crypto.subtle.exportKey('raw', primaryKey))
    );
    const recoveryKeyRaw = recoveryKey
      ? bufferToBase64(new Uint8Array(await crypto.subtle.exportKey('raw', recoveryKey)))
      : null;

    await browser.runtime.sendMessage({
      type: MessageType.unlockVault,
      from: MessageFrom.popup,
      payload: { vaultSession, primaryKeyRaw, recoveryKeyRaw },
    });
  }, []);

  // ── PRF unlock ───────────────────────────────────────────────────────────

  const handlePrfUnlock = useCallback(async () => {
    setError(null);

    // Chrome popup auto-closes on focus loss — escape to side panel or pop-out
    if (await escapePopupForWebAuthn()) return;

    setState('waiting');
    try {
      const bundle = await loadVaultFromStorage();
      if (!bundle) { setError('No vault found.'); setState('error'); return; }
      if (!bundle.credentialId) { setError('No passkey registered. Use recovery phrase.'); setState('error'); return; }

      setState('decrypting');
      const primaryKey = await derivePrimaryKey(base64ToBuffer(bundle.credentialId));
      await finalizeUnlock(primaryKey, bundle);
      onUnlocked();
    } catch (err: any) {
      const msg: string = err?.message ?? 'Authentication failed.';
      setError(
        msg.includes('cancelled') || msg.includes('NotAllowed') || msg.includes('not allowed') || msg.includes('timed out')
          ? 'Authentication cancelled. Try again.'
          : msg
      );
      setState('error');
    }
  }, [onUnlocked, finalizeUnlock]);

  // ── Biometric unlock (Windows Hello face/fingerprint) ────────────────────

  const handleBiometricUnlock = useCallback(async () => {
    setError(null);

    // Chrome popup auto-closes on focus loss — escape to side panel or pop-out
    if (await escapePopupForWebAuthn()) return;

    setState('waiting');
    try {
      const bundle = await loadVaultFromStorage();
      if (!bundle) { setError('No vault found.'); setState('error'); return; }
      if (!bundle.credentialId) { setError('No passkey registered.'); setState('error'); return; }

      const credentialId = base64ToBuffer(bundle.credentialId);

      // Trigger WebAuthn assertion — Windows Hello will show face scan
      const rpId = new URL(window.location.href).hostname;
      const challenge = crypto.getRandomValues(new Uint8Array(32));

      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          rpId,
          userVerification: 'required',
          allowCredentials: [{ id: credentialId, type: 'public-key' }],
          timeout: 60000,
        },
      }) as PublicKeyCredential;

      if (!assertion) {
        setError('Authentication cancelled. Try again.');
        setState('error');
        return;
      }

      // Face scan succeeded — unwrap the stored primary key
      setState('decrypting');
      const primaryKey = await unwrapPrimaryKeyWithBiometric(credentialId);
      await finalizeUnlock(primaryKey, bundle);
      onUnlocked();
    } catch (err: any) {
      const msg: string = err?.message ?? 'Biometric authentication failed.';
      if (msg.includes('cancelled') || msg.includes('NotAllowed') || msg.includes('not allowed') || msg.includes('timed out')) {
        // Biometric dismissed — fall back to passphrase so the user isn't stuck
        setShowPassphraseFallback(true);
        setError('Biometric dismissed. Use your passphrase to unlock.');
        setState('idle');
      } else {
        console.error('[NodeZero] Biometric unlock failed:', err);
        setError(msg);
        setState('error');
      }
    }
  }, [onUnlocked, finalizeUnlock]);

  // Auto-trigger biometric on mount for biometric mode
  // If user prefers passphrase-first, skip biometric and show passphrase input
  useEffect(() => {
    if (primaryMode === 'biometric' && state === 'idle' && !showPassphraseFallback) {
      if (unlockPref === 'passphrase-first') {
        // Skip biometric — go straight to passphrase input
        setShowPassphraseFallback(true);
        return;
      }
      // Small delay so the UI renders before the WebAuthn dialog appears
      const timer = setTimeout(() => handleBiometricUnlock(), 300);
      return () => clearTimeout(timer);
    }
  }, [primaryMode, state, showPassphraseFallback, unlockPref, handleBiometricUnlock]);

  // ── PIN/passphrase unlock ────────────────────────────────────────────────

  const handlePinUnlock = useCallback(async () => {
    if (!pin) return;
    setError(null);
    setState('decrypting');
    try {
      const bundle = await loadVaultFromStorage();
      if (!bundle) { setError('No vault found.'); setState('error'); return; }

      const kdfType = bundle.kdfParams.primary.type;
      const iterations = (kdfType === 'pin' || kdfType === 'biometric')
        ? ((bundle.kdfParams.primary as any).iterations ?? PIN_PBKDF2_ITERATIONS_LEGACY)
        : PIN_PBKDF2_ITERATIONS_LEGACY;
      const primaryKey = await derivePinKey(pin, bundle.did, iterations);
      await finalizeUnlock(primaryKey, bundle);
      setPin('');
      onUnlocked();
    } catch (err: any) {
      console.error('[NodeZero] Passphrase unlock failed:', err);
      setError('Incorrect passphrase or corrupted vault.');
      setState('error');
    }
  }, [pin, onUnlocked, finalizeUnlock]);

  const busy = state === 'waiting' || state === 'decrypting';

  const errorBanner = error && (
    <div className="flex items-start gap-2 w-full bg-destructive/10 text-destructive border border-destructive/20 rounded-md px-3 py-2">
      <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
      <p className="text-xs">{error}</p>
    </div>
  );

  const recoveryLink = (
    <div className="flex flex-col gap-1 w-full">
      <Button variant="ghost" onClick={onRecovery} className="w-full gap-2 text-muted-foreground" disabled={busy}>
        <RotateCcw className="w-3.5 h-3.5" />
        Recover with phrase
      </Button>
      <Button variant="ghost" onClick={() => setShowCreateConfirm(true)} className="w-full gap-2 text-muted-foreground" disabled={busy}>
        <Plus className="w-3.5 h-3.5" />
        Create new vault
      </Button>
    </div>
  );

  // ── Confirm create new vault ───────────────────────────────────────────
  if (showCreateConfirm) {
    return (
      <Layout>
        <Header title="Create New Vault" />
        <ScrollableBody className="flex flex-col items-center justify-center gap-6 p-8">
          <div className="w-16 h-16 rounded-2xl bg-amber-500/10 flex items-center justify-center">
            <AlertCircle className="w-8 h-8 text-amber-500" />
          </div>
          <div className="text-center space-y-2">
            <h2 className="text-sm font-semibold">Replace existing vault?</h2>
            <p className="text-xs text-muted-foreground">
              Creating a new vault will <strong>permanently delete</strong> the vault
              currently stored on this device. If you haven't synced it or saved your
              recovery phrase, that data will be lost.
            </p>
          </div>
          <div className="flex flex-col gap-2 w-full">
            <Button
              variant="destructive"
              onClick={onCreateNew}
              className="w-full"
            >
              Delete & Create New Vault
            </Button>
            <Button
              variant="outline"
              onClick={() => setShowCreateConfirm(false)}
              className="w-full"
            >
              Cancel
            </Button>
          </div>
        </ScrollableBody>
      </Layout>
    );
  }

  // Loading while determining mode
  if (primaryMode === null) {
    return (
      <Layout>
        <Header title="NodeZero" />
        <ScrollableBody className="flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </ScrollableBody>
      </Layout>
    );
  }

  // ── Biometric mode ─────────────────────────────────────────────────────

  if (primaryMode === 'biometric' && !showPassphraseFallback) {
    return (
      <Layout>
        <Header title="NodeZero" />
        <ScrollableBody className="flex flex-col items-center justify-center gap-6 p-8">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
            <ScanFace className="w-8 h-8 text-primary" />
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground">
              {state === 'waiting'
                ? 'Look at your camera…'
                : state === 'decrypting'
                ? 'Unlocking vault…'
                : 'Unlock with face or fingerprint'}
            </p>
          </div>

          {errorBanner}

          <div className="flex flex-col gap-3 w-full">
            <Button onClick={handleBiometricUnlock} disabled={busy} className="w-full gap-2">
              <ScanFace className="w-4 h-4" />
              {state === 'waiting'
                ? 'Scanning…'
                : state === 'decrypting'
                ? 'Decrypting vault…'
                : 'Unlock with Biometrics'}
            </Button>
            <Button
              variant="outline"
              onClick={() => { setShowPassphraseFallback(true); setError(null); setState('idle'); }}
              disabled={busy}
              className="w-full gap-2 text-muted-foreground"
            >
              <KeyRound className="w-3.5 h-3.5" />
              Use passphrase instead
            </Button>
            {recoveryLink}
          </div>
        </ScrollableBody>
      </Layout>
    );
  }

  // ── PIN / passphrase mode (also used as biometric fallback) ────────────

  if (primaryMode === 'pin' || primaryMode === 'biometric') {
    return (
      <Layout>
        <Header title="NodeZero" />
        <ScrollableBody className="flex flex-col items-center justify-center gap-6 p-8">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
            <Lock className="w-8 h-8 text-primary" />
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Enter your vault passphrase to unlock</p>
          </div>

          {errorBanner}

          <div className="w-full space-y-3">
            <div className="relative">
              <Input
                type={showPin ? 'text' : 'password'}
                placeholder="Vault passphrase"
                value={pin}
                onChange={e => setPin(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !busy && pin) handlePinUnlock(); }}
                autoComplete="current-password"
                autoFocus
                className="pr-9"
                disabled={busy}
              />
              <Button type="button" variant="ghost" size="sm"
                onClick={() => setShowPin(v => !v)}
                className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 p-0">
                {showPin ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </Button>
            </div>

            <Button onClick={handlePinUnlock} disabled={!pin || busy} className="w-full gap-2">
              <KeyRound className="w-4 h-4" />
              {state === 'decrypting' ? 'Unlocking…' : 'Unlock'}
            </Button>

            {/* Show "back to biometric" button if this is a fallback from biometric mode */}
            {primaryMode === 'biometric' && showPassphraseFallback && (
              <Button
                variant="outline"
                onClick={() => { setShowPassphraseFallback(false); setError(null); setState('idle'); }}
                disabled={busy}
                className="w-full gap-2 text-muted-foreground"
              >
                <ScanFace className="w-3.5 h-3.5" />
                Use face/fingerprint instead
              </Button>
            )}

            {recoveryLink}
          </div>
        </ScrollableBody>
      </Layout>
    );
  }

  // ── PRF mode ──────────────────────────────────────────────────────────────

  return (
    <Layout>
      <Header title="NodeZero" />
      <ScrollableBody className="flex flex-col items-center justify-center gap-6 p-8">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
          <KeyRound className="w-8 h-8 text-primary" />
        </div>
        <div className="text-center">
          <p className="text-xs text-muted-foreground">Your keys. Your vault.</p>
        </div>

        {errorBanner}

        <div className="flex flex-col gap-3 w-full">
          <Button onClick={handlePrfUnlock} disabled={busy} className="w-full gap-2">
            <Fingerprint className="w-4 h-4" />
            {state === 'waiting'
              ? 'Touch your security key…'
              : state === 'decrypting'
              ? 'Decrypting vault…'
              : 'Unlock with Passkey'}
          </Button>
          {recoveryLink}
        </div>
      </ScrollableBody>
    </Layout>
  );
}
