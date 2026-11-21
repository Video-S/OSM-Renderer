import { decodeTileBinary } from './TileBinaryCodec';
import {
  OSMTILE1_MAGIC,
  type DecodedTilePayload,
} from './TilePackContract';

export interface TileDecodeWorkerRequest {
  requestId: number;
  tileKey: string;
  buffer: ArrayBuffer;
}

export interface TileDecodeWorkerSuccessResponse {
  requestId: number;
  tileKey: string;
  ok: true;
  decoded: DecodedTilePayload;
  decodeDurationMs: number;
}

export interface TileDecodeWorkerErrorResponse {
  requestId: number;
  tileKey: string;
  ok: false;
  error: string;
}

export type TileDecodeWorkerResponse =
  | TileDecodeWorkerSuccessResponse
  | TileDecodeWorkerErrorResponse;

/**
 * Extracts all unique underlying `ArrayBuffer` instances from a `DecodedTilePayload`
 * so a Web Worker can transfer them back to the main thread with zero copy.
 */
export function collectDecodedTileTransferables(
  decoded: DecodedTilePayload
): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  const addView = (
    view: ArrayBufferView | null | undefined
  ): void => {
    if (!view) return;
    const buf = view.buffer;
    if (buf instanceof ArrayBuffer && buf.byteLength > 0) {
      seen.add(buf);
    }
  };

  for (const mesh of decoded.meshes) {
    addView(mesh.positions);
    addView(mesh.normals);
    addView(mesh.uvs);
    addView(mesh.switchAttrs);
    addView(mesh.colors);
    addView(mesh.indices);
    if (mesh.bvh) {
      for (const root of mesh.bvh.roots) {
        if (root instanceof ArrayBuffer && root.byteLength > 0) {
          seen.add(root);
        }
      }
      addView(mesh.bvh.indirectBuffer);
    }
  }

  for (const batch of decoded.instancedBatches) {
    addView(batch.matrices);
    addView(batch.instanceColors);
  }

  return Array.from(seen);
}

function hasOmsTileMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < OSMTILE1_MAGIC.length) return false;
  for (let i = 0; i < OSMTILE1_MAGIC.length; i++) {
    if (bytes[i] !== OSMTILE1_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

async function ensureRawOmsTileBytes(buffer: ArrayBuffer): Promise<Uint8Array> {
  const bytes = new Uint8Array(buffer);
  if (hasOmsTileMagic(bytes)) {
    return bytes;
  }
  if (typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    await writer.write(bytes);
    await writer.close();
    const inflatedBuffer = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(inflatedBuffer);
  }
  return bytes;
}

const workerScope =
  typeof self !== 'undefined' ? (self as unknown as {
    onmessage: ((event: MessageEvent<TileDecodeWorkerRequest>) => void) | null;
    postMessage: (message: TileDecodeWorkerResponse, transfer?: Transferable[]) => void;
  }) : null;

if (
  workerScope &&
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined'
) {
  workerScope.onmessage = async (
    event: MessageEvent<TileDecodeWorkerRequest>
  ) => {
    const { requestId, tileKey, buffer } = event.data;
    const t0 = performance.now();
    try {
      const rawBytes = await ensureRawOmsTileBytes(buffer);
      // Copy typed arrays out of the single source buffer if needed so each transferred
      // buffer is standalone, or transfer the shared backing ArrayBuffer once.
      const decoded = decodeTileBinary(rawBytes, tileKey);
      const transferables = collectDecodedTileTransferables(decoded);
      const decodeDurationMs = performance.now() - t0;
      const response: TileDecodeWorkerSuccessResponse = {
        requestId,
        tileKey,
        ok: true,
        decoded,
        decodeDurationMs,
      };
      workerScope.postMessage(response, transferables);
    } catch (err) {
      const response: TileDecodeWorkerErrorResponse = {
        requestId,
        tileKey,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      workerScope.postMessage(response);
    }
  };
}
