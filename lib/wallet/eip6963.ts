/**
 * EIP-6963 provider announcement metadata.
 *
 * Injected into every page via the ethereum-provider content script.
 * Dapps that support EIP-6963 will discover NodeZero without
 * overriding window.ethereum.
 */

export const PROVIDER_INFO = {
  uuid: 'nodezero-wallet-v1',
  name: 'NodeZero',
  icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="%231a1a2e" stroke="%2316213e" stroke-width="2"/><text x="16" y="21" text-anchor="middle" fill="%23e94560" font-size="14" font-family="monospace" font-weight="bold">N0</text></svg>',
  rdns: 'top.nodezero.wallet',
} as const;
