/**
 * CBOR codec — thin wrapper over cbor-x.
 *
 * All vault CBOR serialization flows through this module.
 * To swap the underlying library (e.g. @ipld/dag-cbor, hand-rolled encoder),
 * change only this file.
 */
import { encode, decode } from 'cbor-x';

export const cborEncode = (value: unknown): Uint8Array => encode(value);
export const cborDecode = (bytes: Uint8Array): unknown => decode(bytes);
