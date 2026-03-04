/**
 * Passkey Intercept Content Script (MAIN world)
 *
 * Wraps navigator.credentials.create() to capture WebAuthn registration
 * responses. When a site registers a new passkey, we intercept the response
 * (after it succeeds), extract the credential metadata, and relay it to
 * the background service worker for storage as a vault entry + VC.
 *
 * The private key NEVER leaves the authenticator — we only capture public
 * metadata (credential ID, public key, RP info, AAGUID).
 *
 * Communication flow:
 *   page calls navigator.credentials.create() → our wrapper lets it through
 *   → on success, posts NODEZERO_PASSKEY_REGISTERED → ISOLATED bridge
 *   → chrome.runtime.sendMessage → background → vault entry created
 *
 * Security:
 * - We do NOT modify the registration request or response
 * - We do NOT block or delay the original WebAuthn ceremony
 * - The content script only reads public metadata from the response
 * - All sensitive operations happen in the background service worker
 */

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',

  main() {
    // Avoid double-wrapping
    if ((window as any).__nodezero_passkey_intercepted) return;
    (window as any).__nodezero_passkey_intercepted = true;

    const originalCreate = navigator.credentials.create.bind(navigator.credentials);

    navigator.credentials.create = async function (
      options?: CredentialCreationOptions,
    ): Promise<Credential | null> {
      // Pass through non-WebAuthn requests (e.g. password credentials)
      if (!options?.publicKey) {
        return originalCreate(options);
      }

      // Let the original ceremony proceed unmodified
      const credential = await originalCreate(options);

      // Only intercept PublicKeyCredential responses
      if (credential && credential.type === 'public-key') {
        try {
          const pkCred = credential as PublicKeyCredential;
          const response = pkCred.response as AuthenticatorAttestationResponse;

          // Extract public metadata
          const publicKeyBytes = response.getPublicKey?.();
          const publicKeyAlgorithm = response.getPublicKeyAlgorithm?.() ?? -7;
          const transports = response.getTransports?.() ?? [];

          const rpId = options.publicKey!.rp?.id ?? window.location.hostname;
          const rpName = options.publicKey!.rp?.name ?? window.location.hostname;

          // Convert ArrayBuffers to base64url for message passing
          const payload = {
            credentialId: arrayBufferToBase64Url(pkCred.rawId),
            publicKey: publicKeyBytes
              ? arrayBufferToBase64Url(publicKeyBytes)
              : '',
            publicKeyAlgorithm,
            rpId,
            rpName,
            origin: window.location.origin,
            transports: transports.length > 0 ? transports : undefined,
            attestationObject: arrayBufferToBase64Url(response.attestationObject),
            clientDataJSON: arrayBufferToBase64Url(response.clientDataJSON),
          };

          // Relay to ISOLATED bridge (non-blocking)
          window.postMessage({
            type: 'NODEZERO_PASSKEY_REGISTERED',
            payload,
          }, '*');
        } catch {
          // Never interfere with the original credential creation
        }
      }

      return credential;
    };

    function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
      const bytes = new Uint8Array(buffer);
      const base64 = btoa(String.fromCharCode(...bytes));
      return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    }
  },
});
