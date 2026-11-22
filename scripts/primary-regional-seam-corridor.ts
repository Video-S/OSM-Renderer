/**
 * TKT-033 read-only primary-road seam diagnosis.
 * Source-line arc-length points, never axis-aligned approximations.
 * Only a bounded sequence of physical samples; NOT a geometry continuity proof.
 */
export type UTM = readonly [number, number];
export interface RoadArcPoint {
  signedMeters: number;
  easting: number;
  northing: number;
}
export type RoadArcPlan =
  | { status: 'inconclusive'; reason: string }
  | {
      status: 'ready';
      anchor: UTM;
      closestDistanceMeters: number;
      sourceLineVertices: number;
      availableBackwardMeters: number;
      availableForwardMeters: number;
      points: RoadArcPoint[];
    };

/** Distances on each side of the actual OSM centerline/seam crossing. */
export const PRIMARY_ROAD_SAMPLE_OFFSETS: readonly number[] = [
  -256, -192, -128, -96, -64, -48, -32, -24, -16, -12, -8, -6, -4,
  -3, -2, -1, -0.5, -0.25, -0.1, -0.05,
  0.05, 0.1, 0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32,
  48, 64, 96, 128, 192, 256,
];

/**
 * Choose the nearest source line at the audited point and probe along its
 * true arc length. Explicitly reject seam tangency, endpoint-only contact,
 * ambiguous source parts, and mismatches with the canonical crossing point.
 */
export function planPrimaryRoadCorridor(input: {
  lines: readonly (readonly UTM[])[];
  easting: number;
  northing: number;
  offsets?: readonly number[];
}): RoadArcPlan {
  const fail = (reason: string): RoadArcPlan => ({ status: 'inconclusive', reason });
  const { lines, easting, northing } = input;
  if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
    return fail('Invalid canonical seam coordinates');
  }
  const candidates: Array<{
    line: readonly UTM[];
    cumulative: number[];
    arcAtClosest: number;
    closest: UTM;
    distance: number;
  }> = [];

  for (const line of lines) {
    if (line.length < 2 || line.some(p =>
      !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) continue;
    const cum = [0];
    for (let i = 1; i < line.length; i++) {
      const length = Math.hypot(line[i][0] - line[i - 1][0],
        line[i][1] - line[i - 1][1]);
      if (length <= 1e-8) break;
      cum.push(cum[cum.length - 1] + length);
    }
    if (cum.length !== line.length) continue;

    let best: { distance: number; arc: number; point: UTM } | null = null;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i], len = cum[i] - cum[i - 1];
      const t = Math.max(0, Math.min(1,
        ((easting - a[0]) * (b[0] - a[0]) +
          (northing - a[1]) * (b[1] - a[1])) / (len * len)));
      const p: UTM = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      const d = Math.hypot(p[0] - easting, p[1] - northing);
      if (!best || d < best.distance) {
        best = { distance: d, arc: cum[i - 1] + t * len, point: p };
      }
    }
    if (best) candidates.push({
      line, cumulative: cum, arcAtClosest: best.arc,
      closest: best.point, distance: best.distance,
    });
  }

  candidates.sort((a, b) => a.distance - b.distance);
  const selected = candidates[0];
  if (!selected || selected.distance > 0.5) {
    return fail('No OSM road centerline within 0.5m of the audited seam point');
  }
  if (candidates.length > 1 && candidates[1].distance < 0.5 &&
      Math.abs(candidates[1].distance - selected.distance) < 0.01) {
    return fail('Multiple indistinguishable source-line parts near the seam');
  }

  const { line, cumulative, arcAtClosest: arc, closest } = selected;
  const total = cumulative[cumulative.length - 1];
  const atArc = (distance: number): UTM => {
    for (let i = 1; i < line.length; i++) {
      if (distance <= cumulative[i] || i === line.length - 1) {
        const t = Math.min(1, Math.max(0,
          (distance - cumulative[i - 1]) /
          (cumulative[i] - cumulative[i - 1])));
        const a = line[i - 1], b = line[i];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
    }
    return line[line.length - 1];
  };
  if (arc < 0.5 || total - arc < 0.5) {
    return fail('Source line terminates within 0.5m of the inspected crossing');
  }
  const a = atArc(arc - 0.25), b = atArc(arc + 0.25);
  if (!((a[1] < northing - 0.02 && b[1] > northing + 0.02) ||
        (b[1] < northing - 0.02 && a[1] > northing + 0.02))) {
    return fail('OSM centerline does not properly cross the horizontal shard seam');
  }
  const offsets = input.offsets ?? PRIMARY_ROAD_SAMPLE_OFFSETS;
  const nearTileBorder = (coordinate: number) => {
    const remainder = coordinate - Math.floor(coordinate / 1024) * 1024;
    return remainder < 0.005 || remainder > 1024 - 0.005;
  };
  const points: RoadArcPoint[] = [];
  for (const signed of offsets) {
    if (!Number.isFinite(signed) || signed === 0) continue;
    const d = arc + signed;
    if (d < 0 || d > total) continue;
    const point = atArc(d);
    if (nearTileBorder(point[0]) || nearTileBorder(point[1])) continue;
    points.push({
      signedMeters: signed, easting: point[0], northing: point[1],
    });
  }
  if (!points.some(p => p.northing < northing - 0.02) ||
      !points.some(p => p.northing > northing + 0.02)) {
    return fail('No valid sampled source centerline points on both sides');
  }
  return {
    status: 'ready',
    anchor: closest,
    closestDistanceMeters: selected.distance,
    sourceLineVertices: line.length,
    availableBackwardMeters: arc,
    availableForwardMeters: total - arc,
    points,
  };
}

/**
 * Physical widths sampled perpendicular to the nearest OSM centerline.
 * Offset signs follow line vertex order. Do not substitute these samples
 * for full polygon or runtime visual equivalence.
 */
export function roadPerpendicularSample(
  lines: readonly (readonly UTM[])[],
  point: UTM,
  lateralMeters: number
): UTM | null {
  let best: { squared: number; tangent: UTM } | null = null;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const d2 = dx * dx + dy * dy;
      if (!(d2 > 1e-10)) continue;
      const t = Math.max(0, Math.min(1,
        ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / d2));
      const x = a[0] + t * dx, y = a[1] + t * dy;
      const dist2 = (point[0] - x) ** 2 + (point[1] - y) ** 2;
      if (!best || dist2 < best.squared) {
        const length = Math.sqrt(d2);
        best = { squared: dist2, tangent: [dx / length, dy / length] };
      }
    }
  }
  if (!best || best.squared > 0.25 || !Number.isFinite(lateralMeters)) return null;
  return [
    point[0] - lateralMeters * best.tangent[1],
    point[1] + lateralMeters * best.tangent[0],
  ];
}
