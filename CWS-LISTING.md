# Chrome Web Store Listing — NodeZero v1.2.0

> Use this file when filling out the Chrome Web Store developer dashboard.

---

## Store Listing

### Name
NodeZero — Zero-Knowledge Password Manager

### Short Description (132 chars max)
Zero-knowledge vault, encrypted email, HD wallet. Hardware keys, DID identity, anonymous sync. No account. No server. Open source.

### Detailed Description
NodeZero is an open-source, zero-knowledge password manager with end-to-end encrypted email and a multi-chain HD wallet — all inside a single lightweight browser extension. No account to create. No master password sent to a server. Your identity is a cryptographic key derived from your hardware — or from a 12-word recovery phrase only you know.

BETA NOTICE

NodeZero is under active development. While all cryptographic operations use audited libraries and follow established standards, the extension has not yet undergone a formal third-party security audit. Exercise caution: avoid storing credentials you cannot afford to lose without a backup, and always keep your 12-word recovery phrase in a safe place. Report issues at https://nodezero.top/contact.

HOW IT WORKS

Your vault is encrypted locally before it ever leaves your browser. Each field (username, password, notes) is encrypted individually with AES-256-GCM using a unique nonce — not as a single blob. The encryption key is derived from your device's hardware authenticator (via WebAuthn PRF), biometric scan (Windows Hello, Touch ID), or a passphrase, and is never stored on any server.

Cross-device sync uploads your encrypted vault to a cloud endpoint that cannot read its contents. The server stores opaque ciphertext, verifies your cryptographic identity, and knows nothing about what is inside. Even sync metering uses blind-signature tokens (VOPRF, RFC 9497) — a privacy technique where the server can verify you hold a valid token without knowing who you are.

WHAT MAKES NODEZERO DIFFERENT

No email, no phone number, no name. Your identity is a decentralised identifier (DID) derived from your cryptographic keys. There is no "forgot password" flow because there is no account. Recovery uses a 12-word mnemonic phrase — the same proven approach used by cryptocurrency wallets.

The server never sees your encryption keys, your plaintext credentials, or your usage patterns. Uploads and downloads are authenticated by Ed25519 signature with a 5-minute timestamp window — not by session cookies or JWT tokens.

NodeZero is open source under the AGPL-3.0 licence. The full encryption layer, vault logic, key derivation, sync protocol, and wallet code are published and auditable.

CREDENTIAL MANAGEMENT

- Hardware-Backed Encryption — Vault keys derived from WebAuthn PRF (YubiKey, SoloKeys, Titan, Feitian) or biometric unlock via Windows Hello and Touch ID. Your encryption keys never leave your device.
- DID-Based Identity — Your vault is owned by a decentralised identifier (did:key) that you control. No email, no phone number, no account required.
- Field-Level Encryption — Every sensitive credential field is individually encrypted with AES-256-GCM and a unique IV. Not single-blob encryption.
- Cross-Device Sync — Encrypted vault syncs via Cloudflare R2. The sync service only sees opaque blobs and cannot read your data.
- Smart Conflict Resolution — Per-entry last-write-wins merge with tombstone-based deletion tracking. Concurrent edits across devices are resolved automatically.
- One-Click Import — Migrate from Chrome, LastPass, Bitwarden, or 1Password in under 60 seconds with CSV drag-and-drop. Round-trip export is also supported.
- 12-Word Recovery — A BIP-39 mnemonic phrase lets you restore your vault on any device. Shown once during setup, never stored. You can recover a different vault on the same device with a clear warning before overwriting.
- Context Menu Fill — Right-click to fill credentials with a domain-matched picker, generate passwords, or save logins. No auto-fill surprises — you choose when and where to fill.
- Save Vault to File — Export your encrypted vault to a local backup file at any time. AES-256-GCM encrypted CBOR — useless without your recovery phrase.
- Dashboard — After unlock, a landing page shows your security score, vault statistics, and non-zero wallet balances at a glance.
- Security Report — Password health analysis flags weak, reused, and old passwords with a composite 0–100 security score.
- Vault Sharing — Delegate vault access to other NodeZero users via X25519-wrapped Verifiable Credentials with Ed25519 signatures. Time-limited and revocable.
- Side Panel — Open NodeZero as a persistent side panel (Chrome 114+) for a full-height view alongside your browsing. Toggle between popup and side panel in settings.

ENCRYPTED EMAIL FOR GMAIL

NodeZero adds transparent end-to-end encryption on top of Gmail. Both sender and recipients must have NodeZero installed.

How to encrypt an email: right-click anywhere inside a Gmail compose window → NodeZero → Encrypt for recipients. NodeZero looks up every address in the To, CC, and BCC fields, encrypts the message body, and replaces it with ciphertext — all before the email leaves your browser.

How to decrypt: right-click on a received encrypted message → NodeZero → Decrypt email. If you grant the optional Gmail host permission (prompted on first use), NodeZero will automatically decrypt incoming encrypted emails as you read them — no right-click needed. A "Decrypted by NodeZero" banner appears above each decrypted message.

How to link your email: right-click on any Gmail or Google Account page → NodeZero → Link this email to my identity. This registers a SHA-256 hash of your email address against your DID so other NodeZero users can encrypt messages to you. Registration is free (0 tokens).

Important: linking is not automatic. Each user must explicitly link their email address before others can send them encrypted messages. Without linking, senders cannot discover the recipient's public key and the message stays plaintext. This is by design — email-to-DID mappings are never created without consent, preserving anonymity for users who choose not to participate.

Under the hood:
- A random content encryption key (CEK) encrypts the email body once with AES-256-GCM.
- A fresh ephemeral X25519 keypair is generated per message for forward secrecy.
- For each recipient (To, CC, BCC), ECDH derives a unique wrapping key that encrypts the CEK.
- The server stores only SHA-256 hashes of email addresses mapped to public keys — it never sees addresses or content in plaintext.
- Recipient lookups cost 1 blind-signature token each. The email-hash-to-DID mapping is cached locally for 24 hours, so repeat messages to the same recipients cost zero tokens. The cache can be cleared from extension settings.

Multi-recipient support: all recipients (including the sender) can decrypt the message. If any recipient has not enrolled, NodeZero warns you by name and the message stays unencrypted — no partial encryption surprises.

MULTI-CHAIN HD WALLET

NodeZero derives a full HD wallet from your existing 12-word recovery phrase — no additional seed to manage.

- EVM chains: Ethereum, Base, Arbitrum, Optimism, Polygon — native and ERC-20 token balances, transaction history.
- Bitcoin: SegWit (BIP-84) and Taproot (BIP-86) addresses with balance and transaction history via Blockstream API.
- EIP-1193/6963 provider: NodeZero acts as a browser wallet for dApps. Connect to any dApp that supports MetaMask-style injection.
- In-extension swap: swap tokens on Base via Uniswap v4 with Permit2 approval — no separate DEX tab needed.
- Transaction signing: EIP-1559 transaction and typed-data signing with a clear approval UI showing destination, value, and gas.
- ENS resolution: forward and reverse ENS lookups integrated across the wallet.

SECURITY BY DESIGN

- No plaintext credential data ever touches disk or chrome.storage.
- Vault signature verified (Ed25519) before decryption — tamper detection built in.
- Auto-lock after 10 minutes of inactivity.
- Recovery vault uses 2,000,000 PBKDF2 iterations (~30 seconds derivation) as brute-force protection.
- All uploads authenticated with DID Ed25519 signature within a 5-minute timestamp window.
- Blind-signature anonymous tokens decouple your identity from your usage patterns.
- Google Password Manager crash guard warns before accidental GPM saves that could expose plaintext.
- WebAuthn ceremonies automatically escape the popup to a side panel or pop-out window to survive Windows Hello focus loss.

SETUP IN THREE STEPS

1. Install NodeZero and register your passkey (security key, Windows Hello, or Touch ID).
2. A 12-word recovery phrase is generated — write it down and verify three words.
3. Right-click on any login field to fill, generate, or save credentials.

CRYPTOGRAPHY STACK

Built entirely with Web Crypto API and audited libraries — no WASM, no custom cryptography.
- AES-256-GCM: field-level encryption with per-field unique nonces.
- X25519 ECDH: email encryption with ephemeral keypairs (@noble/curves).
- Ed25519: DID signing and vault authentication (@noble/curves).
- HKDF-SHA256: all key material derivation (@noble/hashes).
- PBKDF2-SHA256: PIN and recovery key stretching (Web Crypto API).
- BIP-39: 12-word mnemonic generation and recovery (@scure/bip39).
- BIP-32/44/84/86: HD wallet key derivation for EVM and Bitcoin (@scure/bip32).
- VOPRF P-256: anonymous token issuance and redemption (Privacy Pass, RFC 9497, @noble/curves).
- CBOR: compact vault serialisation (cbor-x).

PRICING

Free tier: unlimited local operations, 100 cloud syncs per day, encrypted email included, HD wallet included.
Premium ($5/month, payable in crypto): 500 daily syncs, 50 MB storage, encrypted file attachments. Pay with BTC, XMR, SOL, USDC, or 300+ other coins via NOWPayments. Subscriptions stack — repeat payments extend your expiry date.

All encryption, vault, email, and wallet features are free and unlimited. Premium gates cloud convenience features only — security is never paywalled.

Website: https://nodezero.top
Contact: https://nodezero.top/contact

### Category
Productivity

### Language
English

---

## Privacy Practices (Data Use Disclosures)

### Single Purpose Description
NodeZero is a password manager, email encryption tool, and HD wallet that encrypts all data locally, with optional encrypted cloud sync.

### Does your extension collect or use data?
Yes — but all data is encrypted locally before any transmission.

### Data Type: Personally Identifiable Information
- [ ] Not collected

### Data Type: Health Information
- [ ] Not collected

### Data Type: Financial and Payment Information
- [x] Collected
- Usage: Functionality (the extension derives HD wallet addresses from the user's recovery phrase to display balances and sign transactions; wallet private keys are derived locally and never transmitted)
- Transmitted off device: Yes (signed transactions are broadcast to public blockchain networks; balance queries are sent to public RPC endpoints and the Blockstream API)
- Is the data encrypted in transit? Yes (HTTPS to RPC endpoints)
- Is the data encrypted at rest? Yes (wallet keys are derived on-demand from the encrypted vault and never persisted separately)
- Can users request deletion? Yes (wallet data is derived, not stored; removing the extension removes all local state)

### Data Type: Authentication Information
- [x] Collected
- Usage: Functionality (the extension stores encrypted login credentials)
- Transmitted off device: Yes (encrypted vault blob to Cloudflare R2 for cross-device sync)
- Is the data encrypted in transit? Yes
- Is the data encrypted at rest? Yes
- Can users request deletion? Yes (by removing the extension or using vault settings)

### Data Type: Personal Communications
- [x] Collected
- Usage: Functionality (the extension encrypts email body content end-to-end for Gmail; only SHA-256 hashes of email addresses and encrypted ciphertext are transmitted)
- Transmitted off device: Yes (encrypted email ciphertext embedded in Gmail compose; SHA-256 email hashes sent to lookup service)
- Is the data encrypted in transit? Yes
- Is the data encrypted at rest? Yes (server stores only opaque hashes and public keys — never plaintext addresses or content)
- Can users request deletion? Yes (by unlinking email via extension settings)

### Data Type: Location
- [ ] Not collected

### Data Type: Web History
- [ ] Not collected

### Data Type: User Activity
- [ ] Not collected

### Certifications
- [x] I certify that data is not sold to third parties
- [x] I certify that data is not used for purposes unrelated to the item's single purpose
- [x] I certify that data is not used for creditworthiness or lending

---

## Permission Justifications

### `storage`
**Purpose:** Store the user's encrypted vault, DID identity (encrypted at rest), extension settings, theme preference, and sync state in chrome.storage.local. No plaintext credential data is stored.

### `contextMenus`
**Purpose:** Register a "NodeZero" right-click context menu with actions for credential management (Fill credentials, Generate password, Save this login, Open NodeZero) and encrypted email (Link email to identity, Encrypt for recipients, Decrypt email). This is the primary interaction model — users right-click on form fields or Gmail compose windows to trigger actions.

### `idle`
**Purpose:** Detect when the user has been idle for 10 minutes and automatically lock the vault. This clears the decrypted session from memory to prevent unauthorized access if the user steps away.

### `activeTab`
**Purpose:** Access the currently active tab to inject credentials when the user explicitly requests a fill action (via context menu or popup). Only triggered by deliberate user action — never automatic.

### `scripting`
**Purpose:** Inject the content script on-demand when the user triggers a fill or save action via the context menu. The content script reads form fields and injects credentials. It performs zero cryptographic operations — all crypto runs in the background service worker.

### `tabs`
**Purpose:** Query the active tab's URL and title to pre-populate the entry editor when saving a new credential, and to match existing credentials for the fill picker. Only reads tab metadata — never reads page content without user action.

### `sidePanel`
**Purpose:** NodeZero uses the Chrome side panel API (Chrome 114+) for two purposes: (1) as an alternative to the popup, giving users a persistent, full-height view of their vault alongside their browsing — toggled in settings; (2) during WebAuthn/Windows Hello ceremonies that steal focus and would close the popup, the extension temporarily opens the side panel so the authentication ceremony can complete without interruption.

### `optional_host_permissions: *://mail.google.com/*`
**Purpose:** Declared as optional — requested at runtime only when the user first triggers an email encryption action (Link email, Encrypt, or Decrypt) from the context menu. Once granted, the extension auto-injects its content script on Gmail pages for the auto-decrypt MutationObserver. No background scanning or automatic injection occurs on non-Gmail sites. This permission is never requested automatically — only after an explicit user gesture. Credential fill on other sites uses activeTab (no host permission required).

### `alarms`
**Purpose:** Periodic health check every 30 minutes to maintain the blind-signature token pool. Ensures tokens are automatically refilled when the pool drops below threshold, so sync and email lookups work reliably without manual intervention. Also handles auto-lock scheduling as a fallback for the idle API.

---

## Privacy Policy URL
https://nodezero.top/privacy

---

## Homepage URL
https://nodezero.top

---

## Support URL
https://nodezero.top/contact
