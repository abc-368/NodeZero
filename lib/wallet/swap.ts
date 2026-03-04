/**
 * In-extension swap module — Uniswap v4 UniversalRouter on Base.
 *
 * Uses V4Quoter for quotes and UniversalRouter for execution.
 * Supports ETH, WETH, USDC, DAI, cbBTC on Base mainnet; ETH, WETH, USDC on Sepolia.
 */

import {
  encodeFunctionCall,
  encodeAddress,
  encodeUint,
  encodeInt,
  encodeBool,
  encodeDynBytes,
  encodeDynBytesArray,
  encodeTuple,
  type TuplePart,
  decodeUint,
} from './abi';

// ── Token definitions ─────────────────────────────────────────────

export interface SwapToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoColor: string;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const SWAP_TOKENS_BASE: SwapToken[] = [
  { address: ZERO_ADDRESS, symbol: 'ETH', name: 'Ethereum', decimals: 18, logoColor: 'text-blue-500' },
  { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, logoColor: 'text-blue-400' },
  { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoColor: 'text-blue-600' },
  { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', symbol: 'DAI', name: 'Dai', decimals: 18, logoColor: 'text-yellow-500' },
  { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', symbol: 'cbBTC', name: 'Coinbase BTC', decimals: 8, logoColor: 'text-orange-500' },
  { address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEC22', symbol: 'cbETH', name: 'Coinbase Staked ETH', decimals: 18, logoColor: 'text-blue-300' },
  { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', symbol: 'AERO', name: 'Aerodrome', decimals: 18, logoColor: 'text-cyan-500' },
  { address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', symbol: 'DEGEN', name: 'Degen', decimals: 18, logoColor: 'text-purple-500' },
];

export const SWAP_TOKENS_BASE_SEPOLIA: SwapToken[] = [
  { address: ZERO_ADDRESS, symbol: 'ETH', name: 'Ethereum', decimals: 18, logoColor: 'text-blue-500' },
  { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, logoColor: 'text-blue-400' },
  { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoColor: 'text-blue-600' },
];

export const SWAP_TOKENS_BNB: SwapToken[] = [
  { address: ZERO_ADDRESS, symbol: 'BNB', name: 'BNB', decimals: 18, logoColor: 'text-yellow-500' },
  { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', symbol: 'WBNB', name: 'Wrapped BNB', decimals: 18, logoColor: 'text-yellow-400' },
  { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', name: 'USD Coin', decimals: 18, logoColor: 'text-blue-600' },
  { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', name: 'Tether', decimals: 18, logoColor: 'text-green-500' },
  { address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', symbol: 'ETH', name: 'Ethereum', decimals: 18, logoColor: 'text-blue-500' },
  { address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', symbol: 'BTCB', name: 'Bitcoin BEP2', decimals: 18, logoColor: 'text-orange-500' },
];

export const SWAP_TOKENS_ARBITRUM: SwapToken[] = [
  { address: ZERO_ADDRESS, symbol: 'ETH', name: 'Ethereum', decimals: 18, logoColor: 'text-blue-500' },
  { address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, logoColor: 'text-blue-400' },
  { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoColor: 'text-blue-600' },
  { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', name: 'Tether', decimals: 6, logoColor: 'text-green-500' },
  { address: '0x912CE59144191C1204E64559FE8253a0e49E6548', symbol: 'ARB', name: 'Arbitrum', decimals: 18, logoColor: 'text-sky-500' },
  { address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8, logoColor: 'text-orange-500' },
];

export const SWAP_TOKENS_OPTIMISM: SwapToken[] = [
  { address: ZERO_ADDRESS, symbol: 'ETH', name: 'Ethereum', decimals: 18, logoColor: 'text-blue-500' },
  { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, logoColor: 'text-blue-400' },
  { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoColor: 'text-blue-600' },
  { address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', symbol: 'USDT', name: 'Tether', decimals: 6, logoColor: 'text-green-500' },
  { address: '0x4200000000000000000000000000000000000042', symbol: 'OP', name: 'Optimism', decimals: 18, logoColor: 'text-red-500' },
  { address: '0x68f180fcCe6836688e9084f035309E29Bf0A2095', symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8, logoColor: 'text-orange-500' },
];

export const SWAP_TOKENS_POLYGON: SwapToken[] = [
  { address: ZERO_ADDRESS, symbol: 'POL', name: 'Polygon', decimals: 18, logoColor: 'text-purple-500' },
  { address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', symbol: 'WPOL', name: 'Wrapped POL', decimals: 18, logoColor: 'text-purple-400' },
  { address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoColor: 'text-blue-600' },
  { address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', symbol: 'USDT', name: 'Tether', decimals: 6, logoColor: 'text-green-500' },
  { address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, logoColor: 'text-blue-400' },
  { address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8, logoColor: 'text-orange-500' },
];

export const SWAP_TOKENS_AVALANCHE: SwapToken[] = [
  { address: ZERO_ADDRESS, symbol: 'AVAX', name: 'Avalanche', decimals: 18, logoColor: 'text-red-600' },
  { address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', symbol: 'WAVAX', name: 'Wrapped AVAX', decimals: 18, logoColor: 'text-red-500' },
  { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', symbol: 'USDC', name: 'USD Coin', decimals: 6, logoColor: 'text-blue-600' },
  { address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', symbol: 'USDT', name: 'Tether', decimals: 6, logoColor: 'text-green-500' },
  { address: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', symbol: 'WETH.e', name: 'Wrapped Ether', decimals: 18, logoColor: 'text-blue-400' },
  { address: '0x50b7545627a5162F82A992c33b87aDc75187B218', symbol: 'WBTC.e', name: 'Wrapped BTC', decimals: 8, logoColor: 'text-orange-500' },
];

export function getSwapTokens(chain: string, testnet: boolean): SwapToken[] {
  if (testnet) {
    if (chain === 'base') return SWAP_TOKENS_BASE_SEPOLIA;
    return [];
  }
  switch (chain) {
    case 'base': return SWAP_TOKENS_BASE;
    case 'bnb': return SWAP_TOKENS_BNB;
    case 'arbitrum': return SWAP_TOKENS_ARBITRUM;
    case 'optimism': return SWAP_TOKENS_OPTIMISM;
    case 'polygon': return SWAP_TOKENS_POLYGON;
    case 'avalanche': return SWAP_TOKENS_AVALANCHE;
    default: return [];
  }
}

// ── Contract addresses (Uniswap v4) ──────────────────────────────

const V4_BASE = {
  universalRouter: '0x6ff5693b99212da76ad316178a184ab56d299b43',
  quoter: '0x0d5e0f971ed27fbff6c2837bf31316121532048d',
  poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b',
} as const;

const V4_BASE_SEPOLIA = {
  universalRouter: '0x492e6456d9528771018deb9e87ef7750ef184104',
  quoter: '0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba',
  poolManager: '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408',
} as const;

const V4_BNB = {
  universalRouter: '0x1906c1d672b88cd1b9ac7593301ca990f94eae07',
  quoter: '0x9f75dd27d6664c475b90e105573e550ff69437b0',
  poolManager: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df',
} as const;

const V4_ARBITRUM = {
  universalRouter: '0xa51afafe0263b40edaef0df8781ea9aa03e381a3',
  quoter: '0x3972c00f7ed4885e145823eb7c655375d275a1c5',
  poolManager: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
} as const;

const V4_OPTIMISM = {
  universalRouter: '0x851116d9223fabed8e56c0e6b8ad0c31d98b3507',
  quoter: '0x1f3131a13296fb91c90870043742c3cdbff1a8d7',
  poolManager: '0x9a13f98cb987694c9f086b1f5eb990eea8264ec3',
} as const;

const V4_POLYGON = {
  universalRouter: '0x1095692a6237d83c6a72f3f5efedb9a670c49223',
  quoter: '0xb3d5c3dfc3a7aebff71895a7191796bffc2c81b9',
  poolManager: '0x67366782805870060151383f4bbff9dab53e5cd6',
} as const;

const V4_AVALANCHE = {
  universalRouter: '0x94b75331ae8d42c1b61065089b7d48fe14aa73b7',
  quoter: '0xbe40675bb704506a3c2ccfb762dcfd1e979845c2',
  poolManager: '0x06380c0e0912312b5150364b9dc4542ba0dbbc85',
} as const;

/** Permit2 — canonical deployment on all chains */
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

export function getV4Contracts(chain: string, testnet: boolean) {
  if (testnet) return { ...V4_BASE_SEPOLIA, permit2: PERMIT2 };
  switch (chain) {
    case 'bnb': return { ...V4_BNB, permit2: PERMIT2 };
    case 'arbitrum': return { ...V4_ARBITRUM, permit2: PERMIT2 };
    case 'optimism': return { ...V4_OPTIMISM, permit2: PERMIT2 };
    case 'polygon': return { ...V4_POLYGON, permit2: PERMIT2 };
    case 'avalanche': return { ...V4_AVALANCHE, permit2: PERMIT2 };
    default: return { ...V4_BASE, permit2: PERMIT2 };
  }
}

/** Wrapped native token address per chain (for ETH<->WETH style wrap/unwrap) */
export function getWrappedNativeAddress(chain: string): string {
  switch (chain) {
    case 'ethereum': return '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    case 'base': return '0x4200000000000000000000000000000000000006';
    case 'optimism': return '0x4200000000000000000000000000000000000006';
    case 'arbitrum': return '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
    case 'polygon': return '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270';
    case 'bnb': return '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
    case 'avalanche': return '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7';
    default: return '0x4200000000000000000000000000000000000006';
  }
}

/** Default v4 pool fee: 3000 = 0.30% (standard v4 tier) */
export const DEFAULT_V4_FEE = 3000;
/** Default v4 tick spacing for 0.30% fee tier */
export const DEFAULT_V4_TICK_SPACING = 60;

// ── v4 Action bytes (from Uniswap v4-periphery Actions.sol) ──────

const ACTION_SWAP_EXACT_IN_SINGLE = '06';
const ACTION_SETTLE_ALL = '0c';
const ACTION_TAKE_ALL = '0f';

/** UniversalRouter command: V4_SWAP = 0x10 */
const CMD_V4_SWAP = '10';

// ── Helpers ───────────────────────────────────────────────────────

export function isNativeETH(address: string): boolean {
  return address === ZERO_ADDRESS;
}

/** Calculate minimum output with slippage (basis points) */
export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  return amountOut * BigInt(10000 - slippageBps) / 10000n;
}

/**
 * Sort two currencies for v4 PoolKey (currency0 < currency1).
 * v4 uses address(0) for native ETH.
 */
export function sortCurrencies(tokenIn: string, tokenOut: string): {
  currency0: string; currency1: string; zeroForOne: boolean;
} {
  const a = tokenIn.toLowerCase();
  const b = tokenOut.toLowerCase();
  if (a < b) return { currency0: tokenIn, currency1: tokenOut, zeroForOne: true };
  return { currency0: tokenOut, currency1: tokenIn, zeroForOne: false };
}

// ── v4 Quote encoding (V4Quoter) ─────────────────────────────────

/**
 * Encode V4Quoter.quoteExactInputSingle calldata.
 *
 * Solidity: quoteExactInputSingle(QuoteExactSingleParams memory params)
 * struct QuoteExactSingleParams {
 *   PoolKey poolKey;      // (currency0, currency1, fee, tickSpacing, hooks)
 *   bool zeroForOne;
 *   uint128 exactAmount;
 *   bytes hookData;
 * }
 */
export function encodeV4QuoteCalldata(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  fee: number = DEFAULT_V4_FEE,
  tickSpacing: number = DEFAULT_V4_TICK_SPACING,
  hooks: string = ZERO_ADDRESS,
): string {
  const { currency0, currency1, zeroForOne } = sortCurrencies(tokenIn, tokenOut);

  // Struct fields inline (PoolKey fields + zeroForOne + exactAmount + hookData)
  const parts: TuplePart[] = [
    { dynamic: false, data: encodeAddress(currency0) },
    { dynamic: false, data: encodeAddress(currency1) },
    { dynamic: false, data: encodeUint(BigInt(fee)) },
    { dynamic: false, data: encodeInt(tickSpacing) },
    { dynamic: false, data: encodeAddress(hooks) },
    { dynamic: false, data: encodeBool(zeroForOne) },
    { dynamic: false, data: encodeUint(amountIn) },
    { dynamic: true, data: encodeDynBytes('') }, // empty hookData
  ];

  const tupleData = encodeTuple(parts);
  // PoolKey is a nested struct → signature uses nested parens
  const selector = encodeFunctionCall(
    'quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))',
    [],
  );
  // Single struct param → ABI wraps with offset word (0x20)
  return selector + encodeUint(32n) + tupleData;
}

/** Decode V4Quoter return: (uint256 amountOut, uint256 gasEstimate) */
export function decodeV4QuoteResult(data: string): { amountOut: bigint; gasEstimate: bigint } {
  return {
    amountOut: decodeUint(data, 0),
    gasEstimate: decodeUint(data, 1),
  };
}

// ── v4 Swap encoding (UniversalRouter) ───────────────────────────

/**
 * Encode UniversalRouter.execute(bytes commands, bytes[] inputs, uint256 deadline).
 *
 * commands = [0x10] (V4_SWAP), inputs = [v4SwapPayload]
 * v4SwapPayload = abi.encode(bytes actions, bytes[] params)
 *   actions = 0x060c0f (SWAP_EXACT_IN_SINGLE + SETTLE_ALL + TAKE_ALL)
 */
export function encodeV4SwapCalldata(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  amountOutMinimum: bigint,
  deadline: bigint,
  fee: number = DEFAULT_V4_FEE,
  tickSpacing: number = DEFAULT_V4_TICK_SPACING,
  hooks: string = ZERO_ADDRESS,
): string {
  const { currency0, currency1, zeroForOne } = sortCurrencies(tokenIn, tokenOut);

  // swapParam: ExactInputSingleParams (PoolKey inline + swap fields + hookData)
  const swapParts: TuplePart[] = [
    { dynamic: false, data: encodeAddress(currency0) },
    { dynamic: false, data: encodeAddress(currency1) },
    { dynamic: false, data: encodeUint(BigInt(fee)) },
    { dynamic: false, data: encodeInt(tickSpacing) },
    { dynamic: false, data: encodeAddress(hooks) },
    { dynamic: false, data: encodeBool(zeroForOne) },
    { dynamic: false, data: encodeUint(amountIn) },
    { dynamic: false, data: encodeUint(amountOutMinimum) },
    { dynamic: true, data: encodeDynBytes('') }, // empty hookData
  ];
  const swapParam = encodeTuple(swapParts);

  // SETTLE_ALL: (address currency, uint256 maxAmount)
  const settleParam = encodeAddress(tokenIn) + encodeUint(amountIn);

  // TAKE_ALL: (address currency, uint256 minAmount)
  const takeParam = encodeAddress(tokenOut) + encodeUint(amountOutMinimum);

  // v4SwapPayload: abi.encode(bytes actions, bytes[] params)
  const actions = ACTION_SWAP_EXACT_IN_SINGLE + ACTION_SETTLE_ALL + ACTION_TAKE_ALL;
  const v4PayloadParts: TuplePart[] = [
    { dynamic: true, data: encodeDynBytes(actions) },
    { dynamic: true, data: encodeDynBytesArray([swapParam, settleParam, takeParam]) },
  ];
  const v4Payload = encodeTuple(v4PayloadParts);

  // execute(bytes commands, bytes[] inputs, uint256 deadline)
  const executeParts: TuplePart[] = [
    { dynamic: true, data: encodeDynBytes(CMD_V4_SWAP) },
    { dynamic: true, data: encodeDynBytesArray([v4Payload]) },
    { dynamic: false, data: encodeUint(deadline) },
  ];

  const selector = encodeFunctionCall('execute(bytes,bytes[],uint256)', []);
  return selector + encodeTuple(executeParts);
}

// ── Permit2 encoding ─────────────────────────────────────────────

/** Encode Permit2.approve(address token, address spender, uint160 amount, uint48 expiration) */
export function encodePermit2Approve(
  token: string,
  spender: string,
  amount: bigint,
  expiration: bigint,
): string {
  return encodeFunctionCall('approve(address,address,uint160,uint48)', [
    encodeAddress(token),
    encodeAddress(spender),
    encodeUint(amount),
    encodeUint(expiration),
  ]);
}

/** Encode Permit2.allowance(address user, address token, address spender) */
export function encodePermit2AllowanceCalldata(
  user: string,
  token: string,
  spender: string,
): string {
  return encodeFunctionCall('allowance(address,address,address)', [
    encodeAddress(user),
    encodeAddress(token),
    encodeAddress(spender),
  ]);
}

// ── ERC-20 encoding ──────────────────────────────────────────────

/** Encode ERC-20 approve(address spender, uint256 amount) */
export function encodeApproveCalldata(spender: string, amount: bigint): string {
  return encodeFunctionCall('approve(address,uint256)', [
    encodeAddress(spender),
    encodeUint(amount),
  ]);
}

/** Encode ERC-20 allowance(address owner, address spender) */
export function encodeAllowanceCalldata(owner: string, spender: string): string {
  return encodeFunctionCall('allowance(address,address)', [
    encodeAddress(owner),
    encodeAddress(spender),
  ]);
}

// ── Formatting ────────────────────────────────────────────────────

export function formatSwapAmount(raw: bigint, decimals: number, maxDec: number = 6): string {
  if (raw === 0n) return '0';
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  if (frac === 0n) return whole.toLocaleString();
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, maxDec).replace(/0+$/, '');
  return fracStr ? `${whole.toLocaleString()}.${fracStr}` : whole.toLocaleString();
}

export function parseSwapAmount(input: string, decimals: number): bigint {
  const clean = input.replace(/,/g, '').trim();
  if (!clean || isNaN(Number(clean))) return 0n;
  const parts = clean.split('.');
  const whole = BigInt(parts[0] || '0');
  let frac = 0n;
  if (parts[1]) {
    const fracStr = parts[1].slice(0, decimals).padEnd(decimals, '0');
    frac = BigInt(fracStr);
  }
  return whole * (10n ** BigInt(decimals)) + frac;
}
