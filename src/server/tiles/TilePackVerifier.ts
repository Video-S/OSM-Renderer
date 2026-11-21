import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { MAP_THEMES } from '../../styles/mapThemes';
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
  resolveDefaultTilePackPath,
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

function collectSampleRayTargets(
  scene: BuiltSceneGeometry,
  maxSamples = 12
): Array<{
  layer: string;
  mesh: THREE.Mesh;
  sampleXZ: [number, number];
  expectedSourceFeatureId?: string;
}> {
  const candidates: Array<{
    layer: string;
    mesh: THREE.Mesh;
    sampleXZ: [number, number];
    expectedSourceFeatureId?: string;
  }> = [];

  const groups: Array<[string, THREE.Group]> = [
    ['buildings', scene.buildingsGroup],
    ['roads', scene.roadsGroup],
    ['water', scene.waterGroup],
    ['parks', scene.parksGroup],
    ['landuse', scene.landuseGroup],
    ['railways', scene.railwaysGroup],
  ];

  for (const [layerName, grp] of groups) {
    grp.traverse((obj) => {
      if (candidates.length >= maxSamples) return;
      if (!(obj as THREE.Mesh).isMesh || (obj as THREE.InstancedMesh).isInstancedMesh) return;
      const mesh = obj as THREE.Mesh;
      if (!mesh.visible) return;
      const geo = mesh.geometry;
      const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!pos || pos.count < 3) return;
      const idx = geo.getIndex();
      const triCount = idx ? Math.floor(idx.count / 3) : Math.floor(pos.count / 3);
      if (triCount === 0) return;

      const faceRanges = mesh.userData?.faceRanges as FaceFeatureRange[] | undefined;
      const f = Math.floor(triCount / 2);
      const i0 = idx ? idx.getX(f * 3) : f * 3;
      const i1 = idx ? idx.getX(f * 3 + 1) : f * 3 + 1;
      const i2 = idx ? idx.getX(f * 3 + 2) : f * 3 + 2;
      const cx = (pos.getX(i0) + pos.getX(i1) + pos.getX(i2)) / 3 + mesh.position.x;
      const cz = (pos.getZ(i0) + pos.getZ(i1) + pos.getZ(i2)) / 3 + mesh.position.z;

      let expectedSid: string | undefined;
      if (Array.isArray(faceRanges)) {
        const match = faceRanges.find((r) => f >= r.startFace && f < r.endFace);
        expectedSid = match?.info.sourceFeatureId;
      } else if (typeof mesh.userData?.sourceFeatureId === 'string') {
        expectedSid = mesh.userData.sourceFeatureId;
      }

      candidates.push({
        layer: layerName,
        mesh,
        sampleXZ: [cx, cz],
        expectedSourceFeatureId: expectedSid,
      });
    });
  }

  return candidates;
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

    // BVH raycast + inspection parity
    const raycaster = new THREE.Raycaster();
    let samplesAttempted = 0;
    let samplesPassed = 0;
    const bvhFailures: string[] = [];

    for (const { tile, recon } of reconstructedList) {
      if (samplesAttempted >= 16) break;
      const samples = collectSampleRayTargets(recon.scene, 4);
      for (const s of samples) {
        if (samplesAttempted >= 16) break;
        samplesAttempted++;
        raycaster.set(
          new THREE.Vector3(s.sampleXZ[0], 500, s.sampleXZ[1]),
          new THREE.Vector3(0, -1, 0)
        );
        const hits = raycaster.intersectObject(s.mesh, false);
        if (hits.length === 0) {
          bvhFailures.push(`BVH raycast missed ${s.mesh.name} in ${tile.id} at (${s.sampleXZ[0].toFixed(2)}, ${s.sampleXZ[1].toFixed(2)})`);
          continue;
        }
        const info = resolveInspectedFeature(hits[0]);
        if (!info || !info.id) {
          bvhFailures.push(`resolveInspectedFeature returned null on ${s.mesh.name} in ${tile.id}`);
          continue;
        }
        if (s.expectedSourceFeatureId && info.sourceFeatureId !== s.expectedSourceFeatureId) {
          bvhFailures.push(
            `Inspected sourceFeatureId mismatch on ${s.mesh.name} in ${tile.id}: got ${info.sourceFeatureId}, expected ${s.expectedSourceFeatureId}`
          );
          continue;
        }
        samplesPassed++;
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
        bakeStudyRegionTilesToSqlite({
          ingested,
          outPath: tmpPack,
          snapshotId: metadata.snapshotId,
          sourceSha256: metadata.sourceSha256,
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
  const packPath = options.packPath ?? resolveDefaultTilePackPath();
  const expectedSha256 = options.expectedSha256 ?? OVERIJSSEL_PBF_EXPECTED_SHA256;
  const tileSizeMeters = options.tileSizeMeters ?? DEFAULT_TILE_SIZE_METERS;
  const collarMeters = options.collarMeters ?? DEFAULT_COLLAR_METERS;

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
