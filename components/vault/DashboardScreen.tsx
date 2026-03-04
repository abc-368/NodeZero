/**
 * DashboardScreen — Landing page after unlock.
 *
 * Shows vault stats: password count, security score, passkey count,
 * and non-zero token balances across all chains.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Layout, Header, ScrollableBody } from '@/components/shared/Layout';
import { Button } from '@/components/ui/button';
import {
  Shield,
  Key,
  Wallet,
  Lock,
  Settings,
  Loader2,
  ArrowRight,
  Fingerprint,
  TrendingUp,
  AlertTriangle,
  Copy,
  RefreshCw,
} from 'lucide-react';
import type { VaultEntry } from '@/lib/vault/entry';
import { generateSecurityReport, getGrade, type SecurityReport } from '@/lib/vault/security-report';
import { MessageType, MessageFrom } from '@/lib/types';
import { CHAIN_CONFIGS, EVM_CHAINS, type Chain } from '@/lib/wallet/types';
import { browser } from 'wxt/browser';

interface DashboardScreenProps {
  entries: VaultEntry[];
  onVault: () => void;
  onWallet: () => void;
  onSettings: () => void;
  onSecurityReport: () => void;
  onLock: () => void;
}

interface TokenInfo {
  chain: Chain;
  symbol: string;
  balance: string;
  usdValue?: string;
}

export function DashboardScreen({
  entries,
  onVault,
  onWallet,
  onSettings,
  onSecurityReport,
  onLock,
}: DashboardScreenProps) {
  const [report, setReport] = useState<SecurityReport | null>(null);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [loadingTokens, setLoadingTokens] = useState(true);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);

  // ── Vault stats ─────────────────────────────────────────────────────────
  const passwordCount = useMemo(
    () => entries.filter(e => e.type === 'login' && e.password).length,
    [entries],
  );

  const passkeyCount = useMemo(
    () => entries.filter(e => e.type === 'passkey').length,
    [entries],
  );

  const totalEntries = entries.length;

  // ── Security report (async — zxcvbn can be heavy) ───────────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      setReport(generateSecurityReport(entries));
    }, 50);
    return () => clearTimeout(timer);
  }, [entries]);

  const grade = useMemo(() => (report ? getGrade(report.score) : null), [report]);

  // ── Fetch non-zero balances across all EVM chains + Bitcoin ─────────────
  const fetchTokenBalances = useCallback(async () => {
    setLoadingTokens(true);
    try {
      const state = (await browser.runtime.sendMessage({
        type: MessageType.getWalletState,
        from: MessageFrom.popup,
      })) as any;

      if (!state || state.error || !state.address) {
        setLoadingTokens(false);
        return;
      }

      setWalletAddress(state.address);

      const balances: TokenInfo[] = [];

      // Fetch native balance for each EVM chain
      const promises = EVM_CHAINS.map(async (chain) => {
        try {
          const config = CHAIN_CONFIGS[chain];
          if (!config) return;
          const res = await fetch(config.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'eth_getBalance',
              params: [state.address, 'latest'],
            }),
          });
          const data = await res.json();
          const raw = BigInt(data.result ?? '0x0');
          if (raw > 0n) {
            const whole = raw / 10n ** 18n;
            const frac = raw % 10n ** 18n;
            const fracStr = frac.toString().padStart(18, '0').slice(0, 6);
            const formatted = `${whole}.${fracStr}`.replace(/\.?0+$/, '') || '0';
            balances.push({
              chain,
              symbol: config.symbol,
              balance: formatted,
            });
          }
        } catch {
          // Skip chains that fail
        }
      });

      // Bitcoin balance
      promises.push(
        (async () => {
          try {
            const { fetchBtcBalance, formatSatoshis } = await import('@/lib/wallet/bitcoin');
            const btcBal = await fetchBtcBalance(state.address, false);
            const totalSats = btcBal.confirmed + btcBal.unconfirmed;
            if (totalSats > 0) {
              balances.push({
                chain: 'bitcoin',
                symbol: 'BTC',
                balance: formatSatoshis(totalSats),
              });
            }
          } catch {
            // BTC balance fetch may fail if address isn't a BTC address
          }
        })(),
      );

      await Promise.allSettled(promises);
      setTokens(balances.sort((a, b) => a.chain.localeCompare(b.chain)));
    } catch {
      // Wallet may not be available
    } finally {
      setLoadingTokens(false);
    }
  }, []);

  useEffect(() => {
    fetchTokenBalances();
  }, [fetchTokenBalances]);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <Layout>
      <Header
        title="NodeZero"
        left={
          <Button variant="ghost" size="sm" onClick={onLock} className="h-7 w-7 p-0" aria-label="Lock">
            <Lock className="w-4 h-4" />
          </Button>
        }
        right={
          <Button variant="ghost" size="sm" onClick={onSettings} className="h-7 w-7 p-0" aria-label="Settings">
            <Settings className="w-4 h-4" />
          </Button>
        }
      />
      <ScrollableBody className="p-4 space-y-4">
        {/* ── Security Score Card ────────────────────────────────────────── */}
        <button
          onClick={onSecurityReport}
          className="w-full rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-muted/50"
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Security Score
              </span>
            </div>
            <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />
          </div>
          {report && grade ? (
            <div className="flex items-end gap-3">
              <span className={`text-4xl font-bold ${grade.color}`}>{grade.letter}</span>
              <div className="flex-1 mb-1">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-lg font-semibold">{report.score}</span>
                  <span className="text-xs text-muted-foreground">/ 100</span>
                </div>
                {/* Score bar */}
                <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      report.score >= 90
                        ? 'bg-green-500'
                        : report.score >= 75
                        ? 'bg-lime-500'
                        : report.score >= 60
                        ? 'bg-amber-500'
                        : report.score >= 40
                        ? 'bg-orange-500'
                        : 'bg-red-500'
                    }`}
                    style={{ width: `${report.score}%` }}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Analyzing…</span>
            </div>
          )}
          {report && (report.weak.length > 0 || report.reused.length > 0 || report.old.length > 0) && (
            <div className="flex gap-3 mt-3 text-[11px]">
              {report.weak.length > 0 && (
                <span className="text-amber-500">{report.weak.length} weak</span>
              )}
              {report.reused.length > 0 && (
                <span className="text-orange-500">{report.reused.length} reused</span>
              )}
              {report.old.length > 0 && (
                <span className="text-muted-foreground">{report.old.length} old</span>
              )}
            </div>
          )}
        </button>

        {/* ── Vault Stats Row ───────────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={onVault}
            className="rounded-xl border border-border bg-card p-3 text-center transition-colors hover:bg-muted/50"
          >
            <Key className="w-4 h-4 mx-auto mb-1.5 text-blue-500" />
            <p className="text-lg font-bold">{passwordCount}</p>
            <p className="text-[10px] text-muted-foreground">Passwords</p>
          </button>

          <button
            onClick={onVault}
            className="rounded-xl border border-border bg-card p-3 text-center transition-colors hover:bg-muted/50"
          >
            <Fingerprint className="w-4 h-4 mx-auto mb-1.5 text-purple-500" />
            <p className="text-lg font-bold">{passkeyCount}</p>
            <p className="text-[10px] text-muted-foreground">Passkeys</p>
          </button>

          <button
            onClick={onVault}
            className="rounded-xl border border-border bg-card p-3 text-center transition-colors hover:bg-muted/50"
          >
            <TrendingUp className="w-4 h-4 mx-auto mb-1.5 text-emerald-500" />
            <p className="text-lg font-bold">{totalEntries}</p>
            <p className="text-[10px] text-muted-foreground">Total Items</p>
          </button>
        </div>

        {/* ── Token Balances ────────────────────────────────────────────── */}
        <button
          onClick={onWallet}
          className="w-full rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-muted/50"
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Wallet className="w-4 h-4 text-primary" />
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Wallet
              </span>
            </div>
            <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />
          </div>

          {loadingTokens ? (
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Loading balances…</span>
            </div>
          ) : tokens.length === 0 ? (
            <p className="text-xs text-muted-foreground">No non-zero balances found</p>
          ) : (
            <div className="space-y-2">
              {tokens.map((t) => {
                const config = CHAIN_CONFIGS[t.chain];
                return (
                  <div key={t.chain} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          config
                            ? config.iconColor.replace('text-', 'bg-')
                            : 'bg-gray-400'
                        }`}
                      />
                      <span className="text-xs font-medium">{t.symbol}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {config?.name ?? t.chain}
                      </span>
                    </div>
                    <span className="text-xs font-mono">{t.balance}</span>
                  </div>
                );
              })}
            </div>
          )}
        </button>

        {/* ── Quick Actions ─────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onVault}
            className="h-9 gap-1.5 rounded-xl text-xs"
          >
            <Key className="w-3.5 h-3.5" />
            Open Vault
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onWallet}
            className="h-9 gap-1.5 rounded-xl text-xs"
          >
            <Wallet className="w-3.5 h-3.5" />
            Open Wallet
          </Button>
        </div>
      </ScrollableBody>
    </Layout>
  );
}
