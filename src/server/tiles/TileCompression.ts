import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { TilePackCorruptError } from '../../world/tiling/TilePackContract';

export function sha256Hex(data: Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function deflateTilePayload(rawBytes: Uint8Array, level = 6): Uint8Array {
  const compressed = zlib.deflateSync(rawBytes, { level });
  return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
}

export function inflateTilePayload(
  compressedBytes: Uint8Array,
  tileKeyHint = 'unknown'
): Uint8Array {
  try {
    const inflated = zlib.inflateSync(compressedBytes);
    return new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
  } catch (err: unknown) {
    throw new TilePackCorruptError(
      `Failed to inflate tile payload (${err instanceof Error ? err.message : String(err)})`,
      tileKeyHint,
      'inflate_failed'
    );
  }
}
