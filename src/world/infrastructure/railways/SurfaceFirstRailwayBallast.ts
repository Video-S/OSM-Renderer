import polygonClipping from 'polygon-clipping';
import * as THREE from 'three';
import {
  MultiPolygonCoords,
  filterDegenerateBooleanArtifacts,
} from '../../PlanarLayerValidator';
import { bufferSurfaceFirstRoadCenterline } from '../roads/SurfaceFirstRoadFootprints';
import { createShapesFromMultiPolygon } from '../../GeometryBuilder';
import { InspectableFeatureInfo, RailwayFeature } from '../../../types/MapFeature';
import { SceneResourceManager } from '../../GeometryBuilder';

type Point = [number, number];

export interface SurfaceFirstBallastFootprint {
  id: string;
  sourceFeatureIds: readonly string[];
  track: RailwayFeature;
  points: Point[];
  ballastWidth: number;
  bbox: [number, number, number, number]; // [minX, maxX, minZ, maxZ]
  geometry: MultiPolygonCoords;
}

export interface SurfaceFirstBallastComponent {
  componentId: string;
  footprintIds: string[];
  sourceFeatureIds: string[];
  bbox: [number, number, number, number];
  unionGeometry: MultiPolygonCoords;
}

export interface SurfaceFirstBallastBuildResult {
  /** Generated 3D meshes for at-grade consolidated ballast */
  ballastItems: Array<{
    geom: THREE.BufferGeometry;
    info: InspectableFeatureInfo;
    chunkKey: string;
  }>;
  /** Performance and geometry statistics */
  stats: {
    atGradeTrackCount: number;
    footprintCount: number;
    componentCount: number;
    booleanUnionCount: number;
    ballastTriangles: number;
    ballastMeshes: number;
    constructionTimeMs: number;
  };
}

/**
 * Computes axis-aligned bounding box [minX, maxX, minZ, maxZ] for a MultiPolygonCoords geometry.
 */
export function computeMultiPolygonBBox(mp: MultiPolygonCoords): [number, number, number, number] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const poly of mp) {
    for (const ring of poly) {
      for (const p of ring) {
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minZ) minZ = p[1];
        if (p[1] > maxZ) maxZ = p[1];
      }
    }
  }
  return [minX, maxX, minZ, maxZ];
}

/**
 * Computes the 2D surface area of a MultiPolygon in square meters.
 */
export function computeMultiPolygonArea(mp: MultiPolygonCoords): number {
  let totalArea = 0;
  for (const poly of mp) {
    for (let r = 0; r < poly.length; r++) {
      const ring = poly[r];
      let ringArea = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        ringArea += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      }
      ringArea = 0.5 * Math.abs(ringArea);
      if (r === 0) totalArea += ringArea;
      else totalArea -= ringArea;
    }
  }
  return Math.max(0, totalArea);
}

/**
 * Builds individual 2D buffered footprints for at-grade railway tracks.
 * Elevates only at-grade tracks (`layer === 0 && !isBridge && !isTunnel`).
 */
export function buildAtGradeBallastFootprints(
  railways: readonly RailwayFeature[],
  endpointCapPolicy?: ReadonlyMap<string, { capStart: boolean; capEnd: boolean }>
): SurfaceFirstBallastFootprint[] {
  const footprints: SurfaceFirstBallastFootprint[] = [];

  for (const track of railways) {
    if (track.layer !== 0 || track.isBridge || track.isTunnel) {
      continue;
    }
    const cleanPts: Point[] = [];
    for (const p of track.points) {
      if (
        !cleanPts.length ||
        Math.hypot(p[0] - cleanPts[cleanPts.length - 1][0], p[1] - cleanPts[cleanPts.length - 1][1]) >
          0.02
      ) {
        cleanPts.push([p[0], p[1]]);
      }
    }
    if (cleanPts.length < 2) continue;

    const isTram = track.railwayType === 'tram';
    const ballastWidth = track.width || (isTram ? 3.0 : 3.5);
    const capPolicy = endpointCapPolicy?.get(track.id);
    const geom = bufferSurfaceFirstRoadCenterline(cleanPts, ballastWidth, {
      capStart: capPolicy ? capPolicy.capStart : true,
      capEnd: capPolicy ? capPolicy.capEnd : true,
    });
    if (!geom || geom.length === 0) continue;

    const sids =
      track.sourceFeatureIds && track.sourceFeatureIds.length > 0
        ? [...track.sourceFeatureIds]
        : [track.sourceFeatureId || track.id];

    footprints.push({
      id: track.id,
      sourceFeatureIds: sids,
      track,
      points: cleanPts,
      ballastWidth,
      bbox: computeMultiPolygonBBox(geom),
      geometry: geom,
    });
  }

  // Deterministic sort by ID
  footprints.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return footprints;
}

/**
 * Groups intersecting ballast footprints into disjoint connected components via spatial
 * bounding-box pruning followed by exact 2D planar intersection checks.
 */
export function groupBallastConnectedComponents(
  footprints: readonly SurfaceFirstBallastFootprint[]
): SurfaceFirstBallastComponent[] {
  const n = footprints.length;
  if (n === 0) return [];

  // Disjoint-set union (DSU)
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    if (parent[i] === i) return i;
    return (parent[i] = find(parent[i]));
  };
  const union = (i: number, j: number) => {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) {
      if (rootI < rootJ) parent[rootJ] = rootI;
      else parent[rootI] = rootJ;
    }
  };

  // Pairwise intersection test with AABB pruning
  for (let i = 0; i < n; i++) {
    const fA = footprints[i];
    for (let j = i + 1; j < n; j++) {
      const fB = footprints[j];
      if (
        fA.bbox[0] > fB.bbox[1] ||
        fA.bbox[1] < fB.bbox[0] ||
        fA.bbox[2] > fB.bbox[3] ||
        fA.bbox[3] < fB.bbox[2]
      ) {
        continue;
      }
      try {
        const inter = polygonClipping.intersection(
          fA.geometry as unknown as polygonClipping.Geom,
          fB.geometry as unknown as polygonClipping.Geom
        ) as unknown as MultiPolygonCoords;
        if (inter && inter.length > 0) {
          const interArea = computeMultiPolygonArea(inter);
          if (interArea > 1e-4) {
            union(i, j);
          }
        }
      } catch {
        // Fallback: if intersection check fails, keep conservative
      }
    }
  }

  // Collate groups by root index
  const groups = new Map<number, SurfaceFirstBallastFootprint[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let list = groups.get(root);
    if (!list) {
      list = [];
      groups.set(root, list);
    }
    list.push(footprints[i]);
  }

  const components: SurfaceFirstBallastComponent[] = [];
  for (const [rootIdx, members] of groups.entries()) {
    // Sort members deterministically by ID
    members.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    let unionGeometry: MultiPolygonCoords;
    if (members.length === 1) {
      unionGeometry = members[0].geometry;
    } else {
      try {
        const un = polygonClipping.union(
          members[0].geometry as unknown as polygonClipping.Geom,
          ...(members.slice(1).map((m) => m.geometry) as unknown as polygonClipping.Geom[])
        ) as unknown as MultiPolygonCoords;
        unionGeometry = filterDegenerateBooleanArtifacts(un);
      } catch {
        // Safe fallback if union fails: combine disjoint polygons
        unionGeometry = members.flatMap((m) => m.geometry);
      }
    }

    const sidsSet = new Set<string>();
    for (const m of members) {
      for (const sid of m.sourceFeatureIds) sidsSet.add(sid);
    }

    components.push({
      componentId: `ballast_comp:${members[0].id}`,
      footprintIds: members.map((m) => m.id),
      sourceFeatureIds: Array.from(sidsSet).sort(),
      bbox: computeMultiPolygonBBox(unionGeometry),
      unionGeometry,
    });
  }

  // Sort components deterministically by component ID
  components.sort((a, b) => (a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0));
  return components;
}

/**
 * Synthesizes 3D triangular BufferGeometry meshes for at-grade consolidated ballast surfaces.
 */
export function buildSurfaceFirstRailwayBallastGeometries(
  railways: readonly RailwayFeature[],
  ballastElevationY: number,
  resourceManager: SceneResourceManager,
  getChunkKey: (x: number, z: number) => string,
  endpointCapPolicy?: ReadonlyMap<string, { capStart: boolean; capEnd: boolean }>
): SurfaceFirstBallastBuildResult {
  const t0 = performance.now();
  const footprints = buildAtGradeBallastFootprints(railways, endpointCapPolicy);
  const components = groupBallastConnectedComponents(footprints);

  const ballastItems: Array<{
    geom: THREE.BufferGeometry;
    info: InspectableFeatureInfo;
    chunkKey: string;
  }> = [];

  let totalTriangles = 0;

  for (const comp of components) {
    const shapes = createShapesFromMultiPolygon(comp.unionGeometry);
    if (!shapes || shapes.length === 0) continue;

    for (const shape of shapes) {
      const geo = new THREE.ShapeGeometry(shape);
      // Shape is in (x, -z) space; rotate to horizontal XZ plane
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, ballastElevationY, 0);

      // Clean normal attribute to uniform upward normal [0, 1, 0]
      const count = geo.attributes.position.count;
      const normals = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        normals[i * 3] = 0;
        normals[i * 3 + 1] = 1;
        normals[i * 3 + 2] = 0;
      }
      geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

      // Ensure UV attribute is present for compatibility with BufferGeometryUtils.mergeGeometries
      const uvs = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        uvs[i * 2] = geo.attributes.position.getX(i) * 0.2;
        uvs[i * 2 + 1] = geo.attributes.position.getZ(i) * 0.2;
      }
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

      // Ensure aSwitchAttr attribute is present for mergeGeometries compatibility with ribbon ballast
      const switchAttrs = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        switchAttrs[i * 2] = 999.0;
        switchAttrs[i * 2 + 1] = 1.0;
      }
      geo.setAttribute('aSwitchAttr', new THREE.BufferAttribute(switchAttrs, 2));

      const triCount = geo.index ? geo.index.count / 3 : count / 3;
      if (triCount <= 0) {
        geo.dispose();
        continue;
      }

      totalTriangles += triCount;
      resourceManager.registerGeometry(geo);

      const midX = (comp.bbox[0] + comp.bbox[1]) * 0.5;
      const midZ = (comp.bbox[2] + comp.bbox[3]) * 0.5;
      const chunkKey = getChunkKey(midX, midZ);

      const info: InspectableFeatureInfo = {
        id: comp.componentId,
        sourceFeatureId: comp.sourceFeatureIds[0] || comp.componentId,
        sourceFeatureIds: comp.sourceFeatureIds,
        name: `Ballast Bed (${comp.sourceFeatureIds.length} tracks)`,
        category: 'Railway & Aerial',
        cartoLabel: `Ballast Bed (${comp.sourceFeatureIds.length} tracks)`,
        primaryTag: 'railway=ballast',
        subtype: 'ballast',
        elevation: ballastElevationY,
        layer: 0,
        isBridge: false,
        isTunnel: false,
        osmTags: {
          railway: 'ballast',
          trackCount: comp.footprintIds.length,
        },
      };

      ballastItems.push({
        geom: geo,
        info,
        chunkKey,
      });
    }
  }

  const constructionTimeMs = Number((performance.now() - t0).toFixed(2));

  return {
    ballastItems,
    stats: {
      atGradeTrackCount: footprints.length,
      footprintCount: footprints.length,
      componentCount: components.length,
      booleanUnionCount: components.filter((c) => c.footprintIds.length > 1).length,
      ballastTriangles: totalTriangles,
      ballastMeshes: ballastItems.length,
      constructionTimeMs,
    },
  };
}
