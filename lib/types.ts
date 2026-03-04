// NodeZero message types for popup ↔ background ↔ content communication

export enum MessageType {
  // Session management
  unlockVault = 'unlockVault',
  lockVault = 'lockVault',
  getSessionState = 'getSessionState',

  // Vault operations
  getVaultEntries = 'getVaultEntries',
  saveVaultEntry = 'saveVaultEntry',
  deleteVaultEntry = 'deleteVaultEntry',

  // Content script actions
  fillCredentials = 'fillCredentials',
  saveCurrentLogin = 'saveCurrentLogin',
  getPageInfo = 'getPageInfo',

  // Context menu triggers
  contextMenuFill = 'contextMenuFill',
  contextMenuGenerate = 'contextMenuGenerate',
  contextMenuSave = 'contextMenuSave',
  contextMenuOpen = 'contextMenuOpen',

  // Settings
  changeTheme = 'changeTheme',
  syncVault = 'syncVault',

  // Bulk import
  importEntries = 'importEntries',

  // Token pool
  getTokenBalance = 'getTokenBalance',
  refreshTokens = 'refreshTokens',

  // Signed API proxy — popup asks background to make DID-signed API calls
  signedApiFetch = 'signedApiFetch',

  // Biometric upgrade — popup registers WebAuthn, background wraps key
  upgradeToBiometric = 'upgradeToBiometric',

  // Passkey VC — content script → background
  passkeyRegistered = 'passkeyRegistered',

  // Wallet — popup ↔ background
  getWalletState = 'getWalletState',
  setActiveChain = 'setActiveChain',
  setActiveAccountIndex = 'setActiveAccountIndex',
  approveWalletAction = 'approveWalletAction',
  rejectWalletAction = 'rejectWalletAction',
  signTransaction = 'signTransaction',
  setTestnetMode = 'setTestnetMode',

  // Swap — popup ↔ background
  getSwapQuote = 'getSwapQuote',
  executeSwap = 'executeSwap',
}

export enum MessageFrom {
  popup = 'popup',
  background = 'background',
  content = 'content',
}

export interface NodeZeroMessage<T = unknown> {
  type: MessageType;
  from: MessageFrom;
  payload?: T;
  requestId?: string;
}

export interface SessionState {
  isUnlocked: boolean;
  did: string | null;
  entryCount: number;
  lastUnlocked: number | null;
}

export interface PageInfo {
  url: string;
  title: string;
  hostname: string;
  username?: string;
  password?: string;
  /** true when a visible password input exists on the page (even if empty) */
  hasPasswordField?: boolean;
}

export interface FillPayload {
  username: string;
  password: string;
}

export interface SaveLoginPayload {
  url: string;
  title: string;
  username?: string;
  password?: string;
}
