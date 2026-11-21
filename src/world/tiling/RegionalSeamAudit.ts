import type { DecodedTilePayload } from './TilePackContract';
import { geoToUtm32N } from './RegionalProjection';
import { createRegionalMosaicPlan, type RegionalMosaicPlan } from './RegionalMosaicPlan';

export interface SeamTilePair {
  a: { tx: number; ty: number };
  b: { tx: number; ty: number };
  from: number;
  to: number;
}
export interface ShardSideInterface {
  id: string;
  kind: 'side';
  axis: 'easting' | 'northing';
  at: number;
  from: number;
  to: number;
  shardA: string;
  shardB: string;
  pairs: SeamTilePair[];
}
export interface ShardFourWayJunction {
  id: string;
  kind: 'junction';
  easting: number;
  northing: number;
  shards: [string, string, string, string];
}
export interface SourceSeamCrossing {
  sourceId: string;
  category: 'road' | 'rail' | 'water' | 'landuse';
  tags: Record<string, unknown>;
  easting: number;
  northing: number;
  mode: 'segment' | 'polygon-interior';
  pairIndex: number;
  /**
   * Expected membership of each 25cm seam-inset probe according to the source
   * polygon's outer rings/holes, in adjoining tile A/B order.
   * Undefined for a source line or other nonpolygon geometry.
   */
  expectedPolygonCoverage?: [boolean, boolean];
}
export interface TileFeatureEvidence {
  featureIds: Set<string>;
  taggedLayers: Map<string, Set<number>>;
  taggedBridge: Map<string, Set<boolean>>;
  taggedTunnel: Map<string, Set<boolean>>;
  sleeperBoxes: Array<{ trackId: string; easting: number; northing: number; elevation: number }>;
}

function shardId(row: number, col: number): string {
  return 'r' + String(row).padStart(2, '0') + '-c' + String(col).padStart(2, '0');
}

export function enumerateRegionalShardSeams(
  plan: RegionalMosaicPlan = createRegionalMosaicPlan()
): { sides: ShardSideInterface[]; junctions: ShardFourWayJunction[] } {
  const d = plan.config.shardDimension;
  const size = plan.config.tileSizeMeters;
  const countX = plan.config.cols / d;
  const countY = plan.config.rows / d;
  const minE = plan.grid.studyUtmBounds.minEasting;
  const maxN = plan.grid.studyUtmBounds.maxNorthing;
  const sides: ShardSideInterface[] = [];
  const junctions: ShardFourWayJunction[] = [];
  for (let row = 0; row < countY; row++) {
    for (let col = 0; col < countX; col++) {
      if (col + 1 < countX) {
        const at = minE + (col + 1) * d * size;
        const from = maxN - (row + 1) * d * size;
        const to = maxN - row * d * size;
        const aTx = plan.grid.minTx + (col + 1) * d - 1;
        const pairs: SeamTilePair[] = [];
        for (let i = 0; i < d; i++) {
          const ty = plan.grid.maxTy - row * d - i;
          pairs.push({
            a: { tx: aTx, ty }, b: { tx: aTx + 1, ty },
            from: maxN - (row * d + i + 1) * size,
            to: maxN - (row * d + i) * size,
          });
        }
        sides.push({
          id: 'vertical-r' + row + '-c' + col + '-' + (col + 1),
          kind: 'side', axis: 'easting', at, from, to,
          shardA: shardId(row, col), shardB: shardId(row, col + 1), pairs,
        });
      }
      if (row + 1 < countY) {
        const at = maxN - (row + 1) * d * size;
        const from = minE + col * d * size;
        const to = minE + (col + 1) * d * size;
        const aTy = plan.grid.maxTy - (row + 1) * d + 1;
        const pairs: SeamTilePair[] = [];
        for (let i = 0; i < d; i++) {
          const tx = plan.grid.minTx + col * d + i;
          pairs.push({
            a: { tx, ty: aTy }, b: { tx, ty: aTy - 1 },
            from: minE + (col * d + i) * size,
            to: minE + (col * d + i + 1) * size,
          });
        }
        sides.push({
          id: 'horizontal-r' + row + '-' + (row + 1) + '-c' + col,
          kind: 'side', axis: 'northing', at, from, to,
          shardA: shardId(row, col), shardB: shardId(row + 1, col), pairs,
        });
      }
      if (row + 1 < countY && col + 1 < countX) {
        junctions.push({
          id: 'junction-r' + row + '-' + (row + 1) + '-c' + col + '-' + (col + 1),
          kind: 'junction',
          easting: minE + (col + 1) * d * size,
          northing: maxN - (row + 1) * d * size,
          shards: [
            shardId(row, col), shardId(row, col + 1),
            shardId(row + 1, col), shardId(row + 1, col + 1),
          ],
        });
      }
    }
  }
  return { sides, junctions };
}

export function classifySourceTags(
  tags: Record<string, unknown>
): SourceSeamCrossing['category'] | null {
  if (typeof tags.railway === 'string' && tags.railway !== 'abandoned' && tags.railway !== 'razed') return 'rail';
  if (typeof tags.highway === 'string') return 'road';
  if (typeof tags.waterway === 'string' ||
      tags.natural === 'water' || tags.landuse === 'reservoir' || tags.water !== undefined) return 'water';
  if (typeof tags.landuse === 'string' || typeof tags.leisure === 'string' ||
      tags.natural === 'wood' || tags.natural === 'grassland' ||
      tags.amenity === 'parking') return 'landuse';
  return null;
}

function projectedLine(raw: unknown): Array<[number, number]> {
  if (!Array.isArray(raw)) return [];
  const out: Array<[number, number]> = [];
  for (const point of raw) {
    if (!Array.isArray(point) || point.length < 2 ||
        !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return [];
    out.push(geoToUtm32N(point[0], point[1]));
  }
  return out;
}
function ringContainsPoint(ring: Array<[number, number]>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) &&
        x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function polygonContainsPoint(rings: Array<Array<[number, number]>>, e: number, n: number): boolean {
  return rings.length > 0 && ringContainsPoint(rings[0], e, n) &&
    !rings.slice(1).some((r) => ringContainsPoint(r, e, n));
}
export function getCrossingPairIndex(side: ShardSideInterface, e: number, n: number): number {
  const along = side.axis === 'easting' ? n : e;
  return side.pairs.findIndex((p) => along >= p.from && along < p.to);
}

/** Source-backed line/ring crossings, plus a conservative polygon-interior witness. */
export function extractSourceCrossings(
  side: ShardSideInterface,
  geojson: { features?: unknown[] }
): SourceSeamCrossing[] {
  const out: SourceSeamCrossing[] = [];
  const keys = new Set<string>();
  for (const rawFeature of geojson.features ?? []) {
    if (!rawFeature || typeof rawFeature !== 'object') continue;
    const feature = rawFeature as {
      id?: string | number;
      properties?: Record<string, unknown>;
      geometry?: { type?: string; coordinates?: unknown };
    };
    const tags = (feature.properties?.tags && typeof feature.properties.tags === 'object'
      ? feature.properties.tags : feature.properties) as Record<string, unknown> | undefined;
    if (!tags) continue;
    const category = classifySourceTags(tags);
    if (!category) continue;
    const sourceId = String(feature.id ?? tags.id ?? '');
    if (!sourceId || sourceId === 'undefined') continue;
    const type = feature.geometry?.type, coords = feature.geometry?.coordinates;
    const lines: Array<Array<[number, number]>> = [];
    const polygons: Array<Array<Array<[number, number]>>> = [];
    if (type === 'LineString') lines.push(projectedLine(coords));
    if (type === 'MultiLineString' && Array.isArray(coords))
      for (const line of coords) lines.push(projectedLine(line));
    if (type === 'Polygon' && Array.isArray(coords)) {
      const rings = coords.map(projectedLine);
      polygons.push(rings); lines.push(...rings);
    }
    if (type === 'MultiPolygon' && Array.isArray(coords)) {
      for (const polygon of coords) {
        if (!Array.isArray(polygon)) continue;
        const rings = polygon.map(projectedLine);
        polygons.push(rings); lines.push(...rings);
      }
    }
    const push = (e: number, n: number, mode: SourceSeamCrossing['mode']) => {
      const along = side.axis === 'easting' ? n : e;
      if (!(along > side.from + 0.01 && along < side.to - 0.01)) return;
      const pairIndex = getCrossingPairIndex(side, e, n);
      if (pairIndex < 0) return;
      const key = sourceId + ':' + Math.round(e * 100) + ':' + Math.round(n * 100);
      if (keys.has(key)) return;
      keys.add(key);
      const expectedPolygonCoverage: [boolean, boolean] | undefined = polygons.length
        ? (() => {
            // A is west or north, B is east or south. Use precisely the
            // same inset as the decoded surface probe in the CLI.
            const aE = e + (side.axis === 'easting' ? -0.25 : 0);
            const bE = e + (side.axis === 'easting' ? 0.25 : 0);
            const aN = n + (side.axis === 'northing' ? 0.25 : 0);
            const bN = n + (side.axis === 'northing' ? -0.25 : 0);
            return [
              polygons.some((rings) => polygonContainsPoint(rings, aE, aN)),
              polygons.some((rings) => polygonContainsPoint(rings, bE, bN)),
            ];
          })()
        : undefined;
      out.push({
        sourceId, category, tags, easting: e, northing: n,
        mode, pairIndex, expectedPolygonCoverage,
      });
    };
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i];
        const axisA = side.axis === 'easting' ? a[0] : a[1];
        const axisB = side.axis === 'easting' ? b[0] : b[1];
        const da = axisA - side.at, db = axisB - side.at;
        if (Math.abs(da) <= 0.01 || Math.abs(db) <= 0.01 || da * db >= 0) continue;
        const t = -da / (db - da);
        if (t <= 0 || t >= 1) continue;
        push(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), 'segment');
      }
      // An explicit OSM vertex exactly on the shard border can separate
      // two otherwise crossing segments. Keep crossings but reject tangencies.
      for (let i = 1; i + 1 < line.length; i++) {
        const prev = side.axis === 'easting' ? line[i - 1][0] : line[i - 1][1];
        const curr = side.axis === 'easting' ? line[i][0] : line[i][1];
        const next = side.axis === 'easting' ? line[i + 1][0] : line[i + 1][1];
        if (Math.abs(curr - side.at) <= 0.01 &&
            (prev - side.at) * (next - side.at) < -0.0001) {
          push(line[i][0], line[i][1], 'segment');
        }
      }
    }
    if (polygons.length && category !== 'rail' && category !== 'road') {
      const mid = (side.from + side.to) / 2, offset = 1;
      const a: [number, number] = side.axis === 'easting'
        ? [side.at - offset, mid] : [mid, side.at + offset];
      const b: [number, number] = side.axis === 'easting'
        ? [side.at + offset, mid] : [mid, side.at - offset];
      if (polygons.some((rings) =>
        polygonContainsPoint(rings, a[0], a[1]) &&
        polygonContainsPoint(rings, b[0], b[1])
      )) push(side.axis === 'easting' ? side.at : mid,
                side.axis === 'easting' ? mid : side.at, 'polygon-interior');
    }
  }
  return out.sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId) ||
    a.northing - b.northing || a.easting - b.easting);
}

function addSourceInfo(out: TileFeatureEvidence, info: DecodedTilePayload['featureInfos'][number]): void {
  for (const id of [info.sourceFeatureId, ...(info.sourceFeatureIds ?? [])]) {
    if (!id) continue;
    out.featureIds.add(id);
    if (info.layer !== undefined) {
      if (!out.taggedLayers.has(id)) out.taggedLayers.set(id, new Set());
      out.taggedLayers.get(id)!.add(info.layer);
    }
    if (info.isBridge !== undefined) {
      if (!out.taggedBridge.has(id)) out.taggedBridge.set(id, new Set());
      out.taggedBridge.get(id)!.add(info.isBridge);
    }
    if (info.isTunnel !== undefined) {
      if (!out.taggedTunnel.has(id)) out.taggedTunnel.set(id, new Set());
      out.taggedTunnel.get(id)!.add(info.isTunnel);
    }
  }
}

/** Only emitted geometry metadata counts as presence; unused featureInfos do not. */
export function collectTileFeatureEvidence(
  tile: DecodedTilePayload, centerEasting: number, centerNorthing: number
): TileFeatureEvidence {
  const out: TileFeatureEvidence = {
    featureIds: new Set(), taggedLayers: new Map(),
    taggedBridge: new Map(), taggedTunnel: new Map(), sleeperBoxes: [],
  };
  const addIdx = (idx: number) => {
    if (idx >= 0 && idx < tile.featureInfos.length) addSourceInfo(out, tile.featureInfos[idx]);
  };
  for (const mesh of tile.meshes) {
    if (mesh.positions.length === 0) continue;
    if (mesh.singleFeatureIdx >= 0) addIdx(mesh.singleFeatureIdx);
    for (const range of mesh.faceRanges) if (range.endFace > range.startFace) addIdx(range.infoIdx);
  }
  for (const batch of tile.instancedBatches) {
    for (let i = 0; i < batch.instanceCount; i++) addIdx(batch.instanceFeatureIdxs[i]);
    if (batch.sleeperBoxes) for (const sleeper of batch.sleeperBoxes) {
      out.sleeperBoxes.push({
        trackId: sleeper.trackId,
        easting: centerEasting + sleeper.cx,
        northing: centerNorthing - sleeper.cz,
        elevation: (sleeper.yBottom + sleeper.yTop) / 2,
      });
    }
  }
  return out;
}

export interface FeatureSeamEvidenceComparison {
  classification: 'both' | 'only-a' | 'only-b' | 'neither';
  layerMismatch: boolean;
  bridgeMismatch: boolean;
  tunnelMismatch: boolean;
}
function unequalSets<T>(a: Set<T> | undefined, b: Set<T> | undefined): boolean {
  if (!a || !b || !a.size || !b.size) return false;
  return a.size !== b.size || Array.from(a).some((v) => !b.has(v));
}
export function compareFeatureEvidence(
  sourceId: string, a: TileFeatureEvidence, b: TileFeatureEvidence
): FeatureSeamEvidenceComparison {
  const hasA = a.featureIds.has(sourceId), hasB = b.featureIds.has(sourceId);
  return {
    classification: hasA ? hasB ? 'both' : 'only-a' : hasB ? 'only-b' : 'neither',
    layerMismatch: hasA && hasB && unequalSets(a.taggedLayers.get(sourceId), b.taggedLayers.get(sourceId)),
    bridgeMismatch: hasA && hasB && unequalSets(a.taggedBridge.get(sourceId), b.taggedBridge.get(sourceId)),
    tunnelMismatch: hasA && hasB && unequalSets(a.taggedTunnel.get(sourceId), b.taggedTunnel.get(sourceId)),
  };
}


export interface SurfaceProbeResult {
  status: 'covered' | 'uncovered' | 'unattributed';
  /** Heights of matched surfaces covering the sample point (metres). */
  heights: number[];
  matchedMeshes: number;
  testedTriangles: number;
}

/**
 * Test a single source-attributed XZ sample in the emitted geometry.
 * Query is in global UTM easting/northing. Only face ranges attributed to
 * the requested source ID are checked; unrelated nearby surfaces cannot
 * create a false-positive match. This is a geometric witness, NOT a
 * connectivity, portal or continuous full-edge equivalence proof.
 */
export function probeSourceSurfaceAtUtm(
  tile: DecodedTilePayload,
  centerEasting: number,
  centerNorthing: number,
  sourceId: string,
  easting: number,
  northing: number
): SurfaceProbeResult {
  const localX = easting - centerEasting;
  const localZ = centerNorthing - northing;
  const heights: number[] = [];
  let matchedMeshes = 0;
  let testedTriangles = 0;
  const featureMatches = (idx: number): boolean => {
    if (idx < 0 || idx >= tile.featureInfos.length) return false;
    const info = tile.featureInfos[idx];
    return info.sourceFeatureId === sourceId ||
      info.sourceFeatureIds?.includes(sourceId) === true;
  };
  for (const mesh of tile.meshes) {
    const positions = mesh.positions;
    if (positions.length < 9 || mesh.layer === 'ground') continue;
    const direct = featureMatches(mesh.singleFeatureIdx);
    const ranges = direct
      ? [{ startFace: 0, endFace: Math.floor((mesh.indices?.length ?? positions.length / 3) / 3) }]
      : mesh.faceRanges.filter((r) => featureMatches(r.infoIdx));
    if (!ranges.length) continue;
    matchedMeshes++;
    const triCount = Math.floor((mesh.indices?.length ?? positions.length / 3) / 3);
    const xOffset = mesh.localPositionOffset[0], yOffset = mesh.localPositionOffset[1];
    const zOffset = mesh.localPositionOffset[2];
    for (const range of ranges) {
      for (let face = Math.max(0, range.startFace); face < Math.min(triCount, range.endFace); face++) {
        const ia = (mesh.indices ? mesh.indices[face * 3] : face * 3) * 3;
        const ib = (mesh.indices ? mesh.indices[face * 3 + 1] : face * 3 + 1) * 3;
        const ic = (mesh.indices ? mesh.indices[face * 3 + 2] : face * 3 + 2) * 3;
        if (ic + 2 >= positions.length || ib + 2 >= positions.length || ia + 2 >= positions.length) continue;
        const ax = positions[ia] + xOffset, az = positions[ia + 2] + zOffset;
        const bx = positions[ib] + xOffset, bz = positions[ib + 2] + zOffset;
        const cx = positions[ic] + xOffset, cz = positions[ic + 2] + zOffset;
        if (localX < Math.min(ax, bx, cx) - 0.002 ||
            localX > Math.max(ax, bx, cx) + 0.002 ||
            localZ < Math.min(az, bz, cz) - 0.002 ||
            localZ > Math.max(az, bz, cz) + 0.002) continue;
        testedTriangles++;
        const denom = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(denom) < 1e-10) continue;
        const u = ((bz - cz) * (localX - cx) + (cx - bx) * (localZ - cz)) / denom;
        const v = ((cz - az) * (localX - cx) + (ax - cx) * (localZ - cz)) / denom;
        const w = 1 - u - v;
        if (Math.min(u, v, w) < -0.0001) continue;
        const y = (u * positions[ia + 1] +
          v * positions[ib + 1] + w * positions[ic + 1]) + yOffset;
        if (Number.isFinite(y) && !heights.some((existing) => Math.abs(existing - y) < 0.001)) {
          heights.push(y);
        }
      }
    }
  }
  return {
    status: !matchedMeshes ? 'unattributed' : heights.length ? 'covered' : 'uncovered',
    heights: heights.map((v) => Number(v.toFixed(4))).sort((a, b) => a - b),
    matchedMeshes, testedTriangles,
  };
}

/** Interpret two neighboring source-attributed inset samples in light of OSM polygon ownership. */
export function classifySourceSurfaceCoverage(
  observedCovered: [boolean, boolean],
  expectedPolygonCoverage?: [boolean, boolean]
): 'none' | 'coverage-asymmetry' | 'source-polygon-coverage-mismatch' {
  if (expectedPolygonCoverage) {
    return observedCovered.some((v, i) => v !== expectedPolygonCoverage[i])
      ? 'source-polygon-coverage-mismatch'
      : 'none';
  }
  return observedCovered[0] !== observedCovered[1] ? 'coverage-asymmetry' : 'none';
}
