/**
 * Narrow, geometry-only corner rounding for at-grade path-junction *patches*.
 *
 * A raw union of three or more full-width path stubs naturally creates sharp
 * cusp-like outline corners (the user-visible "pizza slices"). Round only
 * corners near the junction center, never any orthogonal cut portal. This
 * only proposes geometry: the caller must still check rings for intersections,
 * bound the affected area, and validate upward-wound triangulation before use.
 */
export type PathJunctionPolygon = [number, number][][][];
type Point = [number, number];

const snap = (v: number): number => Math.round(v * 10000) / 10000;

export function proposeRoundedPathJunctionOutline(
  polys: PathJunctionPolygon,
  nodeCenter: readonly [number, number],
  portalVertices: readonly (readonly [number, number])[],
  maxRoadWidth: number
): PathJunctionPolygon | null {
  if (!Number.isFinite(maxRoadWidth) || maxRoadWidth < 1 || polys.length === 0) return null;

  // Less than one third of the mapped path width. Do not alter longitudinal
  // road width or globally smooth source OSM polylines.
  const maxInset = Math.min(1.1, maxRoadWidth * 0.27);
  const neighborhood = maxRoadWidth * 1.5;
  let roundedCorners = 0;

  const result: PathJunctionPolygon = polys.map((poly) => {
    // Holes and multipolygon relationships are kept entirely unchanged.
    if (poly.length !== 1 || poly[0].length < 4) return poly;
    const ring = poly[0];
    const closed = ring[0][0] === ring[ring.length - 1][0] &&
      ring[0][1] === ring[ring.length - 1][1];
    const vertices = closed ? ring.slice(0, -1) : ring;
    if (vertices.length < 4) return poly;

    const rounded: Point[] = [];
    for (let i = 0; i < vertices.length; i++) {
      const prev = vertices[(i - 1 + vertices.length) % vertices.length];
      const cur = vertices[i];
      const next = vertices[(i + 1) % vertices.length];
      const dxPrev = cur[0] - prev[0], dzPrev = cur[1] - prev[1];
      const dxNext = next[0] - cur[0], dzNext = next[1] - cur[1];
      const lenPrev = Math.hypot(dxPrev, dzPrev);
      const lenNext = Math.hypot(dxNext, dzNext);

      if (lenPrev < 0.18 || lenNext < 0.18 ||
          Math.hypot(cur[0] - nodeCenter[0], cur[1] - nodeCenter[1]) > neighborhood ||
          portalVertices.some((p) => Math.hypot(cur[0] - p[0], cur[1] - p[1]) < 0.14)) {
        rounded.push([cur[0], cur[1]]);
        continue;
      }

      const cosine = (dxPrev * dxNext + dzPrev * dzNext) / (lenPrev * lenNext);
      // At straight seams there is no visible corner. Very acute reversing
      // spikes must stay with the existing strict validator/repair instead.
      if (cosine > 0.91 || cosine < -0.96) {
        rounded.push([cur[0], cur[1]]);
        continue;
      }
      // Neighboring corners each consume <= 33% of their shared edge;
      // there is always a non-overlapping straight portion left.
      const inset = Math.min(maxInset, lenPrev * 0.33, lenNext * 0.33);
      if (inset < 0.10) {
        rounded.push([cur[0], cur[1]]);
        continue;
      }

      const before: Point = [
        snap(cur[0] - dxPrev / lenPrev * inset),
        snap(cur[1] - dzPrev / lenPrev * inset),
      ];
      const after: Point = [
        snap(cur[0] + dxNext / lenNext * inset),
        snap(cur[1] + dzNext / lenNext * inset),
      ];
      rounded.push(before);
      // Quadratic Bezier is tangent to both original edges at its endpoints.
      for (let j = 1; j < 5; j++) {
        const t = j / 5;
        const a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c = t * t;
        rounded.push([
          snap(a * before[0] + b * cur[0] + c * after[0]),
          snap(a * before[1] + b * cur[1] + c * after[1]),
        ]);
      }
      rounded.push(after);
      roundedCorners++;
    }
    if (rounded.length < 3) return poly;
    return [[...rounded, [rounded[0][0], rounded[0][1]]]];
  });
  return roundedCorners > 0 ? result : null;
}
