/**
 * KDF Web Worker — runs PBKDF2 off the main thread.
 *
 * The 2M-iteration PBKDF2 takes ~30s on modern hardware. Running it in a
 * Web Worker prevents the extension popup from freezing.
 *
 * Messages in:
 *   { type: 'derive', mnemonic: string, didSalt: string }
 *   { type: 'benchmark' }
 *
 * Messages out:
 *   { type: 'progress', message: string }
 *   { type: 'done', keyMaterial: ArrayBuffer }  (raw AES key bytes, exportable for transfer)
 *   { type: 'benchmarkResult', estimatedMs: number }
 *   { type: 'error', message: string }
 */

import { deriveRecoveryKey, benchmarkPbkdf2 } from '@/lib/crypto/recovery-key';

export default defineUnlistedScript(() => {
  self.onmessage = async (event: MessageEvent) => {
    const { type } = event.data;

    if (type === 'derive') {
      const { mnemonic, didSalt } = event.data as { type: string; mnemonic: string; didSalt: string };

      try {
        self.postMessage({ type: 'progress', message: 'Deriving key (this takes ~30s)…' });

        const key = await deriveRecoveryKey(mnemonic, didSalt);

        // Export the key so it can be transferred back to the main thread.
        // The key was derived with extractable: true specifically for this.
        const rawKey = await crypto.subtle.exportKey('raw', key);

        // Zero-out the mnemonic in memory after derivation
        const mnemonicArray = mnemonic.split(' ');
        for (let i = 0; i < mnemonicArray.length; i++) {
          mnemonicArray[i] = '';
        }

        self.postMessage({ type: 'done', keyMaterial: rawKey }, [rawKey]);
      } catch (err: any) {
        self.postMessage({ type: 'error', message: err?.message ?? 'Unknown error' });
      }
    } else if (type === 'benchmark') {
      try {
        const estimatedMs = await benchmarkPbkdf2();
        self.postMessage({ type: 'benchmarkResult', estimatedMs });
      } catch (err: any) {
        self.postMessage({ type: 'error', message: err?.message ?? 'Benchmark failed' });
      }
    }
  };
});
