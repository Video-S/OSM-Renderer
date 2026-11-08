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
 * E2+ rounded stroke footprint. A centerline is buffered as a local union
 * of full-width segment rectangles and round joins/caps. Junctions are the
 * union of intersecting strokes through the existing class-ordered ownership
 * clipper, not explicitly constructed junction patches.
 */
export function bufferSurfaceFirstRoadCenterline(
  points: ReadonlyArray<readonly [number, number]>,
  width: number,
  options: SurfaceFirstBufferOptions
): MultiPolygonCoords {
  if (width <= 0 || !Number.isFinite(width) || points.length < 2) return [];
  const clean: Point[] = [];
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (!clean.length || Math.hypot(
      p[0] - clean[clean.length - 1][0],
      p[1] - clean[clean.length - 1][1]
    ) > 0.02) clean.push([p[0], p[1]]);
  }
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
  }
  for (let i = 1; i < clean.length - 1; i++) {
    const a = clean[i - 1], b = clean[i], c = clean[i + 1];
    const ux = b[0] - a[0], uz = b[1] - a[1];
    const vx = c[0] - b[0], vz = c[1] - b[1];
    const len = Math.hypot(ux, uz) * Math.hypot(vx, vz);
    if (len > 1e-6 && (ux * vx + uz * vz) / len < 0.9986) {
      pieces.push(disk(b));
    }
  }
  if (!closed && options.capStart) pieces.push(disk(clean[0]));
  if (!closed && options.capEnd) pieces.push(disk(clean[clean.length - 1]));
  if (closed) pieces.push(disk(clean[0]));
  if (!pieces.length) return [];
  return filterDegenerateBooleanArtifacts(polygonClipping.union(
    pieces[0] as unknown as polygonClipping.Geom,
    ...(pieces.slice(1) as unknown as polygonClipping.Geom[])
  ) as unknown as MultiPolygonCoords);
}
