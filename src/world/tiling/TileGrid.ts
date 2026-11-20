import {
  EPSG_25832_CODE,
  RegionalProjection,
  geoToUtm32N,
  utm32NToGeo,
} from './RegionalProjection';

export const DEFAULT_TILE_SIZE_METERS = 512;
export const DEFAULT_COLLAR_METERS = 64;
export const HENGELO_CENTER_LONLAT: readonly [number, number] = [6.7935, 52.2625];
export const HENGELO_GRID_DIMENSION = 8; // 8 x 8 = 64 tiles -> 4,096 m x 4,096 m

export interface WorldBox2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  includeMaxEdgeX?: boolean;
  includeMaxEdgeZ?: boolean;
}

export interface UtmBox2D {
  minEasting: number;
  maxEasting: number;
  minNorthing: number;
  maxNorthing: number;
}

export interface GeoBBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface TileDescriptor {
  id: string;
  tx: number;
  ty: number;
  gridRow: number; // 0 = northernmost row within study grid, ascending southward (+Z)
  gridCol: number; // 0 = westernmost col within study grid, ascending eastward (+X)
  utmBounds: UtmBox2D;
  localBounds: WorldBox2D;
  collarLocalBounds: WorldBox2D;
  collarGeoBounds: GeoBBox;
  isEastBoundaryTile: boolean;
  isSouthBoundaryTile: boolean;
}

export interface StudyGridSpec {
  name: string;
  crs: string;
  tileSizeMeters: number;
  collarMeters: number;
  minTx: number;
  maxTx: number;
  minTy: number;
  maxTy: number;
  cols: number;
  rows: number;
  projection: RegionalProjection;
  studyUtmBounds: UtmBox2D;
  studyLocalBounds: WorldBox2D;
  studyGeoBounds: GeoBBox;
  studyExpandedGeoBounds: GeoBBox;
  tiles: TileDescriptor[];
}

export function formatTileId(tx: number, ty: number): string {
  return `tx_${tx}_ty_${ty}`;
}

export function utmBoundsToGeoBounds(utmBounds: UtmBox2D): GeoBBox {
  const corners: [number, number][] = [
    utm32NToGeo(utmBounds.minEasting, utmBounds.minNorthing),
    utm32NToGeo(utmBounds.maxEasting, utmBounds.minNorthing),
    utm32NToGeo(utmBounds.minEasting, utmBounds.maxNorthing),
    utm32NToGeo(utmBounds.maxEasting, utmBounds.maxNorthing),
  ];
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of corners) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLon, minLat, maxLon, maxLat };
}

/**
 * Creates a deterministic, meter-aligned tile grid in ETRS89 / UTM Zone 32N (EPSG:25832).
 *
 * Tile index conventions:
 * - `tx = Math.floor(easting / tileSizeMeters)` (increases Eastward, +X)
 * - `ty = Math.floor(northing / tileSizeMeters)` (increases Northward, -Z)
 *
 * World frame origin is placed at the exact center of the study grid in UTM meters so
 * every tile coordinate in `studyLocalBounds` is an exact integer multiple of `tileSizeMeters`.
 */
export function createAlignedStudyGrid(params: {
  name: string;
  centerLonLat: readonly [number, number];
  cols: number;
  rows: number;
  tileSizeMeters?: number;
  collarMeters?: number;
}): StudyGridSpec {
  const tileSizeMeters = params.tileSizeMeters ?? DEFAULT_TILE_SIZE_METERS;
  const collarMeters = params.collarMeters ?? DEFAULT_COLLAR_METERS;
  const [centerLon, centerLat] = params.centerLonLat;
  const [centerE, centerN] = geoToUtm32N(centerLon, centerLat);

  const halfSpanX = (params.cols * tileSizeMeters) / 2;
  const halfSpanY = (params.rows * tileSizeMeters) / 2;

  const minTx = Math.round((centerE - halfSpanX) / tileSizeMeters);
  const maxTx = minTx + params.cols - 1;
  const minTy = Math.round((centerN - halfSpanY) / tileSizeMeters);
  const maxTy = minTy + params.rows - 1;

  const studyMinE = minTx * tileSizeMeters;
  const studyMaxE = (maxTx + 1) * tileSizeMeters;
  const studyMinN = minTy * tileSizeMeters;
  const studyMaxN = (maxTy + 1) * tileSizeMeters;

  const originE = (studyMinE + studyMaxE) / 2;
  const originN = (studyMinN + studyMaxN) / 2;
  const projection = new RegionalProjection(originE, originN);

  const studyUtmBounds: UtmBox2D = {
    minEasting: studyMinE,
    maxEasting: studyMaxE,
    minNorthing: studyMinN,
    maxNorthing: studyMaxN,
  };

  const [sMinX, sMaxZ] = projection.utmToLocal(studyMinE, studyMinN);
  const [sMaxX, sMinZ] = projection.utmToLocal(studyMaxE, studyMaxN);

  const studyLocalBounds: WorldBox2D = {
    minX: sMinX,
    maxX: sMaxX,
    minZ: sMinZ,
    maxZ: sMaxZ,
    includeMaxEdgeX: true,
    includeMaxEdgeZ: true,
  };

  const tiles: TileDescriptor[] = [];
  // Order rows North-to-South (+Z ascending) and cols West-to-East (+X ascending)
  for (let gridRow = 0; gridRow < params.rows; gridRow++) {
    const ty = maxTy - gridRow;
    const minN = ty * tileSizeMeters;
    const maxN = (ty + 1) * tileSizeMeters;
    const isSouthBoundaryTile = gridRow === params.rows - 1;

    for (let gridCol = 0; gridCol < params.cols; gridCol++) {
      const tx = minTx + gridCol;
      const minE = tx * tileSizeMeters;
      const maxE = (tx + 1) * tileSizeMeters;
      const isEastBoundaryTile = gridCol === params.cols - 1;

      const [minX, maxZ] = projection.utmToLocal(minE, minN);
      const [maxX, minZ] = projection.utmToLocal(maxE, maxN);

      const utmBounds: UtmBox2D = {
        minEasting: minE,
        maxEasting: maxE,
        minNorthing: minN,
        maxNorthing: maxN,
      };
      const localBounds: WorldBox2D = {
        minX,
        maxX,
        minZ,
        maxZ,
        includeMaxEdgeX: isEastBoundaryTile,
        includeMaxEdgeZ: isSouthBoundaryTile,
      };
      const collarLocalBounds: WorldBox2D = {
        minX: minX - collarMeters,
        maxX: maxX + collarMeters,
        minZ: minZ - collarMeters,
        maxZ: maxZ + collarMeters,
        includeMaxEdgeX: true,
        includeMaxEdgeZ: true,
      };
      const collarGeoBounds = utmBoundsToGeoBounds({
        minEasting: minE - collarMeters,
        maxEasting: maxE + collarMeters,
        minNorthing: minN - collarMeters,
        maxNorthing: maxN + collarMeters,
      });

      tiles.push({
        id: formatTileId(tx, ty),
        tx,
        ty,
        gridRow,
        gridCol,
        utmBounds,
        localBounds,
        collarLocalBounds,
        collarGeoBounds,
        isEastBoundaryTile,
        isSouthBoundaryTile,
      });
    }
  }

  const studyGeoBounds = utmBoundsToGeoBounds(studyUtmBounds);
  const studyExpandedGeoBounds = utmBoundsToGeoBounds({
    minEasting: studyMinE - collarMeters,
    maxEasting: studyMaxE + collarMeters,
    minNorthing: studyMinN - collarMeters,
    maxNorthing: studyMaxN + collarMeters,
  });

  return {
    name: params.name,
    crs: EPSG_25832_CODE,
    tileSizeMeters,
    collarMeters,
    minTx,
    maxTx,
    minTy,
    maxTy,
    cols: params.cols,
    rows: params.rows,
    projection,
    studyUtmBounds,
    studyLocalBounds,
    studyGeoBounds,
    studyExpandedGeoBounds,
    tiles,
  };
}

/**
 * Canonical M1a Hengelo study grid:
 * 8 x 8 tiles of 512 m = 4,096 m x 4,096 m aligned to EPSG:25832 around [6.7935, 52.2625].
 * Note: Distinct from legacy TKT-026 S5 4,000 m tangent-equirectangular benchmark footprint.
 */
export function createHengeloStudyGrid(
  tileSizeMeters = DEFAULT_TILE_SIZE_METERS,
  collarMeters = DEFAULT_COLLAR_METERS
): StudyGridSpec {
  return createAlignedStudyGrid({
    name: 'hengelo-8x8-m1a',
    centerLonLat: HENGELO_CENTER_LONLAT,
    cols: HENGELO_GRID_DIMENSION,
    rows: HENGELO_GRID_DIMENSION,
    tileSizeMeters,
    collarMeters,
  });
}

/**
 * Deterministic half-open ownership predicate:
 * [minX, maxX) x [minZ, maxZ), with optional closed outer boundary on study max edges.
 */
export function pointInHalfOpenBox(
  x: number,
  z: number,
  box: WorldBox2D,
  eps = 0
): boolean {
  const xLowerOk = x >= box.minX - eps;
  const xUpperOk = box.includeMaxEdgeX ? x <= box.maxX + eps : x < box.maxX;
  const zLowerOk = z >= box.minZ - eps;
  const zUpperOk = box.includeMaxEdgeZ ? z <= box.maxZ + eps : z < box.maxZ;
  return xLowerOk && xUpperOk && zLowerOk && zUpperOk;
}

export function computeRingBBox(
  rings: readonly (readonly [number, number][])[]
): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let hasPoint = false;
  for (const ring of rings) {
    for (const [x, z] of ring) {
      hasPoint = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  return hasPoint ? { minX, maxX, minZ, maxZ } : null;
}

export function computePointsBBox(
  points: readonly [number, number][]
): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  if (!points || points.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

export function boxesOverlap2D(
  a: { minX: number; maxX: number; minZ: number; maxZ: number },
  b: { minX: number; maxX: number; minZ: number; maxZ: number },
  padMeters = 0
): boolean {
  return (
    a.maxX >= b.minX - padMeters &&
    a.minX <= b.maxX + padMeters &&
    a.maxZ >= b.minZ - padMeters &&
    a.minZ <= b.maxZ + padMeters
  );
}

/**
 * Canonical discrete-object centroid used for deterministic half-open tile ownership
 * (matches GeometryBuilder/Scene ownership without slicing discrete buildings).
 */
export function getRingsBBoxCentroid(
  rings: readonly (readonly [number, number][])[]
): [number, number] | null {
  const bbox = computeRingBBox(rings);
  if (!bbox) return null;
  return [(bbox.minX + bbox.maxX) * 0.5, (bbox.minZ + bbox.maxZ) * 0.5];
}
