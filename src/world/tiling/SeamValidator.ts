import * as THREE from 'three';
import type { InspectableFeatureInfo } from '../../types/MapFeature';
import type { BuiltSceneGeometry, FaceFeatureRange } from '../GeometryBuilder';
import {
  auditGraphRoadMeshIntegrity,
  type GraphRoadMeshIntegrityReport,
} from '../infrastructure/roads/GraphRoadGeometryBuilder';
import type { SleeperBearerBox3D } from '../infrastructure/railways/RailwayTopology';
import { RAILWAY_DIMENSION_SPEC } from '../infrastructure/railways/RailwayTopology';
import type { CollarAuditReport } from './CollarAudit';
import type { BuiltTileEntry, SingleSceneReferenceResult, TiledStudyBuildResult } from './TiledStudyPipeline';
import type { StudyGridSpec, TileDescriptor } from './TileGrid';

export interface SeamLineSpec {
  id: string;
  orientation: 'vertical' | 'horizontal';
  coord: number; // x if vertical, z if horizontal
  spanMin: number; // zMin if vertical, xMin if horizontal
  spanMax: number; // zMax if vertical, xMax if horizontal
  tileAId: string;
  tileBId: string;
}

export interface SeamDefect {
  category:
    | 'road_boundary_end_cap'
    | 'road_seam_overlap'
    | 'road_area_mismatch'
    | 'road_mesh_integrity'
    | 'railway_ballast_overlap'
    | 'railway_ballast_area_mismatch'
    | 'railway_sleeper_parity'
    | 'railway_sleeper_seam_overlap'
    | 'railway_phase_discontinuity'
    | 'bridge_elevation_discontinuity'
    | 'planar_seam_overlap'
    | 'planar_area_mismatch'
    | 'building_parity_or_split'
    | 'tree_parity'
    | 'landmark_parity'
    | 'provenance_mismatch';
  seamId?: string;
  tileAId?: string;
  tileBId?: string;
  layer?: string;
  detail: string;
  measuredValue?: number;
  tolerance?: number;
}

export interface SeamValidationReport {
  isValid: boolean;
  tilesProcessed: number;
  nonEmptyTiles: number;
  emptyTiles: number;
  internalSeamsChecked: number;
  areaComparisons: {
    roadsByClass: Record<string, { refAreaM2: number; tiledAreaM2: number; diffM2: number }>;
    ballast: { refAreaM2: number; tiledAreaM2: number; diffM2: number };
    landuseBySubtype: Record<string, { refAreaM2: number; tiledAreaM2: number; diffM2: number }>;
    parksBySubtype: Record<string, { refAreaM2: number; tiledAreaM2: number; diffM2: number }>;
    water: { refAreaM2: number; tiledAreaM2: number; diffM2: number };
  };
  buildingParity: {
    refCount: number;
    tiledUniqueCount: number;
    tiledTotalEmitted: number;
    missingFromTiles: string[];
    duplicatedAcrossTiles: string[];
    triangleMismatches: Array<{ sourceFeatureId: string; refTris: number; tiledTris: number }>;
  };
  railwayParity: {
    refSleeperCount: number;
    tiledSleeperCount: number;
    maxPhaseDiscontinuityU: number;
    maxRailElevationDiscontinuityM: number;
  };
  bridgeContinuity: {
    maxDeckElevationDiscontinuityM: number;
  };
  provenanceParity: {
    refSourceFeatureCount: number;
    tiledSourceFeatureCount: number;
    missingSourceFeatureIds: string[];
    extraSourceFeatureIds: string[];
  };
  roadIntegrityFailures: Array<{ tileId: string; report: GraphRoadMeshIntegrityReport }>;
  collarAudit: CollarAuditReport;
  defects: SeamDefect[];
}

interface ExtractedTri2D {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  yMean: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  areaXZ: number;
  featureId?: string;
}

function collectGroupMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh && !(obj as THREE.InstancedMesh).isInstancedMesh) {
      meshes.push(obj as THREE.Mesh);
    }
  });
  return meshes;
}

function extractUpwardTrianglesXZ(
  mesh: THREE.Mesh,
  bandFilter?: { orientation: 'vertical' | 'horizontal'; coord: number; halfWidth: number }
): ExtractedTri2D[] {
  const geo = mesh.geometry;
  const posAttr = geo?.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!posAttr) return [];
  const idxAttr = geo.getIndex();
  const faceCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(posAttr.count / 3);
  const faceRanges = mesh.userData?.faceRanges as FaceFeatureRange[] | undefined;
  let rangeIdx = 0;
  const tris: ExtractedTri2D[] = [];

  const px = mesh.position.x;
  const py = mesh.position.y;
  const pz = mesh.position.z;

  for (let f = 0; f < faceCount; f++) {
    const i0 = idxAttr ? idxAttr.getX(f * 3) : f * 3;
    const i1 = idxAttr ? idxAttr.getX(f * 3 + 1) : f * 3 + 1;
    const i2 = idxAttr ? idxAttr.getX(f * 3 + 2) : f * 3 + 2;

    const x0 = posAttr.getX(i0) + px;
    const y0 = posAttr.getY(i0) + py;
    const z0 = posAttr.getZ(i0) + pz;
    const x1 = posAttr.getX(i1) + px;
    const y1 = posAttr.getY(i1) + py;
    const z1 = posAttr.getZ(i1) + pz;
    const x2 = posAttr.getX(i2) + px;
    const y2 = posAttr.getY(i2) + py;
    const z2 = posAttr.getZ(i2) + pz;

    const minX = Math.min(x0, x1, x2);
    const maxX = Math.max(x0, x1, x2);
    const minZ = Math.min(z0, z1, z2);
    const maxZ = Math.max(z0, z1, z2);

    if (bandFilter) {
      if (bandFilter.orientation === 'vertical') {
        if (maxX < bandFilter.coord - bandFilter.halfWidth || minX > bandFilter.coord + bandFilter.halfWidth) {
          continue;
        }
      } else {
        if (maxZ < bandFilter.coord - bandFilter.halfWidth || minZ > bandFilter.coord + bandFilter.halfWidth) {
          continue;
        }
      }
    }

    // 3D normal Y component
    const ax = x1 - x0;
    const ay = y1 - y0;
    const az = z1 - z0;
    const bx = x2 - x0;
    const by = y2 - y0;
    const bz = z2 - z0;
    const nyCross = az * bx - ax * bz;
    const nxCross = ay * bz - az * by;
    const nzCross = ax * by - ay * bx;
    const len3 = Math.hypot(nxCross, nyCross, nzCross);
    if (len3 <= 1e-12) continue;
    if (Math.abs(nyCross / len3) < 0.5) continue;

    const areaXZ = 0.5 * Math.abs((x1 - x0) * (z2 - z0) - (x2 - x0) * (z1 - z0));
    if (areaXZ <= 1e-11) continue;

    let featureId: string | undefined;
    if (faceRanges) {
      while (rangeIdx < faceRanges.length && f >= faceRanges[rangeIdx].endFace) {
        rangeIdx++;
      }
      const r = faceRanges[rangeIdx];
      if (r && f >= r.startFace && f < r.endFace) {
        featureId = r.info.sourceFeatureId || r.info.id;
      }
    }

    tris.push({
      x0,
      z0,
      x1,
      z1,
      x2,
      z2,
      yMean: (y0 + y1 + y2) / 3,
      minX,
      maxX,
      minZ,
      maxZ,
      areaXZ,
      featureId,
    });
  }
  return tris;
}

function sumGroupSurfaceAreaByMeshPrefix(
  group: THREE.Group,
  prefix: string
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const mesh of collectGroupMeshes(group)) {
    if (!mesh.name.startsWith(prefix)) continue;
    const key = mesh.name.slice(prefix.length) || mesh.name;
    const tris = extractUpwardTrianglesXZ(mesh);
    let area = 0;
    for (const t of tris) area += t.areaXZ;
    totals[key] = (totals[key] ?? 0) + area;
  }
  return totals;
}

function sumGroupTotalSurfaceArea(group: THREE.Group, filterName?: (name: string) => boolean): number {
  let area = 0;
  for (const mesh of collectGroupMeshes(group)) {
    if (filterName && !filterName(mesh.name)) continue;
    const tris = extractUpwardTrianglesXZ(mesh);
    for (const t of tris) area += t.areaXZ;
  }
  return area;
}

// Exact 2D convex triangle-triangle intersection area using Sutherland-Hodgman
function computeTriangleOverlapAreaXZ(a: ExtractedTri2D, b: ExtractedTri2D): number {
  if (a.maxX <= b.minX || a.minX >= b.maxX || a.maxZ <= b.minZ || a.minZ >= b.maxZ) {
    return 0;
  }

  let poly: Array<[number, number]> = [
    [a.x0, a.z0],
    [a.x1, a.z1],
    [a.x2, a.z2],
  ];

  // Ensure clip triangle b is CCW in (x, z)
  const signedB = (b.x1 - b.x0) * (b.z2 - b.z0) - (b.x2 - b.x0) * (b.z1 - b.z0);
  if (Math.abs(signedB) < 1e-12) return 0;
  const clipEdges: Array<[number, number, number, number]> =
    signedB > 0
      ? [
          [b.x0, b.z0, b.x1, b.z1],
          [b.x1, b.z1, b.x2, b.z2],
          [b.x2, b.z2, b.x0, b.z0],
        ]
      : [
          [b.x0, b.z0, b.x2, b.z2],
          [b.x2, b.z2, b.x1, b.z1],
          [b.x1, b.z1, b.x0, b.z0],
        ];

  for (const [ex0, ez0, ex1, ez1] of clipEdges) {
    if (poly.length < 3) return 0;
    const nextPoly: Array<[number, number]> = [];
    const edx = ex1 - ex0;
    const edz = ez1 - ez0;
    const side = (px: number, pz: number) => edx * (pz - ez0) - edz * (px - ex0);

    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i];
      const nxt = poly[(i + 1) % poly.length];
      const sCur = side(cur[0], cur[1]);
      const sNxt = side(nxt[0], nxt[1]);
      if (sCur >= 0 && sNxt >= 0) {
        nextPoly.push(nxt);
      } else if (sCur >= 0 && sNxt < 0) {
        const t = sCur / (sCur - sNxt);
        nextPoly.push([cur[0] + (nxt[0] - cur[0]) * t, cur[1] + (nxt[1] - cur[1]) * t]);
      } else if (sCur < 0 && sNxt >= 0) {
        const t = sCur / (sCur - sNxt);
        nextPoly.push([cur[0] + (nxt[0] - cur[0]) * t, cur[1] + (nxt[1] - cur[1]) * t]);
        nextPoly.push(nxt);
      }
    }
    poly = nextPoly;
  }

  if (poly.length < 3) return 0;
  let area2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const p0 = poly[i];
    const p1 = poly[(i + 1) % poly.length];
    area2 += p0[0] * p1[1] - p1[0] * p0[1];
  }
  return 0.5 * Math.abs(area2);
}

function measureCoplanarOverlapAreaXZ(
  trisA: ExtractedTri2D[],
  trisB: ExtractedTri2D[],
  orientation: 'vertical' | 'horizontal',
  elevTol = 2e-4
): number {
  if (trisA.length === 0 || trisB.length === 0) return 0;
  let totalOverlap = 0;
  // Spatial bucket by 4m along the seam span axis (Z for vertical seam, X for horizontal seam)
  const bucketB = new Map<number, number[]>();
  for (let j = 0; j < trisB.length; j++) {
    const tb = trisB[j];
    const spanMin = orientation === 'vertical' ? tb.minZ : tb.minX;
    const spanMax = orientation === 'vertical' ? tb.maxZ : tb.maxX;
    const b0 = Math.floor(spanMin / 4);
    const b1 = Math.floor(spanMax / 4);
    for (let b = b0; b <= b1; b++) {
      let arr = bucketB.get(b);
      if (!arr) {
        arr = [];
        bucketB.set(b, arr);
      }
      arr.push(j);
    }
  }

  const seenPair = new Set<string>();
  for (let i = 0; i < trisA.length; i++) {
    const ta = trisA[i];
    const spanMin = orientation === 'vertical' ? ta.minZ : ta.minX;
    const spanMax = orientation === 'vertical' ? ta.maxZ : ta.maxX;
    const b0 = Math.floor(spanMin / 4);
    const b1 = Math.floor(spanMax / 4);
    for (let b = b0; b <= b1; b++) {
      const candidateIdxs = bucketB.get(b);
      if (!candidateIdxs) continue;
      for (let k = 0; k < candidateIdxs.length; k++) {
        const j = candidateIdxs[k];
        const tb = trisB[j];
        if (Math.abs(ta.yMean - tb.yMean) > elevTol) continue;
        const pairKey = `${i}:${j}`;
        if (seenPair.has(pairKey)) continue;
        seenPair.add(pairKey);
        totalOverlap += computeTriangleOverlapAreaXZ(ta, tb);
      }
    }
  }
  return totalOverlap;
}

export function enumerateInternalSeams(
  grid: StudyGridSpec,
  tilesById: ReadonlyMap<string, BuiltTileEntry>
): SeamLineSpec[] {
  const byRC = new Map<string, TileDescriptor>();
  for (const entry of tilesById.values()) {
    byRC.set(`${entry.tile.gridRow}:${entry.tile.gridCol}`, entry.tile);
  }
  const seams: SeamLineSpec[] = [];
  for (const entry of tilesById.values()) {
    const t = entry.tile;
    const east = byRC.get(`${t.gridRow}:${t.gridCol + 1}`);
    if (east) {
      seams.push({
        id: `V_${t.id}__${east.id}`,
        orientation: 'vertical',
        coord: t.localBounds.maxX,
        spanMin: t.localBounds.minZ,
        spanMax: t.localBounds.maxZ,
        tileAId: t.id,
        tileBId: east.id,
      });
    }
    const south = byRC.get(`${t.gridRow + 1}:${t.gridCol}`);
    if (south) {
      seams.push({
        id: `H_${t.id}__${south.id}`,
        orientation: 'horizontal',
        coord: t.localBounds.maxZ,
        spanMin: t.localBounds.minX,
        spanMax: t.localBounds.maxX,
        tileAId: t.id,
        tileBId: south.id,
      });
    }
  }
  void grid;
  return seams;
}

function collectSeamVertices(
  group: THREE.Group,
  seam: SeamLineSpec,
  meshFilter: (name: string) => boolean,
  coordTol = 1e-3
): Array<{ x: number; y: number; z: number; u?: number; v?: number; period?: number; meshName: string }> {
  const pts: Array<{ x: number; y: number; z: number; u?: number; v?: number; period?: number; meshName: string }> = [];
  for (const mesh of collectGroupMeshes(group)) {
    if (!meshFilter(mesh.name)) continue;
    const geo = mesh.geometry;
    const posAttr = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr) continue;
    const uvAttr = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const faceRanges = mesh.userData?.faceRanges as FaceFeatureRange[] | undefined;
    let vertexPeriods: Float32Array | undefined;
    if (faceRanges && faceRanges.some((r) => r.info?.subtype === 'tram')) {
      vertexPeriods = new Float32Array(posAttr.count);
      vertexPeriods.fill(RAILWAY_DIMENSION_SPEC.visualSleeperPeriodMeters);
      const idxAttr = geo.getIndex();
      const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(posAttr.count / 3);
      let rIdx = 0;
      for (let f = 0; f < triCount; f++) {
        while (rIdx < faceRanges.length && f >= faceRanges[rIdx].endFace) {
          rIdx++;
        }
        const r = faceRanges[rIdx];
        if (r && f >= r.startFace && f < r.endFace && r.info?.subtype === 'tram') {
          const period = RAILWAY_DIMENSION_SPEC.visualTramSleeperPeriodMeters;
          const i0 = idxAttr ? idxAttr.getX(f * 3) : f * 3;
          const i1 = idxAttr ? idxAttr.getX(f * 3 + 1) : f * 3 + 1;
          const i2 = idxAttr ? idxAttr.getX(f * 3 + 2) : f * 3 + 2;
          vertexPeriods[i0] = period;
          vertexPeriods[i1] = period;
          vertexPeriods[i2] = period;
        }
      }
    }
    for (let i = 0; i < posAttr.count; i++) {
      const x = posAttr.getX(i) + mesh.position.x;
      const y = posAttr.getY(i) + mesh.position.y;
      const z = posAttr.getZ(i) + mesh.position.z;
      const d = seam.orientation === 'vertical' ? Math.abs(x - seam.coord) : Math.abs(z - seam.coord);
      const spanCoord = seam.orientation === 'vertical' ? z : x;
      if (d <= coordTol && spanCoord >= seam.spanMin - 0.1 && spanCoord <= seam.spanMax + 0.1) {
        pts.push({
          x,
          y,
          z,
          u: uvAttr ? uvAttr.getX(i) : undefined,
          v: uvAttr ? uvAttr.getY(i) : undefined,
          period: vertexPeriods ? vertexPeriods[i] : RAILWAY_DIMENSION_SPEC.visualSleeperPeriodMeters,
          meshName: mesh.name,
        });
      }
    }
  }
  return pts;
}

interface SeamBoundaryEdge2D {
  s0: number;
  s1: number;
  y0: number;
  y1: number;
  isBridgeMesh: boolean;
  meshName: string;
}

function collectRoadSeamBoundaryEdges(
  group: THREE.Group,
  seam: SeamLineSpec,
  coordTol = 2e-4
): SeamBoundaryEdge2D[] {
  const edges: SeamBoundaryEdge2D[] = [];
  for (const mesh of collectGroupMeshes(group)) {
    if (!mesh.name.startsWith('Roads_') && !mesh.name.startsWith('Bridge_')) continue;
    const geo = mesh.geometry;
    const posAttr = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr || posAttr.count < 3) continue;
    const idxAttr = geo.getIndex();
    const triCount = idxAttr ? Math.floor(idxAttr.count / 3) : Math.floor(posAttr.count / 3);
    const isBridgeMesh = mesh.name.startsWith('Bridge_');

    const getV = (vi: number): [number, number, number] => [
      posAttr.getX(vi) + mesh.position.x,
      posAttr.getY(vi) + mesh.position.y,
      posAttr.getZ(vi) + mesh.position.z,
    ];

    const tryPushEdge = (
      a: [number, number, number],
      b: [number, number, number]
    ) => {
      const ca = seam.orientation === 'vertical' ? a[0] : a[2];
      const cb = seam.orientation === 'vertical' ? b[0] : b[2];
      if (Math.abs(ca - seam.coord) > coordTol || Math.abs(cb - seam.coord) > coordTol) return;
      const saRaw = seam.orientation === 'vertical' ? a[2] : a[0];
      const sbRaw = seam.orientation === 'vertical' ? b[2] : b[0];
      if (Math.abs(sbRaw - saRaw) <= 1e-3) return;
      const flip = saRaw > sbRaw;
      const rawMin = flip ? sbRaw : saRaw;
      const rawMax = flip ? saRaw : sbRaw;
      const yMinRaw = flip ? b[1] : a[1];
      const yMaxRaw = flip ? a[1] : b[1];
      const clampedMin = Math.max(seam.spanMin, rawMin);
      const clampedMax = Math.min(seam.spanMax, rawMax);
      if (clampedMax - clampedMin <= 1e-3) return;
      const len = rawMax - rawMin;
      const y0 = yMinRaw + ((clampedMin - rawMin) / len) * (yMaxRaw - yMinRaw);
      const y1 = yMinRaw + ((clampedMax - rawMin) / len) * (yMaxRaw - yMinRaw);
      edges.push({
        s0: clampedMin,
        s1: clampedMax,
        y0,
        y1,
        isBridgeMesh,
        meshName: mesh.name,
      });
    };

    for (let f = 0; f < triCount; f++) {
      const i0 = idxAttr ? idxAttr.getX(f * 3) : f * 3;
      const i1 = idxAttr ? idxAttr.getX(f * 3 + 1) : f * 3 + 1;
      const i2 = idxAttr ? idxAttr.getX(f * 3 + 2) : f * 3 + 2;
      const v0 = getV(i0);
      const v1 = getV(i1);
      const v2 = getV(i2);
      tryPushEdge(v0, v1);
      tryPushEdge(v1, v2);
      tryPushEdge(v2, v0);
    }
  }
  return edges;
}

function evalBoundaryEdgeY(edge: SeamBoundaryEdge2D, s: number): number {
  const span = edge.s1 - edge.s0;
  if (span <= 1e-9) return (edge.y0 + edge.y1) * 0.5;
  const t = Math.max(0, Math.min(1, (s - edge.s0) / span));
  return edge.y0 + t * (edge.y1 - edge.y0);
}

function extractBuildingStatsFromScene(scene: BuiltSceneGeometry): Map<string, number> {
  const trisByBuildingId = new Map<string, number>();
  for (const mesh of collectGroupMeshes(scene.buildingsGroup)) {
    const faceRanges = mesh.userData?.faceRanges as FaceFeatureRange[] | undefined;
    if (faceRanges && faceRanges.length > 0) {
      for (const r of faceRanges) {
        const key = r.info.id;
        const count = r.endFace - r.startFace;
        trisByBuildingId.set(key, (trisByBuildingId.get(key) ?? 0) + count);
      }
    } else if (mesh.userData?.id) {
      const idx = mesh.geometry.getIndex();
      const pos = mesh.geometry.getAttribute('position');
      const count = idx ? Math.floor(idx.count / 3) : pos ? Math.floor(pos.count / 3) : 0;
      trisByBuildingId.set(mesh.userData.id, count);
    }
  }
  return trisByBuildingId;
}

function collectSourceFeatureIdsFromScene(scene: BuiltSceneGeometry): Set<string> {
  const sids = new Set<string>();
  const groups = [
    scene.buildingsGroup,
    scene.roadsGroup,
    scene.railwaysGroup,
    scene.waterGroup,
    scene.parksGroup,
    scene.landuseGroup,
    scene.barriersGroup,
    scene.foliageGroup,
  ];
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
        }
      }
      if (typeof ud.sourceFeatureId === 'string' && ud.sourceFeatureId) {
        sids.add(ud.sourceFeatureId);
      }
    });
  }
  return sids;
}

/**
 * Validates cross-tile seam continuity AND tiled-union vs single-scene reference parity
 * across all rendered infrastructure, surface cover, buildings, foliage, and OSM provenance.
 */
export function validateTiledSeamContinuity(params: {
  reference: SingleSceneReferenceResult;
  tiled: TiledStudyBuildResult;
  areaToleranceM2?: number;
  overlapToleranceM2?: number;
  elevationToleranceM?: number;
}): SeamValidationReport {
  const {
    reference,
    tiled,
    areaToleranceM2 = 0.25,
    overlapToleranceM2 = 1e-4,
    elevationToleranceM = 1e-3,
  } = params;

  const defects: SeamDefect[] = [];
  const tilesById = new Map<string, BuiltTileEntry>(tiled.tiles.map((t) => [t.tile.id, t]));
  const seams = enumerateInternalSeams(tiled.grid, tilesById);

  let nonEmptyTiles = 0;
  let emptyTiles = 0;
  for (const t of tiled.tiles) {
    if (t.scene.stats.renderedFeaturesCount > 0 || t.scene.stats.totalTriangles > 2) {
      nonEmptyTiles++;
    } else {
      emptyTiles++;
    }
  }

  // 1. Road mesh integrity per tile
  const roadIntegrityFailures: Array<{ tileId: string; report: GraphRoadMeshIntegrityReport }> = [];
  for (const entry of tiled.tiles) {
    const rep = auditGraphRoadMeshIntegrity(entry.scene.roadsGroup);
    const roadMeshOk =
      rep.negativelyWoundCount === 0 &&
      rep.storedNormalMismatchCount === 0 &&
      rep.windingDefects.length === 0;
    if (!roadMeshOk) {
      roadIntegrityFailures.push({ tileId: entry.tile.id, report: rep });
      defects.push({
        category: 'road_mesh_integrity',
        tileAId: entry.tile.id,
        detail: `Tile ${entry.tile.id} failed graph road mesh integrity (${rep.windingDefects.length} winding defects, ${rep.negativelyWoundCount} negatively wound, ${rep.storedNormalMismatchCount} normal mismatches)`,
      });
    }
  }

  // 2. Area parity comparisons (Roads, Ballast, Landuse, Parks, Water)
  const compareCategoryAreas = (
    refTotals: Record<string, number>,
    tiledTotals: Record<string, number>,
    defectCat: SeamDefect['category'],
    labelPrefix: string
  ): Record<string, { refAreaM2: number; tiledAreaM2: number; diffM2: number }> => {
    const keys = new Set([...Object.keys(refTotals), ...Object.keys(tiledTotals)]);
    const out: Record<string, { refAreaM2: number; tiledAreaM2: number; diffM2: number }> = {};
    for (const k of keys) {
      const refArea = refTotals[k] ?? 0;
      const tiledArea = tiledTotals[k] ?? 0;
      const diff = Math.abs(tiledArea - refArea);
      const tol = Math.max(areaToleranceM2, refArea * 5e-4);
      out[k] = {
        refAreaM2: Number(refArea.toFixed(4)),
        tiledAreaM2: Number(tiledArea.toFixed(4)),
        diffM2: Number(diff.toFixed(4)),
      };
      if (diff > tol) {
        defects.push({
          category: defectCat,
          layer: `${labelPrefix}${k}`,
          detail: `${labelPrefix}${k} area mismatch: tiled=${tiledArea.toFixed(3)} m², ref=${refArea.toFixed(3)} m² (diff=${diff.toFixed(3)} m²)`,
          measuredValue: diff,
          tolerance: tol,
        });
      }
    }
    return out;
  };

  const accumulateTileAreas = (
    getter: (s: BuiltSceneGeometry) => Record<string, number>
  ): Record<string, number> => {
    const acc: Record<string, number> = {};
    for (const entry of tiled.tiles) {
      const part = getter(entry.scene);
      for (const [k, v] of Object.entries(part)) {
        acc[k] = (acc[k] ?? 0) + v;
      }
    }
    return acc;
  };

  const roadsByClass = compareCategoryAreas(
    sumGroupSurfaceAreaByMeshPrefix(reference.scene.roadsGroup, 'Roads_'),
    accumulateTileAreas((s) => sumGroupSurfaceAreaByMeshPrefix(s.roadsGroup, 'Roads_')),
    'road_area_mismatch',
    'Roads_'
  );

  const refBallastArea = sumGroupTotalSurfaceArea(reference.scene.railwaysGroup, (n) =>
    n.startsWith('Railway_Ballast')
  );
  let tiledBallastArea = 0;
  for (const entry of tiled.tiles) {
    tiledBallastArea += sumGroupTotalSurfaceArea(entry.scene.railwaysGroup, (n) =>
      n.startsWith('Railway_Ballast')
    );
  }
  const ballastDiff = Math.abs(tiledBallastArea - refBallastArea);
  const ballastTol = Math.max(areaToleranceM2, refBallastArea * 5e-4);
  if (ballastDiff > ballastTol) {
    defects.push({
      category: 'railway_ballast_area_mismatch',
      layer: 'Railway_Ballast',
      detail: `Ballast area mismatch: tiled=${tiledBallastArea.toFixed(3)} m², ref=${refBallastArea.toFixed(3)} m²`,
      measuredValue: ballastDiff,
      tolerance: ballastTol,
    });
  }

  const landuseBySubtype = compareCategoryAreas(
    sumGroupSurfaceAreaByMeshPrefix(reference.scene.landuseGroup, 'Landuse_'),
    accumulateTileAreas((s) => sumGroupSurfaceAreaByMeshPrefix(s.landuseGroup, 'Landuse_')),
    'planar_area_mismatch',
    'Landuse_'
  );

  const parksBySubtype = compareCategoryAreas(
    sumGroupSurfaceAreaByMeshPrefix(reference.scene.parksGroup, 'ParkSurfaces_'),
    accumulateTileAreas((s) => sumGroupSurfaceAreaByMeshPrefix(s.parksGroup, 'ParkSurfaces_')),
    'planar_area_mismatch',
    'ParkSurfaces_'
  );

  const refWaterArea = sumGroupTotalSurfaceArea(reference.scene.waterGroup);
  let tiledWaterArea = 0;
  for (const entry of tiled.tiles) {
    tiledWaterArea += sumGroupTotalSurfaceArea(entry.scene.waterGroup);
  }
  const waterDiff = Math.abs(tiledWaterArea - refWaterArea);
  const waterTol = Math.max(areaToleranceM2, refWaterArea * 5e-4);
  if (waterDiff > waterTol) {
    defects.push({
      category: 'planar_area_mismatch',
      layer: 'WaterSurfaces',
      detail: `Water area mismatch: tiled=${tiledWaterArea.toFixed(3)} m², ref=${refWaterArea.toFixed(3)} m²`,
      measuredValue: waterDiff,
      tolerance: waterTol,
    });
  }

  // 3. Cross-tile seam checks (coplanar overlap, rail/bridge vertex/phase continuity, end-caps)
  let maxPhaseDiscontinuityU = 0;
  let maxRailElevationDiscontinuityM = 0;
  let maxDeckElevationDiscontinuityM = 0;

  for (const seam of seams) {
    const entryA = tilesById.get(seam.tileAId);
    const entryB = tilesById.get(seam.tileBId);
    if (!entryA || !entryB) continue;

    const band = { orientation: seam.orientation, coord: seam.coord, halfWidth: 1.5 };

    // A) Coplanar road seam overlap
    const extractGroupSeamTris = (group: THREE.Group, prefix?: string) => {
      const tris: ExtractedTri2D[] = [];
      for (const m of collectGroupMeshes(group)) {
        if (prefix && !m.name.startsWith(prefix)) continue;
        tris.push(...extractUpwardTrianglesXZ(m, band));
      }
      return tris;
    };

    const roadTrisA = extractGroupSeamTris(entryA.scene.roadsGroup, 'Roads_');
    const roadTrisB = extractGroupSeamTris(entryB.scene.roadsGroup, 'Roads_');
    const roadOverlap = measureCoplanarOverlapAreaXZ(roadTrisA, roadTrisB, seam.orientation);
    if (roadOverlap > overlapToleranceM2) {
      defects.push({
        category: 'road_seam_overlap',
        seamId: seam.id,
        tileAId: seam.tileAId,
        tileBId: seam.tileBId,
        detail: `Coplanar road overlap across seam ${seam.id}: ${roadOverlap.toFixed(6)} m²`,
        measuredValue: roadOverlap,
        tolerance: overlapToleranceM2,
      });
    }

    // B) Coplanar ballast overlap
    const balTrisA = extractGroupSeamTris(entryA.scene.railwaysGroup, 'Railway_Ballast');
    const balTrisB = extractGroupSeamTris(entryB.scene.railwaysGroup, 'Railway_Ballast');
    const balOverlap = measureCoplanarOverlapAreaXZ(balTrisA, balTrisB, seam.orientation);
    if (balOverlap > overlapToleranceM2) {
      defects.push({
        category: 'railway_ballast_overlap',
        seamId: seam.id,
        tileAId: seam.tileAId,
        tileBId: seam.tileBId,
        detail: `Coplanar ballast overlap across seam ${seam.id}: ${balOverlap.toFixed(6)} m²`,
        measuredValue: balOverlap,
        tolerance: overlapToleranceM2,
      });
    }

    // C) Coplanar planar surface overlap (landuse / parks / water)
    for (const [grpLabel, getGrp] of [
      ['Landuse', (s: BuiltSceneGeometry) => s.landuseGroup],
      ['Parks', (s: BuiltSceneGeometry) => s.parksGroup],
      ['Water', (s: BuiltSceneGeometry) => s.waterGroup],
    ] as const) {
      const tA = extractGroupSeamTris(getGrp(entryA.scene));
      const tB = extractGroupSeamTris(getGrp(entryB.scene));
      const ov = measureCoplanarOverlapAreaXZ(tA, tB, seam.orientation);
      if (ov > overlapToleranceM2) {
        defects.push({
          category: 'planar_seam_overlap',
          seamId: seam.id,
          tileAId: seam.tileAId,
          tileBId: seam.tileBId,
          layer: grpLabel,
          detail: `Coplanar ${grpLabel} overlap across seam ${seam.id}: ${ov.toFixed(6)} m²`,
          measuredValue: ov,
          tolerance: overlapToleranceM2,
        });
      }
    }

    // D) Symmetric road & bridge seam boundary-edge interval coverage + elevation check
    const roadSeamEdgesA = collectRoadSeamBoundaryEdges(entryA.scene.roadsGroup, seam);
    const roadSeamEdgesB = collectRoadSeamBoundaryEdges(entryB.scene.roadsGroup, seam);
    const checkRoadSeamDirection = (
      srcEdges: SeamBoundaryEdge2D[],
      dstEdges: SeamBoundaryEdge2D[],
      srcTileId: string,
      dstTileId: string
    ) => {
      const coverTol = 0.05;
      for (const ea of srcEdges) {
        const overlapping = dstEdges
          .filter(
            (eb) =>
              eb.isBridgeMesh === ea.isBridgeMesh &&
              eb.s1 >= ea.s0 - coverTol &&
              eb.s0 <= ea.s1 + coverTol
          )
          .sort((a, b) => a.s0 - b.s0);

        let coveredUntil = ea.s0;
        let maxGap = 0;
        for (const eb of overlapping) {
          if (eb.s0 - coverTol > coveredUntil) {
            maxGap = Math.max(maxGap, eb.s0 - coverTol - coveredUntil);
          }
          coveredUntil = Math.max(coveredUntil, eb.s1 + coverTol);
          if (coveredUntil >= ea.s1) break;
        }
        if (coveredUntil < ea.s1) {
          maxGap = Math.max(maxGap, ea.s1 - coveredUntil);
        }

        const edgeSpan = ea.s1 - ea.s0;
        if (overlapping.length === 0 || (edgeSpan > coverTol && maxGap > coverTol)) {
          const sMid = (ea.s0 + ea.s1) * 0.5;
          const [wx, wz] =
            seam.orientation === 'vertical' ? [seam.coord, sMid] : [sMid, seam.coord];
          const gapDist = overlapping.length === 0 ? edgeSpan : maxGap;
          defects.push({
            category: 'road_boundary_end_cap',
            seamId: seam.id,
            tileAId: srcTileId,
            tileBId: dstTileId,
            layer: ea.meshName,
            detail: `Unmatched road/bridge seam edge (${ea.meshName}) on ${srcTileId} at (${wx.toFixed(2)}, ${wz.toFixed(2)}) span [${ea.s0.toFixed(2)}, ${ea.s1.toFixed(2)}], uncovered gap ${gapDist.toFixed(3)} m on ${dstTileId}`,
            measuredValue: gapDist,
            tolerance: coverTol,
          });
          return;
        }

        const ovStart = Math.max(ea.s0, overlapping[0].s0);
        const ovEnd = Math.min(ea.s1, overlapping[overlapping.length - 1].s1);
        const sSample = ovEnd >= ovStart ? (ovStart + ovEnd) * 0.5 : (ea.s0 + ea.s1) * 0.5;
        const yA = evalBoundaryEdgeY(ea, sSample);
        let bestDy = Infinity;
        for (const eb of overlapping) {
          const clampedS = Math.max(eb.s0, Math.min(eb.s1, sSample));
          const dy = Math.abs(yA - evalBoundaryEdgeY(eb, clampedS));
          if (dy < bestDy) bestDy = dy;
        }
        if (bestDy > maxDeckElevationDiscontinuityM) {
          maxDeckElevationDiscontinuityM = bestDy;
        }
        if (bestDy > elevationToleranceM) {
          defects.push({
            category: 'bridge_elevation_discontinuity',
            seamId: seam.id,
            tileAId: srcTileId,
            tileBId: dstTileId,
            layer: ea.meshName,
            detail: `Road/bridge elevation discontinuity across seam ${seam.id}: |Δy|=${bestDy.toFixed(5)} m`,
            measuredValue: bestDy,
            tolerance: elevationToleranceM,
          });
          return;
        }
      }
    };
    const defectCountBeforeD = defects.length;
    checkRoadSeamDirection(roadSeamEdgesA, roadSeamEdgesB, seam.tileAId, seam.tileBId);
    if (defects.length === defectCountBeforeD) {
      checkRoadSeamDirection(roadSeamEdgesB, roadSeamEdgesA, seam.tileBId, seam.tileAId);
    }

    // E) Railway rail/sleeper UV phase and elevation continuity across seam
    const railPtsA = collectSeamVertices(entryA.scene.railwaysGroup, seam, (n) =>
      n.startsWith('Railway_Sleepers') ||
      n.startsWith('Railway_Rails') ||
      n.startsWith('Railway_Bridge_')
    );
    const railPtsB = collectSeamVertices(entryB.scene.railwaysGroup, seam, (n) =>
      n.startsWith('Railway_Sleepers') ||
      n.startsWith('Railway_Rails') ||
      n.startsWith('Railway_Bridge_')
    );
    for (const pa of railPtsA) {
      let bestExact = false;
      let bestDist = Infinity;
      let bestDy = Infinity;
      let bestPb: (typeof railPtsB)[number] | null = null;
      let bestModDiff = Infinity;
      const paBase = pa.meshName.split('_chunk_')[0];
      for (const pb of railPtsB) {
        if (pb.meshName.split('_chunk_')[0] !== paBase) continue;
        const dXZ = Math.hypot(pa.x - pb.x, pa.z - pb.z);
        if (dXZ > 0.05) continue;
        const isExact = dXZ <= 1e-3;
        const dy = Math.abs(pa.y - pb.y);
        const period = pa.period ?? RAILWAY_DIMENSION_SPEC.visualSleeperPeriodMeters;
        const modDiff =
          pa.u !== undefined && pb.u !== undefined
            ? (() => {
                const rd = Math.abs(pa.u - pb.u) % period;
                return Math.min(rd, period - rd);
              })()
            : 0;
        const better =
          !bestPb ||
          (isExact && !bestExact) ||
          (isExact === bestExact &&
            (isExact
              ? dy < bestDy - 1e-5 ||
                (Math.abs(dy - bestDy) <= 1e-5 &&
                  (modDiff < bestModDiff - 1e-5 ||
                    (Math.abs(modDiff - bestModDiff) <= 1e-5 && dXZ < bestDist)))
              : dXZ < bestDist - 1e-4 ||
                (Math.abs(dXZ - bestDist) <= 1e-4 && (dy < bestDy || modDiff < bestModDiff))));
        if (better) {
          bestExact = isExact;
          bestDist = dXZ;
          bestDy = dy;
          bestPb = pb;
          bestModDiff = modDiff;
        }
      }
      if (!bestPb) continue;
      const dy = Math.abs(pa.y - bestPb.y);
      if (dy > maxRailElevationDiscontinuityM) maxRailElevationDiscontinuityM = dy;
      if (dy > elevationToleranceM) {
        defects.push({
          category: 'bridge_elevation_discontinuity',
          seamId: seam.id,
          tileAId: seam.tileAId,
          tileBId: seam.tileBId,
          layer: pa.meshName,
          detail: `Railway elevation discontinuity on ${pa.meshName} across seam ${seam.id}: |Δy|=${dy.toFixed(5)} m`,
          measuredValue: dy,
          tolerance: elevationToleranceM,
        });
        break;
      }
      if (pa.u !== undefined && bestPb.u !== undefined) {
        if (bestModDiff > maxPhaseDiscontinuityU) maxPhaseDiscontinuityU = bestModDiff;
        if (bestModDiff > 1e-3) {
          defects.push({
            category: 'railway_phase_discontinuity',
            seamId: seam.id,
            tileAId: seam.tileAId,
            tileBId: seam.tileBId,
            layer: pa.meshName,
            detail: `Railway UV phase discontinuity across seam ${seam.id}: uA=${pa.u.toFixed(4)}, uB=${bestPb.u.toFixed(4)}`,
            measuredValue: bestModDiff,
            tolerance: 1e-3,
          });
          break;
        }
      }
    }
  }

  // 4. Railway 3D sleeper count & cross-seam overlap check
  const refRailStats = reference.scene.railwaysGroup.userData?.railwayStats;
  const refSleeperCount: number = refRailStats?.sleeper3DBoxCount ?? 0;
  let tiledSleeperCount = 0;
  for (const entry of tiled.tiles) {
    const st = entry.scene.railwaysGroup.userData?.railwayStats;
    tiledSleeperCount += st?.sleeper3DBoxCount ?? 0;
  }
  if (refSleeperCount !== tiledSleeperCount) {
    defects.push({
      category: 'railway_sleeper_parity',
      detail: `3D sleeper count mismatch: tiled=${tiledSleeperCount}, ref=${refSleeperCount}`,
      measuredValue: Math.abs(tiledSleeperCount - refSleeperCount),
      tolerance: 0,
    });
  }

  // 5. Discrete building 1:1 parity & non-splitting check
  const refBuildings = extractBuildingStatsFromScene(reference.scene);
  const tiledBuildingsSeen = new Map<string, { tileId: string; tris: number }>();
  const duplicatedAcrossTiles: string[] = [];
  const triangleMismatches: Array<{ sourceFeatureId: string; refTris: number; tiledTris: number }> = [];
  let tiledTotalEmitted = 0;

  for (const entry of tiled.tiles) {
    const bMap = extractBuildingStatsFromScene(entry.scene);
    for (const [bid, tris] of bMap.entries()) {
      tiledTotalEmitted++;
      if (tiledBuildingsSeen.has(bid)) {
        duplicatedAcrossTiles.push(bid);
        defects.push({
          category: 'building_parity_or_split',
          tileAId: tiledBuildingsSeen.get(bid)!.tileId,
          tileBId: entry.tile.id,
          detail: `Building ${bid} emitted in multiple tiles (${tiledBuildingsSeen.get(bid)!.tileId} and ${entry.tile.id})`,
        });
      } else {
        tiledBuildingsSeen.set(bid, { tileId: entry.tile.id, tris });
        const refTris = refBuildings.get(bid);
        if (refTris !== undefined && refTris !== tris) {
          triangleMismatches.push({ sourceFeatureId: bid, refTris, tiledTris: tris });
          defects.push({
            category: 'building_parity_or_split',
            tileAId: entry.tile.id,
            detail: `Building ${bid} triangle count differs between tile (${tris}) and reference (${refTris})`,
          });
        }
      }
    }
  }

  const missingFromTiles: string[] = [];
  for (const bid of refBuildings.keys()) {
    if (!tiledBuildingsSeen.has(bid)) {
      missingFromTiles.push(bid);
      defects.push({
        category: 'building_parity_or_split',
        detail: `Building ${bid} present in single-scene reference is missing across all tiles`,
      });
    }
  }

  // 6. Tree count parity
  const refTrees = reference.scene.stats.forestTreesCount ?? 0;
  const tiledTrees = tiled.tiles.reduce(
    (sum, t) => sum + (t.scene.stats.forestTreesCount ?? 0),
    0
  );
  if (refTrees !== tiledTrees) {
    defects.push({
      category: 'tree_parity',
      detail: `Procedural 3D tree count mismatch: tiled=${tiledTrees}, ref=${refTrees}`,
      measuredValue: Math.abs(tiledTrees - refTrees),
      tolerance: 0,
    });
  }

  // 7. OSM provenance parity (`sourceFeatureId` union)
  const refSourceIds = collectSourceFeatureIdsFromScene(reference.scene);
  const tiledSourceIds = new Set<string>();
  for (const entry of tiled.tiles) {
    for (const sid of collectSourceFeatureIdsFromScene(entry.scene)) {
      tiledSourceIds.add(sid);
    }
  }
  const missingSourceFeatureIds: string[] = [];
  for (const sid of refSourceIds) {
    if (!tiledSourceIds.has(sid)) {
      missingSourceFeatureIds.push(sid);
    }
  }
  const extraSourceFeatureIds: string[] = [];
  for (const sid of tiledSourceIds) {
    if (!refSourceIds.has(sid)) {
      extraSourceFeatureIds.push(sid);
    }
  }
  extraSourceFeatureIds.sort();
  if (missingSourceFeatureIds.length > 0) {
    defects.push({
      category: 'provenance_mismatch',
      detail: `${missingSourceFeatureIds.length} OSM sourceFeatureId(s) present in reference are missing from tiled faceRanges/instanceInfos (sample: ${missingSourceFeatureIds.slice(0, 5).join(', ')})`,
      measuredValue: missingSourceFeatureIds.length,
      tolerance: 0,
    });
  }
  if (extraSourceFeatureIds.length > 0) {
    defects.push({
      category: 'provenance_mismatch',
      detail: `${extraSourceFeatureIds.length} unexpected OSM sourceFeatureId(s) present in tiled output are absent from reference (sample: ${extraSourceFeatureIds.slice(0, 5).join(', ')})`,
      measuredValue: extraSourceFeatureIds.length,
      tolerance: 0,
    });
  }

  return {
    isValid: defects.length === 0,
    tilesProcessed: tiled.tiles.length,
    nonEmptyTiles,
    emptyTiles,
    internalSeamsChecked: seams.length,
    areaComparisons: {
      roadsByClass,
      ballast: {
        refAreaM2: Number(refBallastArea.toFixed(4)),
        tiledAreaM2: Number(tiledBallastArea.toFixed(4)),
        diffM2: Number(ballastDiff.toFixed(4)),
      },
      landuseBySubtype,
      parksBySubtype,
      water: {
        refAreaM2: Number(refWaterArea.toFixed(4)),
        tiledAreaM2: Number(tiledWaterArea.toFixed(4)),
        diffM2: Number(waterDiff.toFixed(4)),
      },
    },
    buildingParity: {
      refCount: refBuildings.size,
      tiledUniqueCount: tiledBuildingsSeen.size,
      tiledTotalEmitted,
      missingFromTiles,
      duplicatedAcrossTiles,
      triangleMismatches,
    },
    railwayParity: {
      refSleeperCount,
      tiledSleeperCount,
      maxPhaseDiscontinuityU: Number(maxPhaseDiscontinuityU.toFixed(6)),
      maxRailElevationDiscontinuityM: Number(maxRailElevationDiscontinuityM.toFixed(6)),
    },
    bridgeContinuity: {
      maxDeckElevationDiscontinuityM: Number(maxDeckElevationDiscontinuityM.toFixed(6)),
    },
    provenanceParity: {
      refSourceFeatureCount: refSourceIds.size,
      tiledSourceFeatureCount: tiledSourceIds.size,
      missingSourceFeatureIds,
      extraSourceFeatureIds,
    },
    roadIntegrityFailures,
    collarAudit: tiled.collarAudit,
    defects,
  };
}
