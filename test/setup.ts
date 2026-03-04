/**
 * Vitest global setup — polyfills for Node.js test environment.
 *
 * Provides Web Crypto API and browser globals that the extension
 * code depends on, so tests can run in plain Node.js.
 */

import { webcrypto } from 'crypto';

// Web Crypto polyfill (Node 18+ has it globally, but explicitly set for safety)
if (!globalThis.crypto || !globalThis.crypto.subtle) {
  // @ts-expect-error — webcrypto types differ slightly from browser Crypto
  globalThis.crypto = webcrypto;
}

// btoa / atob are available in Node 16+ natively, but polyfill just in case
if (typeof globalThis.btoa === 'undefined') {
  globalThis.btoa = (str: string) => Buffer.from(str, 'binary').toString('base64');
}
if (typeof globalThis.atob === 'undefined') {
  globalThis.atob = (b64: string) => Buffer.from(b64, 'base64').toString('binary');
}
