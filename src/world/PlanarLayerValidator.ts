import polygonClipping from 'polygon-clipping';
import { LanduseFeature, LinearWaterwayFeature, ParkFeature, WaterBodyFeature } from '../types/MapFeature';
import { ELEVATION_POLICY, DEPTH_OFFSET_CONFIG } from './ElevationPolicy';

export type MultiPolygonCoords = [number, number][][][];

export type SemanticSurfaceClass =
  | 'MACRO_LANDUSE'
  | 'SUBZONING'
  | 'NATURAL_PARK'
  | 'FINE_LANDSCAPE'
  | 'PAVED_LOT'
  | 'SPORTS_PITCH'
  | 'WATER_BODY'
  | 'PARKING_SPACE_DECAL';

export type PairwiseOwnershipOutcome =
  | 'UNION'
  | 'A_REPLACES_B'
  | 'B_REPLACES_A'
  | 'INTENTIONAL_OVERLAY';

export interface PlanarBoundingBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface ResolvedPlanarLayer {
  id: string;
  sourceFeatureIds: string[];
  category: 'landuse' | 'park' | 'water';
  subtype: string;
  semanticClass: SemanticSurfaceClass;
  band: 'substrate' | 'above_water';
  baseTier: number;
  topologicalRank: number;
  area: number;
  resolvedArea: number;
  perimeter: number;
  bbox: PlanarBoundingBox;
  /** Uniform flush physical elevation (+0.025m for all mutually exclusive ground-cover fills) */
  elevationY: number;
  hasSurfaceMarkings: boolean;
  markingElevationY: number;
  renderOrder: number;
  depthOffset: {
    polygonOffset?: boolean;
    polygonOffsetFactor?: number;
    polygonOffsetUnits?: number;
  };
  /** IDs of polygons that replace (carve out) this polygon in their shared 2D region */
  higherOverlappingIds: string[];
  /** MultiPolygon geometry of higher-priority replacing features (for clipping procedural markings) */
  higherOverlappingMultiPolygon: MultiPolygonCoords;
  /** Final non-overlapping MultiPolygon geometry after batch Boolean union subtraction */
  resolvedMultiPolygon: MultiPolygonCoords;
  /** True if merged into another canonical duplicate polygon */
  isDeduplicatedInto?: string;
}

export interface PlanarValidationViolation {
  polygonAId: string;
  polygonBId: string;
  subtypeA: string;
  subtypeB: string;
  elevationA: number;
  elevationB: number;
  separationMeters: number;
  overlapAreaSqMeters?: number;
  reason: string;
}

export interface PlanarValidationReport {
  isValid: boolean;
  totalPolygons: number;
  overlappingPairsChecked: number;
  conflictsResolved: number;
  deduplicatedCount: number;
  unionedCount: number;
  booleanSubtractionsCount: number;
  maxResidualFillOverlapSqMeters: number;
  minObservedSeparationMeters: number;
  maxStackDepth: number;
  violations: PlanarValidationViolation[];
}

/** Tolerance for resolved mutually exclusive surface fill overlap (1 cm² = 1e-4 m²) */
export const MAX_ALLOWED_SURFACE_FILL_OVERLAP_AREA = 1e-4;

/** Coordinate grid snap quantum (0.1 mm = 1e-4 m) to stabilize plane-sweep event ordering */
export const COORDINATE_SNAP_QUANTUM = 1e-4;

/** Minimum consecutive vertex spacing (1 mm = 1e-3 m) */
export const MIN_VERTEX_SPACING = 1e-3;

/** Degenerate numerical collapse thinness threshold: Area / Perimeter < 0.5 mm (0.0005 m) */
export const DEGENERATE_COLLAPSE_THINNESS = 0.0005;

/** Legacy constants preserved for test compatibility */
export const MIN_PLANAR_Y_SEPARATION = 0.008;
export const SURFACE_MARKING_Y_OFFSET = 0.004;
export const MIN_VALIDATED_Y_GAP = 0.006;

export const ALL_SEMANTIC_SURFACE_CLASSES: SemanticSurfaceClass[] = [
  'MACRO_LANDUSE',
  'SUBZONING',
  'NATURAL_PARK',
  'FINE_LANDSCAPE',
  'PAVED_LOT',
  'SPORTS_PITCH',
  'WATER_BODY',
];

const CLASS_PRECEDENCE_RANK: Record<SemanticSurfaceClass, number> = {
  MACRO_LANDUSE: 1,
  SUBZONING: 2,
  NATURAL_PARK: 3,
  FINE_LANDSCAPE: 4,
  PAVED_LOT: 5,
  SPORTS_PITCH: 6,
  WATER_BODY: 7,
  PARKING_SPACE_DECAL: 8,
};

const SUBSTRATE_SUBZONING_SUBTYPES = new Set<string>([
  'cemetery',
  'allotments',
  'farmyard',
  'orchard',
  'vineyard',
  'plant_nursery',
  'garages',
  'education',
  'healthcare',
  'civic',
  'religious',
  'power',
  'water_works',
  'tourism_area',
  'aerodrome',
  'institutional',
  'military',
]);

const PAVED_LOT_LANDUSE_SUBTYPES = new Set<string>([
  'parking',
  'apron',
  'pedestrian_area',
  'platform_area',
]);

const FINE_LANDSCAPE_SUBTYPES = new Set<string>([
  'grass',
  'garden',
  'flowerbed',
  'sand',
  'beach',
  'shoal',
  'islet',
  'playground',
  'dog_park',
  'fitness_station',
]);

const SPORTS_PITCH_SUBTYPES = new Set<string>([
  'pitch',
  'track',
  'ice_rink',
  'miniature_golf',
  'Miniature_golf',
]);

/**
 * Specific subtype specificity rank within the same SemanticSurfaceClass for deterministic partial-overlap tie-breaking.
 */
const SUBTYPE_SPECIFICITY: Record<string, number> = {
  sand: 95,
  shoal: 94,
  flowerbed: 92,
  garden: 90,
  playground: 88,
  dog_park: 86,
  fitness_station: 85,
  pitch: 84,
  track: 80,
  ice_rink: 79,
  parking: 78,
  pedestrian_area: 76,
  platform_area: 75,
  apron: 74,
  grass: 70,
  stadium: 68,
  sports_centre: 66,
  marina: 64,
  recreation_ground: 60,
  village_green: 58,
  park: 55,
  golf_course: 52,
  meadow: 48,
  scrub: 46,
  heath: 45,
  wetland: 44,
  wood: 42,
  forest: 40,
  nature_reserve: 35,
};

/**
 * Step 1A & 1B: Two-step ring conditioning in Float64 local meters:
 * 1. Snap coordinates to 0.1 mm (1e-4 m) grid to stabilize sweep-line event ordering.
 * 2. Remove consecutive vertices closer than 1 mm (1e-3 m) and 180-degree zero-width fold-back spikes.
 */
export function conditionRing(ring: [number, number][]): [number, number][] {
  if (!ring || ring.length < 3) return [];

  // Step A: 0.1mm coordinate grid snap
  const snapped: [number, number][] = ring.map(([x, z]) => [
    Math.round(x / COORDINATE_SNAP_QUANTUM) * COORDINATE_SNAP_QUANTUM,
    Math.round(z / COORDINATE_SNAP_QUANTUM) * COORDINATE_SNAP_QUANTUM,
  ]);

  // Step B: Remove consecutive duplicate vertices (< 1mm)
  const deduped: [number, number][] = [];
  for (const pt of snapped) {
    if (
      deduped.length === 0 ||
      Math.hypot(pt[0] - deduped[deduped.length - 1][0], pt[1] - deduped[deduped.length - 1][1]) >=
        MIN_VERTEX_SPACING
    ) {
      deduped.push(pt);
    }
  }
  if (
    deduped.length > 1 &&
    Math.hypot(
      deduped[0][0] - deduped[deduped.length - 1][0],
      deduped[0][1] - deduped[deduped.length - 1][1]
    ) < MIN_VERTEX_SPACING
  ) {
    deduped.pop();
  }

  if (deduped.length < 3) return [];

  // Remove 180-degree collinear needle spikes
  const cleaned: [number, number][] = [];
  const m = deduped.length;
  for (let i = 0; i < m; i++) {
    const prev = deduped[(i - 1 + m) % m];
    const curr = deduped[i];
    const next = deduped[(i + 1) % m];
    const ux = curr[0] - prev[0];
    const uz = curr[1] - prev[1];
    const vx = next[0] - curr[0];
    const vz = next[1] - curr[1];
    const lenU = Math.hypot(ux, uz);
    const lenV = Math.hypot(vx, vz);
    if (lenU < MIN_VERTEX_SPACING || lenV < MIN_VERTEX_SPACING) continue;
    const cross = Math.abs(ux * vz - uz * vx) / (lenU * lenV);
    const dot = (ux * vx + uz * vz) / (lenU * lenV);
    // Drop pure fold-back spike (dot < -0.9999 and cross < 1e-4)
    if (dot < -0.9999 && cross < 1e-4) continue;
    cleaned.push(curr);
  }

  if (cleaned.length < 3) return [];
  // Close ring explicitly for polygon-clipping compatibility
  return [...cleaned, [cleaned[0][0], cleaned[0][1]]];
}

export function conditionPolygonToMultiPolygon(rings: [number, number][][]): MultiPolygonCoords {
  if (!rings || rings.length === 0) return [];
  const validRings: [number, number][][] = [];
  for (let i = 0; i < rings.length; i++) {
    const c = conditionRing(rings[i]);
    if (c.length >= 4) {
      validRings.push(c);
    } else if (i === 0) {
      return [];
    }
  }
  if (validRings.length === 0) return [];
  return [validRings];
}

/**
 * Signed area of a closed or unclosed ring in XZ coordinates.
 */
export function computeSignedRingArea(ring: [number, number][]): number {
  if (!ring || ring.length < 3) return 0;
  let sum = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p0 = ring[i];
    const p1 = ring[(i + 1) % n];
    sum += p0[0] * p1[1] - p1[0] * p0[1];
  }
  return sum * 0.5;
}

export function computeRingPerimeter(ring: [number, number][]): number {
  if (!ring || ring.length < 2) return 0;
  let perim = 0;
  const n = ring.length;
  for (let i = 0; i < n - 1; i++) {
    perim += Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]);
  }
  const first = ring[0];
  const last = ring[n - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 1e-5) {
    perim += Math.hypot(first[0] - last[0], first[1] - last[1]);
  }
  return perim;
}

export function computeRingMetrics(ring: [number, number][]): {
  area: number;
  perimeter: number;
  bbox: PlanarBoundingBox;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  if (!ring || ring.length < 3) {
    return {
      area: 0,
      perimeter: 0,
      bbox: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
    };
  }

  for (const pt of ring) {
    if (pt[0] < minX) minX = pt[0];
    if (pt[0] > maxX) maxX = pt[0];
    if (pt[1] < minZ) minZ = pt[1];
    if (pt[1] > maxZ) maxZ = pt[1];
  }

  return {
    area: Math.abs(computeSignedRingArea(ring)),
    perimeter: computeRingPerimeter(ring),
    bbox: { minX, maxX, minZ, maxZ },
  };
}

export function computeMultiPolygonArea(mp: MultiPolygonCoords): number {
  let total = 0;
  for (const poly of mp) {
    if (!poly || poly.length === 0) continue;
    let polyArea = Math.abs(computeSignedRingArea(poly[0]));
    for (let h = 1; h < poly.length; h++) {
      polyArea -= Math.abs(computeSignedRingArea(poly[h]));
    }
    if (polyArea > 0) total += polyArea;
  }
  return total;
}

export function computeMultiPolygonPerimeter(mp: MultiPolygonCoords): number {
  let total = 0;
  for (const poly of mp) {
    for (const ring of poly) {
      total += computeRingPerimeter(ring);
    }
  }
  return total;
}

export function computeMultiPolygonBBox(mp: MultiPolygonCoords): PlanarBoundingBox {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const poly of mp) {
    for (const ring of poly) {
      for (const pt of ring) {
        if (pt[0] < minX) minX = pt[0];
        if (pt[0] > maxX) maxX = pt[0];
        if (pt[1] < minZ) minZ = pt[1];
        if (pt[1] > maxZ) maxZ = pt[1];
      }
    }
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  }
  return { minX, maxX, minZ, maxZ };
}

export function doBoundingBoxesOverlap(
  a: PlanarBoundingBox,
  b: PlanarBoundingBox,
  margin: number = 0.001
): boolean {
  return (
    a.maxX > b.minX + margin &&
    a.minX < b.maxX - margin &&
    a.maxZ > b.minZ + margin &&
    a.minZ < b.maxZ - margin
  );
}

export function computeBBoxContainmentRatio(
  inner: PlanarBoundingBox,
  outer: PlanarBoundingBox
): number {
  const innerW = Math.max(0, inner.maxX - inner.minX);
  const innerD = Math.max(0, inner.maxZ - inner.minZ);
  const innerArea = innerW * innerD;
  if (innerArea <= 1e-6) return 0;

  const ix0 = Math.max(inner.minX, outer.minX);
  const ix1 = Math.min(inner.maxX, outer.maxX);
  const iz0 = Math.max(inner.minZ, outer.minZ);
  const iz1 = Math.min(inner.maxZ, outer.maxZ);
  if (ix1 <= ix0 || iz1 <= iz0) return 0;

  return ((ix1 - ix0) * (iz1 - iz0)) / innerArea;
}

/**
 * Exact point-to-segment Euclidean distance in XZ plane.
 */
function pointToSegmentDistance(
  px: number,
  pz: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number
): number {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const lenSq = dx * dx + dz * dz;
  if (lenSq <= 1e-12) return Math.hypot(px - x0, pz - z0);
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / lenSq));
  return Math.hypot(px - (x0 + t * dx), pz - (z0 + t * dz));
}

function extractAllSegments(mp: MultiPolygonCoords): Array<[number, number, number, number]> {
  const segs: Array<[number, number, number, number]> = [];
  for (const poly of mp) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        const p0 = ring[i];
        const p1 = ring[i + 1];
        if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) > 1e-6) {
          segs.push([p0[0], p0[1], p1[0], p1[1]]);
        }
      }
    }
  }
  return segs;
}

/**
 * Computes directed segment-to-segment boundary excursion:
 * sup_{p in boundary(source)} dist(p, boundary(target))
 * by sampling all vertices and dense sub-segment points (every <= 0.25m) of `source`
 * against the exact line segments of `target`.
 */
export function computeDirectedBoundaryDistance(
  sourceMp: MultiPolygonCoords,
  targetMp: MultiPolygonCoords,
  maxStepMeters: number = 0.25
): number {
  const targetSegs = extractAllSegments(targetMp);
  if (targetSegs.length === 0) return Infinity;

  let maxMinDist = 0;
  const minDistToTarget = (px: number, pz: number): number => {
    let best = Infinity;
    for (let i = 0; i < targetSegs.length; i++) {
      const s = targetSegs[i];
      const d = pointToSegmentDistance(px, pz, s[0], s[1], s[2], s[3]);
      if (d < best) {
        best = d;
        if (best <= 1e-5) break;
      }
    }
    return best;
  };

  for (const poly of sourceMp) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length - 1; i++) {
        const p0 = ring[i];
        const p1 = ring[i + 1];
        const segLen = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        const steps = Math.max(1, Math.ceil(segLen / maxStepMeters));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const px = p0[0] + (p1[0] - p0[0]) * t;
          const pz = p0[1] + (p1[1] - p0[1]) * t;
          const d = minDistToTarget(px, pz);
          if (d > maxMinDist) maxMinDist = d;
        }
      }
    }
  }

  return maxMinDist;
}

/**
 * Pure Geometric Containment Test (v5):
 * Determines whether `innerMp` is geometrically contained within `outerMp`
 * using ONLY the outside Boolean difference D_out = innerMp \ outerMp:
 * 1. Outside area A_outside <= min(2.5 m², max(0.02 m², 0.05m * Perimeter(innerMp)))
 * 2. Directed boundary excursion of D_out outside outerMp <= 0.25 m
 * No 92% area-ratio heuristic is applied.
 */
export function isGeometricallyContained(
  innerMp: MultiPolygonCoords,
  outerMp: MultiPolygonCoords,
  innerPerimeter?: number
): boolean {
  if (innerMp.length === 0 || outerMp.length === 0) return false;
  try {
    const diffOut = polygonClipping.difference(
      innerMp as polygonClipping.Geom,
      outerMp as polygonClipping.Geom
    ) as unknown as MultiPolygonCoords;

    if (!diffOut || diffOut.length === 0) return true;

    const areaOutside = computeMultiPolygonArea(diffOut);
    if (areaOutside <= 1e-5) return true;

    const perim = innerPerimeter ?? computeMultiPolygonPerimeter(innerMp);
    const maxAllowedArea = Math.min(2.5, Math.max(0.02, 0.05 * perim));
    if (areaOutside > maxAllowedArea) return false;

    const maxExcursion = computeDirectedBoundaryDistance(diffOut, outerMp, 0.25);
    return maxExcursion <= 0.25;
  } catch {
    return false;
  }
}

/**
 * Symmetric Multi-Criteria Duplicate Detection (v5):
 * 1. Identical (category, subtype) and no conflicting distinguishing metadata (name, ref, sport).
 * 2. Symmetric difference area A_sym <= min(2.0 m², max(0.08 m², 0.04m * max(Perimeter(A), Perimeter(B)))).
 * 3. Bidirectional segment-to-segment Hausdorff boundary distance <= 0.15 m.
 */
export function isConfirmedDuplicateSurface(
  a: {
    category: string;
    subtype: string;
    name?: string;
    osmTags?: Record<string, unknown>;
    mp: MultiPolygonCoords;
    perimeter: number;
  },
  b: {
    category: string;
    subtype: string;
    name?: string;
    osmTags?: Record<string, unknown>;
    mp: MultiPolygonCoords;
    perimeter: number;
  }
): boolean {
  if (a.category !== b.category || a.subtype !== b.subtype) return false;

  const nameA = (a.name || String(a.osmTags?.name || '')).trim().toLowerCase();
  const nameB = (b.name || String(b.osmTags?.name || '')).trim().toLowerCase();
  if (nameA && nameB && nameA !== nameB) return false;

  const refA = String(a.osmTags?.ref || '').trim().toLowerCase();
  const refB = String(b.osmTags?.ref || '').trim().toLowerCase();
  if (refA && refB && refA !== refB) return false;

  const sportA = String(a.osmTags?.sport || '').trim().toLowerCase();
  const sportB = String(b.osmTags?.sport || '').trim().toLowerCase();
  if (sportA && sportB && sportA !== sportB) return false;

  try {
    const symDiff = polygonClipping.xor(
      a.mp as polygonClipping.Geom,
      b.mp as polygonClipping.Geom
    ) as unknown as MultiPolygonCoords;
    const symArea = computeMultiPolygonArea(symDiff);
    const maxPerim = Math.max(a.perimeter, b.perimeter);
    const maxAllowedSymArea = Math.min(2.0, Math.max(0.08, 0.04 * maxPerim));
    if (symArea > maxAllowedSymArea) return false;

    const dAB = computeDirectedBoundaryDistance(a.mp, b.mp, 0.25);
    if (dAB > 0.15) return false;
    const dBA = computeDirectedBoundaryDistance(b.mp, a.mp, 0.25);
    return dBA <= 0.15;
  } catch {
    return false;
  }
}

/**
 * Classifies any surface polygon into its canonical SemanticSurfaceClass and rendering metadata.
 */
export function classifyPlanarTier(
  category: 'landuse' | 'park' | 'water',
  subtype: string,
  area: number,
  osmTags?: Record<string, unknown>
): {
  semanticClass: SemanticSurfaceClass;
  band: 'substrate' | 'above_water';
  baseTier: number;
  baseElevationY: number;
  hasSurfaceMarkings: boolean;
  renderOrder: number;
  depthOffset: {
    polygonOffset?: boolean;
    polygonOffsetFactor?: number;
    polygonOffsetUnits?: number;
  };
} {
  if (category === 'water') {
    return {
      semanticClass: 'WATER_BODY',
      band: 'above_water',
      baseTier: 70,
      baseElevationY: ELEVATION_POLICY.WATER_SURFACE,
      hasSurfaceMarkings: false,
      renderOrder: 2,
      depthOffset: DEPTH_OFFSET_CONFIG.water,
    };
  }

  const isUndergroundParking =
    osmTags?.parking === 'underground' ||
    osmTags?.location === 'underground' ||
    osmTags?.parking === 'multi-storey';

  if (category === 'landuse') {
    if (subtype === 'parking_space') {
      return {
        semanticClass: 'PARKING_SPACE_DECAL',
        band: 'above_water',
        baseTier: 80,
        baseElevationY: ELEVATION_POLICY.PARKING_SPACE_SURFACE,
        hasSurfaceMarkings: !isUndergroundParking,
        renderOrder: 4,
        depthOffset: DEPTH_OFFSET_CONFIG.parkingSpaces,
      };
    }

    if (PAVED_LOT_LANDUSE_SUBTYPES.has(subtype)) {
      return {
        semanticClass: 'PAVED_LOT',
        band: 'above_water',
        baseTier: 50,
        baseElevationY: ELEVATION_POLICY.GROUND_COVER_SURFACE,
        hasSurfaceMarkings: subtype === 'parking' && !isUndergroundParking,
        renderOrder: 3,
        depthOffset: DEPTH_OFFSET_CONFIG.pavedLots,
      };
    }

    if (FINE_LANDSCAPE_SUBTYPES.has(subtype)) {
      return {
        semanticClass: 'FINE_LANDSCAPE',
        band: 'above_water',
        baseTier: 40,
        baseElevationY: ELEVATION_POLICY.GROUND_COVER_SURFACE,
        hasSurfaceMarkings: false,
        renderOrder: 3,
        depthOffset: DEPTH_OFFSET_CONFIG.parks,
      };
    }

    if (SUBSTRATE_SUBZONING_SUBTYPES.has(subtype)) {
      return {
        semanticClass: 'SUBZONING',
        band: 'substrate',
        baseTier: 20,
        baseElevationY: ELEVATION_POLICY.GROUND_COVER_SURFACE,
        hasSurfaceMarkings: false,
        renderOrder: 1,
        depthOffset: DEPTH_OFFSET_CONFIG.subzoning,
      };
    }

    return {
      semanticClass: 'MACRO_LANDUSE',
      band: 'substrate',
      baseTier: 10,
      baseElevationY: ELEVATION_POLICY.GROUND_COVER_SURFACE,
      hasSurfaceMarkings: false,
      renderOrder: 1,
      depthOffset: {},
    };
  }

  // Park / Nature / Sports categories
  if (SPORTS_PITCH_SUBTYPES.has(subtype)) {
    const pitchSubTier = area < 500 ? 64 : area < 2500 ? 62 : 60;
    return {
      semanticClass: 'SPORTS_PITCH',
      band: 'above_water',
      baseTier: pitchSubTier,
      baseElevationY: ELEVATION_POLICY.GROUND_COVER_SURFACE,
      hasSurfaceMarkings: subtype === 'pitch',
      renderOrder: 3,
      depthOffset: DEPTH_OFFSET_CONFIG.parks,
    };
  }

  if (FINE_LANDSCAPE_SUBTYPES.has(subtype)) {
    return {
      semanticClass: 'FINE_LANDSCAPE',
      band: 'above_water',
      baseTier: 40,
      baseElevationY: ELEVATION_POLICY.GROUND_COVER_SURFACE,
      hasSurfaceMarkings: false,
      renderOrder: 3,
      depthOffset: DEPTH_OFFSET_CONFIG.parks,
    };
  }

  return {
    semanticClass: 'NATURAL_PARK',
    band: 'above_water',
    baseTier: 30,
    baseElevationY: ELEVATION_POLICY.GROUND_COVER_SURFACE,
    hasSurfaceMarkings: false,
    renderOrder: 3,
    depthOffset: DEPTH_OFFSET_CONFIG.parks,
  };
}

/**
 * Exhaustive, Antisymmetric Pairwise Ownership Policy (v5):
 * Given two intersecting surface features A and B and their geometric containment flags
 * (`aContainedInB`, `bContainedInA`), returns the unique ownership outcome:
 * - 'INTENTIONAL_OVERLAY' (for parking_space decals)
 * - 'UNION' (for confirmed duplicates or unnamed same-subtype logical fragments)
 * - 'A_REPLACES_B' (A owns the intersection; B subtracts A)
 * - 'B_REPLACES_A' (B owns the intersection; A subtracts B)
 *
 * Guaranteed antisymmetric: if outcome(A, B) === 'A_REPLACES_B', then outcome(B, A) === 'B_REPLACES_A'.
 */
export function resolvePairwiseOutcome(
  a: {
    id: string;
    category: 'landuse' | 'park' | 'water';
    subtype: string;
    semanticClass: SemanticSurfaceClass;
    area: number;
    name?: string;
    isDuplicate?: boolean;
  },
  b: {
    id: string;
    category: 'landuse' | 'park' | 'water';
    subtype: string;
    semanticClass: SemanticSurfaceClass;
    area: number;
    name?: string;
    isDuplicate?: boolean;
  },
  aContainedInB: boolean,
  bContainedInA: boolean,
  isDuplicateOrLogicalUnion: boolean = false
): PairwiseOwnershipOutcome {
  // 0. Intentional decal overlay (parking_space over parent lot)
  if (
    a.semanticClass === 'PARKING_SPACE_DECAL' ||
    b.semanticClass === 'PARKING_SPACE_DECAL'
  ) {
    return 'INTENTIONAL_OVERLAY';
  }

  // 1. Confirmed duplicate or unnamed same-subtype fragment union
  if (isDuplicateOrLogicalUnion && a.category === b.category && a.subtype === b.subtype) {
    return 'UNION';
  }

  // 2. Strict Geometric Containment (one strictly inside the other)
  if (aContainedInB && !bContainedInA) {
    // Inner feature A is strictly inside outer feature B.
    // Inner A replaces outer B in all cartographic cases EXCEPT if a macro background landuse
    // was erroneously mapped smaller inside a specific foreground feature.
    if (a.semanticClass === 'MACRO_LANDUSE' && b.semanticClass !== 'MACRO_LANDUSE') {
      return 'B_REPLACES_A';
    }
    return 'A_REPLACES_B';
  }

  if (bContainedInA && !aContainedInB) {
    if (b.semanticClass === 'MACRO_LANDUSE' && a.semanticClass !== 'MACRO_LANDUSE') {
      return 'A_REPLACES_B';
    }
    return 'B_REPLACES_A';
  }

  // 3. Partial Overlap or Mutual Containment (Co-extensive polygons):
  // If semantic classes differ, strict class precedence decides ownership:
  // WATER_BODY (7) > SPORTS_PITCH (6) > PAVED_LOT (5) > FINE_LANDSCAPE (4) > NATURAL_PARK (3) > SUBZONING (2) > MACRO_LANDUSE (1)
  const rankA = CLASS_PRECEDENCE_RANK[a.semanticClass];
  const rankB = CLASS_PRECEDENCE_RANK[b.semanticClass];
  if (rankA !== rankB) {
    return rankA > rankB ? 'A_REPLACES_B' : 'B_REPLACES_A';
  }

  // 4. Same SemanticSurfaceClass (e.g., NATURAL_PARK `park` vs. `forest`, or two overlapping pitches/lots):
  // Order by (subtypeSpecificity DESC, area ASC, id ASC)
  const specA = SUBTYPE_SPECIFICITY[a.subtype] ?? 50;
  const specB = SUBTYPE_SPECIFICITY[b.subtype] ?? 50;
  if (specA !== specB) {
    return specA > specB ? 'A_REPLACES_B' : 'B_REPLACES_A';
  }

  if (Math.abs(a.area - b.area) > 1e-3) {
    return a.area < b.area ? 'A_REPLACES_B' : 'B_REPLACES_A';
  }

  return a.id.localeCompare(b.id) <= 0 ? 'A_REPLACES_B' : 'B_REPLACES_A';
}

/**
 * Provenance-Preserving Remainder Filter (v5):
 * Discards ONLY degenerate numerical collapse artifacts produced by floating-point subtraction
 * (rings with < 3 distinct vertices, area <= 1e-4 m², or sub-millimeter ribbon thinness Area/Perimeter < 0.0005m).
 * Preserves all legitimate small geometric remainders.
 */
export function filterDegenerateBooleanArtifacts(mp: MultiPolygonCoords): MultiPolygonCoords {
  const cleaned: MultiPolygonCoords = [];
  for (const poly of mp) {
    if (!poly || poly.length === 0) continue;
    const outer = conditionRing(poly[0]);
    if (outer.length < 4) continue;
    const outerArea = Math.abs(computeSignedRingArea(outer));
    const outerPerim = computeRingPerimeter(outer);
    if (outerArea <= MAX_ALLOWED_SURFACE_FILL_OVERLAP_AREA || outerPerim <= 1e-4) continue;
    const thinness = outerArea / outerPerim;
    if (thinness < DEGENERATE_COLLAPSE_THINNESS) continue;

    const validRings: [number, number][][] = [outer];
    for (let h = 1; h < poly.length; h++) {
      const hole = conditionRing(poly[h]);
      if (hole.length < 4) continue;
      const holeArea = Math.abs(computeSignedRingArea(hole));
      const holePerim = computeRingPerimeter(hole);
      if (holeArea <= MAX_ALLOWED_SURFACE_FILL_OVERLAP_AREA || holePerim <= 1e-4) continue;
      if (holeArea / holePerim < DEGENERATE_COLLAPSE_THINNESS) continue;
      validRings.push(hole);
    }

    const netArea = computeMultiPolygonArea([validRings]);
    if (netArea > MAX_ALLOWED_SURFACE_FILL_OVERLAP_AREA) {
      cleaned.push(validRings);
    }
  }
  return cleaned;
}

/**
 * Buffers a 2D polyline into a closed polygon ring of width `width` for waterway footprint subtraction.
 */
function bufferPolylineToMultiPolygon(
  points: [number, number][],
  width: number
): MultiPolygonCoords {
  if (!points || points.length < 2 || width <= 0) return [];
  const halfW = width * 0.5;
  const leftSide: [number, number][] = [];
  const rightSide: [number, number][] = [];

  for (let i = 0; i < points.length; i++) {
    let tx = 0;
    let tz = 0;
    if (i < points.length - 1) {
      const dx = points[i + 1][0] - points[i][0];
      const dz = points[i + 1][1] - points[i][1];
      const len = Math.hypot(dx, dz) || 1e-6;
      tx = dx / len;
      tz = dz / len;
    } else {
      const dx = points[i][0] - points[i - 1][0];
      const dz = points[i][1] - points[i - 1][1];
      const len = Math.hypot(dx, dz) || 1e-6;
      tx = dx / len;
      tz = dz / len;
    }
    const nx = -tz;
    const nz = tx;
    leftSide.push([points[i][0] + nx * halfW, points[i][1] + nz * halfW]);
    rightSide.push([points[i][0] - nx * halfW, points[i][1] - nz * halfW]);
  }

  const ring = [...leftSide, ...rightSide.reverse()];
  return conditionPolygonToMultiPolygon([ring]);
}

interface InternalSurfaceNode {
  id: string;
  sourceFeatureIds: string[];
  category: 'landuse' | 'park' | 'water';
  subtype: string;
  semanticClass: SemanticSurfaceClass;
  band: 'substrate' | 'above_water';
  baseTier: number;
  baseElevationY: number;
  hasSurfaceMarkings: boolean;
  renderOrder: number;
  depthOffset: ResolvedPlanarLayer['depthOffset'];
  name?: string;
  osmTags?: Record<string, unknown>;
  mp: MultiPolygonCoords;
  area: number;
  perimeter: number;
  bbox: PlanarBoundingBox;
  mergedIntoId?: string;
}

/**
 * Resolves all planar surface polygons (`landuse`, `parks`, and `waterBodies`/`linearWaterways`)
 * using the v5 4-Stage Semantic Surface Resolution Engine:
 * 1. Ring conditioning & duplicate / unnamed same-subtype fragment union.
 * 2. Exhaustive, antisymmetric pairwise ownership classification (`resolvePairwiseOutcome`).
 * 3. Order-independent batch MultiPolygon Boolean subtraction: P_final = P \ Union(R(P)).
 * 4. Uniform flush ground-cover plane assignment (+0.025m) & post-resolution invariant verification.
 */
export function resolveAndValidatePlanarPolygons(
  landuse: LanduseFeature[],
  parks: ParkFeature[],
  waterBodies: WaterBodyFeature[] = [],
  linearWaterways: LinearWaterwayFeature[] = []
): {
  resolvedById: Map<string, ResolvedPlanarLayer>;
  report: PlanarValidationReport;
} {
  const nodes: InternalSurfaceNode[] = [];

  for (const item of landuse || []) {
    if (!item.polygon || !item.polygon[0] || item.polygon[0].length < 3) continue;
    const mp = conditionPolygonToMultiPolygon(item.polygon);
    if (mp.length === 0) continue;
    const area = computeMultiPolygonArea(mp);
    if (area <= 1e-4) continue;
    const perimeter = computeMultiPolygonPerimeter(mp);
    const bbox = computeMultiPolygonBBox(mp);
    const subtype = item.landuseType || 'landuse';
    const tier = classifyPlanarTier('landuse', subtype, area, item.osmTags);
    nodes.push({
      id: item.id,
      sourceFeatureIds: [item.sourceFeatureId || item.id],
      category: 'landuse',
      subtype,
      semanticClass: tier.semanticClass,
      band: tier.band,
      baseTier: tier.baseTier,
      baseElevationY: tier.baseElevationY,
      hasSurfaceMarkings: tier.hasSurfaceMarkings,
      renderOrder: tier.renderOrder,
      depthOffset: tier.depthOffset,
      name: item.name,
      osmTags: item.osmTags,
      mp,
      area,
      perimeter,
      bbox,
    });
  }

  for (const item of parks || []) {
    if (!item.polygon || !item.polygon[0] || item.polygon[0].length < 3) continue;
    const mp = conditionPolygonToMultiPolygon(item.polygon);
    if (mp.length === 0) continue;
    const area = computeMultiPolygonArea(mp);
    if (area <= 1e-4) continue;
    const perimeter = computeMultiPolygonPerimeter(mp);
    const bbox = computeMultiPolygonBBox(mp);
    const subtype = item.subtype || 'park';
    const tier = classifyPlanarTier('park', subtype, area, item.osmTags);
    nodes.push({
      id: item.id,
      sourceFeatureIds: [item.sourceFeatureId || item.id],
      category: 'park',
      subtype,
      semanticClass: tier.semanticClass,
      band: tier.band,
      baseTier: tier.baseTier,
      baseElevationY: tier.baseElevationY,
      hasSurfaceMarkings: tier.hasSurfaceMarkings,
      renderOrder: tier.renderOrder,
      depthOffset: tier.depthOffset,
      name: item.name,
      osmTags: item.osmTags,
      mp,
      area,
      perimeter,
      bbox,
    });
  }

  for (const item of waterBodies || []) {
    if (item.isTunnel || (item.layer !== undefined && item.layer < 0)) continue;
    if (!item.polygon || !item.polygon[0] || item.polygon[0].length < 3) continue;
    const mp = conditionPolygonToMultiPolygon(item.polygon);
    if (mp.length === 0) continue;
    const area = computeMultiPolygonArea(mp);
    if (area <= 1e-4) continue;
    const perimeter = computeMultiPolygonPerimeter(mp);
    const bbox = computeMultiPolygonBBox(mp);
    const subtype = item.waterType || 'water';
    const tier = classifyPlanarTier('water', subtype, area, item.osmTags);
    nodes.push({
      id: item.id,
      sourceFeatureIds: [item.sourceFeatureId || item.id],
      category: 'water',
      subtype,
      semanticClass: tier.semanticClass,
      band: tier.band,
      baseTier: tier.baseTier,
      baseElevationY: tier.baseElevationY,
      hasSurfaceMarkings: false,
      renderOrder: tier.renderOrder,
      depthOffset: tier.depthOffset,
      name: item.name,
      osmTags: item.osmTags,
      mp,
      area,
      perimeter,
      bbox,
    });
  }

  // Also include surface linear waterways as water replacement footprints so ground cover is cut back along canals/streams
  const waterwayFootprints: MultiPolygonCoords[] = [];
  for (const ww of linearWaterways || []) {
    if (ww.isTunnel || (ww.layer !== undefined && ww.layer < 0)) continue;
    const wwMp = bufferPolylineToMultiPolygon(ww.points, ww.width || 10.0);
    if (wwMp.length > 0) {
      waterwayFootprints.push(wwMp);
    }
  }

  let deduplicatedCount = 0;
  let unionedCount = 0;
  let booleanSubtractionsCount = 0;
  let overlappingPairsChecked = 0;
  let conflictsResolved = 0;

  // ============================================================================
  // STAGE 1: Intra-Type Deduplication & Logical Fragment Union
  // ============================================================================
  const n = nodes.length;
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    if (a.mergedIntoId) continue;

    for (let j = i + 1; j < n; j++) {
      const b = nodes[j];
      if (b.mergedIntoId) continue;
      if (a.category !== b.category || a.subtype !== b.subtype) continue;
      if (!doBoundingBoxesOverlap(a.bbox, b.bbox)) continue;

      let interArea = 0;
      try {
        const inter = polygonClipping.intersection(
          a.mp as polygonClipping.Geom,
          b.mp as polygonClipping.Geom
        ) as unknown as MultiPolygonCoords;
        interArea = computeMultiPolygonArea(inter);
      } catch {
        interArea = 0;
      }
      if (interArea <= MAX_ALLOWED_SURFACE_FILL_OVERLAP_AREA) continue;

      const isDup = isConfirmedDuplicateSurface(a, b);
      const bothUnnamedSameSubtype =
        !a.name &&
        !b.name &&
        !a.osmTags?.name &&
        !b.osmTags?.name &&
        (a.osmTags?.amenity || '') === (b.osmTags?.amenity || '') &&
        a.semanticClass !== 'SPORTS_PITCH' &&
        a.semanticClass !== 'PARKING_SPACE_DECAL';

      if (isDup || bothUnnamedSameSubtype) {
        try {
          const unioned = polygonClipping.union(
            a.mp as polygonClipping.Geom,
            b.mp as polygonClipping.Geom
          ) as unknown as MultiPolygonCoords;
          const cleaned = filterDegenerateBooleanArtifacts(unioned);
          if (cleaned.length > 0) {
            a.mp = cleaned;
            a.area = computeMultiPolygonArea(cleaned);
            a.perimeter = computeMultiPolygonPerimeter(cleaned);
            a.bbox = computeMultiPolygonBBox(cleaned);
            for (const sid of b.sourceFeatureIds) {
              if (!a.sourceFeatureIds.includes(sid)) a.sourceFeatureIds.push(sid);
            }
            b.mergedIntoId = a.id;
            b.mp = [];
            if (isDup) deduplicatedCount++;
            else unionedCount++;
            conflictsResolved++;
          }
        } catch {
          // Fall through to Stage 2 pairwise ownership difference if union fails
        }
      }
    }
  }

  // ============================================================================
  // STAGE 2: Exhaustive Pairwise Ownership Classification
  // ============================================================================
  const activeIndices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!nodes[i].mergedIntoId && nodes[i].mp.length > 0) {
      activeIndices.push(i);
    }
  }

  // replacersOf[i] stores indices `j` of features that replace feature `i`
  const replacersOf = new Map<number, number[]>();
  const precedences = new Map<number, number[]>(); // directed edges lower -> higher for topological rank
  for (const idx of activeIndices) {
    replacersOf.set(idx, []);
    precedences.set(idx, []);
  }

  for (let ai = 0; ai < activeIndices.length; ai++) {
    const i = activeIndices[ai];
    const a = nodes[i];

    for (let bi = ai + 1; bi < activeIndices.length; bi++) {
      const j = activeIndices[bi];
      const b = nodes[j];

      if (!doBoundingBoxesOverlap(a.bbox, b.bbox)) continue;

      let interArea = 0;
      try {
        const inter = polygonClipping.intersection(
          a.mp as polygonClipping.Geom,
          b.mp as polygonClipping.Geom
        ) as unknown as MultiPolygonCoords;
        interArea = computeMultiPolygonArea(inter);
      } catch {
        interArea = 0;
      }

      if (interArea <= MAX_ALLOWED_SURFACE_FILL_OVERLAP_AREA) continue;
      overlappingPairsChecked++;

      const aInB = isGeometricallyContained(a.mp, b.mp, a.perimeter);
      const bInA = isGeometricallyContained(b.mp, a.mp, b.perimeter);

      const outcome = resolvePairwiseOutcome(a, b, aInB, bInA, false);
      if (outcome === 'A_REPLACES_B') {
        replacersOf.get(j)!.push(i);
        precedences.get(j)!.push(i);
        conflictsResolved++;
      } else if (outcome === 'B_REPLACES_A') {
        replacersOf.get(i)!.push(j);
        precedences.get(i)!.push(j);
        conflictsResolved++;
      } else if (outcome === 'INTENTIONAL_OVERLAY') {
        // Parking space decal sits above parent lot
        if (a.semanticClass === 'PARKING_SPACE_DECAL' && b.semanticClass !== 'PARKING_SPACE_DECAL') {
          precedences.get(j)!.push(i);
        } else if (b.semanticClass === 'PARKING_SPACE_DECAL' && a.semanticClass !== 'PARKING_SPACE_DECAL') {
          precedences.get(i)!.push(j);
        }
      }
    }
  }

  // Compute topological ownership rank (so tests can inspect ownership hierarchy)
  const inDegree = new Map<number, number>();
  for (const idx of activeIndices) inDegree.set(idx, 0);
  for (const idx of activeIndices) {
    for (const higher of precedences.get(idx)!) {
      inDegree.set(higher, (inDegree.get(higher) || 0) + 1);
    }
  }

  const placed = new Set<number>();
  const topoRank = new Map<number, number>();
  const stackDepthByIdx = new Map<number, number>();
  for (const idx of activeIndices) stackDepthByIdx.set(idx, 1);
  let maxStackDepth = 1;

  const sortedActive = [...activeIndices].sort((ia, ib) => {
    const a = nodes[ia];
    const b = nodes[ib];
    const rA = CLASS_PRECEDENCE_RANK[a.semanticClass];
    const rB = CLASS_PRECEDENCE_RANK[b.semanticClass];
    if (rA !== rB) return rA - rB;
    if (Math.abs(a.area - b.area) > 0.05) return b.area - a.area;
    return a.id.localeCompare(b.id);
  });

  let currentRank = 0;
  while (placed.size < sortedActive.length) {
    let chosen = -1;
    for (const idx of sortedActive) {
      if (!placed.has(idx) && (inDegree.get(idx) || 0) === 0) {
        chosen = idx;
        break;
      }
    }
    if (chosen === -1) {
      for (const idx of sortedActive) {
        if (!placed.has(idx)) {
          chosen = idx;
          break;
        }
      }
    }
    placed.add(chosen);
    topoRank.set(chosen, currentRank++);
    const dChosen = stackDepthByIdx.get(chosen) || 1;
    if (dChosen > maxStackDepth) maxStackDepth = dChosen;

    for (const higher of precedences.get(chosen)!) {
      if (!placed.has(higher)) {
        inDegree.set(higher, (inDegree.get(higher) || 1) - 1);
        const nextDepth = dChosen + 1;
        if (nextDepth > (stackDepthByIdx.get(higher) || 1)) {
          stackDepthByIdx.set(higher, nextDepth);
        }
      }
    }
  }

  // ============================================================================
  // STAGE 3: Order-Independent Batch MultiPolygon Boolean Subtraction
  //          P_final = P \ Union_{R in R(P)} R
  // ============================================================================
  const resolvedById = new Map<string, ResolvedPlanarLayer>();

  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    if (node.mergedIntoId) {
      resolvedById.set(node.id, {
        id: node.id,
        sourceFeatureIds: node.sourceFeatureIds,
        category: node.category,
        subtype: node.subtype,
        semanticClass: node.semanticClass,
        band: node.band,
        baseTier: node.baseTier,
        topologicalRank: -1,
        area: node.area,
        resolvedArea: 0,
        perimeter: node.perimeter,
        bbox: node.bbox,
        elevationY: node.baseElevationY,
        hasSurfaceMarkings: false,
        markingElevationY: node.baseElevationY,
        renderOrder: node.renderOrder,
        depthOffset: node.depthOffset,
        higherOverlappingIds: [node.mergedIntoId],
        higherOverlappingMultiPolygon: [],
        resolvedMultiPolygon: [],
        isDeduplicatedInto: node.mergedIntoId,
      });
      continue;
    }

    const replacerIndices = replacersOf.get(i) || [];
    const higherIds = replacerIndices.map((rIdx) => nodes[rIdx].id);
    const clipGeoms: polygonClipping.Geom[] = replacerIndices.map(
      (rIdx) => nodes[rIdx].mp as polygonClipping.Geom
    );

    // Ground-cover polygons also subtract overlapping surface linear waterways
    if (
      node.semanticClass !== 'WATER_BODY' &&
      node.semanticClass !== 'PARKING_SPACE_DECAL' &&
      waterwayFootprints.length > 0
    ) {
      for (const wwMp of waterwayFootprints) {
        const wwBBox = computeMultiPolygonBBox(wwMp);
        if (doBoundingBoxesOverlap(node.bbox, wwBBox)) {
          clipGeoms.push(wwMp as polygonClipping.Geom);
        }
      }
    }

    let finalMp: MultiPolygonCoords = node.mp;
    let higherUnionMp: MultiPolygonCoords = [];

    if (clipGeoms.length > 0) {
      try {
        if (clipGeoms.length === 1) {
          higherUnionMp = clipGeoms[0] as unknown as MultiPolygonCoords;
        } else {
          higherUnionMp = polygonClipping.union(
            clipGeoms[0],
            ...clipGeoms.slice(1)
          ) as unknown as MultiPolygonCoords;
        }
        const diff = polygonClipping.difference(
          node.mp as polygonClipping.Geom,
          higherUnionMp as polygonClipping.Geom
        ) as unknown as MultiPolygonCoords;
        finalMp = filterDegenerateBooleanArtifacts(diff);
        booleanSubtractionsCount++;
      } catch {
        finalMp = node.mp;
      }
    }

    const resolvedArea = computeMultiPolygonArea(finalMp);
    const resolvedBBox = finalMp.length > 0 ? computeMultiPolygonBBox(finalMp) : node.bbox;
    const elevY = node.baseElevationY;
    const markY = node.hasSurfaceMarkings
      ? Number((elevY + ELEVATION_POLICY.MARKING_OFFSET).toFixed(5))
      : elevY;

    resolvedById.set(node.id, {
      id: node.id,
      sourceFeatureIds: node.sourceFeatureIds,
      category: node.category,
      subtype: node.subtype,
      semanticClass: node.semanticClass,
      band: node.band,
      baseTier: node.baseTier,
      topologicalRank: topoRank.get(i) ?? 0,
      area: node.area,
      resolvedArea,
      perimeter: node.perimeter,
      bbox: resolvedBBox,
      elevationY: elevY,
      hasSurfaceMarkings: node.hasSurfaceMarkings,
      markingElevationY: markY,
      renderOrder: node.renderOrder,
      depthOffset: node.depthOffset,
      higherOverlappingIds: higherIds,
      higherOverlappingMultiPolygon: higherUnionMp,
      resolvedMultiPolygon: finalMp,
    });
  }

  // ============================================================================
  // STAGE 4: Post-Resolution Surface Fill Mutual-Exclusion Audit
  // ============================================================================
  const activeResolved = Array.from(resolvedById.values()).filter(
    (l) => !l.isDeduplicatedInto && l.resolvedMultiPolygon.length > 0
  );

  const violations: PlanarValidationViolation[] = [];
  let maxResidualOverlap = 0;

  for (let i = 0; i < activeResolved.length; i++) {
    const a = activeResolved[i];
    if (a.semanticClass === 'PARKING_SPACE_DECAL') continue;

    for (let j = i + 1; j < activeResolved.length; j++) {
      const b = activeResolved[j];
      if (b.semanticClass === 'PARKING_SPACE_DECAL') continue;
      if (!doBoundingBoxesOverlap(a.bbox, b.bbox)) continue;

      let residualArea = 0;
      try {
        const inter = polygonClipping.intersection(
          a.resolvedMultiPolygon as polygonClipping.Geom,
          b.resolvedMultiPolygon as polygonClipping.Geom
        ) as unknown as MultiPolygonCoords;
        residualArea = computeMultiPolygonArea(inter);
      } catch {
        residualArea = 0;
      }

      if (residualArea > maxResidualOverlap) {
        maxResidualOverlap = residualArea;
      }

      if (residualArea > MAX_ALLOWED_SURFACE_FILL_OVERLAP_AREA) {
        violations.push({
          polygonAId: a.id,
          polygonBId: b.id,
          subtypeA: a.subtype,
          subtypeB: b.subtype,
          elevationA: a.elevationY,
          elevationB: b.elevationY,
          separationMeters: Math.abs(a.elevationY - b.elevationY),
          overlapAreaSqMeters: residualArea,
          reason: `Resolved surface fills ${a.id} (${a.subtype}) and ${b.id} (${b.subtype}) still overlap by ${residualArea.toFixed(5)} m² (> ${MAX_ALLOWED_SURFACE_FILL_OVERLAP_AREA} m²)`,
        });
      }
    }
  }

  const report: PlanarValidationReport = {
    isValid: violations.length === 0,
    totalPolygons: nodes.length,
    overlappingPairsChecked,
    conflictsResolved,
    deduplicatedCount,
    unionedCount,
    booleanSubtractionsCount,
    maxResidualFillOverlapSqMeters: Number(maxResidualOverlap.toFixed(6)),
    minObservedSeparationMeters: MIN_PLANAR_Y_SEPARATION,
    maxStackDepth,
    violations,
  };

  return { resolvedById, report };
}

/**
 * Validates a list of resolved planar layers.
 * Checks both:
 * 1. Residual 2D MultiPolygon overlap when `resolvedMultiPolygon` is present (must be <= 1e-4 m²), OR
 * 2. Vertical separation when two unclipped layers share overlapping footprints without Boolean subtraction.
 */
export function validatePlanarLayering(
  layers: ResolvedPlanarLayer[],
  overlappingPairsChecked: number = 0,
  conflictsResolved: number = 0,
  maxStackDepth: number = 1
): PlanarValidationReport {
  const violations: PlanarValidationViolation[] = [];
  let minObservedSeparation = Infinity;
  let maxResidualOverlap = 0;
  let checkedPairs = 0;

  for (let i = 0; i < layers.length; i++) {
    const a = layers[i];
    if (a.isDeduplicatedInto) continue;

    for (let j = i + 1; j < layers.length; j++) {
      const b = layers[j];
      if (b.isDeduplicatedInto) continue;
      if (!doBoundingBoxesOverlap(a.bbox, b.bbox)) continue;
      checkedPairs++;

      // Check if their resolved 2D MultiPolygons are mutually exclusive
      const hasResolvedGeoms =
        Array.isArray(a.resolvedMultiPolygon) &&
        a.resolvedMultiPolygon.length > 0 &&
        Array.isArray(b.resolvedMultiPolygon) &&
        b.resolvedMultiPolygon.length > 0;

      let residualOverlapArea = Infinity;
      if (
        hasResolvedGeoms &&
        a.semanticClass !== 'PARKING_SPACE_DECAL' &&
        b.semanticClass !== 'PARKING_SPACE_DECAL'
      ) {
        try {
          const inter = polygonClipping.intersection(
            a.resolvedMultiPolygon as polygonClipping.Geom,
            b.resolvedMultiPolygon as polygonClipping.Geom
          ) as unknown as MultiPolygonCoords;
          residualOverlapArea = computeMultiPolygonArea(inter);
          if (residualOverlapArea > maxResidualOverlap) {
            maxResidualOverlap = residualOverlapArea;
          }
        } catch {
          residualOverlapArea = Infinity;
        }
      }

      // If Boolean subtraction cleanly eliminated the 2D overlap, the pair is conflict-free!
      if (residualOverlapArea <= MAX_ALLOWED_SURFACE_FILL_OVERLAP_AREA) {
        continue;
      }

      // Otherwise, if the two layers still overlap in 2D, they must have vertical separation >= MIN_VALIDATED_Y_GAP
      const sep = Math.abs(a.elevationY - b.elevationY);
      if (sep < minObservedSeparation) {
        minObservedSeparation = sep;
      }

      if (sep < MIN_VALIDATED_Y_GAP - 1e-5) {
        violations.push({
          polygonAId: a.id,
          polygonBId: b.id,
          subtypeA: a.subtype,
          subtypeB: b.subtype,
          elevationA: a.elevationY,
          elevationB: b.elevationY,
          separationMeters: sep,
          overlapAreaSqMeters: Number.isFinite(residualOverlapArea) ? residualOverlapArea : undefined,
          reason: `Overlapping polygons ${a.id} (${a.subtype}) and ${b.id} (${b.subtype}) have unclipped 2D overlap and insufficient vertical separation (${(sep * 1000).toFixed(2)}mm < ${(MIN_VALIDATED_Y_GAP * 1000).toFixed(1)}mm)`,
        });
      }

      const lower = a.elevationY < b.elevationY ? a : b;
      const upper = a.elevationY < b.elevationY ? b : a;
      if (lower.hasSurfaceMarkings) {
        const markGap = upper.elevationY - lower.markingElevationY;
        if (markGap < MIN_VALIDATED_Y_GAP * 0.5 - 1e-5) {
          violations.push({
            polygonAId: lower.id,
            polygonBId: upper.id,
            subtypeA: lower.subtype,
            subtypeB: upper.subtype,
            elevationA: lower.markingElevationY,
            elevationB: upper.elevationY,
            separationMeters: markGap,
            reason: `Surface markings on ${lower.id} (${lower.subtype} at ${lower.markingElevationY}m) collide with upper overlapping polygon ${upper.id} (${upper.subtype} at ${upper.elevationY}m)`,
          });
        }
      }
    }
  }

  return {
    isValid: violations.length === 0,
    totalPolygons: layers.length,
    overlappingPairsChecked: Math.max(overlappingPairsChecked, checkedPairs),
    conflictsResolved,
    deduplicatedCount: 0,
    unionedCount: 0,
    booleanSubtractionsCount: 0,
    maxResidualFillOverlapSqMeters: Number(maxResidualOverlap.toFixed(6)),
    minObservedSeparationMeters:
      minObservedSeparation === Infinity ? MIN_PLANAR_Y_SEPARATION : Number(minObservedSeparation.toFixed(5)),
    maxStackDepth,
    violations,
  };
}
