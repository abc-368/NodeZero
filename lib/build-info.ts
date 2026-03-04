/**
 * Build-time constants injected by Vite (see wxt.config.ts).
 *
 * __GIT_HASH__ is the 7-char git short hash at build time.
 * Displayed in the TokenCounter footer for commit traceability.
 */

declare const __GIT_HASH__: string;

export const BUILD_HASH: string = typeof __GIT_HASH__ !== 'undefined' ? __GIT_HASH__ : 'dev';
