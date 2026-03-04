/**
 * SwapPanel — In-extension token swap (MetaMask-style).
 *
 * Uses Uniswap v4 UniversalRouter on Base (mainnet & Sepolia).
 * Features: balance + Max, USD estimates, swap details, inline slippage editing.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertCircle,
  ExternalLink,
  Settings,
  Check,
  Pencil,
  Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MessageType, MessageFrom } from '@/lib/types';
import { browser } from 'wxt/browser';
import {
  type SwapToken,
  getSwapTokens,
  getV4Contracts,
  isNativeETH,
  applySlippage,
  formatSwapAmount,
  parseSwapAmount,
  encodeApproveCalldata,
  encodeAllowanceCalldata,
  encodeV4QuoteCalldata,
  decodeV4QuoteResult,
  encodeV4SwapCalldata,
  encodePermit2Approve,
  encodePermit2AllowanceCalldata,
  getWrappedNativeAddress,
} from '@/lib/wallet/swap';
import { decodeUint } from '@/lib/wallet/abi';
import { getChainConfig, type Chain } from '@/lib/wallet/types';

interface SwapPanelProps {
  address: string;
  chain: Chain;
  testnet: boolean;
}

const SLIPPAGE_OPTIONS = [10, 50, 100, 200]; // bps: 0.1%, 0.5%, 1.0%, 2.0%
const BALANCE_OF_SELECTOR = '0x70a08231';
const QUOTE_REFRESH_INTERVAL = 30_000; // 30s
const QUOTE_DEBOUNCE = 2_000; // 2s

/** Stablecoin addresses (mainnet) — used for USD estimation */
const STABLECOINS = new Set([
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC Base
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI Base
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e', // USDC Sepolia
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC Arbitrum
  '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // USDC Optimism
  '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC Polygon
  '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', // USDC Avalanche
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', // USDC BNB
]);

function isStablecoin(address: string): boolean {
  return STABLECOINS.has(address.toLowerCase());
}

export function SwapPanel({ address, chain, testnet }: SwapPanelProps) {
  const tokens = getSwapTokens(chain, testnet);
  const config = getChainConfig(chain, testnet);
  const v4 = getV4Contracts(chain, testnet);
  const wrappedNative = getWrappedNativeAddress(chain);

  const [tokenIn, setTokenIn] = useState<SwapToken | null>(tokens[0] || null);
  const [tokenOut, setTokenOut] = useState<SwapToken | null>(tokens.length > 2 ? tokens[2] : tokens[1] || null);
  const [amountIn, setAmountIn] = useState('');
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteResult, setQuoteResult] = useState<{ amountOut: bigint; gasEstimate: bigint } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [slippageBps, setSlippageBps] = useState(50);
  const [editingSlippage, setEditingSlippage] = useState(false);
  const [showTokenPicker, setShowTokenPicker] = useState<'in' | 'out' | null>(null);
  const [txPending, setTxPending] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [approvalStep, setApprovalStep] = useState<'erc20' | 'permit2' | null>(null);
  const [approving, setApproving] = useState(false);
  const [tokenInBalance, setTokenInBalance] = useState<string | null>(null);
  const [tokenInBalanceRaw, setTokenInBalanceRaw] = useState<bigint>(0n);
  const [refreshCountdown, setRefreshCountdown] = useState(0);
  const quoteTimer = useRef<ReturnType<typeof setTimeout>>();
  const refreshTimer = useRef<ReturnType<typeof setInterval>>();
  const countdownTimer = useRef<ReturnType<typeof setInterval>>();

  // ── Fetch input token balance ─────────────────────────────────

  const fetchTokenBalance = useCallback(async (token: SwapToken) => {
    if (!token) { setTokenInBalance(null); setTokenInBalanceRaw(0n); return; }
    try {
      if (isNativeETH(token.address)) {
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
          setTokenInBalanceRaw(raw);
          setTokenInBalance(formatSwapAmount(raw, 18, 6));
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
          setTokenInBalanceRaw(raw);
          setTokenInBalance(formatSwapAmount(raw, token.decimals, 6));
        } else {
          setTokenInBalanceRaw(0n);
          setTokenInBalance('0');
        }
      }
    } catch {
      // keep existing balance on error
    }
  }, [address, config.rpcUrl]);

  // Fetch balance when input token changes
  useEffect(() => {
    if (tokenIn) fetchTokenBalance(tokenIn);
  }, [tokenIn?.address, fetchTokenBalance]);

  // ── Quote fetching ──────────────────────────────────────────────

  const fetchQuote = useCallback(async () => {
    if (!tokenIn || !tokenOut || !amountIn) {
      setQuoteResult(null);
      setQuoteError(null);
      return;
    }
    const rawAmount = parseSwapAmount(amountIn, tokenIn.decimals);
    if (rawAmount === 0n) { setQuoteResult(null); return; }

    // ETH <-> WETH is 1:1 wrap/unwrap
    if (
      (isNativeETH(tokenIn.address) && tokenOut.address.toLowerCase() === wrappedNative.toLowerCase()) ||
      (tokenIn.address.toLowerCase() === wrappedNative.toLowerCase() && isNativeETH(tokenOut.address))
    ) {
      setQuoteResult({ amountOut: rawAmount, gasEstimate: 45000n });
      setQuoteError(null);
      setNeedsApproval(false);
      return;
    }

    setQuoteLoading(true);
    setQuoteError(null);
    try {
      const calldata = encodeV4QuoteCalldata(tokenIn.address, tokenOut.address, rawAmount);
      const result = await browser.runtime.sendMessage({
        type: MessageType.getSwapQuote,
        from: MessageFrom.popup,
        payload: { calldata, contractAddress: v4.quoter },
      }) as any;

      if (result?.error) {
        const raw = typeof result.error === 'string' ? result.error : 'Quote failed';
        const msg = testnet && raw.includes('revert')
          ? 'No v4 pool on testnet for this pair'
          : raw;
        setQuoteError(msg);
        setQuoteResult(null);
        return;
      }

      if (!result?.data) {
        setQuoteError('No response from quoter');
        setQuoteResult(null);
        return;
      }

      const decoded = decodeV4QuoteResult(result.data);
      if (decoded.amountOut === 0n) {
        setQuoteError('No liquidity for this pair');
        setQuoteResult(null);
        return;
      }

      setQuoteResult(decoded);

      // Check Permit2 two-step approval for ERC-20 tokens
      if (!isNativeETH(tokenIn.address)) {
        const erc20AllowCalldata = encodeAllowanceCalldata(address, v4.permit2);
        const erc20AllowResult = await browser.runtime.sendMessage({
          type: MessageType.getSwapQuote,
          from: MessageFrom.popup,
          payload: { calldata: erc20AllowCalldata, contractAddress: tokenIn.address },
        }) as any;

        if (erc20AllowResult?.data) {
          const erc20Allowance = BigInt(erc20AllowResult.data);
          if (erc20Allowance < rawAmount) {
            setNeedsApproval(true);
            setApprovalStep('erc20');
            return;
          }
        }

        const p2AllowCalldata = encodePermit2AllowanceCalldata(
          address, tokenIn.address, v4.universalRouter,
        );
        const p2AllowResult = await browser.runtime.sendMessage({
          type: MessageType.getSwapQuote,
          from: MessageFrom.popup,
          payload: { calldata: p2AllowCalldata, contractAddress: v4.permit2 },
        }) as any;

        if (p2AllowResult?.data) {
          const p2Allowance = decodeUint(p2AllowResult.data, 0);
          const p2Expiration = decodeUint(p2AllowResult.data, 1);
          const now = BigInt(Math.floor(Date.now() / 1000));
          if (p2Allowance < rawAmount || p2Expiration <= now) {
            setNeedsApproval(true);
            setApprovalStep('permit2');
            return;
          }
        }

        setNeedsApproval(false);
        setApprovalStep(null);
      } else {
        setNeedsApproval(false);
        setApprovalStep(null);
      }
    } catch {
      setQuoteError('Failed to get quote');
      setQuoteResult(null);
    } finally {
      setQuoteLoading(false);
    }
  }, [tokenIn, tokenOut, amountIn, address, v4]);

  // Stable ref so the effect doesn't re-fire when fetchQuote identity changes
  const fetchQuoteRef = useRef(fetchQuote);
  fetchQuoteRef.current = fetchQuote;

  // Debounced quote on input change + auto-refresh every 30s
  useEffect(() => {
    clearTimeout(quoteTimer.current);
    clearInterval(refreshTimer.current);
    clearInterval(countdownTimer.current);
    setTxHash(null);
    setTxError(null);
    setRefreshCountdown(0);
    if (!amountIn || !tokenIn || !tokenOut) { setQuoteResult(null); return; }

    quoteTimer.current = setTimeout(() => {
      fetchQuoteRef.current();
      setRefreshCountdown(QUOTE_REFRESH_INTERVAL / 1000);

      // Countdown timer (ticks every second)
      countdownTimer.current = setInterval(() => {
        setRefreshCountdown(prev => (prev > 0 ? prev - 1 : 0));
      }, 1000);

      refreshTimer.current = setInterval(() => {
        fetchQuoteRef.current();
        setRefreshCountdown(QUOTE_REFRESH_INTERVAL / 1000);
      }, QUOTE_REFRESH_INTERVAL);
    }, QUOTE_DEBOUNCE);

    return () => {
      clearTimeout(quoteTimer.current);
      clearInterval(refreshTimer.current);
      clearInterval(countdownTimer.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountIn, tokenIn?.address, tokenOut?.address]);

  // ── Unsupported chain check (after all hooks to respect Rules of Hooks) ──

  if (tokens.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
        <AlertCircle className="w-6 h-6 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Swap is only available on Base.
          {chain !== 'base' && ' Switch to Base to swap tokens.'}
        </p>
      </div>
    );
  }

  // ── Approve ─────────────────────────────────────────────────────

  const handleApprove = async () => {
    if (!tokenIn) return;
    setApproving(true);
    setTxError(null);
    try {
      if (approvalStep === 'erc20') {
        const maxUint = (1n << 256n) - 1n;
        const data = encodeApproveCalldata(v4.permit2, maxUint);
        const result = await browser.runtime.sendMessage({
          type: MessageType.executeSwap,
          from: MessageFrom.popup,
          payload: { tx: { to: tokenIn.address, data: '0x' + data, value: '0x0' } },
        }) as any;
        if (result?.error) {
          setTxError(typeof result.error === 'string' ? result.error : 'Approval failed');
        } else {
          setApprovalStep('permit2');
        }
      } else if (approvalStep === 'permit2') {
        const maxUint160 = (1n << 160n) - 1n;
        const farFuture = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60);
        const data = encodePermit2Approve(
          tokenIn.address, v4.universalRouter, maxUint160, farFuture,
        );
        const result = await browser.runtime.sendMessage({
          type: MessageType.executeSwap,
          from: MessageFrom.popup,
          payload: { tx: { to: v4.permit2, data: '0x' + data, value: '0x0' } },
        }) as any;
        if (result?.error) {
          setTxError(typeof result.error === 'string' ? result.error : 'Permit2 approval failed');
        } else {
          setNeedsApproval(false);
          setApprovalStep(null);
        }
      }
    } catch (err: any) {
      setTxError(err?.message || 'Approval failed');
    } finally {
      setApproving(false);
    }
  };

  // ── Execute swap ────────────────────────────────────────────────

  const handleSwap = async () => {
    if (!tokenIn || !tokenOut || !quoteResult) return;
    setTxPending(true);
    setTxError(null);
    setTxHash(null);

    const rawAmountIn = parseSwapAmount(amountIn, tokenIn.decimals);
    const minAmountOut = applySlippage(quoteResult.amountOut, slippageBps);

    try {
      let tx: { to: string; data: string; value: string; gasLimit?: string };

      if (isNativeETH(tokenIn.address) && tokenOut.address.toLowerCase() === wrappedNative.toLowerCase()) {
        tx = {
          to: wrappedNative,
          data: '0xd0e30db0',
          value: '0x' + rawAmountIn.toString(16),
          gasLimit: '0x11170',
        };
      } else if (tokenIn.address.toLowerCase() === wrappedNative.toLowerCase() && isNativeETH(tokenOut.address)) {
        const amountHex = rawAmountIn.toString(16).padStart(64, '0');
        tx = {
          to: wrappedNative,
          data: '0x2e1a7d4d' + amountHex,
          value: '0x0',
          gasLimit: '0x11170',
        };
      } else {
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
        const data = encodeV4SwapCalldata(
          tokenIn.address, tokenOut.address, rawAmountIn, minAmountOut, deadline,
        );
        tx = {
          to: v4.universalRouter,
          data: '0x' + data,
          value: isNativeETH(tokenIn.address) ? '0x' + rawAmountIn.toString(16) : '0x0',
          gasLimit: '0x493E0',
        };
      }

      const result = await browser.runtime.sendMessage({
        type: MessageType.executeSwap,
        from: MessageFrom.popup,
        payload: { tx },
      }) as any;

      if (result?.error) {
        setTxError(typeof result.error === 'string' ? result.error : 'Swap failed');
      } else {
        setTxHash(result.txHash);
        setAmountIn('');
        setQuoteResult(null);
        // Refresh balance after swap
        if (tokenIn) fetchTokenBalance(tokenIn);
      }
    } catch (err: any) {
      setTxError(err?.message || 'Swap failed');
    } finally {
      setTxPending(false);
    }
  };

  // ── Flip tokens ─────────────────────────────────────────────────

  const handleFlip = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountIn('');
    setQuoteResult(null);
    setNeedsApproval(false);
    setApprovalStep(null);
  };

  // ── Max button ────────────────────────────────────────────────

  const handleMax = () => {
    if (!tokenIn || tokenInBalanceRaw === 0n) return;
    let maxRaw = tokenInBalanceRaw;
    // Reserve a small amount for gas if paying with native ETH
    if (isNativeETH(tokenIn.address)) {
      const gasReserve = 500000000000000n; // 0.0005 ETH for gas
      maxRaw = maxRaw > gasReserve ? maxRaw - gasReserve : 0n;
    }
    setAmountIn(formatSwapAmount(maxRaw, tokenIn.decimals, tokenIn.decimals));
  };

  // ── Token picker ────────────────────────────────────────────────

  const handleSelectToken = (token: SwapToken, direction: 'in' | 'out') => {
    if (direction === 'in') {
      if (tokenOut?.address === token.address) setTokenOut(tokenIn);
      setTokenIn(token);
    } else {
      if (tokenIn?.address === token.address) setTokenIn(tokenOut);
      setTokenOut(token);
    }
    setShowTokenPicker(null);
    setAmountIn('');
    setQuoteResult(null);
  };

  // ── Derived state ───────────────────────────────────────────────

  const rawIn = tokenIn ? parseSwapAmount(amountIn, tokenIn.decimals) : 0n;

  // Exchange rate string: "1 ETH = 2,008 USDC"
  const rateStr =
    tokenIn && tokenOut && quoteResult && rawIn > 0n
      ? `1 ${tokenIn.symbol} = ${formatSwapAmount(
          quoteResult.amountOut * 10n ** BigInt(tokenIn.decimals) / rawIn,
          tokenOut.decimals,
          4,
        )} ${tokenOut.symbol}`
      : null;

  // USD estimates — derive from stablecoin side when available
  const usdIn = computeUsdEstimate(tokenIn, tokenOut, rawIn, quoteResult?.amountOut ?? null, 'in');
  const usdOut = computeUsdEstimate(tokenIn, tokenOut, rawIn, quoteResult?.amountOut ?? null, 'out');

  // Minimum received after slippage
  const minReceived = quoteResult && tokenOut
    ? formatSwapAmount(applySlippage(quoteResult.amountOut, slippageBps), tokenOut.decimals, 6)
    : null;

  // Network fee estimate (rough: gasEstimate * ~0.05 gwei on Base)
  const networkFeeUsd = quoteResult
    ? estimateNetworkFeeUsd(quoteResult.gasEstimate)
    : null;

  const canSwap = !!tokenIn && !!tokenOut && !!quoteResult && !quoteLoading && !needsApproval && !txPending && rawIn > 0n;

  // ── Render ──────────────────────────────────────────────────────

  return (
    <div className="space-y-2">
      {/* ── Token In (You pay) ──────────────────────────────── */}
      <div className="rounded-xl border bg-muted/30 p-3 space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-[10px] text-muted-foreground">You pay</p>
          {tokenInBalance !== null && tokenIn && (
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span>{tokenInBalance} {tokenIn.symbol}</span>
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
            value={amountIn}
            onChange={e => {
              const v = e.target.value.replace(/[^0-9.]/g, '');
              if (v.split('.').length <= 2) setAmountIn(v);
            }}
            className="flex-1 bg-transparent text-2xl font-medium outline-none placeholder:text-muted-foreground/40 min-w-0"
          />
          <TokenPill token={tokenIn} onClick={() => setShowTokenPicker('in')} />
        </div>
        {usdIn && <p className="text-[10px] text-muted-foreground">{usdIn}</p>}
      </div>

      {/* ── Flip button ──────────────────────────────────────── */}
      <div className="flex justify-center -my-1 relative z-10">
        <button
          onClick={handleFlip}
          className="w-8 h-8 rounded-full border bg-background hover:bg-muted flex items-center justify-center transition-colors shadow-sm"
        >
          <ArrowDownUp className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
      </div>

      {/* ── Token Out (You receive) ──────────────────────────── */}
      <div className="rounded-xl border bg-muted/30 p-3 space-y-1">
        <div className="flex items-center justify-between">
          <p className="text-[10px] text-muted-foreground">You receive</p>
          {tokenOut && !isNativeETH(tokenOut.address) && (
            <a
              href={`${config.explorerUrl}/token/${tokenOut.address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-primary hover:underline font-mono"
            >
              {tokenOut.address.slice(0, 4)}...{tokenOut.address.slice(-4)}
            </a>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            {quoteLoading ? (
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            ) : (
              <p className="text-2xl font-medium truncate">
                {quoteResult && tokenOut
                  ? formatSwapAmount(quoteResult.amountOut, tokenOut.decimals)
                  : '0'}
              </p>
            )}
          </div>
          <TokenPill token={tokenOut} onClick={() => setShowTokenPicker('out')} />
        </div>
        {usdOut && <p className="text-[10px] text-muted-foreground">{usdOut}</p>}
      </div>

      {/* ── Error ────────────────────────────────────────────── */}
      {(quoteError || txError) && (
        <div className="flex items-center gap-1.5 p-2 rounded-lg bg-destructive/10 border border-destructive/30">
          <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
          <p className="text-[10px] text-destructive">{quoteError || txError}</p>
        </div>
      )}

      {/* ── Success ──────────────────────────────────────────── */}
      {txHash && (
        <div className="flex items-center gap-1.5 p-2 rounded-lg bg-green-500/10 border border-green-500/30">
          <Check className="w-3.5 h-3.5 text-green-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] text-green-600 dark:text-green-400 font-medium">Swap submitted</p>
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

      {/* ── Swap details (MetaMask-style) ────────────────────── */}
      {quoteResult && tokenIn && tokenOut && rateStr && (
        <SwapDetails
          rateStr={rateStr}
          refreshCountdown={refreshCountdown}
          networkFeeUsd={networkFeeUsd}
          slippageBps={slippageBps}
          onSlippageChange={setSlippageBps}
          editingSlippage={editingSlippage}
          setEditingSlippage={setEditingSlippage}
          minReceived={minReceived}
          tokenOutSymbol={tokenOut.symbol}
        />
      )}

      {/* ── Action button ────────────────────────────────────── */}
      {needsApproval ? (
        <Button className="w-full h-11 text-sm font-semibold" onClick={handleApprove} disabled={approving}>
          {approving ? (
            <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              {approvalStep === 'erc20' ? `Approving ${tokenIn?.symbol}...` : 'Setting Permit2...'}
            </>
          ) : approvalStep === 'erc20' ? (
            `Approve ${tokenIn?.symbol}`
          ) : (
            `Set Permit2 allowance`
          )}
        </Button>
      ) : (
        <Button className="w-full h-11 text-sm font-semibold" onClick={handleSwap} disabled={!canSwap}>
          {txPending ? (
            <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Swapping...</>
          ) : !amountIn ? (
            'Enter an amount'
          ) : quoteLoading ? (
            'Getting quote...'
          ) : quoteError ? (
            'Unable to swap'
          ) : (
            'Swap'
          )}
        </Button>
      )}

      {/* ── Token picker overlay ─────────────────────────────── */}
      {showTokenPicker && (
        <div className="fixed inset-0 z-50 bg-background/80 flex items-end">
          <div className="w-full bg-popover border-t rounded-t-xl p-3 space-y-1 animate-in slide-in-from-bottom-5">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium">Select token</p>
              <button
                onClick={() => setShowTokenPicker(null)}
                className="text-xs text-muted-foreground hover:text-primary"
              >
                Cancel
              </button>
            </div>
            {tokens.map(token => {
              const isSelected =
                (showTokenPicker === 'in' && tokenIn?.address === token.address) ||
                (showTokenPicker === 'out' && tokenOut?.address === token.address);
              return (
                <button
                  key={token.address}
                  onClick={() => handleSelectToken(token, showTokenPicker)}
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
                  {!isNativeETH(token.address) && (
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

// ── Token pill sub-component (MetaMask-style rounded selector) ────

function TokenPill({ token, onClick }: { token: SwapToken | null; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-full bg-muted hover:bg-muted/80 transition-colors shrink-0 border"
    >
      {token ? (
        <>
          <div className={`w-6 h-6 rounded-full bg-background flex items-center justify-center text-[9px] font-bold border ${token.logoColor}`}>
            {token.symbol.slice(0, 2)}
          </div>
          <span className="text-sm font-semibold">{token.symbol}</span>
        </>
      ) : (
        <span className="text-xs text-muted-foreground px-1">Select</span>
      )}
      <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
    </button>
  );
}

// ── Swap details section (MetaMask-style) ──────────────────────────

function SwapDetails({
  rateStr,
  refreshCountdown,
  networkFeeUsd,
  slippageBps,
  onSlippageChange,
  editingSlippage,
  setEditingSlippage,
  minReceived,
  tokenOutSymbol,
}: {
  rateStr: string;
  refreshCountdown: number;
  networkFeeUsd: string | null;
  slippageBps: number;
  onSlippageChange: (bps: number) => void;
  editingSlippage: boolean;
  setEditingSlippage: (v: boolean) => void;
  minReceived: string | null;
  tokenOutSymbol: string;
}) {
  const formatTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  return (
    <div className="rounded-xl border bg-muted/10 p-3 space-y-2 text-[11px]">
      {/* Rate + countdown */}
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground flex items-center gap-1">
          Rate
          {refreshCountdown > 0 && (
            <span className="text-[10px] text-muted-foreground/70">{formatTime(refreshCountdown)}</span>
          )}
        </span>
        <span className="font-medium flex items-center gap-1">
          {rateStr}
          <ChevronRight className="w-3 h-3 text-muted-foreground" />
        </span>
      </div>

      {/* Network fee */}
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground flex items-center gap-0.5">
          Network fee <Info className="w-3 h-3 text-muted-foreground/50" />
        </span>
        <span className="font-medium">
          {networkFeeUsd ? `$${networkFeeUsd} Included` : '—'}
        </span>
      </div>

      {/* Slippage — inline editable */}
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground flex items-center gap-0.5">
          Slippage <Info className="w-3 h-3 text-muted-foreground/50" />
        </span>
        {editingSlippage ? (
          <div className="flex items-center gap-1">
            {SLIPPAGE_OPTIONS.map(bps => (
              <button
                key={bps}
                onClick={() => { onSlippageChange(bps); setEditingSlippage(false); }}
                className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                  slippageBps === bps
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'hover:bg-muted border-border'
                }`}
              >
                {(bps / 100).toFixed(1)}%
              </button>
            ))}
          </div>
        ) : (
          <button
            onClick={() => setEditingSlippage(true)}
            className="font-medium flex items-center gap-1 hover:text-primary transition-colors"
          >
            {(slippageBps / 100).toFixed(1)}%
            <Pencil className="w-2.5 h-2.5 text-muted-foreground" />
          </button>
        )}
      </div>

      {/* Minimum received */}
      {minReceived && (
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground flex items-center gap-0.5">
            Minimum received <Info className="w-3 h-3 text-muted-foreground/50" />
          </span>
          <span className="font-medium">{minReceived} {tokenOutSymbol}</span>
        </div>
      )}
    </div>
  );
}

// ── USD estimation helpers ─────────────────────────────────────────

/**
 * Estimate USD value from swap pair data.
 * If one side is a stablecoin (USDC/DAI), we can derive the USD value of the other.
 */
function computeUsdEstimate(
  tokenIn: SwapToken | null,
  tokenOut: SwapToken | null,
  rawIn: bigint,
  rawOut: bigint | null,
  side: 'in' | 'out',
): string | null {
  if (!tokenIn || !tokenOut || rawIn === 0n || rawOut === null || rawOut === 0n) return null;

  const inIsStable = isStablecoin(tokenIn.address);
  const outIsStable = isStablecoin(tokenOut.address);

  if (!inIsStable && !outIsStable) return null; // Can't estimate without a stablecoin reference

  if (side === 'in') {
    if (inIsStable) {
      // Input IS the stablecoin — USD ≈ input amount
      return formatUsd(rawIn, tokenIn.decimals);
    }
    // Output is stablecoin — USD of input ≈ output amount (what you'd get)
    return formatUsd(rawOut, tokenOut.decimals);
  } else {
    if (outIsStable) {
      return formatUsd(rawOut, tokenOut.decimals);
    }
    return formatUsd(rawIn, tokenIn.decimals);
  }
}

function formatUsd(raw: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 2);
  return `$${whole.toLocaleString()}.${fracStr}`;
}

/** Estimate network fee in USD. Base L2 fees are very low (~0.001-0.01 USD). */
function estimateNetworkFeeUsd(gasEstimate: bigint): string {
  // Base typical gas price ~0.01-0.05 gwei; ETH ~$2000-3000
  // Conservative: 0.05 gwei * gasEstimate * $2500/ETH
  const gasPriceWei = 50000000n; // 0.05 gwei in wei
  const costWei = gasEstimate * gasPriceWei;
  // $2500/ETH = 2500 * 1e18 wei → costUsd = costWei * 2500 / 1e18
  const costMicroUsd = costWei * 2500n / 1000000000000n; // in micro-USD (1e-6)
  const cents = Number(costMicroUsd) / 1_000_000;
  if (cents < 0.01) return '< 0.01';
  return cents.toFixed(2);
}
