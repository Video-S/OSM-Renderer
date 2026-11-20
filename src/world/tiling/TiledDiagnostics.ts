import * as THREE from 'three';
import type {
  BuildingFeature,
  InspectableFeatureInfo,
  PointLandmarkFeature,
} from '../../types/MapFeature';
import type { BuiltSceneGeometry, FaceFeatureRange } from '../GeometryBuilder';
import { SceneResourceManager } from '../SceneResourceManager';
import { clipBufferGeometryToBoxXZ } from './MeshBoxClipper';
import { auditCollarSufficiency } from './CollarAudit';
import {
  getRingsBBoxCentroid,
  pointInHalfOpenBox,
  type StudyGridSpec,
  type TileDescriptor,
} from './TileGrid';
import type {
  BuiltTileEntry,
  IngestedStudyRegion,
  SingleSceneReferenceResult,
  TiledStudyBuildResult,
} from './TiledStudyPipeline';
import {
  validateTiledSeamContinuity,
  type SeamValidationReport,
} from './SeamValidator';

const DEFAULT_MAX_SAMPLE_IDS_PER_TILE = 10;

export interface TileSynthesisDivergence {
  tileId: string;
  hasGeometryDivergence: boolean;
  hasMetadataDivergence: boolean;
  bBuildings: number;
  cBuildings: number;
  bBuildingTris: number;
  cBuildingTris: number;
  bTrees: number;
  cTrees: number;
  bSleepers: number;
  cSleepers: number;
  maxRoadClassAreaDiffM2: number;
  worstRoadClass?: string;
  extraSourceIdCount: number;
  missingSourceIdCount: number;
  sampleExtraSourceIds: string[];
  sampleMissingSourceIds: string[];
  extraSourceIdsInC: string[];
  missingSourceIdsInC: string[];
}

export interface DiagnosticAbcReport {
  /** Validates (A) single-scene reference vs (B) reference scene directly clipped/partitioned into tiles. Isolates clipper/validator bugs. */
  aVsB: SeamValidationReport;
  /** Compares (B) partitioned reference tiles vs (C) independently built M1a tiles. Isolates synthesis divergences. */
  bVsC: {
    isExactMatch: boolean;
    isGeometryExactMatch: boolean;
    tilesCompared: number;
    tilesWithDivergence: number;
    tilesWithGeometryDivergence: number;
    tilesWithMetadataDivergence: number;
    divergentTiles: TileSynthesisDivergence[];
    totalRoadAreaDiffByClassM2: Record<string, { bAreaM2: number; cAreaM2: number; diffM2: number }>;
    totalBuildingCountB: number;
    totalBuildingCountC: number;
    totalTreesB: number;
    totalTreesC: number;
    totalSleepersB: number;
    totalSleepersC: number;
  };
  timingMs: {
    partitionRefToBMs: number;
    validateAVsBMs: number;
    compareBVsCMs: number;
  };
}

function cloneStaticGroupWithClip(
  srcGroup: THREE.Group,
  tile: TileDescriptor,
  disposables: THREE.BufferGeometry[]
): THREE.Group {
  const dstGroup = new THREE.Group();
  dstGroup.name = srcGroup.name;
  dstGroup.renderOrder = srcGroup.renderOrder;
  dstGroup.userData = srcGroup.userData ? { ...srcGroup.userData } : {};

  srcGroup.traverse((obj) => {
    if ((obj as THREE.InstancedMesh).isInstancedMesh) return;
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const srcFaceRanges = mesh.userData?.faceRanges as FaceFeatureRange[] | undefined;
    let srcGeo = mesh.geometry;
    let needsTempDispose = false;
    if (mesh.position.x !== 0 || mesh.position.y !== 0 || mesh.position.z !== 0) {
      srcGeo = mesh.geometry.clone();
      srcGeo.translate(mesh.position.x, mesh.position.y, mesh.position.z);
      needsTempDispose = true;
    }
    const clipped = clipBufferGeometryToBoxXZ(srcGeo, tile.localBounds, srcFaceRanges);
    if (needsTempDispose) srcGeo.dispose();
    if (!clipped) return;
    disposables.push(clipped);
    const dstMesh = new THREE.Mesh(clipped, mesh.material);
    dstMesh.name = mesh.name;
    dstMesh.renderOrder = mesh.renderOrder;
    const nextUserData: Record<string, unknown> = {
      ...mesh.userData,
    };
    if (Array.isArray(srcFaceRanges)) {
      nextUserData.faceRanges = (clipped.userData?.faceRanges as FaceFeatureRange[] | undefined) ?? [];
      delete nextUserData.id;
      delete nextUserData.sourceFeatureId;
      delete nextUserData.sourceFeatureIds;
    } else if (clipped.userData?.faceRanges) {
      nextUserData.faceRanges = clipped.userData.faceRanges;
    }
    dstMesh.userData = nextUserData;
    dstGroup.add(dstMesh);
  });

  return dstGroup;
}

function partitionPointOwnedFoliageMeshesIntoTiles(
  refFoliageGroup: THREE.Group,
  grid: StudyGridSpec,
  landmarks: readonly PointLandmarkFeature[] = []
): Map<string, FaceFeatureRange[]> {
  const perTile = new Map<string, FaceFeatureRange[]>();
  for (const tile of grid.tiles) {
    perTile.set(tile.id, []);
  }

  const landmarkPosById = new Map<string, [number, number]>();
  for (const lm of landmarks) {
    landmarkPosById.set(lm.id, [lm.position[0], lm.position[1]]);
  }

  refFoliageGroup.traverse((obj) => {
    if ((obj as THREE.InstancedMesh).isInstancedMesh) return;
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr) return;
    const idxAttr = mesh.geometry.getIndex();
    const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(posAttr.count / 3);
    const faceRanges = mesh.userData?.faceRanges as FaceFeatureRange[] | undefined;
    if (!faceRanges || faceRanges.length === 0) return;

    for (const r of faceRanges) {
      let pt = landmarkPosById.get(r.info.id);
      if (!pt) {
        let minX = Infinity;
        let maxX = -Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        const fEnd = Math.min(triCount, r.endFace);
        for (let f = r.startFace; f < fEnd; f++) {
          for (let k = 0; k < 3; k++) {
            const vi = idxAttr ? idxAttr.getX(f * 3 + k) : f * 3 + k;
            const x = posAttr.getX(vi) + mesh.position.x;
            const z = posAttr.getZ(vi) + mesh.position.z;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
          }
        }
        if (Number.isFinite(minX) && Number.isFinite(minZ)) {
          pt = [(minX + maxX) * 0.5, (minZ + maxZ) * 0.5];
        }
      }
      if (!pt) continue;
      for (const tile of grid.tiles) {
        if (pointInHalfOpenBox(pt[0], pt[1], tile.localBounds)) {
          const list = perTile.get(tile.id)!;
          const triSpan = Math.max(1, r.endFace - r.startFace);
          const startFace = list.length > 0 ? list[list.length - 1].endFace : 0;
          list.push({
            startFace,
            endFace: startFace + triSpan,
            info: r.info,
          });
          break;
        }
      }
    }
  });

  return perTile;
}

function partitionBuildingsIntoTiles(
  refBuildingsGroup: THREE.Group,
  grid: StudyGridSpec,
  buildings: readonly BuildingFeature[] = []
): Map<string, Map<string, { tris: number; info: InspectableFeatureInfo }>> {
  const perTile = new Map<string, Map<string, { tris: number; info: InspectableFeatureInfo }>>();
  for (const tile of grid.tiles) {
    perTile.set(tile.id, new Map());
  }

  const canonicalCentroids = new Map<string, [number, number]>();
  for (const b of buildings) {
    if (b.footprint && b.footprint.length > 0) {
      canonicalCentroids.set(b.id, getRingsBBoxCentroid(b.footprint));
    }
  }

  // First pass: accumulate triangle counts and fallback 2D bbox per building ID across all meshes/faceRanges
  const accum = new Map<
    string,
    {
      minX: number;
      maxX: number;
      minZ: number;
      maxZ: number;
      vertCount: number;
      tris: number;
      info: InspectableFeatureInfo;
    }
  >();

  refBuildingsGroup.traverse((obj) => {
    if ((obj as THREE.InstancedMesh).isInstancedMesh) return;
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr) return;
    const idxAttr = mesh.geometry.getIndex();
    const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(posAttr.count / 3);
    const faceRanges = mesh.userData?.faceRanges as FaceFeatureRange[] | undefined;

    if (faceRanges && faceRanges.length > 0) {
      for (const r of faceRanges) {
        const key = r.info.id;
        let entry = accum.get(key);
        if (!entry) {
          entry = {
            minX: Infinity,
            maxX: -Infinity,
            minZ: Infinity,
            maxZ: -Infinity,
            vertCount: 0,
            tris: 0,
            info: r.info,
          };
          accum.set(key, entry);
        }
        const fEnd = Math.min(triCount, r.endFace);
        entry.tris += Math.max(0, fEnd - r.startFace);
        for (let f = r.startFace; f < fEnd; f++) {
          for (let k = 0; k < 3; k++) {
            const vi = idxAttr ? idxAttr.getX(f * 3 + k) : f * 3 + k;
            const x = posAttr.getX(vi) + mesh.position.x;
            const z = posAttr.getZ(vi) + mesh.position.z;
            if (x < entry.minX) entry.minX = x;
            if (x > entry.maxX) entry.maxX = x;
            if (z < entry.minZ) entry.minZ = z;
            if (z > entry.maxZ) entry.maxZ = z;
            entry.vertCount++;
          }
        }
      }
    } else if (mesh.userData?.id) {
      const key = String(mesh.userData.id);
      let entry = accum.get(key);
      if (!entry) {
        entry = {
          minX: Infinity,
          maxX: -Infinity,
          minZ: Infinity,
          maxZ: -Infinity,
          vertCount: 0,
          tris: 0,
          info: mesh.userData as InspectableFeatureInfo,
        };
        accum.set(key, entry);
      }
      entry.tris += triCount;
      for (let i = 0; i < posAttr.count; i++) {
        const x = posAttr.getX(i) + mesh.position.x;
        const z = posAttr.getZ(i) + mesh.position.z;
        if (x < entry.minX) entry.minX = x;
        if (x > entry.maxX) entry.maxX = x;
        if (z < entry.minZ) entry.minZ = z;
        if (z > entry.maxZ) entry.maxZ = z;
        entry.vertCount++;
      }
    }
  });

  for (const [bid, entry] of accum.entries()) {
    if (entry.vertCount === 0) continue;
    const [cx, cz] = canonicalCentroids.get(bid) ?? [
      (entry.minX + entry.maxX) * 0.5,
      (entry.minZ + entry.maxZ) * 0.5,
    ];
    for (const tile of grid.tiles) {
      if (pointInHalfOpenBox(cx, cz, tile.localBounds)) {
        perTile.get(tile.id)!.set(bid, { tris: entry.tris, info: entry.info });
        break;
      }
    }
  }

  return perTile;
}

function createVirtualBuildingMeshForTile(
  entries: Map<string, { tris: number; info: InspectableFeatureInfo }>,
  disposables: THREE.BufferGeometry[]
): THREE.Mesh | null {
  if (entries.size === 0) return null;
  let totalTris = 0;
  for (const e of entries.values()) totalTris += e.tris;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(totalTris * 9), 3));
  const faceRanges: FaceFeatureRange[] = [];
  let cursor = 0;
  for (const e of entries.values()) {
    faceRanges.push({
      startFace: cursor,
      endFace: cursor + e.tris,
      info: e.info,
    });
    cursor += e.tris;
  }
  disposables.push(geom);
  const mesh = new THREE.Mesh(geom);
  mesh.name = 'VirtualPartitionedBuildings';
  mesh.userData = { faceRanges };
  return mesh;
}

function countInstancedWithinBox(
  root: THREE.Object3D,
  tile: TileDescriptor,
  meshNameFilter?: (name: string) => boolean
): { count: number; infos: InspectableFeatureInfo[] } {
  let count = 0;
  const infos: InspectableFeatureInfo[] = [];
  const mat = new THREE.Matrix4();
  root.traverse((obj) => {
    if (!(obj as THREE.InstancedMesh).isInstancedMesh) return;
    const im = obj as THREE.InstancedMesh;
    if (meshNameFilter && !meshNameFilter(im.name)) return;
    const instInfos = im.userData?.instanceInfos as InspectableFeatureInfo[] | undefined;
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, mat);
      const tx = mat.elements[12] + im.position.x;
      const tz = mat.elements[14] + im.position.z;
      if (pointInHalfOpenBox(tx, tz, tile.localBounds)) {
        count++;
        if (instInfos && instInfos[i]) {
          infos.push(instInfos[i]);
        }
      }
    }
  });
  return { count, infos };
}

function sumRoadAreasByClass(group: THREE.Group): Record<string, number> {
  const totals: Record<string, number> = {};
  group.traverse((obj) => {
    if ((obj as THREE.InstancedMesh).isInstancedMesh) return;
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    if (!mesh.name.startsWith('Roads_')) return;
    const cls = mesh.name.slice('Roads_'.length);
    const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr) return;
    const idxAttr = mesh.geometry.getIndex();
    const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(posAttr.count / 3);
    let area = 0;
    for (let f = 0; f < triCount; f++) {
      const i0 = idxAttr ? idxAttr.getX(f * 3) : f * 3;
      const i1 = idxAttr ? idxAttr.getX(f * 3 + 1) : f * 3 + 1;
      const i2 = idxAttr ? idxAttr.getX(f * 3 + 2) : f * 3 + 2;
      const x0 = posAttr.getX(i0);
      const y0 = posAttr.getY(i0);
      const z0 = posAttr.getZ(i0);
      const ax = posAttr.getX(i1) - x0;
      const ay = posAttr.getY(i1) - y0;
      const az = posAttr.getZ(i1) - z0;
      const bx = posAttr.getX(i2) - x0;
      const by = posAttr.getY(i2) - y0;
      const bz = posAttr.getZ(i2) - z0;
      const cy = az * bx - ax * bz;
      const cx = ay * bz - az * by;
      const cz = ax * by - ay * bx;
      const len3 = Math.hypot(cx, cy, cz);
      if (len3 > 1e-12 && Math.abs(cy / len3) >= 0.5) {
        area += 0.5 * Math.abs(cy);
      }
    }
    totals[cls] = (totals[cls] ?? 0) + area;
  });
  return totals;
}

function collectSourceIdsFromGroupList(groups: THREE.Group[]): Set<string> {
  const sids = new Set<string>();
  for (const grp of groups) {
    grp.traverse((obj) => {
      const ud = obj.userData;
      if (!ud) return;
      if (Array.isArray(ud.faceRanges)) {
        for (const r of ud.faceRanges as FaceFeatureRange[]) {
          if (r.info?.sourceFeatureId) sids.add(r.info.sourceFeatureId);
          if (Array.isArray(r.info?.sourceFeatureIds)) {
            for (const s of r.info.sourceFeatureIds) if (s) sids.add(s);
          }
        }
      }
      if (Array.isArray(ud.instanceInfos)) {
        for (const info of ud.instanceInfos as InspectableFeatureInfo[]) {
          if (info?.sourceFeatureId) sids.add(info.sourceFeatureId);
          if (Array.isArray(info?.sourceFeatureIds)) {
            for (const s of info.sourceFeatureIds) if (s) sids.add(s);
          }
        }
      }
      if (typeof ud.sourceFeatureId === 'string' && ud.sourceFeatureId) {
        sids.add(ud.sourceFeatureId);
      }
    });
  }
  return sids;
}

function extractBuildingCounts(group: THREE.Group): { count: number; tris: number } {
  const seen = new Map<string, number>();
  group.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh || (obj as THREE.InstancedMesh).isInstancedMesh) return;
    const mesh = obj as THREE.Mesh;
    const faceRanges = mesh.userData?.faceRanges as FaceFeatureRange[] | undefined;
    if (faceRanges) {
      for (const r of faceRanges) {
        seen.set(r.info.id, (seen.get(r.info.id) ?? 0) + (r.endFace - r.startFace));
      }
    }
  });
  let tris = 0;
  for (const t of seen.values()) tris += t;
  return { count: seen.size, tris };
}

/**
 * Diagnostic A / B / C separation helper:
 * - (A) `reference.scene` (single-scene build clipped to study bounds)
 * - (B) (A) partitioned & clipped directly into `ingested.grid` tiles via `clipBufferGeometryToBoxXZ`
 *       and centroid ownership (zero per-tile synthesis)
 * - (C) `tiled.tiles` (independently built M1a tiles)
 *
 * `aVsB` isolates clipper / validator defects.
 * `bVsC` isolates per-tile synthesis divergences.
 */
export function runDiagnosticAbcComparison(params: {
  ingested: IngestedStudyRegion;
  reference: SingleSceneReferenceResult;
  tiled: TiledStudyBuildResult;
  includeFullIdLists?: boolean;
  maxSampleIdsPerTile?: number;
}): DiagnosticAbcReport {
  const { ingested, reference, tiled } = params;
  const includeFullIdLists = Boolean(params.includeFullIdLists);
  const maxSampleIds = params.maxSampleIdsPerTile ?? DEFAULT_MAX_SAMPLE_IDS_PER_TILE;
  const disposables: THREE.BufferGeometry[] = [];
  const tPart0 = performance.now();

  try {
    const buildingOwnership = partitionBuildingsIntoTiles(
      reference.scene.buildingsGroup,
      ingested.grid,
      ingested.data.buildings
    );
    const pointFoliageOwnership = partitionPointOwnedFoliageMeshesIntoTiles(
      reference.scene.foliageGroup,
      ingested.grid,
      ingested.data.landmarks
    );
    const partitionedEntries: BuiltTileEntry[] = [];

    for (const tile of ingested.grid.tiles) {
      const buildingsGroup = new THREE.Group();
      buildingsGroup.name = 'BuildingsGroup';
      const bMap = buildingOwnership.get(tile.id)!;
      const bMesh = createVirtualBuildingMeshForTile(bMap, disposables);
      if (bMesh) buildingsGroup.add(bMesh);

      const roadsGroup = cloneStaticGroupWithClip(reference.scene.roadsGroup, tile, disposables);
      const railwaysGroup = cloneStaticGroupWithClip(reference.scene.railwaysGroup, tile, disposables);
      const waterGroup = cloneStaticGroupWithClip(reference.scene.waterGroup, tile, disposables);
      const parksGroup = cloneStaticGroupWithClip(reference.scene.parksGroup, tile, disposables);
      const landuseGroup = cloneStaticGroupWithClip(reference.scene.landuseGroup, tile, disposables);
      const barriersGroup = cloneStaticGroupWithClip(reference.scene.barriersGroup, tile, disposables);

      const sleepersInTile = countInstancedWithinBox(
        reference.scene.railwaysGroup,
        tile,
        (n) => n.startsWith('Railway_Sleepers_3D')
      );
      railwaysGroup.userData.railwayStats = {
        ...(railwaysGroup.userData.railwayStats ?? {}),
        sleeper3DBoxCount: sleepersInTile.count,
      };
      if (sleepersInTile.infos.length > 0) {
        const sleeperMetaNode = new THREE.Group();
        sleeperMetaNode.name = 'VirtualSleeperInfos';
        sleeperMetaNode.userData = { instanceInfos: sleepersInTile.infos };
        railwaysGroup.add(sleeperMetaNode);
      }

      const treesInTile = countInstancedWithinBox(
        reference.scene.foliageGroup,
        tile,
        (n) => n === 'ProceduralForest_Trunks'
      );
      const allFoliageInfos = countInstancedWithinBox(reference.scene.foliageGroup, tile);
      const foliageGroup = new THREE.Group();
      foliageGroup.name = reference.scene.foliageGroup.name;
      const pointFoliageRanges = pointFoliageOwnership.get(tile.id) ?? [];
      if (pointFoliageRanges.length > 0) {
        const lmMetaNode = new THREE.Group();
        lmMetaNode.name = 'VirtualPointLandmarksAndFurniture';
        lmMetaNode.userData = { faceRanges: pointFoliageRanges };
        foliageGroup.add(lmMetaNode);
      }
      if (allFoliageInfos.infos.length > 0) {
        const foliageMetaNode = new THREE.Group();
        foliageMetaNode.name = 'VirtualFoliageInfos';
        foliageMetaNode.userData = { instanceInfos: allFoliageInfos.infos };
        foliageGroup.add(foliageMetaNode);
      }

      const groundGeo = new THREE.PlaneGeometry(
        tile.localBounds.maxX - tile.localBounds.minX,
        tile.localBounds.maxZ - tile.localBounds.minZ
      );
      disposables.push(groundGeo);
      const groundMesh = new THREE.Mesh(groundGeo);

      const emptyRes = new SceneResourceManager();
      const virtualScene: BuiltSceneGeometry = {
        buildingsGroup,
        roadsGroup,
        railwaysGroup,
        waterGroup,
        parksGroup,
        landuseGroup,
        barriersGroup,
        foliageGroup,
        groundMesh,
        interactiveMeshes: { buildings: [] },
        stats: {
          totalVertices: 0,
          totalTriangles: 0,
          totalDrawCalls: 0,
          renderedFeaturesCount: 0,
          forestTreesCount: treesInTile.count,
        },
        resources: emptyRes,
        infrastructureRenderOptions: ingested.infrastructureRenderOptions,
        infrastructureRenderPreview: null,
        dispose: () => {},
        updateTheme: () => {},
      };

      partitionedEntries.push({
        tile,
        scene: virtualScene,
        buildTimeMs: 0,
        inputCounts: {
          buildings: bMap.size,
          roads: 0,
          railways: 0,
          landuse: 0,
          parks: 0,
          waterBodies: 0,
          linearWaterways: 0,
          barriers: 0,
          landmarks: 0,
        },
      });
    }

    const partitionRefToBMs = Number((performance.now() - tPart0).toFixed(2));
    const emptyCollarAudit =
      tiled.collarAudit ??
      auditCollarSufficiency({
        data: ingested.data,
        grid: ingested.grid,
        descriptors: ingested.descriptors,
        roadGradeSeparatedPlans: ingested.precomputedGlobalPlans.roadGradeSeparatedPlans,
        railwayGradeSeparatedPlans: ingested.precomputedGlobalPlans.railwayGradeSeparatedPlans,
        hasGlobalAtGradeRoadPlan: Boolean(ingested.precomputedGlobalPlans.atGradeRoadPlan),
        hasGlobalBarrierResolution: Boolean(ingested.precomputedGlobalPlans.barrierResolution),
      });

    const partitionedB: TiledStudyBuildResult = {
      grid: ingested.grid,
      tiles: partitionedEntries,
      collarAudit: emptyCollarAudit,
      totalBuildTimeMs: partitionRefToBMs,
      maxTileBuildTimeMs: 0,
      avgTileBuildTimeMs: 0,
      peakMemory: tiled.peakMemory,
      memoryAfterAllTiles: tiled.memoryAfterAllTiles,
      dispose: () => {},
    };

    const tVal0 = performance.now();
    const aVsB = validateTiledSeamContinuity({ reference, tiled: partitionedB });
    const validateAVsBMs = Number((performance.now() - tVal0).toFixed(2));

    const tCmp0 = performance.now();
    const cByTileId = new Map(tiled.tiles.map((t) => [t.tile.id, t]));
    const divergentTiles: TileSynthesisDivergence[] = [];
    let tilesWithGeometryDivergence = 0;
    let tilesWithMetadataDivergence = 0;
    const totalRoadAreaDiffByClassM2: Record<
      string,
      { bAreaM2: number; cAreaM2: number; diffM2: number }
    > = {};
    let totalBuildingCountB = 0;
    let totalBuildingCountC = 0;
    let totalTreesB = 0;
    let totalTreesC = 0;
    let totalSleepersB = 0;
    let totalSleepersC = 0;

    for (const bEntry of partitionedEntries) {
      const cEntry = cByTileId.get(bEntry.tile.id);
      if (!cEntry) continue;

      const bBldg = extractBuildingCounts(bEntry.scene.buildingsGroup);
      const cBldg = extractBuildingCounts(cEntry.scene.buildingsGroup);
      totalBuildingCountB += bBldg.count;
      totalBuildingCountC += cBldg.count;

      const bTrees = bEntry.scene.stats.forestTreesCount ?? 0;
      const cTrees = cEntry.scene.stats.forestTreesCount ?? 0;
      totalTreesB += bTrees;
      totalTreesC += cTrees;

      const bSleepers = bEntry.scene.railwaysGroup.userData?.railwayStats?.sleeper3DBoxCount ?? 0;
      const cSleepers = cEntry.scene.railwaysGroup.userData?.railwayStats?.sleeper3DBoxCount ?? 0;
      totalSleepersB += bSleepers;
      totalSleepersC += cSleepers;

      const bRoads = sumRoadAreasByClass(bEntry.scene.roadsGroup);
      const cRoads = sumRoadAreasByClass(cEntry.scene.roadsGroup);
      const classes = new Set([...Object.keys(bRoads), ...Object.keys(cRoads)]);
      let maxRoadClassAreaDiffM2 = 0;
      let worstRoadClass: string | undefined;
      for (const cls of classes) {
        const ba = bRoads[cls] ?? 0;
        const ca = cRoads[cls] ?? 0;
        const diff = Math.abs(ca - ba);
        if (diff > maxRoadClassAreaDiffM2) {
          maxRoadClassAreaDiffM2 = diff;
          worstRoadClass = cls;
        }
        const agg = (totalRoadAreaDiffByClassM2[cls] ??= {
          bAreaM2: 0,
          cAreaM2: 0,
          diffM2: 0,
        });
        agg.bAreaM2 += ba;
        agg.cAreaM2 += ca;
      }

      const bSids = collectSourceIdsFromGroupList([
        bEntry.scene.buildingsGroup,
        bEntry.scene.roadsGroup,
        bEntry.scene.railwaysGroup,
        bEntry.scene.waterGroup,
        bEntry.scene.parksGroup,
        bEntry.scene.landuseGroup,
        bEntry.scene.barriersGroup,
        bEntry.scene.foliageGroup,
      ]);
      const cSids = collectSourceIdsFromGroupList([
        cEntry.scene.buildingsGroup,
        cEntry.scene.roadsGroup,
        cEntry.scene.railwaysGroup,
        cEntry.scene.waterGroup,
        cEntry.scene.parksGroup,
        cEntry.scene.landuseGroup,
        cEntry.scene.barriersGroup,
        cEntry.scene.foliageGroup,
      ]);
      const allExtraSourceIdsInC = [...cSids].filter((id) => !bSids.has(id)).sort();
      const allMissingSourceIdsInC = [...bSids].filter((id) => !cSids.has(id)).sort();

      const hasGeometryDivergence =
        bBldg.count !== cBldg.count ||
        bBldg.tris !== cBldg.tris ||
        bTrees !== cTrees ||
        bSleepers !== cSleepers ||
        maxRoadClassAreaDiffM2 > 0.05;
      const hasMetadataDivergence =
        allExtraSourceIdsInC.length > 0 || allMissingSourceIdsInC.length > 0;

      if (hasGeometryDivergence) tilesWithGeometryDivergence++;
      if (hasMetadataDivergence) tilesWithMetadataDivergence++;

      if (hasGeometryDivergence || hasMetadataDivergence) {
        const sampleExtraSourceIds = allExtraSourceIdsInC.slice(0, maxSampleIds);
        const sampleMissingSourceIds = allMissingSourceIdsInC.slice(0, maxSampleIds);
        divergentTiles.push({
          tileId: bEntry.tile.id,
          hasGeometryDivergence,
          hasMetadataDivergence,
          bBuildings: bBldg.count,
          cBuildings: cBldg.count,
          bBuildingTris: bBldg.tris,
          cBuildingTris: cBldg.tris,
          bTrees,
          cTrees,
          bSleepers,
          cSleepers,
          maxRoadClassAreaDiffM2: Number(maxRoadClassAreaDiffM2.toFixed(4)),
          worstRoadClass,
          extraSourceIdCount: allExtraSourceIdsInC.length,
          missingSourceIdCount: allMissingSourceIdsInC.length,
          sampleExtraSourceIds,
          sampleMissingSourceIds,
          extraSourceIdsInC: includeFullIdLists ? allExtraSourceIdsInC : sampleExtraSourceIds,
          missingSourceIdsInC: includeFullIdLists ? allMissingSourceIdsInC : sampleMissingSourceIds,
        });
      }
    }

    for (const cls of Object.keys(totalRoadAreaDiffByClassM2)) {
      const agg = totalRoadAreaDiffByClassM2[cls];
      agg.bAreaM2 = Number(agg.bAreaM2.toFixed(4));
      agg.cAreaM2 = Number(agg.cAreaM2.toFixed(4));
      agg.diffM2 = Number(Math.abs(agg.cAreaM2 - agg.bAreaM2).toFixed(4));
    }

    const compareBVsCMs = Number((performance.now() - tCmp0).toFixed(2));

    return {
      aVsB,
      bVsC: {
        isExactMatch: divergentTiles.length === 0,
        isGeometryExactMatch: tilesWithGeometryDivergence === 0,
        tilesCompared: partitionedEntries.length,
        tilesWithDivergence: divergentTiles.length,
        tilesWithGeometryDivergence,
        tilesWithMetadataDivergence,
        divergentTiles,
        totalRoadAreaDiffByClassM2,
        totalBuildingCountB,
        totalBuildingCountC,
        totalTreesB,
        totalTreesC,
        totalSleepersB,
        totalSleepersC,
      },
      timingMs: {
        partitionRefToBMs,
        validateAVsBMs,
        compareBVsCMs,
      },
    };
  } finally {
    for (const g of disposables) {
      g.dispose();
    }
  }
}
