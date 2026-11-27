import {
  computeFoliagePrototypeUnionLocalBoundsArray,
  isFoliagePrototypeKind,
} from '../FoliageLodSystem';
import { buildInstancedSpatialIndexData } from '../InstancedSpatialIndex';
import {
  decodeTileBinaryCompact,
  isCompactDecodedTilePayload,
  type AnyDecodedTilePayload,
} from './CompactTileTransport';
import { decodeTileBinary } from './TileBinaryCodec';
import {
  OSMTILE1_MAGIC,
  UNIT_SLEEPER_BOX_LOCAL_BOUNDS,
  type DecodedTilePayload,
} from './TilePackContract';
import {
  nowEpochMs,
  resolveTilePreparationOptions,
  type TilePreparationOptions,
} from './TilePreparationConfig';
import type { TileMemoryFootprint } from './TileStreamManager';

export interface TileDecodeWorkerRequest {
  requestId: number;
  tileKey: string;
  buffer: ArrayBuffer;
  options?: Partial<TilePreparationOptions>;
  mainPostMessageEpochMs?: number;
}

export interface TileDecodeWorkerTimingsPayload {
  usedCompactTransport: boolean;
  transferAllTypedArrays: boolean;
  workerInstanceBvhEnabled: boolean;
  workerQueueWaitMs: number;
  workerInflateMs?: number;
  workerDecodeOnlyMs?: number;
  workerInflateAndDecodeMs: number;
  workerBvhBuildMs: number;
  workerPayloadPrepMs: number;
  workerPostMessageStartEpochMs: number;
  workerTotalBeforePostMessageMs: number;
  transferableBufferCount: number;
  transferableBytes: number;
  workerBvhBatchCount: number;
  workerBvhInstanceCount: number;
}

export interface TileDecodeWorkerSuccessResponse {
  requestId: number;
  tileKey: string;
  ok: true;
  decoded: AnyDecodedTilePayload;
  decodeDurationMs: number;
  workerTimings: TileDecodeWorkerTimingsPayload;
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
 * Extracts all unique underlying `ArrayBuffer` instances from a decoded tile payload
 * (legacy or compact) so a Web Worker can transfer them to the main thread zero-copy.
 *
 * When `transferAllTypedArrays` is `true` (default), includes `instanceFeatureIdxs`,
 * worker-prepared BVH typed arrays, and compact metadata buffers (`featureTable`,
 * `packedGroups`, `packedFaceRanges`, `sleeperBoxFloats`, `sleeperBoxTrackStrIdxs`).
 * When `false`, reproduces the pre-TKT-040 baseline transfer list for A/B benchmarking.
 */
export function collectTileTransferables(
  decoded: AnyDecodedTilePayload,
  options?: { transferAllTypedArrays?: boolean }
): { transferables: ArrayBuffer[]; totalBytes: number } {
  const includeAll = options?.transferAllTypedArrays !== false;
  const seen = new Set<ArrayBuffer>();
  let totalBytes = 0;

  const addBuffer = (buf: ArrayBufferLike | null | undefined): void => {
    if (buf instanceof ArrayBuffer && buf.byteLength > 0 && !seen.has(buf)) {
      seen.add(buf);
      totalBytes += buf.byteLength;
    }
  };

  const addView = (view: ArrayBufferView | null | undefined): void => {
    if (!view) return;
    addBuffer(view.buffer);
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
        addBuffer(root);
      }
      addView(mesh.bvh.indirectBuffer);
    }
  }

  for (const batch of decoded.instancedBatches) {
    addView(batch.matrices);
    addView(batch.instanceColors);
    if (includeAll) {
      addView(batch.instanceFeatureIdxs);
      if (batch.preparedSpatialIndex) {
        addView(batch.preparedSpatialIndex.nodeBounds);
        addView(batch.preparedSpatialIndex.nodeMeta);
        addView(batch.preparedSpatialIndex.sortedInstanceIds);
        addView(batch.preparedSpatialIndex.instanceBounds);
      }
    }
  }

  if (includeAll && isCompactDecodedTilePayload(decoded)) {
    addView(decoded.featureTable.strings.bytes);
    addView(decoded.featureTable.strings.offsets);
    addView(decoded.featureTable.featureBytes);
    addView(decoded.featureTable.featureOffsets);
    addView(decoded.packedGroups);
    addView(decoded.packedFaceRanges);
    for (const batch of decoded.instancedBatches) {
      addView(batch.sleeperBoxFloats);
      addView(batch.sleeperBoxTrackStrIdxs);
    }
  }

  return {
    transferables: Array.from(seen),
    totalBytes,
  };
}

/**
 * Convenience wrapper returning only the deduplicated `ArrayBuffer[]` transfer list.
 */
export function collectDecodedTileTransferables(
  decoded: AnyDecodedTilePayload,
  transferAllTypedArrays = true
): ArrayBuffer[] {
  return collectTileTransferables(decoded, { transferAllTypedArrays }).transferables;
}

function computeLegacyTileMemoryFootprint(
  decoded: DecodedTilePayload
): TileMemoryFootprint {
  let cpuGeometryBytes = 0;
  let bvhBytes = 0;
  let meshCount = 0;
  let bvhCount = 0;
  for (const m of decoded.meshes) {
    if (m.layer !== 'ground') {
      meshCount += 1;
    }
    cpuGeometryBytes += m.positions.byteLength;
    cpuGeometryBytes += m.normals?.byteLength ?? 0;
    cpuGeometryBytes += m.uvs?.byteLength ?? 0;
    cpuGeometryBytes += m.switchAttrs?.byteLength ?? 0;
    cpuGeometryBytes += m.colors?.byteLength ?? 0;
    cpuGeometryBytes += m.indices?.byteLength ?? 0;
    if (m.bvh) {
      bvhCount += 1;
      for (const root of m.bvh.roots) {
        bvhBytes += root.byteLength;
      }
      bvhBytes += m.bvh.indirectBuffer?.byteLength ?? 0;
    }
  }
  for (const b of decoded.instancedBatches) {
    meshCount += 1;
    cpuGeometryBytes += b.matrices.byteLength;
    cpuGeometryBytes += b.instanceColors?.byteLength ?? 0;
    if (b.preparedSpatialIndex) {
      bvhBytes += b.preparedSpatialIndex.estimatedMemoryBytes;
    }
  }
  return {
    cpuGeometryBytes,
    bvhBytes,
    meshCount,
    instancedBatchCount: decoded.instancedBatches.length,
    bvhCount,
    triangleCount: decoded.totalTriangles,
    vertexCount: decoded.totalVertices,
  };
}

export interface WorkerTilePreparationResult {
  decoded: AnyDecodedTilePayload;
  transferables: ArrayBuffer[];
  transferableBytes: number;
  decodeOnlyMs: number;
  workerBvhBuildMs: number;
  workerPayloadPrepMs: number;
  workerBvhBatchCount: number;
  workerBvhInstanceCount: number;
  options: TilePreparationOptions;
}

/**
 * Pure, worker-safe tile preparation pipeline shared by `TileDecodeWorker` and
 * unit tests / inline fallback. Decodes `OSMTILE1` v1 bytes (compact or legacy),
 * optionally builds `InstancedSpatialIndex` BVHs off the main thread, and collects
 * deduplicated transferable `ArrayBuffer`s.
 */
export function prepareTileInWorker(
  rawBytes: Uint8Array,
  tileKey: string,
  optionsInput?: Partial<TilePreparationOptions>,
  builtInWorker = true
): WorkerTilePreparationResult {
  const options = resolveTilePreparationOptions(optionsInput);

  const tDecode0 = performance.now();
  const decoded: AnyDecodedTilePayload = options.compactMetadataTransport
    ? decodeTileBinaryCompact(rawBytes, tileKey)
    : decodeTileBinary(rawBytes, tileKey);
  const decodeOnlyMs = performance.now() - tDecode0;

  let workerBvhBuildMs = 0;
  let workerBvhBatchCount = 0;
  let workerBvhInstanceCount = 0;

  if (options.workerInstanceBvh && decoded.instancedBatches.length > 0) {
    const tBvh0 = performance.now();
    let extraBvhBytes = 0;
    for (const batch of decoded.instancedBatches) {
      if (batch.instanceCount <= 0) {
        batch.preparedSpatialIndex = null;
        continue;
      }
      const protoLocalBounds = isFoliagePrototypeKind(batch.prototypeKind)
        ? computeFoliagePrototypeUnionLocalBoundsArray(batch.prototypeKind)
        : UNIT_SLEEPER_BOX_LOCAL_BOUNDS;
      const prepared = buildInstancedSpatialIndexData(
        batch.matrices,
        batch.instanceCount,
        protoLocalBounds,
        { builtInWorker }
      );
      batch.preparedSpatialIndex = prepared;
      workerBvhBatchCount += 1;
      workerBvhInstanceCount += prepared.instanceCount;
      extraBvhBytes += prepared.estimatedMemoryBytes;
    }
    if (isCompactDecodedTilePayload(decoded)) {
      decoded.precomputedFootprint.bvhBytes += extraBvhBytes;
    }
    workerBvhBuildMs = performance.now() - tBvh0;
  }

  const tPrep0 = performance.now();
  if (!isCompactDecodedTilePayload(decoded) && options.optimizeMainThreadPrep) {
    decoded.precomputedFootprint = computeLegacyTileMemoryFootprint(decoded);
  }
  const { transferables, totalBytes } = collectTileTransferables(decoded, {
    transferAllTypedArrays: options.transferAllTypedArrays,
  });
  const workerPayloadPrepMs = performance.now() - tPrep0;

  return {
    decoded,
    transferables,
    transferableBytes: totalBytes,
    decodeOnlyMs,
    workerBvhBuildMs,
    workerPayloadPrepMs,
    workerBvhBatchCount,
    workerBvhInstanceCount,
    options,
  };
}

function hasOmsTileMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < OSMTILE1_MAGIC.length) return false;
  for (let i = 0; i < OSMTILE1_MAGIC.length; i++) {
    if (bytes[i] !== OSMTILE1_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

export async function ensureRawOmsTileBytes(buffer: ArrayBuffer): Promise<Uint8Array> {
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
  typeof self !== 'undefined'
    ? (self as unknown as {
        onmessage: ((event: MessageEvent<TileDecodeWorkerRequest>) => void) | null;
        postMessage: (
          message: TileDecodeWorkerResponse,
          transfer?: Transferable[]
        ) => void;
      })
    : null;

if (
  workerScope &&
  typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !==
    'undefined'
) {
  workerScope.onmessage = async (
    event: MessageEvent<TileDecodeWorkerRequest>
  ) => {
    const entryEpochMs = nowEpochMs();
    const t0 = performance.now();
    const { requestId, tileKey, buffer, options, mainPostMessageEpochMs } =
      event.data;
    const workerQueueWaitMs =
      typeof mainPostMessageEpochMs === 'number' &&
      Number.isFinite(mainPostMessageEpochMs)
        ? Math.max(0, entryEpochMs - mainPostMessageEpochMs)
        : 0;

    try {
      const tInflate0 = performance.now();
      const rawBytes = await ensureRawOmsTileBytes(buffer);
      const inflateMs = performance.now() - tInflate0;

      const prep = prepareTileInWorker(rawBytes, tileKey, options, true);
      const workerInflateAndDecodeMs = inflateMs + prep.decodeOnlyMs;
      const workerTotalBeforePostMessageMs = performance.now() - t0;
      const workerPostMessageStartEpochMs = nowEpochMs();

      const response: TileDecodeWorkerSuccessResponse = {
        requestId,
        tileKey,
        ok: true,
        decoded: prep.decoded,
        decodeDurationMs: workerTotalBeforePostMessageMs,
        workerTimings: {
          usedCompactTransport: prep.options.compactMetadataTransport,
          transferAllTypedArrays: prep.options.transferAllTypedArrays,
          workerInstanceBvhEnabled: prep.options.workerInstanceBvh,
          workerQueueWaitMs: Number(workerQueueWaitMs.toFixed(3)),
          workerInflateMs: Number(inflateMs.toFixed(3)),
          workerDecodeOnlyMs: Number(prep.decodeOnlyMs.toFixed(3)),
          workerInflateAndDecodeMs: Number(workerInflateAndDecodeMs.toFixed(3)),
          workerBvhBuildMs: Number(prep.workerBvhBuildMs.toFixed(3)),
          workerPayloadPrepMs: Number(prep.workerPayloadPrepMs.toFixed(3)),
          workerPostMessageStartEpochMs,
          workerTotalBeforePostMessageMs: Number(
            workerTotalBeforePostMessageMs.toFixed(3)
          ),
          transferableBufferCount: prep.transferables.length,
          transferableBytes: prep.transferableBytes,
          workerBvhBatchCount: prep.workerBvhBatchCount,
          workerBvhInstanceCount: prep.workerBvhInstanceCount,
        },
      };
      // IMPORTANT: Never access any transferred buffer after postMessage().
      workerScope.postMessage(response, prep.transferables);
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
