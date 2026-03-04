/**
 * SendPanel — MetaMask-style "Send" panel for native and ERC-20 token transfers.
 *
 * Supports ETH, BNB, POL, and major ERC-20 tokens per chain.
 * Uses MessageType.executeSwap to sign and broadcast transactions via the background.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Loader2,
  AlertCircle,
  Check,
  ChevronDown,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MessageType, MessageFrom } from '@/lib/types';
import { browser } from 'wxt/browser';
import { formatSwapAmount, parseSwapAmount } from '@/lib/wallet/swap';
import { getChainConfig, type Chain } from '@/lib/wallet/types';

// ── Props ────────────────────────────────────────────────────────────────

interface SendPanelProps {
  address: string;
  chain: Chain;
  testnet: boolean;
}

// ── Token definitions per chain ──────────────────────────────────────────

interface SendToken {
  address: string; // '0x0000...' for native
  symbol: string;
  name: string;
  decimals: number;
  logoColor: string;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const SEND_TOKENS: Partial<Record<Chain, SendToken[]>> = {
  ethereum: [
    { address: ZERO_ADDRESS, symbol: 'ETH', name: 'Ethereum', decimals: 18, logoColor: 'text-blue-500' },
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoColor: 'text-blue-600' },
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', name: 'Tether', decimals: 6, logoColor: 'text-green-500' },
    { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', name: 'Dai', decimals: 18, logoColor: 'text-yellow-500' },
  ],
  base: [
    { address: ZERO_ADDRESS, symbol: 'ETH', name: 'Ethereum', decimals: 18, logoColor: 'text-blue-500' },
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoColor: 'text-blue-600' },
    { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', name: 'Dai', decimals: 18, logoColor: 'text-yellow-500' },
  ],
  arbitrum: [
    { address: ZERO_ADDRESS, symbol: 'ETH', name: 'Ethereum', decimals: 18, logoColor: 'text-blue-500' },
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoColor: 'text-blue-600' },
    { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', name: 'Tether', decimals: 6, logoColor: 'text-green-500' },
  ],
  optimism: [
    { address: ZERO_ADDRESS, symbol: 'ETH', name: 'Ethereum', decimals: 18, logoColor: 'text-blue-500' },
    { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoColor: 'text-blue-600' },
  ],
  polygon: [
    { address: ZERO_ADDRESS, symbol: 'POL', name: 'Polygon', decimals: 18, logoColor: 'text-purple-500' },
    { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoColor: 'text-blue-600' },
    { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', name: 'Tether', decimals: 6, logoColor: 'text-green-500' },
  ],
  bnb: [
    { address: ZERO_ADDRESS, symbol: 'BNB', name: 'BNB Chain', decimals: 18, logoColor: 'text-yellow-500' },
    { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', name: 'USD Coin', decimals: 18, logoColor: 'text-blue-600' },
    { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', name: 'Tether', decimals: 18, logoColor: 'text-green-500' },
  ],
  avalanche: [
    { address: ZERO_ADDRESS, symbol: 'AVAX', name: 'Avalanche', decimals: 18, logoColor: 'text-red-600' },
    { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoColor: 'text-blue-600' },
    { address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', symbol: 'USDT', name: 'Tether', decimals: 6, logoColor: 'text-green-500' },
  ],
};

function getSendTokens(chain: Chain): SendToken[] {
  return SEND_TOKENS[chain] || [];
}

function isNative(address: string): boolean {
  return address === ZERO_ADDRESS;
}

// ── ERC-20 transfer encoding ─────────────────────────────────────────────

function encodeTransfer(to: string, amount: bigint): string {
  const selector = 'a9059cbb'; // transfer(address,uint256)
  const paddedTo = to.slice(2).toLowerCase().padStart(64, '0');
  const paddedAmount = amount.toString(16).padStart(64, '0');
  return selector + paddedTo + paddedAmount;
}

// ── Address validation ───────────────────────────────────────────────────

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

// ── Constants ────────────────────────────────────────────────────────────

const BALANCE_OF_SELECTOR = '0x70a08231';
const NATIVE_GAS_ESTIMATE = 21_000;
const ERC20_GAS_ESTIMATE = 65_000;

// ── Component ────────────────────────────────────────────────────────────

export function SendPanel({ address, chain, testnet }: SendPanelProps) {
  const config = getChainConfig(chain, testnet);
  const tokens = getSendTokens(chain);

  // ── State (all hooks before any early return) ──────────────────────────

  const [recipient, setRecipient] = useState('');
  const [selectedToken, setSelectedToken] = useState<SendToken>(tokens[0] || {
    address: ZERO_ADDRESS, symbol: config.symbol, name: config.name, decimals: 18, logoColor: 'text-muted-foreground',
  });
  const [amount, setAmount] = useState('');
  const [balance, setBalance] = useState<string | null>(null);
  const [balanceRaw, setBalanceRaw] = useState<bigint>(0n);
  const [showTokenPicker, setShowTokenPicker] = useState(false);
  const [sending, setSending] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Fetch balance ──────────────────────────────────────────────────────

  const fetchBalance = useCallback(async (token: SendToken) => {
    try {
      if (isNative(token.address)) {
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
        if (json.result) {
          const raw = BigInt(json.result);
          setBalanceRaw(raw);
          setBalance(formatSwapAmount(raw, 18, 6));
        }
      } else {
        const paddedAddr = address.slice(2).toLowerCase().padStart(64, '0');
        const resp = await fetch(config.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'eth_call',
            params: [{ to: token.address, data: BALANCE_OF_SELECTOR + paddedAddr }, 'latest'],
          }),
        });
        const json = await resp.json() as { result?: string };
        if (json.result && json.result !== '0x') {
          const raw = BigInt(json.result);
          setBalanceRaw(raw);
          setBalance(formatSwapAmount(raw, token.decimals, 6));
        } else {
          setBalanceRaw(0n);
          setBalance('0');
        }
      }
    } catch {
      // keep existing balance on error
    }
  }, [address, config.rpcUrl]);

  // Fetch balance when selected token changes
  useEffect(() => {
    fetchBalance(selectedToken);
  }, [selectedToken.address, fetchBalance]);

  // ── Derived state ──────────────────────────────────────────────────────

  const recipientValid = isValidAddress(recipient);
  const recipientTouched = recipient.length > 0;
  const rawAmount = parseSwapAmount(amount, selectedToken.decimals);
  const gasEstimate = isNative(selectedToken.address) ? NATIVE_GAS_ESTIMATE : ERC20_GAS_ESTIMATE;
  const insufficientBalance = rawAmount > 0n && rawAmount > balanceRaw;
  const canSend = recipientValid && rawAmount > 0n && !insufficientBalance && !sending && !txHash;

  // ── Max button ─────────────────────────────────────────────────────────

  const handleMax = () => {
    if (balanceRaw === 0n) return;
    let maxRaw = balanceRaw;
    // Reserve gas for native transfers
    if (isNative(selectedToken.address)) {
      const gasReserve = 500000000000000n; // 0.0005 ETH for gas
      maxRaw = maxRaw > gasReserve ? maxRaw - gasReserve : 0n;
    }
    setAmount(formatSwapAmount(maxRaw, selectedToken.decimals, selectedToken.decimals));
  };

  // ── Token selection ────────────────────────────────────────────────────

  const handleSelectToken = (token: SendToken) => {
    setSelectedToken(token);
    setShowTokenPicker(false);
    setAmount('');
    setBalance(null);
    setBalanceRaw(0n);
  };

  // ── Send transaction ───────────────────────────────────────────────────

  const handleSend = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    setTxHash(null);

    try {
      let tx: { to: string; data: string; value: string; gasLimit?: string };

      if (isNative(selectedToken.address)) {
        // Native transfer
        tx = {
          to: recipient,
          data: '0x',
          value: '0x' + rawAmount.toString(16),
          gasLimit: '0x' + NATIVE_GAS_ESTIMATE.toString(16),
        };
      } else {
        // ERC-20 transfer
        const data = encodeTransfer(recipient, rawAmount);
        tx = {
          to: selectedToken.address,
          data: '0x' + data,
          value: '0x0',
          gasLimit: '0x' + ERC20_GAS_ESTIMATE.toString(16),
        };
      }

      const result = await browser.runtime.sendMessage({
        type: MessageType.executeSwap,
        from: MessageFrom.popup,
        payload: { tx },
      }) as any;

      if (result?.error) {
        setError(typeof result.error === 'string' ? result.error : 'Transaction failed');
      } else if (result?.txHash) {
        setTxHash(result.txHash);
        // Refresh balance after send
        fetchBalance(selectedToken);
      } else {
        setError('No transaction hash returned');
      }
    } catch (err: any) {
      setError(err?.message || 'Transaction failed');
    } finally {
      setSending(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      {/* Recipient address */}
      <div className="rounded-xl border bg-muted/30 p-3 space-y-1">
        <p className="text-[10px] text-muted-foreground">To</p>
        <input
          type="text"
          placeholder="0x..."
          value={recipient}
          onChange={e => setRecipient(e.target.value.trim())}
          className={`w-full bg-transparent text-xs font-mono outline-none placeholder:text-muted-foreground/40 ${
            recipientTouched && !recipientValid ? 'text-destructive' : ''
          }`}
        />
        {recipientTouched && !recipientValid && (
          <p className="text-[10px] text-destructive flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            Invalid Ethereum address
          </p>
        )}
      </div>

      {/* Token + Amount */}
      <div className="rounded-xl border bg-muted/30 p-3 space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-[10px] text-muted-foreground">Amount</p>
          {balance !== null && (
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span>Balance: {balance} {selectedToken.symbol}</span>
              <button
                onClick={handleMax}
                className="text-primary font-semibold hover:underline"
              >
                Max
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={e => {
              const v = e.target.value.replace(/[^0-9.]/g, '');
              if (v.split('.').length <= 2) setAmount(v);
            }}
            className="flex-1 bg-transparent text-2xl font-medium outline-none placeholder:text-muted-foreground/40 min-w-0"
          />
          {/* Token selector pill */}
          <button
            onClick={() => setShowTokenPicker(!showTokenPicker)}
            className="flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-full bg-muted hover:bg-muted/80 transition-colors shrink-0 border"
          >
            <div className={`w-6 h-6 rounded-full bg-background flex items-center justify-center text-[9px] font-bold border ${selectedToken.logoColor}`}>
              {selectedToken.symbol.slice(0, 2)}
            </div>
            <span className="text-sm font-semibold">{selectedToken.symbol}</span>
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        </div>
        {insufficientBalance && (
          <p className="text-[10px] text-destructive flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            Insufficient balance
          </p>
        )}
      </div>

      {/* Gas estimate */}
      <div className="rounded-xl border bg-muted/10 p-3 space-y-1.5 text-[11px]">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Estimated gas</span>
          <span className="font-medium font-mono">{gasEstimate.toLocaleString()} gas</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Network</span>
          <span className={`font-medium ${config.iconColor}`}>{config.name}</span>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-1.5 p-2 rounded-lg bg-destructive/10 border border-destructive/30">
          <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
          <p className="text-[10px] text-destructive">{error}</p>
        </div>
      )}

      {/* Success */}
      {txHash && (
        <div className="flex items-center gap-1.5 p-2 rounded-lg bg-green-500/10 border border-green-500/30">
          <Check className="w-3.5 h-3.5 text-green-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] text-green-600 dark:text-green-400 font-medium">Transaction submitted</p>
            <a
              href={`${config.explorerUrl}/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-green-600 dark:text-green-400 hover:underline flex items-center gap-1 font-mono truncate"
            >
              {txHash.slice(0, 10)}...{txHash.slice(-6)}
              <ExternalLink className="w-2.5 h-2.5 shrink-0" />
            </a>
          </div>
        </div>
      )}

      {/* Send button */}
      <Button
        className="w-full h-11 text-sm font-semibold"
        onClick={handleSend}
        disabled={!canSend}
      >
        {sending ? (
          <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Sending...</>
        ) : !recipient ? (
          'Enter recipient'
        ) : !recipientValid ? (
          'Invalid address'
        ) : !amount || rawAmount === 0n ? (
          'Enter an amount'
        ) : insufficientBalance ? (
          'Insufficient balance'
        ) : txHash ? (
          'Sent'
        ) : (
          `Send ${selectedToken.symbol}`
        )}
      </Button>

      {/* Token picker overlay */}
      {showTokenPicker && (
        <div className="fixed inset-0 z-50 bg-background/80 flex items-end">
          <div className="w-full bg-popover border-t rounded-t-xl p-3 space-y-1 animate-in slide-in-from-bottom-5">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium">Select token</p>
              <button
                onClick={() => setShowTokenPicker(false)}
                className="text-xs text-muted-foreground hover:text-primary"
              >
                Cancel
              </button>
            </div>
            {tokens.map(token => {
              const isSelected = selectedToken.address === token.address;
              return (
                <button
                  key={token.address}
                  onClick={() => handleSelectToken(token)}
                  className={`w-full flex items-center gap-2.5 p-2 rounded-lg transition-colors ${
                    isSelected ? 'bg-primary/10' : 'hover:bg-muted'
                  }`}
                >
                  <div className={`w-8 h-8 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold ${token.logoColor}`}>
                    {token.symbol.slice(0, 2)}
                  </div>
                  <div className="text-left flex-1">
                    <p className="text-xs font-medium">{token.symbol}</p>
                    <p className="text-[10px] text-muted-foreground">{token.name}</p>
                  </div>
                  {!isNative(token.address) && (
                    <span className="text-[9px] text-muted-foreground font-mono">
                      {token.address.slice(0, 4)}...{token.address.slice(-4)}
                    </span>
                  )}
                  {isSelected && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
