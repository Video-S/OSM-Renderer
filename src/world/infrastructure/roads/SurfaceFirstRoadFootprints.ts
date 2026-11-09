import polygonClipping from 'polygon-clipping';
import {
  MultiPolygonCoords,
  filterDegenerateBooleanArtifacts,
} from '../../PlanarLayerValidator';

type Point = [number, number];

export interface SurfaceFirstBufferOptions {
  capStart: boolean;
  capEnd: boolean;
}

/**
 * Optional per-call or per-build accumulator for E2+ footprint construction metrics.
 * Recording into this structure is purely observational and never alters geometry output.
 */
export interface SurfaceFirstBufferInstrumentation {
  /** Number of segment rectangle primitives generated. */
  rectanglePrimitiveCount: number;
  /** Number of interior bend disk primitives generated (`dot < 0.9986`). */
  bendDiskPrimitiveCount: number;
  /** Number of endpoint or closed-loop cap disk primitives generated. */
  capDiskPrimitiveCount: number;
  /** Number of `polygonClipping.union` operations invoked during stroke buffering. */
  unionOperationCount: number;
  /** Wall-clock time (`ms`) spent constructing segment rectangle and disk primitives prior to Boolean union. */
  primitiveConstructionTimeMs: number;
  /** Wall-clock time (`ms`) spent in `polygonClipping.union` and `filterDegenerateBooleanArtifacts` during stroke buffering. */
  polygonUnionTimeMs: number;
}

export interface SurfaceFirstProvenanceSubSegmentSpec {
  id: string;
  sourceKey: string;
  points: ReadonlyArray<readonly [number, number]>;
  width: number;
}

export function cleanSurfaceFirstPolyline(
  points: ReadonlyArray<readonly [number, number]>
): Point[] {
  const clean: Point[] = [];
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (
      !clean.length ||
      Math.hypot(
        p[0] - clean[clean.length - 1][0],
        p[1] - clean[clean.length - 1][1]
      ) > 0.02
    ) {
      clean.push([p[0], p[1]]);
    }
  }
  return clean;
}

function computeCleanedPolylineLength(clean: ReadonlyArray<Point>): number {
  let total = 0;
  for (let i = 1; i < clean.length; i++) {
    total += Math.hypot(clean[i][0] - clean[i - 1][0], clean[i][1] - clean[i - 1][1]);
  }
  return total;
}

function compareStringsLexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Determines whether the shared internal boundary between two consecutive
 * provenance subsegments `subA` (at its end) and `subB` (at its start)
 * requires a rounding join disk, and assigns that join to at most one of
 * the two subsegments deterministically.
 *
 * - Straight equal-width boundaries (`dot >= 0.9986`) receive no disk on either side.
 * - Angled boundaries (`dot < 0.9986`) or width transitions (`|wA - wB| > 1e-3`)
 *   assign a single rounding disk to one deterministic owner:
 *   1. Wider segment if widths differ (`|wA - wB| > 1e-3`).
 *   2. Longer segment if millimeter-rounded cleaned arc lengths differ.
 *   3. Lexically smaller `sourceKey` (then `id`) for ties.
 */
export function resolveInternalProvenanceBoundaryCaps(
  subA: SurfaceFirstProvenanceSubSegmentSpec,
  subB: SurfaceFirstProvenanceSubSegmentSpec
): { capEndOnA: boolean; capStartOnB: boolean } {
  if (
    subA.width <= 0 ||
    subB.width <= 0 ||
    !Number.isFinite(subA.width) ||
    !Number.isFinite(subB.width)
  ) {
    return { capEndOnA: false, capStartOnB: false };
  }

  const cleanA = cleanSurfaceFirstPolyline(subA.points);
  const cleanB = cleanSurfaceFirstPolyline(subB.points);
  if (cleanA.length < 2 || cleanB.length < 2) {
    return { capEndOnA: false, capStartOnB: false };
  }

  const pJoinA = cleanA[cleanA.length - 1];
  const pJoinB = cleanB[0];
  if (Math.hypot(pJoinA[0] - pJoinB[0], pJoinA[1] - pJoinB[1]) >= 0.05) {
    return { capEndOnA: false, capStartOnB: false };
  }

  const a = cleanA[cleanA.length - 2];
  const c = cleanB[1];
  const ux = pJoinA[0] - a[0];
  const uz = pJoinA[1] - a[1];
  const vx = c[0] - pJoinB[0];
  const vz = c[1] - pJoinB[1];
  const len = Math.hypot(ux, uz) * Math.hypot(vx, vz);
  if (len <= 1e-6) {
    return { capEndOnA: false, capStartOnB: false };
  }

  const dot = (ux * vx + uz * vz) / len;
  const hasBend = dot < 0.9986;
  const hasWidthTransition = Math.abs(subA.width - subB.width) > 1e-3;

  if (!hasBend && !hasWidthTransition) {
    return { capEndOnA: false, capStartOnB: false };
  }

  if (hasWidthTransition) {
    return subA.width >= subB.width
      ? { capEndOnA: true, capStartOnB: false }
      : { capEndOnA: false, capStartOnB: true };
  }

  const lenAMm = Math.round(computeCleanedPolylineLength(cleanA) * 1000);
  const lenBMm = Math.round(computeCleanedPolylineLength(cleanB) * 1000);
  if (lenAMm !== lenBMm) {
    return lenAMm > lenBMm
      ? { capEndOnA: true, capStartOnB: false }
      : { capEndOnA: false, capStartOnB: true };
  }

  const keyCmp = compareStringsLexical(subA.sourceKey, subB.sourceKey);
  if (keyCmp !== 0) {
    return keyCmp < 0
      ? { capEndOnA: true, capStartOnB: false }
      : { capEndOnA: false, capStartOnB: true };
  }

  return compareStringsLexical(subA.id, subB.id) <= 0
    ? { capEndOnA: true, capStartOnB: false }
    : { capEndOnA: false, capStartOnB: true };
}

/**
 * E2+ rounded stroke footprint. A centerline is buffered as a local union
 * of full-width segment rectangles and round joins/caps. Junctions are the
 * union of intersecting strokes through the existing class-ordered ownership
 * clipper, not explicitly constructed junction patches.
 */
export function bufferSurfaceFirstRoadCenterline(
  points: ReadonlyArray<readonly [number, number]>,
  width: number,
  options: SurfaceFirstBufferOptions,
  instrumentation?: SurfaceFirstBufferInstrumentation
): MultiPolygonCoords {
  const tStart = instrumentation ? performance.now() : 0;
  if (width <= 0 || !Number.isFinite(width) || points.length < 2) return [];
  const clean = cleanSurfaceFirstPolyline(points);
  if (clean.length < 2) return [];
  const closed = clean.length >= 4 && Math.hypot(
    clean[0][0] - clean[clean.length - 1][0],
    clean[0][1] - clean[clean.length - 1][1]
  ) < 0.05;
  const snap = (x: number) => Math.round(x * 10000) / 10000;
  const radius = width / 2;
  const pieces: MultiPolygonCoords[] = [];
  const disk = (p: Point): MultiPolygonCoords => {
    const ring: Point[] = [];
    for (let k = 0; k < 16; k++) {
      const angle = k * Math.PI / 8;
      ring.push([snap(p[0] + Math.cos(angle) * radius),
        snap(p[1] + Math.sin(angle) * radius)]);
    }
    ring.push([ring[0][0], ring[0][1]]);
    return [[ring]];
  };
  let rectCount = 0;
  let bendDiskCount = 0;
  let capDiskCount = 0;
  for (let i = 1; i < clean.length; i++) {
    const a = clean[i - 1], b = clean[i];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len <= 0.02) continue;
    const nx = -dz * radius / len, nz = dx * radius / len;
    const ring: Point[] = [
      [snap(a[0] + nx), snap(a[1] + nz)],
      [snap(b[0] + nx), snap(b[1] + nz)],
      [snap(b[0] - nx), snap(b[1] - nz)],
      [snap(a[0] - nx), snap(a[1] - nz)],
    ];
    ring.push([ring[0][0], ring[0][1]]);
    pieces.push([[ring]]);
    rectCount++;
  }
  for (let i = 1; i < clean.length - 1; i++) {
    const a = clean[i - 1], b = clean[i], c = clean[i + 1];
    const ux = b[0] - a[0], uz = b[1] - a[1];
    const vx = c[0] - b[0], vz = c[1] - b[1];
    const len = Math.hypot(ux, uz) * Math.hypot(vx, vz);
    if (len > 1e-6 && (ux * vx + uz * vz) / len < 0.9986) {
      pieces.push(disk(b));
      bendDiskCount++;
    }
  }
  if (!closed && options.capStart) {
    pieces.push(disk(clean[0]));
    capDiskCount++;
  }
  if (!closed && options.capEnd) {
    pieces.push(disk(clean[clean.length - 1]));
    capDiskCount++;
  }
  if (closed) {
    pieces.push(disk(clean[0]));
    capDiskCount++;
  }
  if (instrumentation) {
    instrumentation.rectanglePrimitiveCount += rectCount;
    instrumentation.bendDiskPrimitiveCount += bendDiskCount;
    instrumentation.capDiskPrimitiveCount += capDiskCount;
    instrumentation.primitiveConstructionTimeMs += performance.now() - tStart;
  }
  if (!pieces.length) return [];
  const tUnionStart = instrumentation ? performance.now() : 0;
  try {
    return filterDegenerateBooleanArtifacts(polygonClipping.union(
      pieces[0] as unknown as polygonClipping.Geom,
      ...(pieces.slice(1) as unknown as polygonClipping.Geom[])
    ) as unknown as MultiPolygonCoords);
  } finally {
    if (instrumentation) {
      instrumentation.unionOperationCount += 1;
      instrumentation.polygonUnionTimeMs += performance.now() - tUnionStart;
    }
  }
}

