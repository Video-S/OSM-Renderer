import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { acceleratedRaycast } from 'three-mesh-bvh';
import { MAP_THEMES } from '../../styles/mapThemes';
import type { InspectableFeatureInfo } from '../../types/MapFeature';
import {
  resolveInspectedFeature,
  type BuiltSceneGeometry,
  type FaceFeatureRange,
} from '../../world/GeometryBuilder';
import { auditCollarSufficiency } from '../../world/tiling/CollarAudit';
import {
  validateTiledSeamContinuity,
  type SeamValidationReport,
} from '../../world/tiling/SeamValidator';
import { ThemeMaterialRegistry } from '../../world/tiling/ThemeMaterialRegistry';
import {
  DEFAULT_COLLAR_METERS,
  DEFAULT_TILE_SIZE_METERS,
  createHengeloStudyGrid,
  type StudyGridSpec,
} from '../../world/tiling/TileGrid';
import {
  BAKE_SCHEMA_VERSION,
  CANONICAL_HENGELO_SNAPSHOT_ID,
  DEFAULT_PROJECTION_ID,
  type DecodedTilePayload,
  type TilePackMetadata,
} from '../../world/tiling/TilePackContract';
import {
  reconstructTileSceneFromDecoded,
  type ReconstructedTileSceneResult,
} from '../../world/tiling/TileSceneReconstructor';
import {
  buildSingleSceneReference,
  captureProcessMemorySnapshot,
  ingestCanonicalStudyGeoJson,
  mergeProcessMemoryPeak,
  type BuiltTileEntry,
  type IngestedStudyRegion,
  type ProcessMemorySnapshot,
  type TiledStudyBuildResult,
} from '../../world/tiling/TiledStudyPipeline';
import { OverijsselOsmStore } from '../osm/OverijsselOsmStore';
import {
  OVERIJSSEL_PBF_EXPECTED_SHA256,
  resolveOverijsselIndexPath,
} from '../osm/overijsselConfig';
import {
  bakeStudyRegionTilesToSqlite,
  disposeIngestedStudyRegionPlans,
} from './OfflineHengeloTileBaker';
import {
  TilePackSqliteStore,
  resolveTilePackPathForTileSize,
} from './TilePackSqliteStore';

export interface ThemeParityResult {
  themeId: string;
  passed: boolean;
  detail: string;
}

export interface BvhInspectionCheckResult {
  samplesAttempted: number;
  samplesPassed: number;
  failures: string[];
}

export interface DeterminismCheckResult {
  checked: boolean;
  passed: boolean;
  mismatchedTiles: string[];
}

export interface TilePackVerificationReport {
  generatedAtIso: string;
  packPath: string;
  dbSizeBytes: number;
  metadata: TilePackMetadata;
  isValid: boolean;
  timingsMs: {
    ingestMs: number;
    referenceBuildMs: number;
    decodeAllTilesMs: number;
    reconstructAllTilesMs: number;
    seamValidationMs: number;
    bvhAndThemeCheckMs: number;
    determinismBakeMs?: number;
  };
  decodeStats: {
    tilesDecoded: number;
    totalRawBytes: number;
    totalCompressedBytes: number;
    avgDecodeMsPerTile: number;
    avgReconstructMsPerTile: number;
    maxDecodePlusReconstructMs: number;
  };
  memoryMB: {
    peakDuringVerify: ProcessMemorySnapshot;
  };
  seamReport: SeamValidationReport;
  themeSwapChecks: ThemeParityResult[];
  bvhInspectionCheck: BvhInspectionCheckResult;
  attributeAndInstanceChecks: {
    railwayUvAndSwitchAttrPresent: boolean;
    sleeperInstancedParity: boolean;
    sharedMaterialCount: number;
    details: string[];
  };
  determinismCheck: DeterminismCheckResult;
  failures: string[];
}

export type SampleRayCategory =
  | 'building_roof'
  | 'building_facade'
  | 'building_single_feature'
  | 'surface_horizontal'
  | 'sleeper_instanced';

export interface StaticMeshRaySample {
  kind: 'static';
  category: Exclude<SampleRayCategory, 'sleeper_instanced'>;
  layer: string;
  mesh: THREE.Mesh;
  faceIndex: number;
  centroidWorld: THREE.Vector3;
  normalWorld: THREE.Vector3;
  expectedInfo: InspectableFeatureInfo | null;
}

export interface InstancedSleeperRaySample {
  kind: 'instanced_sleeper';
  category: 'sleeper_instanced';
  layer: 'railways';
  instancedMesh: THREE.InstancedMesh;
  instanceId: number;
  rayOrigin: THREE.Vector3;
  rayDirection: THREE.Vector3;
  expectedInfo: InspectableFeatureInfo | null;
}

export type TileRaySampleTarget = StaticMeshRaySample | InstancedSleeperRaySample;

function resolveExpectedFeatureForMeshFace(
  mesh: THREE.Mesh,
  faceIndex: number
): InspectableFeatureInfo | null {
  const faceRanges = mesh.userData?.faceRanges as FaceFeatureRange[] | undefined;
  if (Array.isArray(faceRanges) && faceRanges.length > 0) {
    let lo = 0;
    let hi = faceRanges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const r = faceRanges[mid];
      if (faceIndex < r.startFace) {
        hi = mid - 1;
      } else if (faceIndex >= r.endFace) {
        lo = mid + 1;
      } else {
        return r.info;
      }
    }
  }
  if (typeof mesh.userData?.id === 'string') {
    return mesh.userData as InspectableFeatureInfo;
  }
  return null;
}

function findMatchingTriangleInMesh(
  mesh: THREE.Mesh,
  predicate: (normalY: number, area: number) => boolean
): {
  faceIndex: number;
  centroidWorld: THREE.Vector3;
  normalWorld: THREE.Vector3;
  expectedInfo: InspectableFeatureInfo | null;
} | null {
  const geo = mesh.geometry;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || pos.count < 3) return null;
  const idx = geo.getIndex();
  const triCount = idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
  if (triCount <= 0) return null;

  mesh.updateMatrixWorld(true);
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const cross = new THREE.Vector3();

  // Probe deterministic spread across triangles (including midpoint, quartiles, start)
  const probeOrder: number[] = [];
  const step = Math.max(1, Math.floor(triCount / 24));
  for (let offset = 0; offset < triCount && probeOrder.length < 32; offset += step) {
    probeOrder.push(offset);
  }
  const mid = Math.floor(triCount / 2);
  if (!probeOrder.includes(mid)) probeOrder.unshift(mid);

  for (const f of probeOrder) {
    const i0 = idx ? idx.getX(f * 3) : f * 3;
    const i1 = idx ? idx.getX(f * 3 + 1) : f * 3 + 1;
    const i2 = idx ? idx.getX(f * 3 + 2) : f * 3 + 2;
    v0.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
    v1.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
    v2.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);

    e1.subVectors(v1, v0);
    e2.subVectors(v2, v0);
    cross.crossVectors(e1, e2);
    const doubleArea = cross.length();
    const area = doubleArea * 0.5;
    if (!Number.isFinite(area) || area <= 1e-4) continue;
    cross.divideScalar(doubleArea);

    if (!predicate(cross.y, area)) continue;

    const expectedInfo = resolveExpectedFeatureForMeshFace(mesh, f);
    if (!expectedInfo || !expectedInfo.id) continue;

    const centroidWorld = new THREE.Vector3()
      .addVectors(v0, v1)
      .add(v2)
      .multiplyScalar(1 / 3);
    return {
      faceIndex: f,
      centroidWorld,
      normalWorld: cross.clone(),
      expectedInfo,
    };
  }
  return null;
}

export function collectTileRaySampleTargets(
  scene: BuiltSceneGeometry,
  maxStaticSamples = 4
): TileRaySampleTarget[] {
  const samples: TileRaySampleTarget[] = [];
  scene.buildingsGroup.updateMatrixWorld(true);
  scene.roadsGroup.updateMatrixWorld(true);
  scene.waterGroup.updateMatrixWorld(true);
  scene.parksGroup.updateMatrixWorld(true);
  scene.landuseGroup.updateMatrixWorld(true);
  scene.railwaysGroup.updateMatrixWorld(true);

  const buildingMeshes: THREE.Mesh[] = [];
  scene.buildingsGroup.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh && !(obj as THREE.InstancedMesh).isInstancedMesh) {
      const m = obj as THREE.Mesh;
      if (m.visible) buildingMeshes.push(m);
    }
  });

  // 1. Merged or primary building roof (horizontal upward face)
  for (const m of buildingMeshes) {
    if (samples.length >= maxStaticSamples) break;
    const hit = findMatchingTriangleInMesh(m, (ny, area) => ny > 0.7 && area > 1e-3);
    if (hit) {
      samples.push({
        kind: 'static',
        category: 'building_roof',
        layer: 'buildings',
        mesh: m,
        ...hit,
      });
      break;
    }
  }

  // 2. Building vertical facade (|normal.y| < 0.25)
  for (const m of buildingMeshes) {
    if (samples.length >= maxStaticSamples) break;
    const hit = findMatchingTriangleInMesh(m, (ny, area) => Math.abs(ny) < 0.25 && area > 1e-2);
    if (hit) {
      samples.push({
        kind: 'static',
        category: 'building_facade',
        layer: 'buildings',
        mesh: m,
        ...hit,
      });
      break;
    }
  }

  // 3. Single-feature building mesh if present (userData.id with empty faceRanges)
  for (const m of buildingMeshes) {
    if (samples.length >= maxStaticSamples) break;
    const ranges = m.userData?.faceRanges as FaceFeatureRange[] | undefined;
    const isSingle = (!Array.isArray(ranges) || ranges.length === 0) && typeof m.userData?.id === 'string';
    if (!isSingle) continue;
    const hit = findMatchingTriangleInMesh(m, (_ny, area) => area > 1e-3);
    if (hit) {
      samples.push({
        kind: 'static',
        category: 'building_single_feature',
        layer: 'buildings',
        mesh: m,
        ...hit,
      });
      break;
    }
  }

  // 4. Horizontal infrastructure/surface layers (roads, water, parks, landuse, railways)
  const surfaceGroups: Array<[string, THREE.Group]> = [
    ['roads', scene.roadsGroup],
    ['water', scene.waterGroup],
    ['parks', scene.parksGroup],
    ['landuse', scene.landuseGroup],
    ['railways', scene.railwaysGroup],
  ];
  for (const [layerName, grp] of surfaceGroups) {
    if (samples.length >= maxStaticSamples) break;
    let picked = false;
    grp.traverse((obj) => {
      if (picked || samples.length >= maxStaticSamples) return;
      if (!(obj as THREE.Mesh).isMesh || (obj as THREE.InstancedMesh).isInstancedMesh) return;
      const m = obj as THREE.Mesh;
      if (!m.visible) return;
      const hit = findMatchingTriangleInMesh(m, (ny, area) => ny > 0.7 && area > 1e-4);
      if (hit) {
        samples.push({
          kind: 'static',
          category: 'surface_horizontal',
          layer: layerName,
          mesh: m,
          ...hit,
        });
        picked = true;
      }
    });
  }

  // 5. Instanced sleeper batch sample if present
  let sleeperSampleAdded = false;
  scene.railwaysGroup.traverse((obj) => {
    if (sleeperSampleAdded) return;
    if (!(obj as THREE.InstancedMesh).isInstancedMesh) return;
    const im = obj as THREE.InstancedMesh;
    if (!im.name.startsWith('Railway_Sleepers_3D') || im.count <= 0) return;
    im.updateMatrixWorld(true);
    const instIdx = Math.floor(im.count / 2);
    const instMat = new THREE.Matrix4();
    im.getMatrixAt(instIdx, instMat);
    const worldMat = new THREE.Matrix4().multiplyMatrices(im.matrixWorld, instMat);
    // Unit sleeper box spans y in [0, 1] centered at x=0, z=0
    const topCenter = new THREE.Vector3(0, 1.0, 0).applyMatrix4(worldMat);
    const infos = im.userData?.instanceInfos as InspectableFeatureInfo[] | undefined;
    const expectedInfo = Array.isArray(infos) ? infos[instIdx] ?? null : null;
    if (expectedInfo && expectedInfo.id) {
      samples.push({
        kind: 'instanced_sleeper',
        category: 'sleeper_instanced',
        layer: 'railways',
        instancedMesh: im,
        instanceId: instIdx,
        rayOrigin: new THREE.Vector3(topCenter.x, topCenter.y + 0.5, topCenter.z),
        rayDirection: new THREE.Vector3(0, -1, 0),
        expectedInfo,
      });
      sleeperSampleAdded = true;
    }
  });

  return samples;
}

function sameFeatureIdentity(
  a: InspectableFeatureInfo | null,
  b: InspectableFeatureInfo | null
): boolean {
  if (!a || !b) return false;
  return a.id === b.id && a.sourceFeatureId === b.sourceFeatureId;
}

export function verifyStaticMeshBvhSample(params: {
  sample: StaticMeshRaySample;
  tileId: string;
  expectBvhAttached: boolean;
}): string | null {
  const { sample, tileId, expectBvhAttached } = params;
  const { mesh, faceIndex, centroidWorld, normalWorld, expectedInfo, category } = sample;

  if (expectBvhAttached) {
    const bvh = (mesh.geometry as unknown as { boundsTree?: unknown }).boundsTree;
    if (!bvh) {
      return `Mesh ${mesh.name} (${category}) in ${tileId} missing deserialized boundsTree`;
    }
    if (mesh.raycast !== acceleratedRaycast) {
      return `Mesh ${mesh.name} (${category}) in ${tileId} does not use acceleratedRaycast`;
    }
  }

  const runPair = (standoff: number) => {
    const rayDir = normalWorld.clone().negate().normalize();
    const rayOrigin = centroidWorld.clone().addScaledVector(normalWorld, standoff);

    const rayAll = new THREE.Raycaster(rayOrigin, rayDir, 0, 2000);
    (rayAll as unknown as { firstHitOnly?: boolean }).firstHitOnly = false;
    const bvhHits = rayAll.intersectObject(mesh, false);

    const rayFirst = new THREE.Raycaster(rayOrigin, rayDir, 0, 2000);
    (rayFirst as unknown as { firstHitOnly?: boolean }).firstHitOnly = true;
    const bvhFirstHits = rayFirst.intersectObject(mesh, false);

    const prevRaycast = mesh.raycast;
    let stdHits: THREE.Intersection[];
    mesh.raycast = THREE.Mesh.prototype.raycast;
    try {
      const rayStd = new THREE.Raycaster(rayOrigin, rayDir, 0, 2000);
      stdHits = rayStd.intersectObject(mesh, false);
    } finally {
      mesh.raycast = prevRaycast;
    }

    return { bvhHits, bvhFirstHits, stdHits };
  };

  const primary = runPair(0.5);
  if (primary.bvhHits.length === 0 || primary.stdHits.length === 0 || primary.bvhFirstHits.length === 0) {
    return `BVH/standard raycast missed ${mesh.name} (${category}) face ${faceIndex} in ${tileId} (bvh=${primary.bvhHits.length}, std=${primary.stdHits.length})`;
  }
  if (primary.bvhHits.length !== primary.stdHits.length) {
    return `BVH vs standard hit-count mismatch on ${mesh.name} (${category}) in ${tileId}: bvh=${primary.bvhHits.length}, std=${primary.stdHits.length}`;
  }

  const checkHitParity = (
    bvhHits: THREE.Intersection[],
    bvhFirstHits: THREE.Intersection[],
    stdHits: THREE.Intersection[],
    label: string
  ): string | null => {
    const b0 = bvhHits[0];
    const f0 = bvhFirstHits[0];
    const s0 = stdHits[0];

    if (Math.abs(b0.distance - s0.distance) > 1e-4 || Math.abs(f0.distance - s0.distance) > 1e-4) {
      return `BVH vs standard nearest distance mismatch (${label}) on ${mesh.name} (${category}) in ${tileId}: bvh=${b0.distance.toFixed(5)}, firstHit=${f0.distance.toFixed(5)}, std=${s0.distance.toFixed(5)}`;
    }

    // Compare faceIndex; if coplanar tie at same distance (within 1e-4), ensure both exist in hit sets
    if (b0.faceIndex !== s0.faceIndex) {
      const sHasB0 = stdHits.some(
        (h) => h.faceIndex === b0.faceIndex && Math.abs(h.distance - s0.distance) <= 1e-4
      );
      if (!sHasB0) {
        return `BVH vs standard nearest faceIndex mismatch (${label}) on ${mesh.name} (${category}) in ${tileId}: bvh=${b0.faceIndex}, std=${s0.faceIndex}`;
      }
    }
    if (f0.faceIndex !== s0.faceIndex) {
      const sHasF0 = stdHits.some(
        (h) => h.faceIndex === f0.faceIndex && Math.abs(h.distance - s0.distance) <= 1e-4
      );
      if (!sHasF0) {
        return `BVH firstHitOnly vs standard nearest faceIndex mismatch (${label}) on ${mesh.name} (${category}) in ${tileId}: firstHit=${f0.faceIndex}, std=${s0.faceIndex}`;
      }
    }

    // Verify metadata resolution for the frontmost hit against its exact face owner
    for (const hit of [b0, f0]) {
      if (typeof hit.faceIndex !== 'number') {
        return `Hit missing faceIndex on ${mesh.name} (${category}) in ${tileId}`;
      }
      const resolved = resolveInspectedFeature(hit);
      const expectedForHit = resolveExpectedFeatureForMeshFace(mesh, hit.faceIndex);
      if (!resolved || !expectedForHit || !sameFeatureIdentity(resolved, expectedForHit)) {
        return `resolveInspectedFeature mismatch (${label}) on ${mesh.name} (${category}) face ${hit.faceIndex} in ${tileId}: got ${resolved?.sourceFeatureId ?? 'null'}, expected ${expectedForHit?.sourceFeatureId ?? 'null'}`;
      }
    }

    // Target triangle must appear in both BVH and standard raycast hit lists
    const bvhTargetHit = bvhHits.find((h) => h.faceIndex === faceIndex);
    const stdTargetHit = stdHits.find((h) => h.faceIndex === faceIndex);
    if (!bvhTargetHit || !stdTargetHit) {
      return `Target triangle ${faceIndex} missing from ray hits (${label}) on ${mesh.name} (${category}) in ${tileId} (bvhHit=${Boolean(bvhTargetHit)}, stdHit=${Boolean(stdTargetHit)})`;
    }
    const targetResolved = resolveInspectedFeature(bvhTargetHit);
    if (!sameFeatureIdentity(targetResolved, expectedInfo)) {
      return `Inspected sourceFeatureId mismatch (${label}) on ${mesh.name} (${category}) face ${faceIndex} in ${tileId}: got ${targetResolved?.sourceFeatureId ?? 'null'}, expected ${expectedInfo?.sourceFeatureId ?? 'null'}`;
    }

    return null;
  };

  const primaryErr = checkHitParity(primary.bvhHits, primary.bvhFirstHits, primary.stdHits, 'd=0.5m');
  if (primaryErr) return primaryErr;

  // If primary standoff hit a closer occluding triangle (< 0.5m - 1e-4) rather than the target triangle,
  // verify at close standoff (0.05m) so target triangle itself is verified unobstructed.
  const b0 = primary.bvhHits[0];
  if (b0.faceIndex !== faceIndex && b0.distance < 0.5 - 1e-4) {
    const close = runPair(0.05);
    if (close.bvhHits.length === 0 || close.stdHits.length === 0 || close.bvhFirstHits.length === 0) {
      return `Close-standoff raycast missed ${mesh.name} (${category}) face ${faceIndex} in ${tileId}`;
    }
    if (close.bvhHits.length !== close.stdHits.length) {
      return `Close-standoff BVH vs standard hit-count mismatch on ${mesh.name} (${category}) in ${tileId}`;
    }
    const closeErr = checkHitParity(close.bvhHits, close.bvhFirstHits, close.stdHits, 'd=0.05m');
    if (closeErr) return closeErr;
  }

  return null;
}

export function verifyBakedTilePackAgainstIngested(params: {
  packPath: string;
  ingested: IngestedStudyRegion;
  expectedSnapshotId?: string;
  expectedSourceSha256?: string;
  allowCustomSnapshot?: boolean;
  checkDeterminism?: boolean;
  includeBvh?: boolean;
}): TilePackVerificationReport {
  const {
    packPath,
    ingested,
    expectedSnapshotId,
    expectedSourceSha256,
    allowCustomSnapshot = false,
    checkDeterminism = false,
    includeBvh = true,
  } = params;

  const failures: string[] = [];
  const store = new TilePackSqliteStore(packPath, {
    expectedSnapshotId: expectedSnapshotId ?? (allowCustomSnapshot ? undefined : CANONICAL_HENGELO_SNAPSHOT_ID),
    expectedSourceSha256,
    expectedBakeSchemaVersion: BAKE_SCHEMA_VERSION,
    expectedProjectionId: DEFAULT_PROJECTION_ID,
    allowCustomSnapshot,
    verifyTileCount: true,
  });

  const metadata = store.getMetadata();
  const dbSizeBytes = store.getFileSizeBytes();
  let peakMemory = captureProcessMemorySnapshot();

  if (
    metadata.tileSizeMeters !== ingested.grid.tileSizeMeters ||
    metadata.gridCols !== ingested.grid.cols ||
    metadata.gridRows !== ingested.grid.rows
  ) {
    failures.push(
      `Tile pack grid mismatch: pack has ${metadata.gridCols}x${metadata.gridRows} @ ${metadata.tileSizeMeters}m, expected ${ingested.grid.cols}x${ingested.grid.rows} @ ${ingested.grid.tileSizeMeters}m`
    );
  }

  // Verify alignment with canonical 512m Hengelo study bounds/origin when verifying alternate tile sizes
  if (ingested.grid.name.startsWith('hengelo-') && ingested.grid.tileSizeMeters !== DEFAULT_TILE_SIZE_METERS) {
    const canonical512 = createHengeloStudyGrid(DEFAULT_TILE_SIZE_METERS, ingested.grid.collarMeters);
    const utmBoundsMatch =
      ingested.grid.studyUtmBounds.minEasting === canonical512.studyUtmBounds.minEasting &&
      ingested.grid.studyUtmBounds.maxEasting === canonical512.studyUtmBounds.maxEasting &&
      ingested.grid.studyUtmBounds.minNorthing === canonical512.studyUtmBounds.minNorthing &&
      ingested.grid.studyUtmBounds.maxNorthing === canonical512.studyUtmBounds.maxNorthing;
    if (!utmBoundsMatch) {
      failures.push(`Study UTM bounds for ${ingested.grid.tileSizeMeters}m grid deviate from canonical 512m bounds`);
    }
    const localEdgesAligned = ingested.grid.tiles.every(
      (t) =>
        Math.abs(t.localBounds.minX % DEFAULT_TILE_SIZE_METERS) < 1e-6 &&
        Math.abs(t.localBounds.maxX % DEFAULT_TILE_SIZE_METERS) < 1e-6 &&
        Math.abs(t.localBounds.minZ % DEFAULT_TILE_SIZE_METERS) < 1e-6 &&
        Math.abs(t.localBounds.maxZ % DEFAULT_TILE_SIZE_METERS) < 1e-6
    );
    if (!localEdgesAligned) {
      failures.push(`Tile edges for ${ingested.grid.tileSizeMeters}m grid do not align with 512m boundaries`);
    }
  }

  const reference = buildSingleSceneReference(ingested, MAP_THEMES.tactical);
  peakMemory = mergeProcessMemoryPeak(peakMemory, reference.memoryAfterBuild);

  const materialRegistry = new ThemeMaterialRegistry(MAP_THEMES.tactical, 1.0);
  const reconstructedList: Array<{
    tile: StudyGridSpec['tiles'][number];
    decoded: DecodedTilePayload;
    recon: ReconstructedTileSceneResult;
  }> = [];

  try {
    let decodeAllTilesMs = 0;
    let reconstructAllTilesMs = 0;
    let totalRawBytes = 0;
    let totalCompressedBytes = 0;
    let maxDecodePlusReconstructMs = 0;

    for (const tile of ingested.grid.tiles) {
      const tDec0 = performance.now();
      const compressedEntry = store.getTileCompressed(0, tile.tx, tile.ty);
      if (!compressedEntry) {
        failures.push(`Missing tile (${tile.tx}, ${tile.ty}) in tile pack`);
        continue;
      }
      const decoded = store.getTileDecoded(0, tile.tx, tile.ty);
      const decMs = performance.now() - tDec0;
      if (!decoded) {
        failures.push(`Failed to decode tile (${tile.tx}, ${tile.ty})`);
        continue;
      }

      const tRec0 = performance.now();
      const recon = reconstructTileSceneFromDecoded(decoded, {
        materialRegistry,
        placementMode: 'study-world-mesh-offset',
        initialCameraZoom: 1.0,
      });
      const recMs = performance.now() - tRec0;

      decodeAllTilesMs += decMs;
      reconstructAllTilesMs += recMs;
      if (decMs + recMs > maxDecodePlusReconstructMs) {
        maxDecodePlusReconstructMs = decMs + recMs;
      }

      totalRawBytes += compressedEntry.manifest.rawBytes;
      totalCompressedBytes += compressedEntry.manifest.compressedBytes;

      if (decoded.tx !== tile.tx || decoded.ty !== tile.ty) {
        failures.push(`Decoded tile coordinate mismatch for ${tile.id}`);
      }
      if (includeBvh) {
        for (const m of decoded.meshes) {
          if (m.positions.length >= 9 && !m.bvh) {
            failures.push(`Mesh ${m.name} in ${tile.id} missing serialized MeshBVH`);
          }
        }
      }

      reconstructedList.push({ tile, decoded, recon });
    }

    peakMemory = mergeProcessMemoryPeak(peakMemory, captureProcessMemorySnapshot());

    const collarAudit = auditCollarSufficiency({
      data: ingested.data,
      grid: ingested.grid,
      descriptors: ingested.descriptors,
      roadGradeSeparatedPlans: ingested.precomputedGlobalPlans.roadGradeSeparatedPlans,
      railwayGradeSeparatedPlans: ingested.precomputedGlobalPlans.railwayGradeSeparatedPlans,
      hasGlobalAtGradeRoadPlan: Boolean(ingested.precomputedGlobalPlans.atGradeRoadPlan),
      hasGlobalBarrierResolution: Boolean(ingested.precomputedGlobalPlans.barrierResolution),
    });

    const builtTileEntries: BuiltTileEntry[] = reconstructedList.map(({ tile, recon }) => ({
      tile,
      scene: recon.scene,
      buildTimeMs: 0,
      inputCounts: {
        buildings: 0,
        roads: 0,
        railways: 0,
        landuse: 0,
        parks: 0,
        waterBodies: 0,
        linearWaterways: 0,
        barriers: 0,
        landmarks: 0,
      },
    }));

    const tiledResult: TiledStudyBuildResult = {
      grid: ingested.grid,
      tiles: builtTileEntries,
      collarAudit,
      totalBuildTimeMs: Number((decodeAllTilesMs + reconstructAllTilesMs).toFixed(2)),
      maxTileBuildTimeMs: Number(maxDecodePlusReconstructMs.toFixed(2)),
      avgTileBuildTimeMs:
        reconstructedList.length > 0
          ? Number(((decodeAllTilesMs + reconstructAllTilesMs) / reconstructedList.length).toFixed(2))
          : 0,
      peakMemory,
      memoryAfterAllTiles: peakMemory,
      dispose: () => {
        for (const item of reconstructedList) item.recon.dispose();
      },
    };

    const tVal0 = performance.now();
    const seamReport = validateTiledSeamContinuity({ reference, tiled: tiledResult });
    const seamValidationMs = Number((performance.now() - tVal0).toFixed(2));
    if (!seamReport.isValid) {
      failures.push(`SeamValidator failed with ${seamReport.defects.length} defect(s)`);
    }

    // Check shared material identity, 4-theme parity, attributes, and BVH raycasts
    const tCheck0 = performance.now();
    const seenMaterials = new Set<THREE.Material>();
    let railwayUvAndSwitchAttrPresent = true;
    let sleeperInstancedParity = true;
    const attrDetails: string[] = [];
    let totalDecodedSleeperInstances = 0;

    for (const { tile, recon } of reconstructedList) {
      for (const grp of [
        recon.scene.buildingsGroup,
        recon.scene.roadsGroup,
        recon.scene.railwaysGroup,
        recon.scene.waterGroup,
        recon.scene.parksGroup,
        recon.scene.landuseGroup,
        recon.scene.barriersGroup,
        recon.scene.foliageGroup,
      ]) {
        grp.traverse((obj) => {
          if ((obj as THREE.Mesh).isMesh) {
            const m = obj as THREE.Mesh;
            if (Array.isArray(m.material)) {
              for (const mm of m.material) seenMaterials.add(mm);
            } else if (m.material) {
              seenMaterials.add(m.material);
            }
          }
          if ((obj as THREE.InstancedMesh).isInstancedMesh) {
            const im = obj as THREE.InstancedMesh;
            if (im.name.startsWith('Railway_Sleepers_3D')) {
              totalDecodedSleeperInstances += im.count;
              const boxes = im.userData?.instanceBoxes;
              const infos = im.userData?.instanceInfos;
              if (!Array.isArray(boxes) || boxes.length !== im.count || !Array.isArray(infos) || infos.length !== im.count) {
                sleeperInstancedParity = false;
                attrDetails.push(`Tile ${tile.id} sleeper InstancedMesh missing instanceBoxes/instanceInfos`);
              }
            }
          } else if ((obj as THREE.Mesh).isMesh) {
            const m = obj as THREE.Mesh;
            if (m.name.startsWith('Railway_Sleepers') || m.name.startsWith('Railway_Rails')) {
              if (!m.name.includes('_3D')) {
                const hasUv = Boolean(m.geometry.getAttribute('uv'));
                const hasSwitch = Boolean(m.geometry.getAttribute('aSwitchAttr'));
                if (!hasUv || !hasSwitch) {
                  railwayUvAndSwitchAttrPresent = false;
                  attrDetails.push(`Tile ${tile.id} ${m.name} missing uv=${hasUv} or aSwitchAttr=${hasSwitch}`);
                }
              }
            }
          }
        });
      }
    }

    const refSleeperCount = reference.scene.railwaysGroup.userData?.railwayStats?.sleeper3DBoxCount ?? 0;
    if (refSleeperCount > 0 && totalDecodedSleeperInstances !== refSleeperCount) {
      sleeperInstancedParity = false;
      attrDetails.push(`Decoded sleeper instances (${totalDecodedSleeperInstances}) != reference (${refSleeperCount})`);
    }
    if (!railwayUvAndSwitchAttrPresent || !sleeperInstancedParity) {
      failures.push(...attrDetails);
    }

    // 4-theme parity checks
    const themeSwapChecks: ThemeParityResult[] = [];
    const expectedThemeIds = ['tactical', 'daylight', 'dusk', 'blueprint'] as const;
    for (const themeId of expectedThemeIds) {
      const targetTheme = MAP_THEMES[themeId];
      materialRegistry.applyTheme(targetTheme);
      const groundHex = materialRegistry.getMaterial('ground').color.getHexString();
      const expectedGroundHex = new THREE.Color(targetTheme.groundColor).getHexString();
      const wallHex = materialRegistry.getMaterial('building:wall:default').color.getHexString();
      const expectedWallHex = new THREE.Color(targetTheme.buildingWallColor).getHexString();
      const sleeperUniforms = materialRegistry.getMaterial('railway:sleepers_uv').userData?.railwayUniforms;
      const expectedRailHex = new THREE.Color(targetTheme.railwayColors.rail).getHexString();
      const actualRailHex = materialRegistry.getMaterial('railway:rails_3d').color.getHexString();
      const sleeperUniformOk = sleeperUniforms
        ? sleeperUniforms.uBallastColor.value.getHexString() ===
          new THREE.Color(targetTheme.railwayColors.ballast).getHexString()
        : false;

      const passed =
        groundHex === expectedGroundHex &&
        wallHex === expectedWallHex &&
        actualRailHex === expectedRailHex &&
        sleeperUniformOk;
      if (!passed) {
        failures.push(
          `Theme "${themeId}" parity failed (ground=${groundHex}/${expectedGroundHex}, wall=${wallHex}/${expectedWallHex}, rail=${actualRailHex}/${expectedRailHex}, uniform=${sleeperUniformOk})`
        );
      }
      themeSwapChecks.push({
        themeId,
        passed,
        detail: passed
          ? `ground=#${groundHex}, wall=#${wallHex}, rail=#${actualRailHex}`
          : `Mismatch in theme ${themeId}`,
      });
    }
    // Restore tactical theme
    materialRegistry.applyTheme(MAP_THEMES.tactical);

    // BVH raycast + inspection parity across roofs, vertical facades, single-feature meshes, surfaces, and instanced sleepers
    let samplesAttempted = 0;
    let samplesPassed = 0;
    const bvhFailures: string[] = [];

    const nonEmptyTiles = reconstructedList.filter(
      ({ recon }) =>
        recon.scene.stats.renderedFeaturesCount > 0 || recon.scene.stats.totalTriangles > 2
    );
    const maxTilesToSample = 8;
    const tileStride = Math.max(1, Math.floor(nonEmptyTiles.length / maxTilesToSample));
    const sampledTiles: typeof reconstructedList = [];
    for (let i = 0; i < nonEmptyTiles.length && sampledTiles.length < maxTilesToSample; i += tileStride) {
      sampledTiles.push(nonEmptyTiles[i]);
    }

    for (const { tile, recon } of sampledTiles) {
      const samples = collectTileRaySampleTargets(recon.scene, 8);
      for (const s of samples) {
        samplesAttempted++;
        if (s.kind === 'static') {
          const err = verifyStaticMeshBvhSample({
            sample: s,
            tileId: tile.id,
            expectBvhAttached: includeBvh,
          });
          if (err) {
            bvhFailures.push(err);
          } else {
            samplesPassed++;
          }
        } else {
          // Instanced sleeper check: activate close zoom so Railway_Sleepers_3D is visible
          recon.scene.updateCameraZoom?.(6.0);
          try {
            s.instancedMesh.updateMatrixWorld(true);
            const ray = new THREE.Raycaster(s.rayOrigin, s.rayDirection, 0, 10);
            const hits = ray.intersectObject(s.instancedMesh, false);
            if (hits.length === 0 || typeof hits[0].instanceId !== 'number') {
              bvhFailures.push(
                `Instanced sleeper raycast missed ${s.instancedMesh.name} instance ${s.instanceId} in ${tile.id}`
              );
              continue;
            }
            const resolved = resolveInspectedFeature(hits[0]);
            const infos = s.instancedMesh.userData?.instanceInfos as InspectableFeatureInfo[] | undefined;
            const ownerForHit = Array.isArray(infos) ? infos[hits[0].instanceId] ?? null : null;
            if (!resolved || !ownerForHit || !sameFeatureIdentity(resolved, ownerForHit)) {
              bvhFailures.push(
                `Instanced sleeper resolveInspectedFeature mismatch on ${s.instancedMesh.name} instance ${hits[0].instanceId} in ${tile.id}: got ${resolved?.sourceFeatureId ?? 'null'}, expected ${ownerForHit?.sourceFeatureId ?? 'null'}`
              );
              continue;
            }
            if (!hits.some((h) => h.instanceId === s.instanceId)) {
              bvhFailures.push(
                `Target sleeper instance ${s.instanceId} missing from raycast hits on ${s.instancedMesh.name} in ${tile.id}`
              );
              continue;
            }
            samplesPassed++;
          } finally {
            recon.scene.updateCameraZoom?.(1.0);
          }
        }
      }
    }
    if (bvhFailures.length > 0) {
      failures.push(...bvhFailures);
    }

    const bvhAndThemeCheckMs = Number((performance.now() - tCheck0).toFixed(2));

    // Optional repeatability / determinism check
    let determinismCheck: DeterminismCheckResult = {
      checked: false,
      passed: true,
      mismatchedTiles: [],
    };
    let determinismBakeMs: number | undefined;

    if (checkDeterminism) {
      const tmpPack = path.join(
        os.tmpdir(),
        `hengelo-determinism-${process.pid}-${Date.now()}.sqlite`
      );
      try {
        const tDet0 = performance.now();
        const detBatchDimension = Math.min(
          4,
          Math.max(1, Math.round(2048 / ingested.grid.tileSizeMeters))
        );
        bakeStudyRegionTilesToSqlite({
          ingested,
          outPath: tmpPack,
          snapshotId: metadata.snapshotId,
          sourceSha256: metadata.sourceSha256,
          batchDimension: detBatchDimension,
          includeBvh,
        });
        determinismBakeMs = Number((performance.now() - tDet0).toFixed(2));
        const detStore = new TilePackSqliteStore(tmpPack, {
          expectedSnapshotId: metadata.snapshotId,
          expectedSourceSha256: metadata.sourceSha256,
          allowCustomSnapshot: true,
        });
        try {
          const mA = store.listManifestEntries(0);
          const mB = detStore.listManifestEntries(0);
          const byKeyA = new Map(mA.map((e) => [`${e.tx}:${e.ty}`, e]));
          const mismatchedTiles: string[] = [];
          for (const b of mB) {
            const a = byKeyA.get(`${b.tx}:${b.ty}`);
            if (
              !a ||
              a.contentHash !== b.contentHash ||
              a.compressedBytes !== b.compressedBytes ||
              a.rawBytes !== b.rawBytes ||
              a.triCount !== b.triCount
            ) {
              mismatchedTiles.push(`tx_${b.tx}_ty_${b.ty}`);
            }
          }
          determinismCheck = {
            checked: true,
            passed: mismatchedTiles.length === 0 && mA.length === mB.length,
            mismatchedTiles,
          };
          if (!determinismCheck.passed) {
            failures.push(`Determinism check failed on tiles: ${mismatchedTiles.join(', ')}`);
          }
        } finally {
          detStore.close();
        }
      } finally {
        if (fs.existsSync(tmpPack)) {
          fs.rmSync(tmpPack, { force: true });
        }
      }
    }

    const nTiles = reconstructedList.length;
    return {
      generatedAtIso: new Date().toISOString(),
      packPath,
      dbSizeBytes,
      metadata,
      isValid: failures.length === 0,
      timingsMs: {
        ingestMs: ingested.ingestTimeMs,
        referenceBuildMs: reference.buildTimeMs,
        decodeAllTilesMs: Number(decodeAllTilesMs.toFixed(2)),
        reconstructAllTilesMs: Number(reconstructAllTilesMs.toFixed(2)),
        seamValidationMs,
        bvhAndThemeCheckMs,
        ...(determinismBakeMs !== undefined ? { determinismBakeMs } : {}),
      },
      decodeStats: {
        tilesDecoded: nTiles,
        totalRawBytes,
        totalCompressedBytes,
        avgDecodeMsPerTile: nTiles > 0 ? Number((decodeAllTilesMs / nTiles).toFixed(2)) : 0,
        avgReconstructMsPerTile:
          nTiles > 0 ? Number((reconstructAllTilesMs / nTiles).toFixed(2)) : 0,
        maxDecodePlusReconstructMs: Number(maxDecodePlusReconstructMs.toFixed(2)),
      },
      memoryMB: {
        peakDuringVerify: peakMemory,
      },
      seamReport,
      themeSwapChecks,
      bvhInspectionCheck: {
        samplesAttempted,
        samplesPassed,
        failures: bvhFailures,
      },
      attributeAndInstanceChecks: {
        railwayUvAndSwitchAttrPresent,
        sleeperInstancedParity,
        sharedMaterialCount: seenMaterials.size,
        details: attrDetails,
      },
      determinismCheck,
      failures,
    };
  } finally {
    for (const item of reconstructedList) {
      item.recon.dispose();
    }
    materialRegistry.dispose();
    reference.dispose();
    store.close();
  }
}

export function verifyHengeloTilePackFromStore(options: {
  indexPath?: string;
  packPath?: string;
  expectedSha256?: string;
  tileSizeMeters?: number;
  collarMeters?: number;
  checkDeterminism?: boolean;
  jsonOutPath?: string;
  maxCaseSamples?: number;
} = {}): TilePackVerificationReport {
  const indexPath = options.indexPath ?? resolveOverijsselIndexPath();
  const expectedSha256 = options.expectedSha256 ?? OVERIJSSEL_PBF_EXPECTED_SHA256;
  const requestedTileSize = options.tileSizeMeters;
  const packPath =
    options.packPath ??
    resolveTilePackPathForTileSize(requestedTileSize ?? DEFAULT_TILE_SIZE_METERS);

  // Peek pack metadata so `--pack=...-1024m.sqlite` works automatically without requiring `--tile-size=1024`,
  // while still rejecting explicit `--tile-size` conflicts.
  let packMeta: TilePackMetadata;
  const peekStore = new TilePackSqliteStore(packPath, {
    expectedSourceSha256: expectedSha256,
    expectedBakeSchemaVersion: BAKE_SCHEMA_VERSION,
    expectedProjectionId: DEFAULT_PROJECTION_ID,
    verifyTileCount: true,
  });
  try {
    packMeta = peekStore.getMetadata();
  } finally {
    peekStore.close();
  }

  if (
    requestedTileSize !== undefined &&
    packMeta.tileSizeMeters !== requestedTileSize
  ) {
    throw new Error(
      `Requested tileSizeMeters=${requestedTileSize} does not match pack "${packPath}" tileSizeMeters=${packMeta.tileSizeMeters}.`
    );
  }

  const tileSizeMeters = requestedTileSize ?? packMeta.tileSizeMeters ?? DEFAULT_TILE_SIZE_METERS;
  const collarMeters = options.collarMeters ?? packMeta.collarMeters ?? DEFAULT_COLLAR_METERS;

  const grid = createHengeloStudyGrid(tileSizeMeters, collarMeters);
  const store = new OverijsselOsmStore(indexPath, { expectedSha256 });
  let ingested: IngestedStudyRegion | null = null;

  try {
    const queryRes = store.queryBBox({
      ...grid.studyExpandedGeoBounds,
      locationName: grid.name,
    });
    ingested = ingestCanonicalStudyGeoJson(queryRes.geojson, grid);

    const report = verifyBakedTilePackAgainstIngested({
      packPath,
      ingested,
      expectedSnapshotId: queryRes.snapshotMetadata.snapshotId,
      expectedSourceSha256: queryRes.snapshotMetadata.sourceSha256,
      checkDeterminism: options.checkDeterminism ?? false,
    });

    if (options.jsonOutPath) {
      const maxCases = options.maxCaseSamples ?? 50;
      const serializable: TilePackVerificationReport = {
        ...report,
        seamReport: {
          ...report.seamReport,
          collarAudit: {
            ...report.seamReport.collarAudit,
            cases: report.seamReport.collarAudit.cases.slice(0, maxCases),
          },
        },
      };
      const outPath = path.resolve(options.jsonOutPath);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(serializable, null, 2), 'utf8');
    }

    return report;
  } finally {
    if (ingested) {
      disposeIngestedStudyRegionPlans(ingested);
    }
    store.close();
  }
}
