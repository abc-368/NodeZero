/**
 * Per-field AES-GCM encryption (ADR-006)
 *
 * Each credential field (username, password, url, notes) is individually
 * encrypted with a fresh 96-bit nonce. This enables:
 * - Partial re-keying (rotate key without re-encrypting all fields)
 * - Granular sharing (share username without sharing password)
 * - Efficient sync (only re-upload changed fields)
 *
 * Wire format: [12 bytes nonce][N bytes ciphertext+tag]
 */

const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_TAG_BITS = 128;

/**
 * Encrypt a plaintext string field with AES-GCM.
 *
 * @param plaintext - the field value to encrypt
 * @param key       - AES-GCM CryptoKey (from primary or recovery derivation)
 * @param aad       - optional additional authenticated data (e.g. entry ID + field name)
 * @returns Uint8Array: [12-byte nonce || ciphertext+tag]
 */
export async function encryptField(
  plaintext: string,
  key: CryptoKey,
  aad?: string
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
  const enc = new TextEncoder();
  const plaintextBytes = enc.encode(plaintext);

  const additionalData = aad ? enc.encode(aad) : undefined;

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      tagLength: AES_GCM_TAG_BITS,
      ...(additionalData ? { additionalData } : {}),
    },
    key,
    plaintextBytes
  );

  // Prepend nonce to ciphertext
  const result = new Uint8Array(AES_GCM_NONCE_BYTES + ciphertext.byteLength);
  result.set(nonce, 0);
  result.set(new Uint8Array(ciphertext), AES_GCM_NONCE_BYTES);
  return result;
}

/**
 * Decrypt a field encrypted with encryptField.
 *
 * @param cipherBytes - [12-byte nonce || ciphertext+tag]
 * @param key         - AES-GCM CryptoKey
 * @param aad         - must match the AAD used during encryption
 * @returns decrypted plaintext string
 */
export async function decryptField(
  cipherBytes: Uint8Array,
  key: CryptoKey,
  aad?: string
): Promise<string> {
  if (cipherBytes.length < AES_GCM_NONCE_BYTES) {
    throw new Error('Ciphertext too short: missing nonce');
  }

  const nonce = cipherBytes.slice(0, AES_GCM_NONCE_BYTES);
  const ciphertext = cipherBytes.slice(AES_GCM_NONCE_BYTES);
  const enc = new TextEncoder();
  const additionalData = aad ? enc.encode(aad) : undefined;

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        tagLength: AES_GCM_TAG_BITS,
        ...(additionalData ? { additionalData } : {}),
      },
      key,
      ciphertext
    );
  } catch {
    throw new Error('Field decryption failed: wrong key or corrupted data');
  }

  return new TextDecoder().decode(plaintext);
}

/**
 * Encrypt a set of fields for a vault entry.
 * Returns a map of field name → encrypted bytes (base64-encoded for JSON storage).
 */
export async function encryptFields(
  fields: Record<string, string>,
  key: CryptoKey,
  entryId: string
): Promise<Record<string, string>> {
  const encrypted: Record<string, string> = {};
  for (const [fieldName, value] of Object.entries(fields)) {
    if (!value) continue; // skip empty fields
    const aad = `${entryId}:${fieldName}`;
    const cipherBytes = await encryptField(value, key, aad);
    encrypted[fieldName] = bufferToBase64(cipherBytes);
  }
  return encrypted;
}

/**
 * Decrypt a set of encrypted fields for a vault entry.
 */
export async function decryptFields(
  encryptedFields: Record<string, string>,
  key: CryptoKey,
  entryId: string
): Promise<Record<string, string>> {
  const decrypted: Record<string, string> = {};
  for (const [fieldName, b64] of Object.entries(encryptedFields)) {
    const aad = `${entryId}:${fieldName}`;
    const cipherBytes = base64ToBuffer(b64);
    decrypted[fieldName] = await decryptField(cipherBytes, key, aad);
  }
  return decrypted;
}

// ── Key transport helpers ────────────────────────────────────────────────────

/**
 * Import raw AES-GCM key bytes as a usable CryptoKey.
 *
 * chrome.runtime.sendMessage uses JSON serialization — CryptoKey objects
 * become {} in transit.  The solution is to export the key to raw bytes in
 * the popup, pass the bytes (base64) in the message payload, and re-import
 * here in the background service worker.
 */
export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM', length: 256 },
    false,                      // non-extractable once inside the background
    ['encrypt', 'decrypt']
  );
}

// ── Encoding helpers ────────────────────────────────────────────────────────

export function bufferToBase64(buffer: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary);
}

export function base64ToBuffer(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bufferToHex(buffer: Uint8Array): string {
  return Array.from(buffer)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBuffer(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
