/**
 * WalletScreen — Multi-account, multi-chain wallet UI
 *
 * Shows active account address, ETH balance, chain selector,
 * ERC-20 token balances, and recent transaction history.
 * "Add account" increments accountIndex for HD derivation.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Layout, Header, ScrollableBody } from '@/components/shared/Layout';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  ArrowLeft,
  ArrowDownUp,
  Copy,
  Check,
  Plus,
  ChevronDown,
  ExternalLink,
  ArrowUpRight,
  ArrowDownLeft,
  Send,
  QrCode,
  Loader2,
  RefreshCw,
  Wallet,
  Coins,
  Clock,
} from 'lucide-react';
import { MessageType, MessageFrom } from '@/lib/types';
import { CHAIN_CONFIGS, TESTNET_CHAIN_CONFIGS, EVM_CHAINS, type Chain } from '@/lib/wallet/types';
import { fetchBtcBalance, fetchBtcTxHistory, formatSatoshis, type BtcTxItem } from '@/lib/wallet/bitcoin';
import { SwapPanel } from '@/components/wallet/SwapPanel';
import { SendPanel } from '@/components/wallet/SendPanel';
import { ReceivePanel } from '@/components/wallet/ReceivePanel';
import { browser } from 'wxt/browser';

/** All chains available in the wallet (EVM + Bitcoin) */
const ALL_WALLET_CHAINS: Chain[] = [...EVM_CHAINS, 'bitcoin'];

// ── Blockscout-compatible tx type ──────────────────────────────────────

interface TxItem {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  isError: string;
  functionName?: string;
}

interface TokenBalance {
  symbol: string;
  name: string;
  balance: string;
  decimals: number;
  contractAddress: string;
}

interface WalletScreenProps {
  onBack: () => void;
  onApproval: () => void;
}

// ── Well-known ERC-20 tokens per chain ────────────────────────────────

const TRACKED_TOKENS: Partial<Record<Chain, Array<{ address: string; symbol: string; name: string; decimals: number }>>> = {
  ethereum: [
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', name: 'Tether', decimals: 6 },
    { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', name: 'Dai', decimals: 18 },
  ],
  base: [
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', name: 'Dai', decimals: 18 },
  ],
  arbitrum: [
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', name: 'Tether', decimals: 6 },
  ],
  optimism: [
    { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  ],
  polygon: [
    { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', name: 'Tether', decimals: 6 },
  ],
  bnb: [
    { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', name: 'USD Coin', decimals: 18 },
    { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', name: 'Tether', decimals: 18 },
  ],
  avalanche: [
    { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    { address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', symbol: 'USDT', name: 'Tether', decimals: 6 },
  ],
};

// ── ERC-20 balanceOf ABI selector ─────────────────────────────────────

const BALANCE_OF_SELECTOR = '0x70a08231';

export function WalletScreen({ onBack, onApproval }: WalletScreenProps) {
  const [address, setAddress] = useState<string | null>(null);
  const [chain, setChain] = useState<Chain>('base');
  const [accountIndex, setAccountIndex] = useState(0);
  const [balance, setBalance] = useState<string | null>(null);
  const [tokenBalances, setTokenBalances] = useState<TokenBalance[]>([]);
  const [txHistory, setTxHistory] = useState<TxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [copiedAddr, setCopiedAddr] = useState(false);
  const [showChainPicker, setShowChainPicker] = useState(false);
  const [showAccountPicker, setShowAccountPicker] = useState(false);
  const [maxAccountIndex, setMaxAccountIndex] = useState(0);
  const [hasPendingApproval, setHasPendingApproval] = useState(false);
  const [testnetMode, setTestnetMode] = useState(false);
  const [activeTab, setActiveTab] = useState<'assets' | 'send' | 'swap' | 'receive' | 'activity'>('assets');

  // ── Load wallet state from background ──────────────────────────────

  const loadWalletState = useCallback(async () => {
    try {
      const state = await browser.runtime.sendMessage({
        type: MessageType.getWalletState,
        from: MessageFrom.popup,
      }) as any;

      if (state?.error) {
        setLoading(false);
        return;
      }

      setAddress(state.address);
      setChain(state.chain);
      setAccountIndex(state.accountIndex);
      setMaxAccountIndex(prev => Math.max(prev, state.accountIndex));
      setTestnetMode(!!state.testnetMode);
    } catch {
      // Vault likely locked
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadWalletState();
    // Check for pending approvals
    chrome.storage.session.get('pendingWalletApproval').then(data => {
      setHasPendingApproval(!!data.pendingWalletApproval);
    });
    // Load persisted max account index
    chrome.storage.local.get('nz_max_account_index').then(data => {
      if (typeof data.nz_max_account_index === 'number') {
        setMaxAccountIndex(prev => Math.max(prev, data.nz_max_account_index));
      }
    });
  }, [loadWalletState]);

  // ── Fetch balance + tokens + history when address/chain changes ────

  useEffect(() => {
    if (!address) return;

    if (chain === 'bitcoin') {
      fetchBtcData(address);
    } else {
      // Only overwrite balance if fetch succeeds — avoids flicker on RPC errors
      fetchBalance(address, chain, testnetMode).then(b => {
        if (b !== '—') setBalance(b);
        else if (balance === null) setBalance(b); // first load, show dash
      });
      fetchTokenBalances(address, chain, testnetMode).then(setTokenBalances);
      fetchTxHistory(address, chain, testnetMode).then(setTxHistory);
    }
  }, [address, chain, testnetMode]);

  const fetchBtcData = async (addr: string) => {
    try {
      const bal = await fetchBtcBalance(addr);
      setBalance(bal.btc);
    } catch {
      setBalance('—');
    }
    try {
      const txs = await fetchBtcTxHistory(addr);
      // Normalize BTC txs to our TxItem format
      setTxHistory(txs.map(tx => btcTxToTxItem(tx, addr)));
    } catch {
      setTxHistory([]);
    }
    setTokenBalances([]); // No ERC-20 on Bitcoin
  };

  // ── Actions ────────────────────────────────────────────────────────

  const handleSwitchChain = async (newChain: Chain) => {
    setShowChainPicker(false);
    setBalance(null);
    setTokenBalances([]);
    setTxHistory([]);

    const result = await browser.runtime.sendMessage({
      type: MessageType.setActiveChain,
      from: MessageFrom.popup,
      payload: { chain: newChain },
    }) as any;

    if (result?.success) {
      setChain(newChain);
      // Re-fetch wallet state (address stays same for EVM chains)
      await loadWalletState();
    }
  };

  const handleSwitchAccount = async (index: number) => {
    setShowAccountPicker(false);
    if (index === accountIndex) return;
    const result = await browser.runtime.sendMessage({
      type: MessageType.setActiveAccountIndex,
      from: MessageFrom.popup,
      payload: { index },
    }) as any;

    if (result?.success) {
      setAccountIndex(index);
      setAddress(result.address);
      setBalance(null);
      setTokenBalances([]);
      setTxHistory([]);
    }
  };

  const handleAddAccount = async () => {
    const newIndex = maxAccountIndex + 1;
    setShowAccountPicker(false);
    const result = await browser.runtime.sendMessage({
      type: MessageType.setActiveAccountIndex,
      from: MessageFrom.popup,
      payload: { index: newIndex },
    }) as any;

    if (result?.success) {
      setAccountIndex(newIndex);
      setMaxAccountIndex(newIndex);
      chrome.storage.local.set({ nz_max_account_index: newIndex });
      setAddress(result.address);
      setBalance(null);
      setTokenBalances([]);
      setTxHistory([]);
    }
  };

  const handleRefresh = async () => {
    if (!address) return;
    setRefreshing(true);
    if (chain === 'bitcoin') {
      await fetchBtcData(address);
    } else {
      await Promise.all([
        fetchBalance(address, chain, testnetMode).then(setBalance),
        fetchTokenBalances(address, chain, testnetMode).then(setTokenBalances),
        fetchTxHistory(address, chain, testnetMode).then(setTxHistory),
      ]);
    }
    setRefreshing(false);
  };

  const handleToggleTestnet = async () => {
    const newMode = !testnetMode;
    const result = await browser.runtime.sendMessage({
      type: MessageType.setTestnetMode,
      from: MessageFrom.popup,
      payload: { enabled: newMode },
    }) as any;
    if (result?.success) {
      setTestnetMode(newMode);
      setBalance(null);
      setTokenBalances([]);
      setTxHistory([]);
      // Address stays the same, just re-fetch data on new network
      if (address) {
        const configs = newMode ? TESTNET_CHAIN_CONFIGS : CHAIN_CONFIGS;
        const cfg = configs[chain];
        if (chain === 'bitcoin') {
          fetchBtcData(address);
        } else {
          fetchBalance(address, chain, newMode).then(setBalance);
          fetchTokenBalances(address, chain, newMode).then(setTokenBalances);
          fetchTxHistory(address, chain, newMode).then(setTxHistory);
        }
      }
    }
  };

  const copyAddress = () => {
    if (!address) return;
    navigator.clipboard.writeText(address);
    setCopiedAddr(true);
    setTimeout(() => setCopiedAddr(false), 2000);
  };

  // ── Render ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <Layout>
        <Header title="Wallet" left={<BackBtn onClick={onBack} />} />
        <ScrollableBody className="flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </ScrollableBody>
      </Layout>
    );
  }

  if (!address) {
    return (
      <Layout>
        <Header title="Wallet" left={<BackBtn onClick={onBack} />} />
        <ScrollableBody className="flex flex-col items-center justify-center gap-2 p-4">
          <Wallet className="w-8 h-8 text-muted-foreground" />
          <p className="text-xs text-muted-foreground text-center">
            Vault is locked or no mnemonic available.
          </p>
        </ScrollableBody>
      </Layout>
    );
  }

  const configs = testnetMode ? TESTNET_CHAIN_CONFIGS : CHAIN_CONFIGS;
  const chainConfig = configs[chain];

  return (
    <Layout>
      <Header
        title="Wallet"
        left={<BackBtn onClick={onBack} />}
        right={
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRefresh}
              disabled={refreshing}
              className="h-7 w-7 p-0"
              aria-label="Refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        }
      />
      <ScrollableBody className="p-3 space-y-3">
        {/* Pending approval banner */}
        {hasPendingApproval && (
          <button
            onClick={onApproval}
            className="w-full flex items-center gap-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400"
          >
            <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
            <span className="text-[11px] font-medium">Pending approval — tap to review</span>
          </button>
        )}

        {/* Chain selector */}
        <div className="relative">
          <button
            onClick={() => { setShowChainPicker(!showChainPicker); setShowAccountPicker(false); }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted/50 border hover:bg-muted transition-colors"
          >
            <span className={`text-xs font-medium ${chainConfig.iconColor}`}>
              {chainConfig.name}
            </span>
            <ChevronDown className="w-3 h-3 text-muted-foreground" />
          </button>

          {showChainPicker && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-popover border rounded-lg shadow-lg p-1 min-w-[160px]">
              <p className="px-2.5 py-1 text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
                Select Network
              </p>
              {ALL_WALLET_CHAINS.map(c => (
                <button
                  key={c}
                  onClick={() => handleSwitchChain(c)}
                  className={`w-full text-left px-2.5 py-1.5 rounded text-xs hover:bg-muted transition-colors ${
                    c === chain ? 'bg-muted font-medium' : ''
                  }`}
                >
                  <span className={configs[c].iconColor}>
                    {configs[c].name}
                  </span>
                </button>
              ))}
              <div className="border-t my-1" />
              <button
                onClick={handleToggleTestnet}
                className="w-full text-left px-2.5 py-1.5 rounded text-xs hover:bg-muted transition-colors flex items-center justify-between"
              >
                <span className="text-muted-foreground">Testnet mode</span>
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                  testnetMode ? 'bg-amber-500/20 text-amber-500' : 'bg-muted text-muted-foreground'
                }`}>
                  {testnetMode ? 'ON' : 'OFF'}
                </span>
              </button>
            </div>
          )}
        </div>

        {/* Testnet banner */}
        {testnetMode && (
          <div className="flex items-center gap-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
            <div className="w-2 h-2 rounded-full bg-amber-500" />
            <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
              Testnet mode — balances have no real value
            </span>
          </div>
        )}

        {/* Account card */}
        <div className="rounded-xl border bg-gradient-to-br from-muted/30 to-muted/60 p-4 space-y-3">
          {/* Account selector + address + copy */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <div className="relative">
                <button
                  onClick={() => { setShowAccountPicker(!showAccountPicker); setShowChainPicker(false); }}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary transition-colors"
                >
                  Account {accountIndex}
                  <ChevronDown className="w-2.5 h-2.5" />
                </button>
                {showAccountPicker && (
                  <div className="absolute top-full left-0 mt-1 z-50 bg-popover border rounded-lg shadow-lg p-1 min-w-[130px]">
                    {Array.from({ length: maxAccountIndex + 1 }, (_, i) => (
                      <button
                        key={i}
                        onClick={() => handleSwitchAccount(i)}
                        className={`w-full text-left px-2.5 py-1.5 rounded text-xs hover:bg-muted transition-colors ${
                          i === accountIndex ? 'bg-muted font-medium' : ''
                        }`}
                      >
                        Account {i}
                      </button>
                    ))}
                    <div className="border-t my-1" />
                    <button
                      onClick={handleAddAccount}
                      className="w-full text-left px-2.5 py-1.5 rounded text-xs hover:bg-muted transition-colors flex items-center gap-1 text-muted-foreground"
                    >
                      <Plus className="w-3 h-3" />
                      New Account
                    </button>
                  </div>
                )}
              </div>
              <button onClick={copyAddress} className="flex items-center gap-1 text-xs font-mono hover:text-primary transition-colors">
                {truncateAddress(address)}
                {copiedAddr ? (
                  <Check className="w-3 h-3 text-green-500" />
                ) : (
                  <Copy className="w-3 h-3 text-muted-foreground" />
                )}
              </button>
            </div>
          </div>

          {/* Native balance */}
          <div className="text-center py-2">
            <p className="text-2xl font-bold tracking-tight">
              {balance !== null ? `${balance} ${chainConfig.symbol}` : '—'}
            </p>
          </div>

          {/* Unified nav — circular icon buttons */}
          <div className="flex justify-center gap-3 py-1">
            {([
              { key: 'assets' as const, label: 'Assets', icon: Coins },
              { key: 'send' as const, label: 'Send', icon: Send },
              { key: 'swap' as const, label: 'Swap', icon: ArrowDownUp },
              { key: 'receive' as const, label: 'Receive', icon: QrCode },
              { key: 'activity' as const, label: 'Activity', icon: Clock },
            ]).map(item => {
              const isActive = activeTab === item.key;
              return (
                <button
                  key={item.key}
                  onClick={() => setActiveTab(item.key)}
                  className="flex flex-col items-center gap-1 group"
                >
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-primary/10 group-hover:bg-primary/20 text-primary'
                  }`}>
                    <item.icon className="w-4 h-4" />
                  </div>
                  <span className={`text-[10px] transition-colors ${
                    isActive ? 'text-foreground font-medium' : 'text-muted-foreground group-hover:text-foreground'
                  }`}>
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Tab content */}
        {activeTab === 'assets' && (
          <div className="space-y-1.5">
            {tokenBalances.length > 0 ? (
              <>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
                  Tokens
                </p>
                {tokenBalances.map(token => (
                  <div
                    key={token.contractAddress}
                    className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-[9px] font-bold">
                        {token.symbol.slice(0, 2)}
                      </div>
                      <div>
                        <p className="text-xs font-medium">{token.symbol}</p>
                        <p className="text-[10px] text-muted-foreground">{token.name}</p>
                      </div>
                    </div>
                    <p className="text-xs font-mono">{token.balance}</p>
                  </div>
                ))}
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground text-center py-4">
                No token balances found
              </p>
            )}
          </div>
        )}

        {activeTab === 'send' && (
          <SendPanel address={address} chain={chain} testnet={testnetMode} />
        )}

        {activeTab === 'swap' && (
          <SwapPanel address={address} chain={chain} testnet={testnetMode} />
        )}

        {activeTab === 'receive' && (
          <ReceivePanel address={address} chain={chain} testnet={testnetMode} />
        )}

        {activeTab === 'activity' && (
          <div className="space-y-1.5">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
              Recent Transactions
            </p>
            {txHistory.length === 0 ? (
              <p className="text-[11px] text-muted-foreground text-center py-4">
                No transactions found
              </p>
            ) : (
              txHistory.map(tx => (
                <TxRow key={tx.hash} tx={tx} address={address} chain={chain} />
              ))
            )}
          </div>
        )}
      </ScrollableBody>
    </Layout>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────

function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} className="h-7 w-7 p-0" aria-label="Back">
      <ArrowLeft className="w-4 h-4" />
    </Button>
  );
}

function TxRow({ tx, address, chain }: { tx: TxItem; address: string; chain: Chain }) {
  const isSent = tx.from.toLowerCase() === address.toLowerCase();
  const peerAddr = isSent ? tx.to : tx.from;
  const config = CHAIN_CONFIGS[chain];
  const value = formatWei(tx.value, config.decimals);
  const isError = tx.isError === '1';
  const date = new Date(parseInt(tx.timeStamp) * 1000);
  const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <a
      href={`${config.explorerUrl}/tx/${tx.hash}`}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex items-center gap-2 py-2 px-2 rounded-lg hover:bg-muted/50 transition-colors ${
        isError ? 'opacity-50' : ''
      }`}
    >
      <div className={`w-7 h-7 rounded-full flex items-center justify-center ${
        isSent ? 'bg-red-500/10' : 'bg-green-500/10'
      }`}>
        {isSent ? (
          <ArrowUpRight className="w-3.5 h-3.5 text-red-500" />
        ) : (
          <ArrowDownLeft className="w-3.5 h-3.5 text-green-500" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium">
          {isSent ? 'Sent' : 'Received'}
          {isError && <span className="text-red-500 ml-1">(Failed)</span>}
        </p>
        <p className="text-[10px] text-muted-foreground font-mono truncate">
          {truncateAddress(peerAddr)}
        </p>
      </div>
      <div className="text-right">
        <p className={`text-xs font-mono ${isSent ? 'text-red-500' : 'text-green-500'}`}>
          {isSent ? '-' : '+'}{value} {config.symbol}
        </p>
        <p className="text-[10px] text-muted-foreground">{dateStr}</p>
      </div>
    </a>
  );
}

// ── Bitcoin tx normalization ─────────────────────────────────────────────

function btcTxToTxItem(tx: BtcTxItem, myAddress: string): TxItem {
  // Determine if sent: any input prevout matches my address
  const isSent = tx.vin.some(v => v.prevout?.scriptpubkey_address === myAddress);
  const isReceived = tx.vout.some(v => v.scriptpubkey_address === myAddress);

  let value = 0;
  let peer = '';

  if (isSent) {
    // Sum outputs NOT to me
    for (const out of tx.vout) {
      if (out.scriptpubkey_address !== myAddress) {
        value += out.value || 0;
        if (!peer) peer = out.scriptpubkey_address || '';
      }
    }
  } else {
    // Sum outputs TO me
    for (const out of tx.vout) {
      if (out.scriptpubkey_address === myAddress) {
        value += out.value || 0;
      }
    }
    peer = tx.vin[0]?.prevout?.scriptpubkey_address || '';
  }

  return {
    hash: tx.txid,
    from: isSent ? myAddress : peer,
    to: isSent ? peer : myAddress,
    value: '0x' + value.toString(16), // hex-encoded satoshis
    timeStamp: String(tx.status.block_time || Math.floor(Date.now() / 1000)),
    isError: '0',
  };
}

// ── Data fetching ───────────────────────────────────────────────────────

async function fetchBalance(address: string, chain: Chain, testnet: boolean = false): Promise<string> {
  const config = (testnet ? TESTNET_CHAIN_CONFIGS : CHAIN_CONFIGS)[chain];
  try {
    const resp = await fetch(config.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_getBalance',
        params: [address, 'latest'],
      }),
    });
    const json = await resp.json() as { result?: string };
    if (!json.result) return '0';
    return formatWei(json.result, config.decimals);
  } catch {
    return '—';
  }
}

async function fetchTokenBalances(address: string, chain: Chain, testnet: boolean = false): Promise<TokenBalance[]> {
  // No tracked tokens on testnet (addresses differ)
  if (testnet) return [];
  const tokens = TRACKED_TOKENS[chain];
  if (!tokens || tokens.length === 0) return [];

  const config = CHAIN_CONFIGS[chain];
  const paddedAddr = address.slice(2).toLowerCase().padStart(64, '0');

  // Batch balanceOf calls
  const calls = tokens.map((token, i) => ({
    jsonrpc: '2.0',
    id: i + 1,
    method: 'eth_call',
    params: [
      { to: token.address, data: BALANCE_OF_SELECTOR + paddedAddr },
      'latest',
    ],
  }));

  try {
    const resp = await fetch(config.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(calls),
    });
    const results = await resp.json() as Array<{ id: number; result?: string }>;

    const balances: TokenBalance[] = [];
    for (const r of results) {
      const token = tokens[r.id - 1];
      if (!token || !r.result || r.result === '0x' || r.result === '0x0') continue;
      const rawBal = BigInt(r.result);
      if (rawBal === 0n) continue;
      balances.push({
        symbol: token.symbol,
        name: token.name,
        balance: formatTokenBalance(rawBal, token.decimals),
        decimals: token.decimals,
        contractAddress: token.address,
      });
    }
    return balances;
  } catch {
    return [];
  }
}

async function fetchTxHistory(address: string, chain: Chain, testnet: boolean = false): Promise<TxItem[]> {
  // Use Blockscout-compatible API (free, no key required)
  const explorerApiMap: Partial<Record<Chain, string>> = testnet
    ? {
        ethereum: 'https://api-sepolia.etherscan.io/api',
        base: 'https://api-sepolia.basescan.org/api',
        arbitrum: 'https://api-sepolia.arbiscan.io/api',
        optimism: 'https://api-sepolia-optimistic.etherscan.io/api',
        polygon: 'https://api-amoy.polygonscan.com/api',
      }
    : {
        ethereum: 'https://api.etherscan.io/api',
        base: 'https://api.basescan.org/api',
        arbitrum: 'https://api.arbiscan.io/api',
        optimism: 'https://api-optimistic.etherscan.io/api',
        polygon: 'https://api.polygonscan.com/api',
      };

  const apiBase = explorerApiMap[chain];
  if (!apiBase) return [];

  try {
    const url = `${apiBase}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=10&sort=desc`;
    const resp = await fetch(url);
    const json = await resp.json() as { status: string; result: TxItem[] | string };
    if (json.status !== '1' || !Array.isArray(json.result)) return [];
    return json.result.slice(0, 10);
  } catch {
    return [];
  }
}

// ── Formatting helpers ──────────────────────────────────────────────────

function truncateAddress(addr: string): string {
  if (!addr || addr.length <= 12) return addr || '';
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function formatWei(hex: string, decimals: number = 18): string {
  try {
    const wei = BigInt(hex);
    if (wei === 0n) return '0';
    // Convert to decimal string with proper precision
    const divisor = 10n ** BigInt(decimals);
    const whole = wei / divisor;
    const frac = wei % divisor;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(decimals, '0');
    // Show up to 6 significant decimal digits
    const trimmed = fracStr.slice(0, 6).replace(/0+$/, '');
    return trimmed ? `${whole}.${trimmed}` : whole.toString();
  } catch {
    return '0';
  }
}

function formatTokenBalance(raw: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  if (frac === 0n) return whole.toLocaleString();
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
  return fracStr ? `${whole.toLocaleString()}.${fracStr}` : whole.toLocaleString();
}
