/**
 * email/gmail-selectors.ts — Gmail DOM selectors and encrypted message markers
 *
 * Constants and helpers for interacting with Gmail's DOM structure.
 * Used by the content script to extract/inject email content.
 */

// ── Gmail DOM selectors ──────────────────────────────────────────────────────

/** Selectors for finding the logged-in user's email address */
export const USER_EMAIL_SELECTORS = [
  '[data-email]',
  'a[href*="accounts.google.com"][title]',
] as const;

/** Compose window: the editable message body */
export const COMPOSE_BODY_SELECTOR =
  'div[aria-label="Message Body"][contenteditable="true"]';

/** Compose window: "To" recipients input field */
export const TO_FIELD_SELECTOR = 'input[aria-label="To recipients"]';

/** Read view: the message body container */
export const MESSAGE_BODY_SELECTOR = 'div.a3s.aiL';

// ── Encrypted message markers ────────────────────────────────────────────────
// These markers wrap the base64-encoded encrypted blob in the email body.
// They are designed to be human-visible ("this message is encrypted") and
// machine-parseable for the decrypt flow.
//
// v1 (legacy single-recipient) and v2 (multi-recipient) use the same
// end marker but different start markers. The decrypt flow checks for both.

export const MARKER_START_V1 = '---NODEZERO-v1---';
export const MARKER_START_V2 = '---NODEZERO-v2---';
export const MARKER_END = '---/NODEZERO---';

// Keep v1 alias for backward compatibility
export const MARKER_START = MARKER_START_V1;

/**
 * Wrap a base64-encoded encrypted blob with markers for display in an email.
 * The result replaces the compose body before sending.
 *
 * @param blobBase64 - the encrypted blob
 * @param recipientCount - number of recipients (determines v1 vs v2 marker)
 */
export function formatEncryptedMessage(
  blobBase64: string,
  recipientCount: number = 1,
): string {
  const marker = recipientCount > 1 ? MARKER_START_V2 : MARKER_START_V1;
  const recipientLabel = recipientCount > 1
    ? `${recipientCount} recipients need`
    : 'The recipient needs';

  return [
    `🔒 This message is encrypted with NodeZero.`,
    `${recipientLabel} the NodeZero extension to decrypt it.`,
    '',
    marker,
    blobBase64,
    MARKER_END,
  ].join('\n');
}

/**
 * Extract the encrypted blob from a message body that contains markers.
 * Supports both v1 and v2 markers.
 * Returns null if no valid markers are found.
 */
export function extractEncryptedBlob(bodyText: string): string | null {
  // Try v2 marker first, then v1
  let startIdx = bodyText.indexOf(MARKER_START_V2);
  let markerLen = MARKER_START_V2.length;

  if (startIdx === -1) {
    startIdx = bodyText.indexOf(MARKER_START_V1);
    markerLen = MARKER_START_V1.length;
  }

  const endIdx = bodyText.indexOf(MARKER_END);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }

  // Extract text between markers, trim whitespace
  const blob = bodyText
    .slice(startIdx + markerLen, endIdx)
    .trim();

  // Basic validation: should be non-empty base64
  if (!blob || !/^[A-Za-z0-9+/=\s]+$/.test(blob)) {
    return null;
  }

  // Remove any whitespace that Gmail may have inserted
  return blob.replace(/\s/g, '');
}
