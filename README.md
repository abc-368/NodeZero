<p align="center">
  <img src="public/icon/icon.svg" width="80" alt="NodeZero" />
</p>

<h1 align="center">NodeZero</h1>

<p align="center">
  <strong>Your Keys. Your Vault. No Central Server.</strong><br/>
  A decentralized password manager with end-to-end encrypted email, built as a lightweight browser extension.
</p>

<p align="center">
  <a href="https://www.nodezero.top">Website</a> &nbsp;·&nbsp;
  <a href="https://chromewebstore.google.com/detail/nodezero/beecpjkkjgmnmpjjmilphcchppabgcgf">Chrome Web Store</a> &nbsp;·&nbsp;
  <a href="https://github.com/abc-368/NodeZero/issues">Issues</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License" />
  <img src="https://img.shields.io/badge/platform-Chrome%20%7C%20Edge%20%7C%20Brave-green" alt="Platform" />
  <img src="https://img.shields.io/badge/bundle-~688%20kB-orange" alt="Bundle size" />
</p>

---

## Why NodeZero?

Every major password manager stores your vault on their servers. When they get breached — [and they do](https://blog.lastpass.com/posts/2022/12/notice-of-recent-security-incident) — millions of encrypted vaults land in attackers' hands, giving them unlimited time to crack master passwords offline.

NodeZero takes a fundamentally different approach: **you are your own auth server**. There is no central vault database, no master password to crack, and no company that can be compelled to hand over your data.

### How it compares

| | LastPass / 1Password | Bitwarden | **NodeZero** |
|---|---|---|---|
| **Vault storage** | Company servers | Company servers (or self-hosted) | **User-controlled encrypted blob** — no central database |
| **Unlock method** | Master password | Master password | **Hardware security key (WebAuthn PRF)** or device PIN — no password to phish |
| **Encryption scope** | Single-blob AES | Single-blob AES | **Field-level AES-GCM** — each field encrypted with a unique random IV |
| **Metadata protection** | URLs & timestamps in plaintext | URLs in plaintext | **All credential fields encrypted** — no plaintext metadata |
| **Sync privacy** | Server sees every sync event | Server sees every sync event | **Blind-signature tokens** — sync events are cryptographically unlinkable |
| **Recovery model** | Email/SMS recovery (backdoor) | Email-based recovery | **12-word mnemonic** — deterministic, no backdoor, user-controlled |
| **Account required?** | Yes | Yes | **No** — identity is a decentralized DID derived from your recovery phrase |
| **Email encryption** | None | None | **End-to-end encrypted email overlay for Gmail** — X25519 ECDH, multi-recipient |
| **Extension size** | 10+ MB | 4+ MB | **~688 kB** — minimal attack surface |
| **Security paywall** | MFA behind premium | Mostly free | **All security features are free** — pay only for convenience |

---

## Core Architecture

### Two-Tier Vault

NodeZero encrypts your credentials across two parallel vaults, synced as a single encrypted bundle:

**Primary Vault** — for daily use:
- Unlocked via **WebAuthn PRF** (YubiKey, SoloKeys, Titan, Feitian) or a **device PIN**
- PRF provides a deterministic hardware-bound secret — not a signature, not a password
- **Biometric unlock** via Windows Hello or Touch ID — wraps the vault key in a credential-bound envelope, unwrapped on successful biometric scan
- PIN fallback uses PBKDF2 (200K iterations) for devices without PRF support

**Recovery Vault** — for lost-device scenarios:
- Unlocked via your **12-word BIP-39 mnemonic**
- Deliberately slow KDF (PBKDF2, 2M iterations, ~30 seconds) as brute-force protection
- KDF runs in a Web Worker so the UI never freezes

Both vaults use **field-level AES-GCM encryption** — username, password, and notes are each encrypted with independent random IVs. There is no single encryption key that decrypts everything.

### Self-Sovereign Identity (DID)

Your identity is a `did:key` derived deterministically from your recovery phrase:

```
mnemonic → BIP-39 seed → HKDF-SHA256 → Ed25519 keypair → did:key
```

- No account creation, no email, no phone number
- Your DID is your vault address — only you can derive it from the mnemonic
- Every vault upload is signed with your Ed25519 private key — the server verifies the signature before accepting

### Anonymous Sync (Blind Signature Tokens)

Most password managers track exactly when and how often you sync. NodeZero uses **Chaumian blind signatures** to decouple sync metering from your identity:

1. **Issuance** (authenticated): Your extension requests tokens from the server, signed with your DID. The server knows your identity at this point.
2. **Blinding** (client-side): Tokens are cryptographically blinded before signing — the server signs them without seeing the actual token values.
3. **Redemption** (anonymous): When syncing, the extension redeems a token with **no identifying headers**. The server can verify the token is legitimate but cannot link it back to the issuance request.

The result: the server cannot build a profile of your sync frequency or patterns. This is verifiable by auditing the open-source code.

### Cross-Device Sync & Merge

- Encrypted vault blob stored on Cloudflare R2 (one object per user, overwritten in place)
- Local caching eliminates redundant downloads — only fetches when the remote vault has changed
- **Per-entry Last-Write-Wins (LWW)** merge with tombstone-based deletion tracking
- Smart sync detects concurrent edits from multiple devices and merges automatically
- Optimistic concurrency with conflict retry (up to 3 attempts)

### Cross-Device Recovery

Lost your device? On a new browser:

1. Enter your 12-word recovery phrase
2. NodeZero derives your DID and downloads your encrypted vault
3. Slow KDF (~30 seconds) derives the recovery key
4. Vault decrypts — set a new PIN and you're back in business

No email reset. No support ticket. No backdoor. Just cryptography.

---

## Features

### Encrypted Email for Gmail

NodeZero adds transparent end-to-end encryption on top of Gmail. Both sender and recipients must have NodeZero installed.

- **Encrypt**: right-click in a Gmail compose window → NodeZero → Encrypt for recipients
- **Decrypt**: right-click on a received encrypted message → NodeZero → Decrypt email
- **Auto-decrypt**: grant the optional Gmail permission (prompted on first use) and incoming encrypted emails are decrypted automatically as you read them
- **Link email**: right-click on any Gmail page → NodeZero → Link this email to my identity — registers a SHA-256 hash of your address so others can encrypt to you (free, 0 tokens)
- **Multi-recipient**: encrypts for all To/CC/BCC recipients with per-recipient X25519 ECDH key wrapping and forward secrecy (fresh ephemeral keypair per message)
- **Self-encrypt**: sender is automatically included so you can decrypt from your Sent folder
- **All-or-nothing**: if any recipient is not enrolled, the message stays plaintext — no partial encryption
- **Privacy**: the server stores only SHA-256 hashes of email addresses mapped to public keys — it never sees addresses or content
- **Caching**: email-hash-to-DID lookups are cached locally for 24 hours (clearable from settings) — repeat messages to the same recipients cost zero tokens

### Security
- **Hardware-backed unlock** — WebAuthn PRF with YubiKey, SoloKeys, Titan, Feitian, and other FIDO2 security keys
- **Biometric unlock** — Windows Hello / Touch ID wraps the vault key in a credential-bound envelope
- **Field-level encryption** — AES-GCM with unique random IVs per field, per entry
- **Ed25519 vault signing** — tamper detection before decryption
- **Auto-lock** — session cleared after idle timeout
- **No stored master password** — key material exists in memory only while unlocked
- **Authenticated downloads** — vault blob requires DID signature to retrieve
- **Save Vault to File** — export your encrypted vault to a local `.bin` backup at any time (AES-256-GCM CBOR, useless without recovery phrase)
- **GPM crash guard** — warns before accidental Google Password Manager saves that could expose plaintext

### Privacy
- **Blind-signature sync metering** — anonymous, unlinkable token redemption (Chaumian RSA-PSS blind signatures via Web Crypto API)
- **No account creation** — identity is a DID derived from your mnemonic
- **No trackers or cookies** — zero telemetry in the extension
- **Open source** — every security claim is auditable (AGPL-3.0)

### Usability
- **Context menu integration** — right-click → Fill credentials, Generate password, Save login, plus email encryption actions on Gmail
- **Domain-matched fill picker** — shows matching entries with favicon, title, and last-updated timestamp; includes copy-to-clipboard fallback for non-standard forms
- **One-click password generation** — configurable length, character sets
- **CSV import** — drag-and-drop from LastPass, 1Password, Bitwarden, or Chrome; round-trip export also supported
- **Vault search & grouping** — filter by domain or login, virtualized for 1000+ entries
- **Dark mode** — system-aware theme switching

---

## Installation

### Chrome Web Store

**[Install NodeZero from the Chrome Web Store](https://chromewebstore.google.com/detail/nodezero/beecpjkkjgmnmpjjmilphcchppabgcgf)** — works on Chrome, Edge, Brave, and other Chromium browsers.

### Build from Source

```bash
git clone https://github.com/abc-368/NodeZero.git
cd NodeZero
npm install
npm run build        # → .output/chrome-mv3/
```

Then load the extension:
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `.output/chrome-mv3/` folder

### Firefox

```bash
npm run build:firefox    # → .output/firefox-mv3/
```

---

## Usage

1. **Click the NodeZero icon** in the toolbar to open the vault
2. **First time?** The onboarding wizard walks you through:
   - Registering a security key (PRF) or setting a PIN
   - Writing down your 12-word recovery phrase
   - Verifying 3 words to confirm you saved it
3. **Save a login**: Right-click on any page → NodeZero → Save this login
4. **Fill credentials**: Right-click on a login form → NodeZero → Fill credentials
5. **Generate a password**: Right-click on a password field → NodeZero → Generate password
6. **Import existing passwords**: Open vault → Settings → Import (CSV drag-and-drop)

---

## Security Model

### What's encrypted

| Field | Primary Vault | Recovery Vault |
|-------|:---:|:---:|
| Username | AES-GCM | AES-GCM |
| Password | AES-GCM | AES-GCM |
| Notes | AES-GCM | AES-GCM |
| Title | Plaintext | Plaintext |
| URL | Plaintext | Plaintext |
| Tags | Plaintext | Plaintext |

Title, URL, and tags are stored as plaintext metadata to enable search without decryption. They do not contain secrets.

### Key derivation

| Path | Algorithm | Iterations | Purpose |
|------|-----------|-----------|---------|
| WebAuthn PRF | HKDF-SHA256 | N/A (hardware) | Daily unlock (security key) |
| PIN | PBKDF2-SHA256 | 200,000 | Daily unlock (fallback) |
| Recovery | PBKDF2-SHA256 | 2,000,000 | Lost-device recovery (~30s) |

### What the server never sees

- Your plaintext credentials (field-level encrypted before upload)
- Your encryption keys (derived locally from PRF output, PIN, or mnemonic)
- Your sync patterns (blind-signature tokens make redemption unlinkable)
- Your recovery phrase (never leaves your device after onboarding)

---

## Pricing

| | Free | Premium ($5/mo) |
|---|---|---|
| Passwords | Unlimited | Unlimited |
| Hardware-backed unlock | ✓ | ✓ |
| Field-level encryption | ✓ | ✓ |
| Recovery phrase | ✓ | ✓ |
| CSV import / export | ✓ | ✓ |
| Cross-device sync | ✓ | ✓ |
| Daily syncs | 100 | 500 |
| Storage | 2 MB | 50 MB |
| Encrypted attachments | — | ✓ |
| Secure sharing | — | ✓ |

**No security feature is paywalled.** Encryption, hardware keys, recovery, and sync are free. Pro adds convenience and higher limits.

---

## Tech Stack

| Component | Choice |
|-----------|--------|
| Extension framework | [WXT](https://wxt.dev/) (React + TypeScript + Vite) |
| UI | [shadcn/ui](https://ui.shadcn.com/) + Tailwind CSS |
| Encryption | Web Crypto API (AES-GCM, PBKDF2, HKDF) |
| Identity | Ed25519 `did:key` via native WebCrypto |
| Mnemonic | [@scure/bip39](https://github.com/paulmillr/scure-bip39) (audited) |
| Signing | [@noble/curves](https://github.com/paulmillr/noble-curves) (audited) |
| Vault format | CBOR ([cbor-x](https://github.com/nicknisi/cbor-x)) |
| Blind signatures | Native Web Crypto RSA-PSS (zero dependencies) |

---

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

```bash
npm run dev          # Chrome with HMR
npm run test         # Run tests
npm run build        # Production build
```

---

## License

[AGPL-3.0](LICENSE) — source must be disclosed for derivative works.

This project includes code ported from [Padloc](https://github.com/padloc/padloc) (AGPL-3.0): entry type definitions, CSV importers, and password generator logic.

Built on [WXT + React + shadcn boilerplate](https://github.com/imtiger/wxt-react-shadcn-tailwindcss-chrome-extension) (MIT).

Cryptographic libraries by [paulmillr](https://github.com/paulmillr) (@scure/bip39, @noble/curves, @noble/hashes) — independently audited.
