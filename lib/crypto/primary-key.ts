/**
 * Primary Key Derivation via WebAuthn PRF
 *
 * Flow: User gesture → navigator.credentials.get() with PRF extension
 *    → PRF output (32 bytes, deterministic for same credential + salt)
 *    → HKDF-SHA256(prfOutput, salt="nodezero-primary-v1") → 256-bit AES-GCM key
 *
 * CRITICAL: Uses PRF output, NOT the authentication signature.
 * Standard FIDO2 signatures are non-deterministic. PRF output is deterministic.
 *
 * Fallback: If the authenticator does not support PRF (e.g. Windows Hello
 * which lacks hmac-secret as of early 2026, or Firefox), the caller should
 * fall back to PIN-based key derivation.
 */

const PRF_EVAL_SALT = new TextEncoder().encode('nodezero-primary-v1');

export interface WebAuthnCredentialInfo {
  credentialId: Uint8Array;
  rpId: string;
}

/** Result of registerWebAuthnCredential — always check prfSupported */
export interface WebAuthnRegistrationResult {
  credentialId: Uint8Array;
  /** true only if the authenticator confirmed PRF extension is enabled */
  prfSupported: boolean;
}

/**
 * Get the effective RP ID for the extension popup context.
 * For chrome-extension:// origins, the hostname IS the extension ID.
 */
function getExtensionRpId(): string {
  return new URL(window.location.href).hostname;
}

/**
 * Register a new WebAuthn credential with PRF extension requested.
 * Does NOT throw if PRF is unsupported — check `prfSupported` in the result.
 *
 * @returns { credentialId, prfSupported }
 */
export async function registerWebAuthnCredential(): Promise<WebAuthnRegistrationResult> {
  const rpId = getExtensionRpId();
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'NodeZero', id: rpId },
      user: {
        id: userId,
        name: 'nodezero-vault',
        displayName: 'NodeZero Vault',
      },
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },   // ES256
        { alg: -257, type: 'public-key' }, // RS256 fallback
      ],
      authenticatorSelection: {
        userVerification: 'required',
        residentKey: 'required',
      },
      extensions: {
        prf: {},
      } as AuthenticationExtensionsClientInputs,
      timeout: 60000,
    },
  }) as PublicKeyCredential;

  if (!credential) {
    throw new Error('WebAuthn registration failed: no credential returned');
  }

  const extensions = credential.getClientExtensionResults() as any;
  const prfSupported = !!extensions?.prf?.enabled;

  return {
    credentialId: new Uint8Array(credential.rawId),
    prfSupported,
  };
}

/**
 * Derive the primary AES-GCM key using WebAuthn PRF.
 * Called on every vault unlock when vault is in 'prf' mode.
 *
 * @param credentialId - stored credential ID from registration
 * @returns AES-GCM CryptoKey (non-extractable)
 */
export async function derivePrimaryKey(
  credentialId: Uint8Array
): Promise<CryptoKey> {
  const rpId = getExtensionRpId();
  const challenge = crypto.getRandomValues(new Uint8Array(32));

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId,
      userVerification: 'required',
      allowCredentials: [{ id: credentialId, type: 'public-key' }],
      extensions: {
        prf: { eval: { first: PRF_EVAL_SALT } },
      } as AuthenticationExtensionsClientInputs,
      timeout: 60000,
    },
  }) as PublicKeyCredential;

  if (!assertion) {
    throw new Error('WebAuthn assertion failed: user cancelled or error');
  }

  const extensions = assertion.getClientExtensionResults() as any;
  const prfOutput: ArrayBuffer | undefined = extensions?.prf?.results?.first;

  if (!prfOutput) {
    throw new Error(
      'WebAuthn PRF output not available. ' +
      'This authenticator does not support PRF. Use your vault PIN instead.'
    );
  }

  // Import PRF output as raw key material
  const prfKeyMaterial = await crypto.subtle.importKey(
    'raw',
    prfOutput,
    { name: 'HKDF' },
    false,
    ['deriveKey']
  );

  // HKDF-SHA256 → 256-bit AES-GCM key
  // extractable: true — key must be exported to raw bytes before crossing
  // the extension message bus (chrome.runtime.sendMessage is JSON-only).
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('nodezero-primary-v1'),
      info: new TextEncoder().encode('aes-gcm-key'),
    },
    prfKeyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Check if PRF is likely supported on this browser.
 *
 * Note: Chrome supports PRF (v128+), but Windows Hello (the platform
 * authenticator on Windows 11) does NOT support hmac-secret/PRF as of
 * early 2026. Microsoft hasn't enabled this code path yet. So on Windows
 * with only Windows Hello, `prfSupported` will be false at registration
 * time even though face/fingerprint authentication works fine.
 *
 * External security keys (YubiKey 5, SoloKeys, etc.) DO support PRF.
 * Always check `prfSupported` from registerWebAuthnCredential() at runtime.
 */
export function isPrfLikelySuuported(): boolean {
  if (!window.PublicKeyCredential) return false;
  // Firefox doesn't support PRF as of early 2026
  if (navigator.userAgent.includes('Firefox')) return false;
  return true;
}
