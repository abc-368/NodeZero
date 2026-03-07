/**
 * BIP-39 Mnemonic generation, verification, and secure memory wiping.
 *
 * Security invariant: The full mnemonic must exist in memory ONLY during
 * onboarding verification. After the 3-word challenge passes, all in-memory
 * references must be zeroed and nulled.
 *
 * Uses @scure/bip39 — an audited, minimal implementation.
 */

import { generateMnemonic, validateMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

export const MNEMONIC_WORD_COUNT = 12;
export const VERIFY_WORD_COUNT = 3; // number of words user must confirm

/**
 * Generate a fresh 12-word BIP-39 mnemonic.
 * Returns the mnemonic as a string array for display.
 */
export function generateVaultMnemonic(): string[] {
  // 128-bit entropy → 12 words
  const mnemonic = generateMnemonic(wordlist, 128);
  return mnemonic.split(' ');
}

/**
 * Validate a mnemonic string (space-separated or array).
 */
export function isValidMnemonic(input: string | string[]): boolean {
  const phrase = Array.isArray(input) ? input.join(' ') : input;
  return validateMnemonic(phrase.trim(), wordlist);
}

/**
 * Join mnemonic words into a canonical phrase string.
 */
export function joinMnemonic(words: string[]): string {
  return words.join(' ');
}

/**
 * Pick N random word indices for the verification challenge.
 * Returns an array of 0-based indices, sorted ascending.
 */
export function pickVerifyIndices(
  wordCount: number = MNEMONIC_WORD_COUNT,
  verifyCount: number = VERIFY_WORD_COUNT
): number[] {
  const indices = Array.from({ length: wordCount }, (_, i) => i);
  // Fisher-Yates shuffle then take first verifyCount
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, verifyCount).sort((a, b) => a - b);
}

/**
 * Securely wipe a mnemonic words array in place.
 * Zero-fills each character slot, then sets length to 0.
 *
 * MUST be called in useEffect cleanup during onboarding.
 */
export function wipeMnemonic(words: string[]): void {
  for (let i = 0; i < words.length; i++) {
    // Overwrite string reference (JS strings are immutable, but we can
    // at least null the slot to remove the reference)
    words[i] = '\x00'.repeat(words[i].length);
    words[i] = '';
  }
  words.length = 0;
}

/**
 * Securely wipe a Uint8Array by overwriting with zeros.
 */
export function wipeBuffer(buf: Uint8Array): void {
  buf.fill(0);
}

/**
 * Check if a word is in the BIP-39 wordlist.
 */
export function isValidWord(word: string): boolean {
  return wordlist.includes(word.toLowerCase().trim());
}

/**
 * Get BIP-39 wordlist autocomplete suggestions for a partial word.
 */
export function getWordSuggestions(partial: string, limit = 5): string[] {
  if (!partial || partial.length < 2) return [];
  const lower = partial.toLowerCase();
  return wordlist.filter(w => w.startsWith(lower)).slice(0, limit);
}
