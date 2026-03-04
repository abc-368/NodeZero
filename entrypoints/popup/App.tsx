/**
 * Popup App — Main router
 *
 * Screen state machine:
 *   loading → onboarding | locked | vault
 *   locked → vault (after PRF unlock) | recovery
 *   recovery → vault
 *   vault → editor | generator | settings
 *   editor → vault
 *   generator → vault
 *   settings → vault | import | export
 */

import React, { useState, useEffect, useCallback } from 'react';
import { ThemeProvider, useTheme } from '@/components/theme-provider';
import { Onboarding } from '@/components/auth/Onboarding';
import { UnlockScreen } from '@/components/auth/UnlockScreen';
import { RecoveryFlow } from '@/components/auth/RecoveryFlow';
import { VaultList } from '@/components/vault/VaultList';
import { EntryEditor } from '@/components/vault/EntryEditor';
import { FillPicker } from '@/components/vault/FillPicker';
import { ImportScreen } from '@/components/vault/ImportScreen';
import { ExportScreen } from '@/components/vault/ExportScreen';
import { PasswordGenerator } from '@/components/generator/PasswordGenerator';
import { Layout, Header, ScrollableBody } from '@/components/shared/Layout';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { VaultEntry, createEntry } from '@/lib/vault/entry';
import { vaultExists } from '@/lib/vault/vault';
import { Input } from '@/components/ui/input';
import { MessageType, MessageFrom, SessionState, PageInfo } from '@/lib/types';
import { ArrowLeft, Shield, RefreshCw, Sun, Moon, Key, Upload, Download, ScanFace, KeyRound, Share2 } from 'lucide-react';
import { getUnlockMode, setUnlockMode } from '@/lib/settings/unlock-preference';
import type { UnlockMode } from '@/lib/settings/unlock-preference';
import { DeviceBudget } from '@/components/vault/DeviceBudget';
import { TokenCounter } from '@/components/vault/TokenCounter';
import type { TierStatus, Tier } from '@/lib/tier';
import { getPoolMeta } from '@/lib/tokens/pool';
import { BUILD_HASH } from '@/lib/build-info';
import { TierSelector } from '@/components/settings/TierSelector';
import { StorageQuota } from '@/components/settings/StorageQuota';
import { SharingScreen } from '@/components/delegation/SharingScreen';
import { IncomingDelegationsScreen } from '@/components/delegation/IncomingDelegationsScreen';
import { SecurityReportScreen } from '@/components/vault/SecurityReportScreen';
import { WalletScreen } from '@/components/wallet/WalletScreen';
import { WalletApprovalScreen } from '@/components/wallet/WalletApprovalScreen';
import { PasskeyListScreen } from '@/components/vault/PasskeyListScreen';
import { DashboardScreen } from '@/components/vault/DashboardScreen';

type Screen =
  | 'loading'
  | 'onboarding'
  | 'locked'
  | 'recovery'
  | 'dashboard'
  | 'vault'
  | 'new-entry'
  | 'edit-entry'
  | 'generator'
  | 'settings'
  | 'import'
  | 'export'
  | 'fill-picker'
  | 'share'
  | 'incoming-delegations'
  | 'security-report'
  | 'wallet'
  | 'wallet-approval'
  | 'passkeys';

interface SyncStatus {
  type: 'success' | 'error' | 'warning';
  message: string;
}

function AppInner() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [editingEntry, setEditingEntry] = useState<VaultEntry | undefined>(undefined);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [pendingSave, setPendingSave] = useState<PageInfo | null>(null);
  const [pendingFill, setPendingFill] = useState<{ entries: VaultEntry[]; tabId: number } | null>(null);
  const [recoverySource, setRecoverySource] = useState<'locked' | 'onboarding'>('locked');
  const { theme } = useTheme();

  // ── MV3 keepalive — ping background every 25s while popup is open ────────
  // An open port alone doesn't reset Chrome's 30s inactivity timer; we must
  // actively use it.  Pings keep the service worker (and its session) alive
  // for as long as the popup is open, regardless of user activity.
  useEffect(() => {
    const port = browser.runtime.connect({ name: 'nodezero-keepalive' });
    const interval = setInterval(() => {
      try {
        port.postMessage({ type: 'ping' });
      } catch {
        clearInterval(interval); // port closed unexpectedly
      }
    }, 25_000);
    return () => {
      clearInterval(interval);
      try { port.disconnect(); } catch { /* already closed */ }
    };
  }, []);

  // ── Fetch page info from the active tab's content script ───────────────

  const fetchActiveTabPageInfo = useCallback(async (): Promise<PageInfo | null> => {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return null;
      // Inject content script on demand (activeTab grants permission when popup opens)
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content-inject.js'],
      });
      return await browser.tabs.sendMessage(tab.id, {
        type: MessageType.getPageInfo,
        from: MessageFrom.popup,
      }) as PageInfo;
    } catch {
      return null; // injection or messaging failed (e.g. chrome:// pages)
    }
  }, []);

  // ── Initialization ──────────────────────────────────────────────────────

  useEffect(() => {
    (async () => {
      try {
        // Always check for pending context menu actions, regardless of
        // unlock state (fixes: second save wouldn't open the editor
        // because the vault was already unlocked and check was skipped).
        const sessionData = await chrome.storage.session.get(['pendingSaveLogin', 'pendingFill']);
        if (sessionData.pendingSaveLogin) {
          setPendingSave(sessionData.pendingSaveLogin);
          await chrome.storage.session.remove('pendingSaveLogin');
        }
        if (sessionData.pendingFill) {
          setPendingFill(sessionData.pendingFill);
          await chrome.storage.session.remove('pendingFill');
        }

        // Check if already unlocked in background
        const state = await browser.runtime.sendMessage({
          type: MessageType.getSessionState,
          from: MessageFrom.popup,
        }) as SessionState;

        if (state.isUnlocked) {
          await loadEntries();
          // Route to the right screen based on pending actions
          if (sessionData.pendingFill) {
            setScreen('fill-picker');
          } else if (sessionData.pendingSaveLogin) {
            setEditingEntry(undefined);
            setScreen('new-entry');
          } else {
            setScreen('dashboard');
          }
          return;
        }

        // Check if vault exists
        const exists = await vaultExists();
        setScreen(exists ? 'locked' : 'onboarding');
      } catch (err) {
        console.error('[NodeZero] Init error:', err);
        setScreen('locked');
      }
    })();
  }, []);

  // ── Session handling ─────────────────────────────────────────────────────

  const loadEntries = useCallback(async () => {
    try {
      const response = await browser.runtime.sendMessage({
        type: MessageType.getVaultEntries,
        from: MessageFrom.popup,
      }) as { entries: VaultEntry[] } | { error: string };

      if ('entries' in response) {
        setEntries(response.entries);
      }
    } catch (err) {
      console.error('[NodeZero] Load entries error:', err);
    }
  }, []);

  const handleUnlocked = useCallback(async () => {
    await loadEntries();
    // Route based on pending context menu actions
    if (pendingFill) {
      setScreen('fill-picker');
    } else if (pendingSave) {
      setEditingEntry(undefined);
      setScreen('new-entry');
    } else {
      setScreen('dashboard');
    }
  }, [loadEntries, pendingSave, pendingFill]);

  const handleLock = useCallback(async () => {
    await browser.runtime.sendMessage({
      type: MessageType.lockVault,
      from: MessageFrom.popup,
    });
    setEntries([]);
    setScreen('locked');
  }, []);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncStatus(null);
    try {
      const response = await browser.runtime.sendMessage({
        type: MessageType.syncVault,
        from: MessageFrom.popup,
      }) as { success: true; result?: { tokenLimitReached?: boolean } } | { error: string };

      if ('success' in response) {
        if (response.result?.tokenLimitReached) {
          setSyncStatus({ type: 'warning', message: 'Daily points limit reached. Saved locally.' });
        } else {
          setSyncStatus({ type: 'success', message: 'Vault synced' });
        }
        await loadEntries();
      } else {
        setSyncStatus({ type: 'error', message: response.error || 'Sync failed' });
      }
    } catch (err: any) {
      setSyncStatus({ type: 'error', message: err.message || 'Sync error' });
    } finally {
      setSyncing(false);
      // Auto-hide status after 3 seconds (5s for warnings)
      const delay = syncStatus?.type === 'warning' ? 5000 : 3000;
      setTimeout(() => setSyncStatus(null), delay);
    }
  }, [loadEntries]);

  const handleExportVault = useCallback(async () => {
    setSyncing(true);
    setSyncStatus(null);
    try {
      const data = await chrome.storage.local.get('nodezero_vault_bundle');
      const b64: string | undefined = data.nodezero_vault_bundle;
      if (b64) {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.download = `nodezero-vault-backup-${ts}.bin`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setSyncStatus({ type: 'success', message: 'Vault backup saved' });
      } else {
        setSyncStatus({ type: 'error', message: 'No vault data to export' });
      }
    } catch (err: any) {
      setSyncStatus({ type: 'error', message: err.message || 'Export error' });
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncStatus(null), 5000);
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    await loadEntries();
    // Also trigger a background sync check
    handleSync();
  }, [loadEntries, handleSync]);

  // ── Routing ─────────────────────────────────────────────────────────────

  const handleAddEntry = useCallback(async () => {
    // Capture the current tab's page info so the editor can pre-populate
    // URL, title, and any filled-in username/password — same as context menu
    const pageInfo = await fetchActiveTabPageInfo();
    setPendingSave(pageInfo);
    setEditingEntry(undefined);
    setScreen('new-entry');
  }, [fetchActiveTabPageInfo]);

  const handleEditEntry = useCallback((entry: VaultEntry) => {
    setEditingEntry(entry);
    setScreen('edit-entry');
  }, []);

  const handleSaved = useCallback(async () => {
    await loadEntries();
    setScreen('vault');
    setEditingEntry(undefined);
  }, [loadEntries]);

  // ── Render ───────────────────────────────────────────────────────────────

  // Apply dark/light class to root div
  return (
    <div className={theme}>
      {screen === 'loading' && <LoadingScreen />}

      {screen === 'onboarding' && (
        <Onboarding
          onComplete={handleUnlocked}
          onRecover={() => {
            setRecoverySource('onboarding');
            setScreen('recovery');
          }}
        />
      )}

      {screen === 'locked' && (
        <UnlockScreen
          onUnlocked={handleUnlocked}
          onRecovery={() => {
            setRecoverySource('locked');
            setScreen('recovery');
          }}
          onCreateNew={async () => {
            // Lock session, clear vault + DID data, go to onboarding
            await browser.runtime.sendMessage({
              type: MessageType.lockVault,
              from: MessageFrom.popup,
            });
            await chrome.storage.local.remove([
              'nodezero_vault_bundle',
              'nodezero_did',
              'nodezero_wrapped_recovery_key',
              'nodezero_biometric_wrap',
              'nodezero_vault_cid',
            ]);
            setEntries([]);
            setScreen('onboarding');
          }}
        />
      )}

      {screen === 'recovery' && (
        <RecoveryFlow
          onRecovered={handleUnlocked}
          onBack={() => setScreen(recoverySource)}
        />
      )}

      {screen === 'dashboard' && (
        <DashboardScreen
          entries={entries}
          onVault={() => setScreen('vault')}
          onWallet={() => setScreen('wallet')}
          onSettings={() => setScreen('settings')}
          onSecurityReport={() => setScreen('security-report')}
          onLock={handleLock}
        />
      )}

      {screen === 'vault' && (
        <VaultList
          entries={entries}
          onAddEntry={handleAddEntry}
          onEditEntry={handleEditEntry}
          onBack={() => setScreen('dashboard')}
          onLock={handleLock}
          onSettings={() => setScreen('settings')}
          onWallet={() => setScreen('wallet')}
          onRefresh={handleRefresh}
          syncing={syncing}
          syncStatus={syncStatus}
        />
      )}

      {(screen === 'new-entry' || screen === 'edit-entry') && (
        <EntryEditor
          entry={editingEntry}
          defaultUrl={pendingSave?.url ?? ''}
          defaultUsername={pendingSave?.username ?? ''}
          defaultPassword={pendingSave?.password ?? ''}
          defaultTitle={pendingSave?.hostname?.replace(/^www\./, '') ?? ''}
          onSaved={() => { setPendingSave(null); handleSaved(); }}
          onCancel={() => { setPendingSave(null); setScreen('vault'); }}
        />
      )}

      {screen === 'fill-picker' && pendingFill && (
        <FillPicker
          entries={pendingFill.entries}
          tabId={pendingFill.tabId}
          onFilled={() => { setPendingFill(null); setScreen('vault'); }}
          onCancel={() => { setPendingFill(null); setScreen('vault'); }}
        />
      )}

      {screen === 'generator' && (
        <PasswordGenerator
          onBack={() => setScreen('vault')}
        />
      )}

      {screen === 'import' && (
        <ImportScreen
          onImported={async () => {
            await loadEntries();
          }}
          onBack={() => setScreen('settings')}
        />
      )}

      {screen === 'export' && (
        <ExportScreen
          entries={entries}
          onBack={() => setScreen('settings')}
        />
      )}

      {screen === 'share' && (
        <SharingScreen
          entries={entries}
          vaultKey={null /* TODO: pass vault key from unlock state */}
          onBack={() => setScreen('settings')}
        />
      )}

      {screen === 'incoming-delegations' && (
        <IncomingDelegationsScreen
          onBack={() => setScreen('settings')}
          bipSeed={null /* TODO: pass BIP seed from unlock state */}
        />
      )}

      {screen === 'security-report' && (
        <SecurityReportScreen
          entries={entries}
          onBack={() => setScreen('dashboard')}
          onEditEntry={handleEditEntry}
        />
      )}

      {screen === 'wallet' && (
        <WalletScreen
          onBack={() => setScreen('dashboard')}
          onApproval={() => setScreen('wallet-approval')}
        />
      )}

      {screen === 'wallet-approval' && (
        <WalletApprovalScreen
          onBack={() => setScreen('wallet')}
        />
      )}

      {screen === 'passkeys' && (
        <PasskeyListScreen
          entries={entries}
          onBack={() => setScreen('settings')}
          onExportVC={async (entry) => {
            if (!entry.passkey) return;
            try {
              const { issuePasskeyVC, exportPasskeyVCAsJSON } = await import('@/lib/did/passkey-vc');
              const vc = await issuePasskeyVC(entry.passkey, entry.url);
              const json = exportPasskeyVCAsJSON(vc);
              const blob = new Blob([json], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `passkey-vc-${entry.passkey.rpId}-${Date.now()}.json`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            } catch (err: any) {
              console.error('[NodeZero] Passkey VC export failed:', err);
            }
          }}
        />
      )}

      {screen === 'settings' && (
        <SettingsScreen
          onBack={() => setScreen('dashboard')}
          onSync={handleSync}
          onExportVault={handleExportVault}
          onImport={() => setScreen('import')}
          onExport={() => setScreen('export')}
          onShare={() => setScreen('share')}
          onIncoming={() => setScreen('incoming-delegations')}
          onSecurityReport={() => setScreen('security-report')}
          onPasskeys={() => setScreen('passkeys')}
          syncing={syncing}
          syncStatus={syncStatus}
        />
      )}
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}

// ── Sub-screens ────────────────────────────────────────────────────────────

function LoadingScreen() {
  return (
    <Layout>
      <ScrollableBody className="flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" role="status" aria-label="Loading" />
      </ScrollableBody>
    </Layout>
  );
}

interface SettingsScreenProps {
  onBack: () => void;
  onSync: () => void;
  onExportVault: () => Promise<void>;
  onImport: () => void;
  onExport: () => void;
  onShare: () => void;
  onIncoming: () => void;
  onSecurityReport: () => void;
  onPasskeys: () => void;
  syncing: boolean;
  syncStatus: SyncStatus | null;
}

function SettingsScreen({ onBack, onSync, onExportVault, onImport, onExport, onShare, onIncoming, onSecurityReport, onPasskeys, syncing, syncStatus }: SettingsScreenProps) {
  const { theme, toggleTheme } = useTheme();
  const [did, setDid] = useState<string | null>(null);
  const [copiedDid, setCopiedDid] = useState(false);
  const [tierStatus, setTierStatus] = useState<TierStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [unlockMode, setUnlockModeState] = useState<UnlockMode>('biometric');
  const [vaultPrimaryType, setVaultPrimaryType] = useState<'prf' | 'pin' | 'biometric' | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [cacheCleared, setCacheCleared] = useState(false);

  useEffect(() => {
    browser.runtime.sendMessage({ type: MessageType.getSessionState, from: MessageFrom.popup })
      .then((state: any) => setDid(state.did));
    // Read tier from cached pool metadata (populated by balance/issuance responses)
    getPoolMeta().then(meta => {
      if (meta) {
        setTierStatus({
          tier: (meta.tier as Tier) ?? 'free',
          premiumExpiresAt: meta.premiumExpiresAt ?? null,
        });
      }
    });
    // Load unlock preference + vault primary type
    getUnlockMode().then(setUnlockModeState);
    import('@/lib/vault/vault').then(({ loadVaultFromStorage }) =>
      loadVaultFromStorage().then(bundle => {
        if (bundle) {
          const type = bundle.kdfParams.primary.type as 'prf' | 'pin' | 'biometric';
          setVaultPrimaryType(type);
          // PIN vaults default to passphrase-first (no biometric set up yet)
          if (type === 'pin') {
            setUnlockModeState('passphrase-first');
          }
        }
      })
    );
  }, []);

  const copyDid = () => {
    if (!did) return;
    navigator.clipboard.writeText(did);
    setCopiedDid(true);
    setTimeout(() => setCopiedDid(false), 2000);
  };

  return (
    <Layout>
      <Header
        title="Settings"
        left={
          <Button variant="ghost" size="sm" onClick={onBack} className="h-7 w-7 p-0" aria-label="Back">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        }
      />
      <ScrollableBody className="p-4 space-y-6">
        {/* Identity */}
        <div className="space-y-3">
          <div className="flex items-center gap-1.5">
            <Key className="w-3.5 h-3.5 text-muted-foreground" />
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Your Identity (DID)
            </p>
          </div>
          <div className="flex items-center gap-2 bg-muted/50 p-2 rounded-lg border border-dashed">
            <code className="text-[11px] flex-1 truncate">{did ?? 'Locked'}</code>
            <Button variant="ghost" size="sm" onClick={copyDid} disabled={!did} className="h-6 px-2 text-[11px]">
              {copiedDid ? 'Copied!' : 'Copy'}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            This is your unique decentralized identifier. Use it to delegate storage permissions.
          </p>
        </div>

        <Separator />

        {/* Theme */}
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Appearance
          </p>
          <div className="flex gap-2">
            {(['light', 'dark'] as const).map(t => (
              <Button
                key={t}
                variant={theme === t ? 'default' : 'outline'}
                size="sm"
                onClick={() => toggleTheme(t)}
                className="flex-1 capitalize gap-1.5"
              >
                {t === 'light' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                {t}
              </Button>
            ))}
          </div>
        </div>

        <Separator />

        {/* Open Mode: popup vs side panel */}
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Open As
          </p>
          <OpenModeToggle />
        </div>

        <Separator />

        {/* Unlock Mode — for biometric and pin vaults (not PRF) */}
        {(vaultPrimaryType === 'biometric' || vaultPrimaryType === 'pin') && (
          <>
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Unlock Method
              </p>
              <p className="text-xs text-muted-foreground">
                Choose how to unlock your vault when opening NodeZero.
              </p>
              <div className="flex gap-2">
                {([
                  { mode: 'biometric' as UnlockMode, label: 'Auto-Unlock', icon: ScanFace, desc: 'Face / fingerprint' },
                  { mode: 'passphrase-first' as UnlockMode, label: 'Passphrase', icon: KeyRound, desc: 'Type to unlock' },
                ] as const).map(({ mode, label, icon: Icon, desc }) => (
                  <button
                    key={mode}
                    disabled={upgrading}
                    onClick={async () => {
                      // If switching to biometric on a PIN vault, need to register first
                      if (mode === 'biometric' && vaultPrimaryType === 'pin') {
                        // Chrome popup auto-closes on focus loss — escape first
                        const { escapePopupForWebAuthn } = await import('@/lib/popout');
                        if (await escapePopupForWebAuthn()) return;
                        setUpgradeError(null);
                        setUpgrading(true);
                        try {
                          const { registerWebAuthnCredential } = await import('@/lib/crypto/primary-key');
                          const { bufferToBase64 } = await import('@/lib/crypto/field-encrypt');
                          const webauthn = await registerWebAuthnCredential();
                          const result = await browser.runtime.sendMessage({
                            type: MessageType.upgradeToBiometric,
                            from: MessageFrom.popup,
                            payload: { credentialId: bufferToBase64(webauthn.credentialId) },
                          }) as { success?: boolean; error?: string };
                          if (result?.error) throw new Error(result.error);
                          setVaultPrimaryType('biometric');
                          setUnlockModeState('biometric');
                          setUnlockMode('biometric');
                        } catch (err: any) {
                          const msg = err?.message ?? '';
                          console.error('[NodeZero] Biometric upgrade error:', msg, err);
                          if (msg.includes('cancelled') || msg.includes('NotAllowed') || msg.includes('not allowed') || msg.includes('timed out')) {
                            // User cancelled / dismissed Windows Hello — stay on passphrase
                          } else {
                            setUpgradeError(msg || 'Biometric setup failed. Try again.');
                            setTimeout(() => setUpgradeError(null), 5000);
                          }
                        } finally {
                          setUpgrading(false);
                        }
                        return;
                      }
                      setUnlockModeState(mode);
                      setUnlockMode(mode);
                    }}
                    className={`flex-1 flex flex-col items-center gap-1.5 p-3 rounded-lg border-2 transition-colors ${
                      unlockMode === mode
                        ? 'border-primary bg-primary/5'
                        : 'border-muted hover:border-muted-foreground/30'
                    } ${upgrading ? 'opacity-50' : ''}`}
                  >
                    <Icon className={`w-5 h-5 ${unlockMode === mode ? 'text-primary' : 'text-muted-foreground'}`} />
                    <span className={`text-xs font-medium ${unlockMode === mode ? 'text-primary' : ''}`}>{label}</span>
                    <span className="text-[10px] text-muted-foreground">{desc}</span>
                  </button>
                ))}
              </div>
              {upgradeError && (
                <p className="text-[11px] text-destructive">{upgradeError}</p>
              )}
              <p className="text-[11px] text-muted-foreground">
                {upgrading
                  ? 'Setting up biometric unlock…'
                  : vaultPrimaryType === 'pin' && unlockMode === 'passphrase-first'
                  ? 'Select Auto-Unlock to set up face/fingerprint via Windows Hello.'
                  : unlockMode === 'biometric'
                  ? 'Windows Hello will prompt automatically. Passphrase is available as fallback.'
                  : 'Passphrase input shown immediately. Faster if Windows Hello is unreliable.'}
              </p>
            </div>
            <Separator />
          </>
        )}

        {/* Sync */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <RefreshCw className="w-3.5 h-3.5 text-muted-foreground" />
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Vault Sync
              </p>
            </div>
            {syncStatus && (
              <span role="alert" className={`text-[11px] font-medium animate-in fade-in duration-300 ${
                syncStatus.type === 'success' ? 'text-green-500'
                : syncStatus.type === 'warning' ? 'text-amber-500'
                : 'text-destructive'
              }`}>
                {syncStatus.message}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Your encrypted vault syncs securely across devices. Data is unreadable
            without your passkey or recovery phrase.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={onSync}
            disabled={syncing}
            className="w-full gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing…' : 'Sync Now'}
          </Button>
        </div>

        <Separator />

        {/* Secure Email — cache management */}
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Secure Email
          </p>
          <p className="text-xs text-muted-foreground">
            Recipient public keys are cached locally for 24 hours.
            Clear the cache to force a fresh lookup on the next encrypt.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              await chrome.storage.local.remove('nodezero_email_cache');
              setCacheCleared(true);
              setTimeout(() => setCacheCleared(false), 2000);
            }}
            disabled={cacheCleared}
            className="w-full gap-1.5"
          >
            {cacheCleared ? 'Cache cleared' : 'Clear Email Key Cache'}
          </Button>
        </div>

        <Separator />

        {/* Device Sync Budget */}
        <DeviceBudget />

        <Separator />

        {/* Plan / Tier selector */}
        <TierSelector tierStatus={tierStatus} />

        <Separator />

        {/* Storage quota progress bar */}
        <StorageQuota tier={(tierStatus?.tier ?? 'free') as 'free' | 'premium'} />

        <Separator />

        {/* Security Report */}
        <div className="space-y-3">
          <div className="flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5 text-muted-foreground" />
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Security Report
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Check your vault for weak, reused, or old passwords.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={onSecurityReport}
            className="w-full gap-1.5"
          >
            <Shield className="w-3.5 h-3.5" />
            Run Security Audit
          </Button>
        </div>

        <Separator />

        {/* Passkeys */}
        <div className="space-y-3">
          <div className="flex items-center gap-1.5">
            <Key className="w-3.5 h-3.5 text-muted-foreground" />
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Passkeys
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Passkeys registered on websites are automatically captured and
            stored as verifiable credentials in your vault.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={onPasskeys}
            className="w-full gap-1.5"
          >
            <Key className="w-3.5 h-3.5" />
            View Passkeys
          </Button>
        </div>

        <Separator />

        {/* Secure Sharing */}
        <div className="space-y-3">
          <div className="flex items-center gap-1.5">
            <Share2 className="w-3.5 h-3.5 text-muted-foreground" />
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Secure Sharing
            </p>
            {tierStatus?.tier !== 'premium' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 font-medium">
                PRO
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Share vault entries with other NodeZero users via time-limited delegation VCs.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onShare}
              disabled={tierStatus?.tier !== 'premium'}
              className="flex-1 gap-1.5"
            >
              <Upload className="w-3.5 h-3.5" />
              Share
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onIncoming}
              className="flex-1 gap-1.5"
            >
              <Download className="w-3.5 h-3.5" />
              Shared with me
            </Button>
          </div>
        </div>

        <Separator />

        {/* Import & Export */}
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Import & Export
          </p>
          <p className="text-xs text-muted-foreground">
            Import from or export to Chrome, LastPass, Bitwarden, or 1Password CSV format.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onImport}
              className="flex-1 gap-1.5"
            >
              <Upload className="w-3.5 h-3.5" />
              Import
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onExport}
              className="flex-1 gap-1.5"
            >
              <Download className="w-3.5 h-3.5" />
              Export
            </Button>
          </div>
        </div>

        <Separator />

        {/* About */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            About
          </p>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Shield className="w-4 h-4 text-primary" />
            </div>
            <div>
              <p className="text-xs font-medium">NodeZero v{browser.runtime.getManifest().version} {tierStatus?.tier === 'premium' ? <span className="text-blue-400">Premium</span> : <span className="text-muted-foreground">Free</span>} <span className="font-mono text-muted-foreground">({BUILD_HASH})</span></p>
              <p className="text-[11px] text-muted-foreground">
                Decentralized credential manager
              </p>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">
            No master password. No central server. Your vault, your keys.
          </p>
        </div>

        <Separator />

        {/* Vault Backup — save encrypted vault blob to file */}
        <div className="space-y-3">
          <div className="flex items-center gap-1.5">
            <Download className="w-3.5 h-3.5 text-muted-foreground" />
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Vault Backup
            </p>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Save your encrypted vault to a local file. The file is
            AES-256-GCM encrypted CBOR — useless without your recovery
            phrase. Keep this backup in a safe location in case you need
            to restore your vault later.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-1.5"
            disabled={syncing || saving}
            onClick={async () => {
              setSaving(true);
              await onExportVault();
              setSaving(false);
            }}
          >
            <Download className="w-3.5 h-3.5" />
            {saving ? 'Saving…' : 'Save Vault to File'}
          </Button>
        </div>
      </ScrollableBody>

      {/* Token balance footer — persistent across vault + settings */}
      <TokenCounter />
    </Layout>
  );
}

/** Toggle between popup and side panel mode — closes the current view on switch */
function OpenModeToggle() {
  const [mode, setMode] = useState<'popup' | 'sidepanel'>('popup');
  useEffect(() => {
    chrome.storage.local.get('nodezero_open_mode').then(data => {
      setMode((data['nodezero_open_mode'] as 'popup' | 'sidepanel') ?? 'popup');
    });
  }, []);
  const toggle = async (newMode: 'popup' | 'sidepanel') => {
    if (newMode === mode) return;
    setMode(newMode);
    await chrome.storage.local.set({ nodezero_open_mode: newMode });
    // Close the current window so only one mode is active at a time.
    // The background script's storage listener will apply the new sidePanel behavior.
    // Next time the user clicks the extension icon, it opens in the chosen mode.
    window.close();
  };
  return (
    <div className="flex gap-2">
      {([
        { value: 'popup' as const, label: 'Popup' },
        { value: 'sidepanel' as const, label: 'Side Panel' },
      ]).map(({ value, label }) => (
        <Button
          key={value}
          variant={mode === value ? 'default' : 'outline'}
          size="sm"
          className="flex-1 capitalize"
          onClick={() => toggle(value)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}
