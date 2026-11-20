import * as THREE from 'three';
import polygonClipping from 'polygon-clipping';
import {
  filterDegenerateBooleanArtifacts,
  type MultiPolygonCoords,
} from '../PlanarLayerValidator';
import type { InspectableFeatureInfo } from '../../types/MapFeature';

export interface ClipBox2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface FaceRangeEntry {
  startFace: number;
  endFace: number;
  info: InspectableFeatureInfo;
}

const POLY_CLIP_EPS = 1e-7;
const TRI_AREA_3D_EPS = 1e-12;
const TRI_AREA_XZ_EPS = 1e-11;

export function createBoxMultiPolygon(bounds: ClipBox2D): MultiPolygonCoords {
  const { minX, maxX, minZ, maxZ } = bounds;
  return [
    [
      [
        [minX, minZ],
        [maxX, minZ],
        [maxX, maxZ],
        [minX, maxZ],
        [minX, minZ],
      ],
    ],
  ];
}

export function getMultiPolygonBBox(
  mp: MultiPolygonCoords
): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let hasPoint = false;
  for (const poly of mp) {
    if (!poly[0]) continue;
    for (const [x, z] of poly[0]) {
      hasPoint = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  return hasPoint ? { minX, maxX, minZ, maxZ } : null;
}

/**
 * Exact 2D polygon intersection against a tile axis-aligned bounding box.
 * Uses fast accept/reject bbox checks before calling polygon-clipping.
 */
export function clipMultiPolygonToBox2D(
  mp: MultiPolygonCoords,
  bounds: ClipBox2D
): MultiPolygonCoords {
  if (!mp || mp.length === 0) return [];
  const bbox = getMultiPolygonBBox(mp);
  if (!bbox) return [];

  if (
    bbox.maxX <= bounds.minX + POLY_CLIP_EPS ||
    bbox.minX >= bounds.maxX - POLY_CLIP_EPS ||
    bbox.maxZ <= bounds.minZ + POLY_CLIP_EPS ||
    bbox.minZ >= bounds.maxZ - POLY_CLIP_EPS
  ) {
    return [];
  }

  if (
    bbox.minX >= bounds.minX - POLY_CLIP_EPS &&
    bbox.maxX <= bounds.maxX + POLY_CLIP_EPS &&
    bbox.minZ >= bounds.minZ - POLY_CLIP_EPS &&
    bbox.maxZ <= bounds.maxZ + POLY_CLIP_EPS
  ) {
    return mp;
  }

  const boxGeom = createBoxMultiPolygon(bounds);
  try {
    const clipped = polygonClipping.intersection(
      mp as unknown as polygonClipping.Geom,
      boxGeom as unknown as polygonClipping.Geom
    ) as unknown as MultiPolygonCoords;
    return filterDegenerateBooleanArtifacts(clipped);
  } catch {
    return [];
  }
}

interface ClipVertex {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  u: number;
  v: number;
  sw0: number;
  sw1: number;
  cr: number;
  cg: number;
  cb: number;
}

function lerpVertex(a: ClipVertex, b: ClipVertex, t: number): ClipVertex {
  const s = 1 - t;
  return {
    x: a.x * s + b.x * t,
    y: a.y * s + b.y * t,
    z: a.z * s + b.z * t,
    nx: a.nx * s + b.nx * t,
    ny: a.ny * s + b.ny * t,
    nz: a.nz * s + b.nz * t,
    u: a.u * s + b.u * t,
    v: a.v * s + b.v * t,
    sw0: a.sw0 * s + b.sw0 * t,
    sw1: a.sw1 * s + b.sw1 * t,
    cr: a.cr * s + b.cr * t,
    cg: a.cg * s + b.cg * t,
    cb: a.cb * s + b.cb * t,
  };
}

function clipPolyAgainstHalfPlane(
  poly: ClipVertex[],
  signedDist: (v: ClipVertex) => number
): ClipVertex[] {
  if (poly.length < 3) return [];
  const out: ClipVertex[] = [];
  const n = poly.length;

  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % n];
    const dCur = signedDist(cur);
    const dNxt = signedDist(nxt);
    const curIn = dCur >= 0;
    const nxtIn = dNxt >= 0;

    if (curIn && nxtIn) {
      out.push(nxt);
    } else if (curIn && !nxtIn) {
      const denom = dCur - dNxt;
      if (Math.abs(denom) > 1e-15) {
        const t = Math.max(0, Math.min(1, dCur / denom));
        out.push(lerpVertex(cur, nxt, t));
      }
    } else if (!curIn && nxtIn) {
      const denom = dCur - dNxt;
      if (Math.abs(denom) > 1e-15) {
        const t = Math.max(0, Math.min(1, dCur / denom));
        out.push(lerpVertex(cur, nxt, t));
      }
      out.push(nxt);
    }
  }
  return out;
}

function clipTriangleToBoxXZ(
  v0: ClipVertex,
  v1: ClipVertex,
  v2: ClipVertex,
  bounds: ClipBox2D
): ClipVertex[] {
  const minTX = Math.min(v0.x, v1.x, v2.x);
  const maxTX = Math.max(v0.x, v1.x, v2.x);
  const minTZ = Math.min(v0.z, v1.z, v2.z);
  const maxTZ = Math.max(v0.z, v1.z, v2.z);

  if (
    maxTX < bounds.minX ||
    minTX > bounds.maxX ||
    maxTZ < bounds.minZ ||
    minTZ > bounds.maxZ
  ) {
    return [];
  }

  // Reject flush-on-max-boundary zero-width triangles (half-open ownership on max edges)
  if (
    (minTX >= bounds.maxX - 1e-9 && maxTX <= bounds.maxX + 1e-9) ||
    (minTZ >= bounds.maxZ - 1e-9 && maxTZ <= bounds.maxZ + 1e-9)
  ) {
    return [];
  }

  if (
    minTX >= bounds.minX &&
    maxTX <= bounds.maxX &&
    minTZ >= bounds.minZ &&
    maxTZ <= bounds.maxZ
  ) {
    return [v0, v1, v2];
  }

  let poly: ClipVertex[] = [v0, v1, v2];
  poly = clipPolyAgainstHalfPlane(poly, (v) => v.x - bounds.minX);
  if (poly.length < 3) return [];
  poly = clipPolyAgainstHalfPlane(poly, (v) => bounds.maxX - v.x);
  if (poly.length < 3) return [];
  poly = clipPolyAgainstHalfPlane(poly, (v) => v.z - bounds.minZ);
  if (poly.length < 3) return [];
  poly = clipPolyAgainstHalfPlane(poly, (v) => bounds.maxZ - v.z);
  if (poly.length < 3) return [];

  return poly;
}

function resolveFaceRangeForInputFace(
  faceRanges: readonly FaceRangeEntry[] | undefined,
  faceIdx: number,
  cursorRef: { idx: number }
): InspectableFeatureInfo | null {
  if (!faceRanges || faceRanges.length === 0) return null;
  while (
    cursorRef.idx < faceRanges.length &&
    faceIdx > faceRanges[cursorRef.idx].endFace
  ) {
    cursorRef.idx++;
  }
  const current = faceRanges[cursorRef.idx];
  if (current && faceIdx >= current.startFace && faceIdx <= current.endFace) {
    return current.info;
  }
  // Fallback linear lookup if unsorted
  for (let i = 0; i < faceRanges.length; i++) {
    const entry = faceRanges[i];
    if (faceIdx >= entry.startFace && faceIdx <= entry.endFace) {
      return entry.info;
    }
  }
  return null;
}

/**
 * Exact 3D triangle clipping against an infinite vertical XZ prism `[minX, maxX] x [minZ, maxZ]`.
 * Preserves `position`, `normal`, `uv`, `aSwitchAttr`, vertex `color`, `groups` (materialIndex),
 * and accurately remaps `userData.faceRanges`.
 */
export function clipBufferGeometryToBoxXZ(
  geom: THREE.BufferGeometry,
  bounds: ClipBox2D
): THREE.BufferGeometry | null {
  const posAttr = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!posAttr || posAttr.count === 0) return null;

  if (!geom.boundingBox) {
    geom.computeBoundingBox();
  }
  const bb = geom.boundingBox;
  if (bb) {
    if (
      bb.max.x < bounds.minX ||
      bb.min.x > bounds.maxX ||
      bb.max.z < bounds.minZ ||
      bb.min.z > bounds.maxZ
    ) {
      return null;
    }
    if (
      bb.min.x >= bounds.minX &&
      bb.max.x < bounds.maxX - 1e-6 &&
      bb.min.z >= bounds.minZ &&
      bb.max.z < bounds.maxZ - 1e-6
    ) {
      const out = geom.index ? geom.toNonIndexed() : geom.clone();
      if (geom.userData) {
        out.userData = { ...geom.userData };
      }
      return out;
    }
  }

  const normAttr = geom.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const uvAttr = geom.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const switchAttr = geom.getAttribute('aSwitchAttr') as THREE.BufferAttribute | undefined;
  const colorAttr = geom.getAttribute('color') as THREE.BufferAttribute | undefined;
  const indexAttr = geom.getIndex();

  const totalTriCount = indexAttr
    ? Math.floor(indexAttr.count / 3)
    : Math.floor(posAttr.count / 3);
  if (totalTriCount <= 0) return null;

  const readVertex = (vi: number): ClipVertex => {
    return {
      x: posAttr.getX(vi),
      y: posAttr.getY(vi),
      z: posAttr.getZ(vi),
      nx: normAttr ? normAttr.getX(vi) : 0,
      ny: normAttr ? normAttr.getY(vi) : 1,
      nz: normAttr ? normAttr.getZ(vi) : 0,
      u: uvAttr ? uvAttr.getX(vi) : 0,
      v: uvAttr ? uvAttr.getY(vi) : 0,
      sw0: switchAttr ? switchAttr.getX(vi) : 999,
      sw1: switchAttr ? switchAttr.getY(vi) : 1,
      cr: colorAttr ? colorAttr.getX(vi) : 1,
      cg: colorAttr ? colorAttr.getY(vi) : 1,
      cb: colorAttr ? colorAttr.getZ(vi) : 1,
    };
  };

  // Group span handling (preserve multi-material groups if present)
  const srcGroups =
    geom.groups && geom.groups.length > 0
      ? geom.groups.map((g) => ({
          startTri: Math.floor(g.start / 3),
          endTri: Math.floor((g.start + g.count) / 3) - 1,
          materialIndex: g.materialIndex ?? 0,
        }))
      : [{ startTri: 0, endTri: totalTriCount - 1, materialIndex: 0 }];

  const outPositions: number[] = [];
  const outNormals: number[] = [];
  const outUvs: number[] = [];
  const outSwitches: number[] = [];
  const outColors: number[] = [];
  const outGroups: Array<{ start: number; count: number; materialIndex: number }> = [];

  const srcFaceRanges = geom.userData?.faceRanges as FaceRangeEntry[] | undefined;
  const outFaceRanges: FaceRangeEntry[] = [];
  const faceRangeCursor = { idx: 0 };
  let outFaceCount = 0;

  const pushOutputTriangle = (
    a: ClipVertex,
    b: ClipVertex,
    c: ClipVertex,
    info: InspectableFeatureInfo | null
  ) => {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const acx = c.x - a.x;
    const acy = c.y - a.y;
    const acz = c.z - a.z;

    const cx = aby * acz - abz * acy;
    const cy = abz * acx - abx * acz;
    const cz = abx * acy - aby * acx;
    const area3DSq = 0.25 * (cx * cx + cy * cy + cz * cz);
    if (area3DSq <= TRI_AREA_3D_EPS * TRI_AREA_3D_EPS) return;

    // If essentially horizontal, reject zero-area XZ slivers on boundary edges
    const areaXZ = 0.5 * Math.abs(abx * acz - abz * acx);
    if (Math.abs(aby) < 1e-6 && Math.abs(acy) < 1e-6 && areaXZ <= TRI_AREA_XZ_EPS) {
      return;
    }

    const pushV = (v: ClipVertex) => {
      outPositions.push(v.x, v.y, v.z);
      if (normAttr) {
        const len = Math.hypot(v.nx, v.ny, v.nz);
        if (len > 1e-9) {
          outNormals.push(v.nx / len, v.ny / len, v.nz / len);
        } else {
          outNormals.push(0, 1, 0);
        }
      }
      if (uvAttr) outUvs.push(v.u, v.v);
      if (switchAttr) outSwitches.push(v.sw0, v.sw1);
      if (colorAttr) outColors.push(v.cr, v.cg, v.cb);
    };

    pushV(a);
    pushV(b);
    pushV(c);

    if (info) {
      const lastRange = outFaceRanges[outFaceRanges.length - 1];
      if (lastRange && lastRange.info === info && lastRange.endFace === outFaceCount - 1) {
        lastRange.endFace = outFaceCount;
      } else {
        outFaceRanges.push({
          startFace: outFaceCount,
          endFace: outFaceCount,
          info,
        });
      }
    }
    outFaceCount++;
  };

  for (const grp of srcGroups) {
    const grpStartVertex = outFaceCount * 3;
    for (let f = grp.startTri; f <= grp.endTri && f < totalTriCount; f++) {
      const i0 = indexAttr ? indexAttr.getX(f * 3) : f * 3;
      const i1 = indexAttr ? indexAttr.getX(f * 3 + 1) : f * 3 + 1;
      const i2 = indexAttr ? indexAttr.getX(f * 3 + 2) : f * 3 + 2;

      const v0 = readVertex(i0);
      const v1 = readVertex(i1);
      const v2 = readVertex(i2);
      const clippedPoly = clipTriangleToBoxXZ(v0, v1, v2, bounds);
      if (clippedPoly.length < 3) continue;

      const faceInfo = resolveFaceRangeForInputFace(srcFaceRanges, f, faceRangeCursor);
      for (let k = 1; k < clippedPoly.length - 1; k++) {
        pushOutputTriangle(clippedPoly[0], clippedPoly[k], clippedPoly[k + 1], faceInfo);
      }
    }
    const grpEndVertex = outFaceCount * 3;
    if (grpEndVertex > grpStartVertex && geom.groups && geom.groups.length > 0) {
      outGroups.push({
        start: grpStartVertex,
        count: grpEndVertex - grpStartVertex,
        materialIndex: grp.materialIndex,
      });
    }
  }

  if (outFaceCount === 0) return null;

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPositions, 3));
  if (normAttr) {
    out.setAttribute('normal', new THREE.Float32BufferAttribute(outNormals, 3));
  }
  if (uvAttr) {
    out.setAttribute('uv', new THREE.Float32BufferAttribute(outUvs, 2));
  }
  if (switchAttr) {
    out.setAttribute('aSwitchAttr', new THREE.Float32BufferAttribute(outSwitches, 2));
  }
  if (colorAttr) {
    out.setAttribute('color', new THREE.Float32BufferAttribute(outColors, 3));
  }
  for (const g of outGroups) {
    out.addGroup(g.start, g.count, g.materialIndex);
  }
  if (geom.userData) {
    out.userData = { ...geom.userData };
  }
  if (srcFaceRanges) {
    out.userData.faceRanges = outFaceRanges;
  }
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}
