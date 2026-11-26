import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  CANONICAL_HENGELO_SNAPSHOT_ID,
  CANONICAL_HENGELO_SOURCE_SHA256,
  BAKE_SCHEMA_VERSION,
  DEFAULT_PROJECTION_ID,
  OSMTILE1_FORMAT_VERSION,
  TILE_MESH_FLAG_HAS_BVH,
  TILE_MESH_FLAG_VISIBLE,
  TILE_PAYLOAD_FLAG_HAS_BVH,
  computeLodPolicyHash,
  type DecodedTilePayload,
  type TileManifestEntry,
} from './tiling/TilePackContract';
import {
  buildTileLocalBvh,
  decodeTileBinary,
  encodeDecodedTilePayloadToBinary,
} from './tiling/TileBinaryCodec';
import { deflateTilePayload, inflateTilePayload } from '../server/tiles/TileCompression';
import { TileStreamManager } from './tiling/TileStreamManager';
import { StreamingProfiler } from './tiling/StreamingProfiler';
import {
  assessObservedRefreshCadence,
  attributeWorstFrames,
  classifyScenarioCacheBehavior,
  computeStreamingFrameDistribution,
  summarizeStageTimings,
  utmToLocalTarget,
  verifyFrameStageNesting,
} from './tiling/StreamingFluidityStats';
import {
  buildTrajectoryPoseAtElapsedMs,
  formatStreamingFluidityMarkdown,
  parseStreamingFluidityCli,
  type StreamingFluidityBenchmarkReport,
} from '../../benchmarks/streamingFluidityRunner';
import type { TilePackManifestPayload } from './tiling/TileStreamManager';

import type { InspectableFeatureInfo } from '../types/MapFeature';

function createSyntheticTileForProfilerTest(
  tx: number,
  ty: number,
  tileSizeMeters = 1024
): DecodedTilePayload {
  const half = tileSizeMeters * 0.5;
  const g = new THREE.BoxGeometry(12, 8, 12);
  g.translate(0, 4, 0);
  const positions = new Float32Array(g.attributes.position.array as Float32Array);
  const normals = new Float32Array(g.attributes.normal.array as Float32Array);
  const uvs = new Float32Array(g.attributes.uv.array as Float32Array);
  const indices = new Uint16Array(g.index!.array as Uint16Array);
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const triCount = indices.length / 3;
  g.dispose();

  const bvh = buildTileLocalBvh(positions, indices);

  const count = 16;
  const matrices = new Float32Array(count * 16);
  const featureIdxs = new Int32Array(count);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    dummy.position.set((i % 4) * 30 - 45, 0, Math.floor(i / 4) * 30 - 45);
    dummy.updateMatrix();
    dummy.matrix.toArray(matrices, i * 16);
    featureIdxs[i] = 1;
  }

  const featureInfos: InspectableFeatureInfo[] = [
    {
      id: `way/bldg-${tx}-${ty}`,
      sourceFeatureId: `way/bldg-${tx}-${ty}`,
      category: 'Building',
      cartoLabel: 'Residential Building',
      primaryTag: 'building=yes',
      subtype: 'residential',
      name: 'Synthetic Building',
      osmTags: { building: 'yes' },
    },
    {
      id: `way/forest-${tx}-${ty}`,
      sourceFeatureId: `way/forest-${tx}-${ty}`,
      category: 'Terrain & Nature',
      cartoLabel: 'Broadleaf Forest',
      primaryTag: 'natural=wood',
      subtype: 'wood',
      name: 'Synthetic Forest',
      osmTags: { natural: 'wood' },
    },
  ];

  return {
    formatVersion: OSMTILE1_FORMAT_VERSION,
    lod: 0,
    tx,
    ty,
    tileSizeMeters,
    tileCenterX: (tx + 0.5) * tileSizeMeters,
    tileCenterZ: (ty + 0.5) * tileSizeMeters,
    overhangBoundsMin: [-half, 0, -half],
    overhangBoundsMax: [half, 20, half],
    totalTriangles: triCount,
    totalVertices: positions.length / 3,
    totalDrawCalls: 2,
    renderedFeaturesCount: featureInfos.length,
    forestTreesCount: count,
    sleeper3DBoxCount: 0,
    railwayRenderSource: 'graph-R+',
    flags: TILE_PAYLOAD_FLAG_HAS_BVH,
    meshes: [
      {
        layer: 'buildings',
        name: `Building_Tile_${tx}_${ty}`,
        materialSlotKeys: ['building:wall:default'],
        renderOrder: 0,
        flags: TILE_MESH_FLAG_VISIBLE | TILE_MESH_FLAG_HAS_BVH,
        localPositionOffset: [0, 0, 0],
        bboxMin: [bb.min.x, bb.min.y, bb.min.z],
        bboxMax: [bb.max.x, bb.max.y, bb.max.z],
        positions,
        normals,
        uvs,
        switchAttrs: null,
        colors: null,
        indices,
        groups: [{ start: 0, count: indices.length, materialIndex: 0 }],
        faceRanges: [{ startFace: 0, endFace: triCount - 1, infoIdx: 0 }],
        singleFeatureIdx: 0,
        bvh,
      },
    ],
    instancedBatches: [
      {
        layer: 'foliage',
        name: 'ProceduralForest_BroadleavedCanopy',
        materialSlotKey: 'foliage:broadleaved',
        prototypeKind: 'tree_broadleaved',
        renderOrder: 0,
        flags: TILE_MESH_FLAG_VISIBLE,
        bboxMin: [-half, 0, -half],
        bboxMax: [half, 20, half],
        instanceCount: count,
        matrices,
        instanceColors: null,
        instanceFeatureIdxs: featureIdxs,
        sleeperBoxes: null,
      },
    ],
    featureInfos,
    byteLength: 0,
  };
}

test('computeStreamingFrameDistribution computes p99.9, all 5 budget thresholds, and slow-frame streaks', () => {
  // 1000 samples: mostly 6.8 ms with a streak of 3 frames > 16.67ms and 1 major hitch 58ms
  const samples: number[] = Array(1000).fill(6.8);
  samples[10] = 8.5;
  samples[20] = 14.2;
  samples[50] = 19.4;
  samples[51] = 35.1;
  samples[52] = 58.2;
  samples[90] = 22.0;

  const dist = computeStreamingFrameDistribution(samples);
  assert.equal(dist.sampleCount, 1000);
  assert.equal(dist.median, 6.8);
  assert.equal(dist.max, 58.2);
  assert.ok(dist.p999 >= 35.1, `Expected p99.9 >= 35.1, got ${dist.p999}`);
  assert.equal(dist.thresholdExceedances.length, 5);

  const over6 = dist.thresholdExceedances.find((t) => t.thresholdMs === 6.94)!;
  const over13 = dist.thresholdExceedances.find((t) => t.thresholdMs === 13.89)!;
  const over16 = dist.thresholdExceedances.find((t) => t.thresholdMs === 16.67)!;
  const over33 = dist.thresholdExceedances.find((t) => t.thresholdMs === 33.33)!;
  const over50 = dist.thresholdExceedances.find((t) => t.thresholdMs === 50)!;

  assert.equal(over6.count, 6);
  assert.equal(over6.maxConsecutiveFrames, 3);
  assert.equal(over13.count, 5);
  assert.equal(over16.count, 4);
  assert.equal(over16.maxConsecutiveFrames, 3);
  assert.equal(over33.count, 2);
  assert.equal(over33.maxConsecutiveFrames, 2);
  assert.equal(over50.count, 1);
  assert.equal(over50.maxConsecutiveFrames, 1);
});

test('assessObservedRefreshCadence distinguishes VSync cadence vs workload stalls vs software rasterizer', () => {
  const steady60 = assessObservedRefreshCadence({
    frameIntervalsMs: Array(60).fill(16.67),
    cpuRenderMs: Array(60).fill(1.4),
    syncMainThreadMs: Array(60).fill(2.0),
    isSoftwareRenderer: false,
  });
  assert.equal(steady60.classification, 'refresh_limited_steady');
  assert.ok(steady60.estimatedRefreshHz >= 59 && steady60.estimatedRefreshHz <= 61);

  const stalls144 = assessObservedRefreshCadence({
    frameIntervalsMs: [...Array(98).fill(6.94), 28.4, 42.1],
    cpuRenderMs: [...Array(98).fill(1.2), 18.0, 29.0],
    syncMainThreadMs: [...Array(98).fill(1.8), 26.0, 39.0],
    isSoftwareRenderer: false,
    stationaryReferenceMedianMs: 6.94,
  });
  assert.equal(stalls144.classification, 'workload_induced_stalls');

  const sw = assessObservedRefreshCadence({
    frameIntervalsMs: Array(20).fill(45.0),
    cpuRenderMs: Array(20).fill(41.0),
    syncMainThreadMs: Array(20).fill(43.0),
    isSoftwareRenderer: true,
  });
  assert.equal(sw.classification, 'software_rasterizer_limited');
});

test('StreamingProfiler enforces disabled zero-op fast path, bounded ring drops, Raycaster wrap lifecycle, and non-double-counted nesting', () => {
  const profiler = new StreamingProfiler({
    maxFrames: 4,
    maxEvents: 3,
    installBrowserObservers: false,
    instrumentRaycaster: true,
  });

  // Disabled state: zero samples recorded and Raycaster untouched
  const origIntersectObjects = THREE.Raycaster.prototype.intersectObjects;
  profiler.recordCameraUseFrame({
    totalMs: 1.5,
    controlsUpdateMs: 0.4,
    frustumMs: 0.2,
    orientationCallbackMs: 0.1,
  });
  profiler.recordEvent({
    eventType: 'fetch_start',
    tileKey: '0:0',
    tileSizeMeters: 1024,
    lod: 0,
    queueDepths: { queued: 0, fetching: 1, decoding: 0, readyToCommit: 0, loaded: 0, visible: 0 },
  });
  assert.equal(
    profiler.finishRenderFrame({
      frameTimestampMs: 100,
      frameIntervalMs: 16.6,
      glRenderCpuMs: 2.0,
      renderCalls: 10,
      renderTriangles: 100,
      driverGeometries: 5,
      driverTextures: 1,
      driverPrograms: 1,
      gpuTimerQuerySupported: false,
      gpuTimerStatus: 'unsupported',
      gpuDisjointOccurred: false,
      gpuPassTimeMs: null,
    }),
    null
  );
  assert.equal(profiler.getSnapshot().totalFramesRecorded, 0);
  assert.equal(THREE.Raycaster.prototype.intersectObjects, origIntersectObjects);

  // Enabled state: wraps Raycaster and enforces bounded ring capacity
  profiler.setEnabled(true, 'unit_test');
  assert.notEqual(THREE.Raycaster.prototype.intersectObjects, origIntersectObjects);

  const rc = new THREE.Raycaster();
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshBasicMaterial()
  );
  rc.set(new THREE.Vector3(0.3, 5, 0.2), new THREE.Vector3(0, -1, 0));
  const hits = rc.intersectObjects([box], false);
  assert.equal(hits.length, 1);

  for (let i = 0; i < 6; i++) {
    profiler.recordCameraUseFrame({
      totalMs: 1.2,
      controlsUpdateMs: 0.5,
      frustumMs: 0.3,
      orientationCallbackMs: 0.2,
    });
    profiler.recordViewportBoundsDuration(0.3, 0.2);
    profiler.recordViewportUpdate({
      totalMs: 1.4,
      tileScanMs: 0.6,
      cancelInFlightMs: 0.1,
      evictDisposeMs: 0.3,
      evictRebuildStatsMs: 0.1,
      evictEmitDiagnosticsMs: 0.1,
      pumpFetchQueueMs: 0.1,
      tilesEvictedCount: 1,
      tilesCancelledCount: 0,
    });
    profiler.recordStreamTick({
      totalMs: 4.5,
      readyScanAndSortMs: 0.2,
      reconstructMs: 3.0,
      instancedBvhBuildMs: 1.4,
      staticBvhDeserializeMs: 0.8,
      sceneAttachMs: 0.6,
      commitRebuildStatsMs: 0.4,
      commitEmitDiagnosticsMs: 0.3,
      tilesCommittedCount: 1,
    });
    profiler.recordMapSceneUseFrame({
      totalMs: 7.5, // includes 0.5 bounds + 1.4 viewport + 4.5 tick + 0.4 zoom + 0.2 hud + 0.5 other
      shadowFollowMs: 0.3,
      zoomPropagationMs: 0.4,
      viewportFrameUpdateMs: 6.4,
      railwayIndexRebuildMs: 0.1,
      telemetryHudMs: 0.2,
    });
    profiler.recordReactCommit(0.5);
    profiler.markBeforeGlRender(10);
    const frame = profiler.finishRenderFrame({
      frameTimestampMs: 1000 + i * 16.6,
      frameIntervalMs: 16.6,
      glRenderCpuMs: 2.1,
      renderCalls: 25,
      renderTriangles: 5000,
      driverGeometries: 12,
      driverTextures: 2,
      driverPrograms: 3,
      gpuTimerQuerySupported: false,
      gpuTimerStatus: 'unsupported',
      gpuDisjointOccurred: false,
      gpuPassTimeMs: null,
    });
    assert.ok(frame);
    const nesting = verifyFrameStageNesting(frame);
    assert.equal(
      nesting.valid,
      true,
      `Nesting invariant failed: ${nesting.violations.join('; ')}`
    );

    profiler.recordEvent({
      eventType: 'fetch_start',
      tileKey: `${i}:0`,
      tileSizeMeters: 1024,
      lod: 0,
      queueDepths: { queued: 0, fetching: 1, decoding: 0, readyToCommit: 0, loaded: i, visible: 1 },
    });
  }

  const snap = profiler.getSnapshot();
  assert.equal(snap.totalFramesRecorded, 6);
  assert.equal(snap.droppedFramesCount, 2);
  assert.equal(snap.frames.length, 4);
  assert.equal(snap.totalEventsRecorded, 6);
  assert.equal(snap.droppedEventsCount, 3);
  assert.equal(snap.events.length, 3);

  profiler.setEnabled(false);
  assert.equal(THREE.Raycaster.prototype.intersectObjects, origIntersectObjects);
  box.geometry.dispose();
  (box.material as THREE.Material).dispose();
  profiler.dispose();
});

test('TileStreamManager + StreamingProfiler records complete streaming lifecycle events, compressed/raw sizes, BVH timings, eviction, and cancellation', async () => {
  const tile0 = createSyntheticTileForProfilerTest(0, 0, 1024);
  const tile1 = createSyntheticTileForProfilerTest(1, 0, 1024);
  const tile2 = createSyntheticTileForProfilerTest(5, 0, 1024); // outside keep radius later for cancel

  const encodeCompressed = (p: DecodedTilePayload) => {
    const rawBin = encodeDecodedTilePayloadToBinary(p);
    return deflateTilePayload(rawBin);
  };
  const payloadsByCoord = new Map<string, Uint8Array>([
    ['0:0', encodeCompressed(tile0)],
    ['1:0', encodeCompressed(tile1)],
    ['5:0', encodeCompressed(tile2)],
  ]);

  const originE = 350000;
  const originN = 5800000;
  const makeEntry = (p: DecodedTilePayload): TileManifestEntry => {
    const cx = originE + p.tileCenterX;
    const cz = originN - p.tileCenterZ;
    const compBytes = payloadsByCoord.get(`${p.tx}:${p.ty}`)!.byteLength;
    return {
      lod: 0,
      tx: p.tx,
      ty: p.ty,
      minEasting: cx - p.tileSizeMeters * 0.5,
      maxEasting: cx + p.tileSizeMeters * 0.5,
      minNorthing: cz - p.tileSizeMeters * 0.5,
      maxNorthing: cz + p.tileSizeMeters * 0.5,
      tileCenterX: p.tileCenterX,
      tileCenterZ: p.tileCenterZ,
      overhangMinX: p.overhangBoundsMin[0],
      overhangMaxX: p.overhangBoundsMax[0],
      overhangMinY: p.overhangBoundsMin[1],
      overhangMaxY: p.overhangBoundsMax[1],
      overhangMinZ: p.overhangBoundsMin[2],
      overhangMaxZ: p.overhangBoundsMax[2],
      triCount: p.totalTriangles,
      vertexCount: p.totalVertices,
      featureCount: p.featureInfos.length,
      isEmpty: false,
      hasBvh: true,
      rawBytes: compBytes * 2,
      compressedBytes: compBytes,
      contentHash: '0'.repeat(64),
    };
  };

  const manifest: TilePackManifestPayload = {
    available: true,
    packPath: 'synthetic/mosaic.json',
    metadata: {
      snapshotId: CANONICAL_HENGELO_SNAPSHOT_ID,
      sourceSha256: CANONICAL_HENGELO_SOURCE_SHA256,
      projectionId: DEFAULT_PROJECTION_ID,
      bakeSchemaVersion: BAKE_SCHEMA_VERSION,
      lodPolicyHash: computeLodPolicyHash({
        projectionId: DEFAULT_PROJECTION_ID,
        tileSizeMeters: 1024,
        collarMeters: 64,
        lod: 0,
        includeBvh: true,
      }),
      compression: 'deflate',
      tileSizeMeters: 1024,
      collarMeters: 64,
      studyOriginEasting: originE,
      studyOriginNorthing: originN,
      gridCols: 6,
      gridRows: 1,
      minTx: 0,
      maxTx: 5,
      minTy: 0,
      maxTy: 0,
      bakeStatus: 'complete',
      createdAtIso: new Date().toISOString(),
      completedAtIso: new Date().toISOString(),
    },
    tiles: [makeEntry(tile0), makeEntry(tile1), makeEntry(tile2)],
  };

  const profiler = new StreamingProfiler({
    installBrowserObservers: false,
    instrumentRaycaster: false,
  });
  profiler.setEnabled(true, 'stream_lifecycle');

  let delayTile5 = true;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const match = url.match(/\/0\/(-?\d+)\/(-?\d+)/);
    const coord = match ? `${match[1]}:${match[2]}` : '';
    const compressed = payloadsByCoord.get(coord);
    if (!compressed) {
      return new Response('Not found', { status: 404 });
    }
    if (coord === '5:0' && delayTile5) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 60);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const abortErr = new Error('Aborted');
          abortErr.name = 'AbortError';
          reject(abortErr);
        });
      });
    }
    const copy = compressed.slice();
    return new Response(copy.buffer, { status: 200 });
  };

  const manager = new TileStreamManager({
    apiBaseUrl: '/api/tiles-test',
    preloadMarginTiles: 0,
    retainMarginTiles: 0.2,
    fetchFn,
    decodeClient: {
      decodeTile: async (buf) => {
        const raw = inflateTilePayload(new Uint8Array(buf));
        return {
          decoded: decodeTileBinary(raw),
          decodeDurationMs: 1.1,
          usedWebWorker: false,
        };
      },
      dispose: () => {},
    } as any,
    profiler,
  });

  await manager.initialize(manifest);

  // Viewport around tile 0:0 (centerX=512, centerZ=512)
  manager.updateViewport({ minX: 200, maxX: 800, minZ: 200, maxZ: 800, focusX: 512, focusZ: 512 });
  await manager.waitForIdle();
  profiler.markBeforeGlRender(10);
  profiler.finishRenderFrame({
    frameTimestampMs: 100,
    frameIntervalMs: 16.6,
    glRenderCpuMs: 1.5,
    renderCalls: 12,
    renderTriangles: 300,
    driverGeometries: 14,
    driverTextures: 1,
    driverPrograms: 2,
    gpuTimerQuerySupported: false,
    gpuTimerStatus: 'unsupported',
    gpuDisjointOccurred: false,
    gpuPassTimeMs: null,
  });

  // Jump far east to tile 5:0 (centerX=5632) -> evicts 0:0, starts delayed fetch 5:0
  manager.updateViewport({ minX: 5400, maxX: 5800, minZ: 200, maxZ: 800, focusX: 5632, focusZ: 512 });
  await new Promise((r) => setTimeout(r, 10));
  // Immediately jump back to tile 1:0 (centerX=1536) -> cancels 5:0 + attaches 1:0
  manager.updateViewport({ minX: 1200, maxX: 1800, minZ: 200, maxZ: 800, focusX: 1536, focusZ: 512 });
  await manager.waitForIdle();
  profiler.markBeforeGlRender(14);
  const lastFrame = profiler.finishRenderFrame({
    frameTimestampMs: 150,
    frameIntervalMs: 16.6,
    glRenderCpuMs: 1.8,
    renderCalls: 12,
    renderTriangles: 300,
    driverGeometries: 18,
    driverTextures: 1,
    driverPrograms: 2,
    gpuTimerQuerySupported: false,
    gpuTimerStatus: 'unsupported',
    gpuDisjointOccurred: false,
    gpuPassTimeMs: null,
  });

  assert.ok(lastFrame);
  assert.equal(verifyFrameStageNesting(lastFrame).valid, true);

  const snap = profiler.getSnapshot();
  const types = new Set(snap.events.map((e) => e.eventType));
  for (const required of [
    'fetch_start',
    'fetch_complete',
    'decode_start',
    'decode_complete',
    'ready_to_commit',
    'reconstruct_start',
    'reconstruct_complete',
    'attach',
    'first_rendered_use',
    'evict',
    'cancel',
  ] as const) {
    assert.ok(types.has(required), `Missing streaming event "${required}"`);
  }

  const reconEvt = snap.events.find((e) => e.eventType === 'reconstruct_complete')!;
  assert.ok((reconEvt.payloadCompressedBytes ?? 0) > 0);
  assert.ok((reconEvt.payloadRawBytes ?? 0) > 0);
  assert.ok((reconEvt.detail?.instancedBvhBuildMs ?? -1) >= 0);

  const stageSummary = summarizeStageTimings(snap.frames);
  assert.ok(stageSummary.some((s) => s.stageKey === 'streamTickMs' && s.totalMs > 0));

  manager.dispose();
  profiler.dispose();
});

test('classifyScenarioCacheBehavior strictly detects warm-cache violations, streaming activity, and reverse reuse rates', () => {
  const warmClean = classifyScenarioCacheBehavior({
    scenarioId: 'B_warm_cache_pan',
    events: [],
  });
  assert.equal(warmClean.classificationValid, true);
  assert.equal(warmClean.classification, 'warm_cache_clean');

  const warmViolated = classifyScenarioCacheBehavior({
    scenarioId: 'B_warm_cache_pan',
    events: [
      {
        seq: 1,
        timestampMs: 50,
        frameIndex: 2,
        eventType: 'fetch_start',
        tileKey: '1:0',
        tileSizeMeters: 1024,
        lod: 0,
        payloadCompressedBytes: null,
        payloadRawBytes: null,
        durationMs: null,
        queueDepths: { queued: 0, fetching: 1, decoding: 0, readyToCommit: 0, loaded: 4, visible: 2 },
      },
    ],
  });
  assert.equal(warmViolated.classificationValid, false);
  assert.equal(warmViolated.classification, 'warm_cache_violated_streaming_occurred');

  const reverse = classifyScenarioCacheBehavior({
    scenarioId: 'D_reverse_traversal',
    events: [],
    initiallyResidentTileKeys: ['0:0'],
    forwardEvents: [
      {
        seq: 1,
        timestampMs: 10,
        frameIndex: 1,
        eventType: 'attach',
        tileKey: '1:0',
        tileSizeMeters: 1024,
        lod: 0,
        payloadCompressedBytes: 100,
        payloadRawBytes: 500,
        durationMs: 2,
        queueDepths: { queued: 0, fetching: 0, decoding: 0, readyToCommit: 0, loaded: 2, visible: 2 },
      },
      {
        seq: 2,
        timestampMs: 20,
        frameIndex: 2,
        eventType: 'evict',
        tileKey: '0:0',
        tileSizeMeters: 1024,
        lod: 0,
        payloadCompressedBytes: null,
        payloadRawBytes: null,
        durationMs: 1,
        queueDepths: { queued: 0, fetching: 0, decoding: 0, readyToCommit: 0, loaded: 1, visible: 1 },
      },
    ],
    reverseEvents: [
      {
        seq: 3,
        timestampMs: 40,
        frameIndex: 4,
        eventType: 'fetch_start',
        tileKey: '0:0',
        tileSizeMeters: 1024,
        lod: 0,
        payloadCompressedBytes: null,
        payloadRawBytes: null,
        durationMs: null,
        queueDepths: { queued: 0, fetching: 1, decoding: 0, readyToCommit: 0, loaded: 1, visible: 1 },
      },
    ],
  });
  assert.equal(reverse.reverseReuseSummary?.forwardAttachedTiles, 1);
  assert.equal(reverse.reverseReuseSummary?.forwardEvictedTiles, 1);
  assert.equal(reverse.reverseReuseSummary?.reverseReusedLoadedTiles, 1);
  assert.equal(reverse.reverseReuseSummary?.reverseRefetchedTiles, 1);
  assert.equal(reverse.reverseReuseSummary?.reverseReuseHitRatePct, 50);
});

test('attributeWorstFrames separates sync vs async events, LoAFs, first-render proxies, and unattributed residual', () => {
  const frames = [
    {
      frameIndex: 1,
      rafStartMs: 100,
      frameTimestampMs: 106.9,
      frameIntervalMs: 6.9,
      cameraUseFrameMs: 0.4,
      mapSceneUseFrameOtherMs: 0.2,
      zoomPropagationMs: 0.1,
      viewportUpdateMs: 0.3,
      streamTickMs: 0.1,
      telemetryHudMs: 0.1,
      pickingRaycasterMs: 0.1,
      reactCommitMs: 0,
      glRenderCpuMs: 1.5,
      attributedSyncMainThreadMs: 2.8,
      controlsUpdateMs: 0.2,
      cameraFrustumMs: 0.1,
      cameraOrientationCallbackMs: 0.1,
      shadowFollowMs: 0.1,
      railwayIndexRebuildMs: 0,
      viewportBoundsMs: 0.1,
      zoomSyncMs: 0.05,
      tileScanMs: 0.1,
      cancelInFlightMs: 0,
      evictDisposeMs: 0,
      evictRebuildStatsMs: 0,
      evictEmitDiagnosticsMs: 0,
      pumpFetchQueueMs: 0.05,
      readyScanAndSortMs: 0.1,
      reconstructMs: 0,
      instancedBvhBuildMs: 0,
      staticBvhDeserializeMs: 0,
      sceneAttachMs: 0,
      commitRebuildStatsMs: 0,
      commitEmitDiagnosticsMs: 0,
      tilesCommittedCount: 0,
      tilesEvictedCount: 0,
      tilesCancelledCount: 0,
      pickingCallsCount: 1,
      reactCommitsCount: 0,
      newlyAttachedTilesCount: 0,
      newlyAttachedTileKeys: [],
      newlyAttachedTriangles: 0,
      newlyAttachedMeshes: 0,
      driverGeometriesBeforeRender: 10,
      driverGeometriesAfterRender: 10,
      driverGeometriesDelta: 0,
      renderCalls: 40,
      renderTriangles: 15000,
      driverGeometries: 10,
      driverTextures: 2,
      driverPrograms: 3,
      gpuTimerQuerySupported: true,
      gpuTimerStatus: 'valid' as const,
      gpuDisjointOccurred: false,
      gpuPassTimeMs: 1.1,
      cameraTargetX: 0,
      cameraTargetZ: 0,
      cameraZoom: 1.2,
      cameraAzimuthDeg: 45,
      queueDepths: { queued: 0, fetching: 0, decoding: 0, readyToCommit: 0, loaded: 4, visible: 4 },
    },
    {
      frameIndex: 2,
      rafStartMs: 107,
      frameTimestampMs: 152.9,
      frameIntervalMs: 46.0,
      cameraUseFrameMs: 0.5,
      mapSceneUseFrameOtherMs: 0.2,
      zoomPropagationMs: 0.1,
      viewportUpdateMs: 0.6,
      streamTickMs: 24.5,
      telemetryHudMs: 0.1,
      pickingRaycasterMs: 0.2,
      reactCommitMs: 0.4,
      glRenderCpuMs: 8.4,
      attributedSyncMainThreadMs: 35.0,
      controlsUpdateMs: 0.2,
      cameraFrustumMs: 0.2,
      cameraOrientationCallbackMs: 0.1,
      shadowFollowMs: 0.1,
      railwayIndexRebuildMs: 0,
      viewportBoundsMs: 0.1,
      zoomSyncMs: 0.05,
      tileScanMs: 0.3,
      cancelInFlightMs: 0,
      evictDisposeMs: 0,
      evictRebuildStatsMs: 0,
      evictEmitDiagnosticsMs: 0,
      pumpFetchQueueMs: 0.15,
      readyScanAndSortMs: 0.2,
      reconstructMs: 22.0,
      instancedBvhBuildMs: 18.2,
      staticBvhDeserializeMs: 2.1,
      sceneAttachMs: 1.1,
      commitRebuildStatsMs: 0.8,
      commitEmitDiagnosticsMs: 0.4,
      tilesCommittedCount: 1,
      tilesEvictedCount: 0,
      tilesCancelledCount: 0,
      pickingCallsCount: 1,
      reactCommitsCount: 1,
      newlyAttachedTilesCount: 1,
      newlyAttachedTileKeys: ['2:0'],
      newlyAttachedTriangles: 22000,
      newlyAttachedMeshes: 12,
      driverGeometriesBeforeRender: 10,
      driverGeometriesAfterRender: 22,
      driverGeometriesDelta: 12,
      renderCalls: 52,
      renderTriangles: 37000,
      driverGeometries: 22,
      driverTextures: 2,
      driverPrograms: 3,
      gpuTimerQuerySupported: true,
      gpuTimerStatus: 'valid' as const,
      gpuDisjointOccurred: false,
      gpuPassTimeMs: 2.3,
      cameraTargetX: 350,
      cameraTargetZ: 0,
      cameraZoom: 1.2,
      cameraAzimuthDeg: 45,
      queueDepths: { queued: 0, fetching: 0, decoding: 0, readyToCommit: 0, loaded: 5, visible: 4 },
    },
  ];

  const attributed = attributeWorstFrames({
    frames,
    events: [
      {
        seq: 1,
        timestampMs: 120,
        frameIndex: 2,
        eventType: 'decode_complete',
        tileKey: '2:0',
        tileSizeMeters: 4096,
        lod: 0,
        payloadCompressedBytes: 400000,
        payloadRawBytes: 1500000,
        durationMs: 12,
        queueDepths: { queued: 0, fetching: 0, decoding: 0, readyToCommit: 1, loaded: 4, visible: 4 },
      },
      {
        seq: 2,
        timestampMs: 144,
        frameIndex: 2,
        eventType: 'reconstruct_complete',
        tileKey: '2:0',
        tileSizeMeters: 4096,
        lod: 0,
        payloadCompressedBytes: 400000,
        payloadRawBytes: 1500000,
        durationMs: 22,
        queueDepths: { queued: 0, fetching: 0, decoding: 0, readyToCommit: 0, loaded: 5, visible: 4 },
      },
    ],
    longTasks: [{ seq: 1, startTimeMs: 115, durationMs: 52, name: 'self', attributionName: 'window', containerType: null, containerName: null }],
    loafs: [],
    topN: 2,
  });

  assert.equal(attributed[0].frameIndex, 2);
  assert.equal(attributed[0].primarySuspect, 'instanced_bvh_build');
  assert.equal(attributed[0].unattributedMs, 11.0);
  assert.equal(attributed[0].cameraMovingState.targetDeltaMeters, 350);
  assert.equal(attributed[0].firstRenderUploadProxy.driverGeometriesDelta, 12);
  assert.equal(attributed[0].syncMainThreadEvents.length, 1);
  assert.equal(attributed[0].asyncOverlappingEvents.length, 1);
  assert.equal(attributed[0].overlappingLongTasks.length, 1);
});

test('utmToLocalTarget, parseStreamingFluidityCli, buildTrajectoryPoseAtElapsedMs, and formatStreamingFluidityMarkdown work cleanly', () => {
  const local = utmToLocalTarget(345620, 5792000, 344000, 5790000);
  assert.deepEqual(local, [1620, 0, -2000]);

  const cli = parseStreamingFluidityCli([
    '--index-1024=data/osm/a/mosaic.json',
    '--index-4096=data/osm/b/mosaic.json',
    '--foliage=off',
    '--picking=both',
    '--scenarios=A,B,C,overhead',
    '--quick',
    '--allow-software',
  ]);
  assert.equal(cli.mosaics.length, 2);
  assert.equal(cli.foliage, 'off');
  assert.equal(cli.picking, 'both');
  assert.equal(cli.requireHardware, false);
  assert.equal(cli.measureMs, 1500);
  assert.deepEqual(cli.scenarios, [
    'A_stationary_baseline',
    'B_warm_cache_pan',
    'C_streaming_pan',
    'overhead',
  ]);

  const pMid = buildTrajectoryPoseAtElapsedMs({
    scenarioId: 'C_streaming_pan',
    elapsedMs: 2000,
    durationMs: 4000,
    baseTarget: [100, 0, -50],
    baseZoom: 1.2,
    azimuthDeg: 45,
    warmPanDistanceMeters: 120,
    streamPanDistanceMeters: 4000,
  });
  assert.deepEqual(pMid.target, [2100, 0, -50]);

  const dummyReport: StreamingFluidityBenchmarkReport = {
    schemaVersion: '1.0.0',
    generatedAtIso: '2026-11-25T12:00:00.000Z',
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    themeId: 'daylight',
    targetUtm: { easting: 344000, northing: 5790000 },
    preloadMarginTiles: 1,
    retainMarginTiles: 2,
    panSpeedMps: 350,
    warmPanDistanceMeters: 120,
    warmupMs: 300,
    measureMs: 1500,
    runsPerScenario: 1,
    gpuVendor: 'NVIDIA',
    gpuRenderer: 'NVIDIA GeForce RTX 4060 Ti',
    isSoftwareRenderer: false,
    softwareRendererWarning: null,
    traceOutPath: null,
    mosaics: [],
    interactiveResults: [],
    teleportationResults: [],
    overheadChecks: [],
  };
  const md = formatStreamingFluidityMarkdown(dummyReport);
  assert.ok(md.includes('TKT-039 Camera Movement & Streaming Frame-Time Profiling Report'));
  assert.ok(md.includes('Methodological Caveats'));
});
