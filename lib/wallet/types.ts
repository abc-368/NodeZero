/**
 * Wallet types — extends VaultEntry for blockchain accounts.
 *
 * Addresses are derived on-demand from the mnemonic + index, never stored.
 * Only the accountIndex and chain identifier are persisted in the vault.
 */

export type Chain = 'ethereum' | 'base' | 'arbitrum' | 'optimism' | 'polygon' | 'bnb' | 'avalanche' | 'bitcoin';

export interface WalletEntry {
  id: string;
  type: 'wallet_account';
  chain: Chain;
  accountIndex: number;
  derivationPath: string;
  addressLabel?: string;      // user-defined label ("Main", "Trading", etc.)
  createdAt: number;          // Unix ms
  updatedAt: number;          // Unix ms
}

export interface ChainConfig {
  chainId: string;            // hex (e.g., '0x1' for Ethereum mainnet)
  name: string;
  symbol: string;
  decimals: number;
  rpcUrl: string;
  explorerUrl: string;
  iconColor: string;          // Tailwind color for UI badges
}

export const CHAIN_CONFIGS: Record<Chain, ChainConfig> = {
  ethereum: {
    chainId: '0x1',
    name: 'Ethereum',
    symbol: 'ETH',
    decimals: 18,
    rpcUrl: 'https://eth.llamarpc.com',
    explorerUrl: 'https://etherscan.io',
    iconColor: 'text-blue-500',
  },
  base: {
    chainId: '0x2105',
    name: 'Base',
    symbol: 'ETH',
    decimals: 18,
    rpcUrl: 'https://mainnet.base.org',
    explorerUrl: 'https://basescan.org',
    iconColor: 'text-blue-600',
  },
  arbitrum: {
    chainId: '0xa4b1',
    name: 'Arbitrum One',
    symbol: 'ETH',
    decimals: 18,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    explorerUrl: 'https://arbiscan.io',
    iconColor: 'text-sky-500',
  },
  optimism: {
    chainId: '0xa',
    name: 'Optimism',
    symbol: 'ETH',
    decimals: 18,
    rpcUrl: 'https://mainnet.optimism.io',
    explorerUrl: 'https://optimistic.etherscan.io',
    iconColor: 'text-red-500',
  },
  polygon: {
    chainId: '0x89',
    name: 'Polygon',
    symbol: 'POL',
    decimals: 18,
    rpcUrl: 'https://polygon-rpc.com',
    explorerUrl: 'https://polygonscan.com',
    iconColor: 'text-purple-500',
  },
  bnb: {
    chainId: '0x38',
    name: 'BNB Chain',
    symbol: 'BNB',
    decimals: 18,
    rpcUrl: 'https://bsc-dataseed.binance.org',
    explorerUrl: 'https://bscscan.com',
    iconColor: 'text-yellow-500',
  },
  avalanche: {
    chainId: '0xa86a',
    name: 'Avalanche',
    symbol: 'AVAX',
    decimals: 18,
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    explorerUrl: 'https://snowscan.xyz',
    iconColor: 'text-red-600',
  },
  bitcoin: {
    chainId: 'bitcoin',
    name: 'Bitcoin',
    symbol: 'BTC',
    decimals: 8,
    rpcUrl: 'https://blockstream.info/api',
    explorerUrl: 'https://blockstream.info',
    iconColor: 'text-orange-500',
  },
};

/** EVM chains only (excludes Bitcoin) */
export const EVM_CHAINS: Chain[] = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bnb', 'avalanche'];

/** Testnet chain configs — same Chain keys, different RPC/explorer/chainId */
export const TESTNET_CHAIN_CONFIGS: Record<Chain, ChainConfig> = {
  ethereum: {
    chainId: '0xaa36a7',
    name: 'Sepolia',
    symbol: 'ETH',
    decimals: 18,
    rpcUrl: 'https://rpc.sepolia.org',
    explorerUrl: 'https://sepolia.etherscan.io',
    iconColor: 'text-blue-500',
  },
  base: {
    chainId: '0x14a34',
    name: 'Base Sepolia',
    symbol: 'ETH',
    decimals: 18,
    rpcUrl: 'https://sepolia.base.org',
    explorerUrl: 'https://sepolia.basescan.org',
    iconColor: 'text-blue-600',
  },
  arbitrum: {
    chainId: '0x66eee',
    name: 'Arbitrum Sepolia',
    symbol: 'ETH',
    decimals: 18,
    rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    explorerUrl: 'https://sepolia.arbiscan.io',
    iconColor: 'text-sky-500',
  },
  optimism: {
    chainId: '0xaa37dc',
    name: 'OP Sepolia',
    symbol: 'ETH',
    decimals: 18,
    rpcUrl: 'https://sepolia.optimism.io',
    explorerUrl: 'https://sepolia-optimistic.etherscan.io',
    iconColor: 'text-red-500',
  },
  polygon: {
    chainId: '0x13882',
    name: 'Polygon Amoy',
    symbol: 'POL',
    decimals: 18,
    rpcUrl: 'https://rpc-amoy.polygon.technology',
    explorerUrl: 'https://amoy.polygonscan.com',
    iconColor: 'text-purple-500',
  },
  bnb: {
    chainId: '0x61',
    name: 'BSC Testnet',
    symbol: 'tBNB',
    decimals: 18,
    rpcUrl: 'https://data-seed-prebsc-1-s1.binance.org:8545',
    explorerUrl: 'https://testnet.bscscan.com',
    iconColor: 'text-yellow-500',
  },
  avalanche: {
    chainId: '0xa869',
    name: 'Avalanche Fuji',
    symbol: 'AVAX',
    decimals: 18,
    rpcUrl: 'https://api.avax-test.network/ext/bc/C/rpc',
    explorerUrl: 'https://testnet.snowscan.xyz',
    iconColor: 'text-red-600',
  },
  bitcoin: {
    chainId: 'bitcoin-testnet',
    name: 'Bitcoin Testnet',
    symbol: 'tBTC',
    decimals: 8,
    rpcUrl: 'https://blockstream.info/testnet/api',
    explorerUrl: 'https://blockstream.info/testnet',
    iconColor: 'text-orange-500',
  },
};

/**
 * Get the chain config for a given chain, respecting testnet mode.
 */
export function getChainConfig(chain: Chain, testnet: boolean): ChainConfig {
  return testnet ? TESTNET_CHAIN_CONFIGS[chain] : CHAIN_CONFIGS[chain];
}
