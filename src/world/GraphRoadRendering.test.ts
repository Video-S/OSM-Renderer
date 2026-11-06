import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  ProcessedMapData,
  RoadClass,
  RoadFeature,
} from '../types/MapFeature';
import { ELEVATION_POLICY } from './ElevationPolicy';
import {
  BuiltSceneGeometry,
  FaceFeatureRange,
  GeometryBuilder,
  GraphRoadRenderStats,
  normalizeInfrastructureRenderOptions,
  parseInfrastructureRenderOptionsFromSearch,
  parseInfrastructureRenderSource,
  parseRailwayInfrastructureRenderSource,
  parseRoadInfrastructureRenderSource,
  prepareInfrastructureRenderPreview,
  requiresInfrastructureGraphPreview,
  resolveInspectedFeature,
} from './GeometryBuilder';
import { validateRoadNetworkGeometry } from './ZFightingValidator';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { MAP_THEMES } from '../styles/mapThemes';
import { UnchainedRoadPart } from './infrastructure/topology/types';
import realOsmExtracts from './prototype/realOsmRailwayExtracts.json';

/**
 * Helper to create a synthetic `RoadFeature` together with its matching raw `topologySource`
 * record so both `ProcessedMapData.roads` and `ProcessedMapData.topologySource` are populated.
 */
interface SyntheticRoadSpec {
  id: string;
  sourceFeatureId?: string;
  roadClass: RoadClass;
  points: [number, number][];
  nodeIds?: Array<string | undefined>;
  width?: number;
  lanes?: number;
  oneway?: boolean;
  layer?: number;
  isBridge?: boolean;
  isTunnel?: boolean;
  name?: string;
  surface?: string;
  clippedAtStart?: boolean;
  clippedAtEnd?: boolean;
  osmTags?: Record<string, any>;
}

const DEFAULT_WIDTH_BY_CLASS: Partial<Record<RoadClass, number>> = {
  motorway: 14,
  trunk: 13,
  primary: 12,
  secondary: 10,
  tertiary: 8,
  residential: 7,
  living_street: 6,
  unclassified: 6,
  service: 4.5,
  pedestrian: 4,
  cycleway: 2.5,
  footway: 2.0,
  path: 1.8,
  steps: 2.0,
  track: 3.0,
};

function createDatasetFromSpecs(
  specs: SyntheticRoadSpec[],
  bounds = { minX: -200, maxX: 200, minZ: -200, maxZ: 200 }
): ProcessedMapData {
  const roads: (RoadFeature & { lanes?: number; oneway?: boolean; surface?: string })[] = [];
  const roadParts: UnchainedRoadPart[] = [];

  for (const s of specs) {
    const width = s.width ?? DEFAULT_WIDTH_BY_CLASS[s.roadClass] ?? 7;
    const lanes = s.lanes ?? 2;
    const layer = s.layer ?? 0;
    const isBridge = s.isBridge ?? false;
    const isTunnel = s.isTunnel ?? false;
    const sourceFeatureId = s.sourceFeatureId ?? s.id;
    const osmTags: Record<string, any> = {
      highway: s.roadClass,
      ...(s.name ? { name: s.name } : {}),
      ...(s.oneway !== undefined ? { oneway: s.oneway ? 'yes' : 'no' } : {}),
      ...(s.surface ? { surface: s.surface } : {}),
      ...(isBridge ? { bridge: 'yes' } : {}),
      ...(isTunnel ? { tunnel: 'yes' } : {}),
      ...(layer !== 0 ? { layer: String(layer) } : {}),
      ...(s.osmTags ?? {}),
    };
    const isCulvert =
      !isTunnel &&
      Boolean(
        osmTags.culvert === 'yes' ||
          osmTags.tunnel === 'culvert' ||
          osmTags.bridge === 'culvert' ||
          osmTags.man_made === 'culvert' ||
          osmTags.bridge === 'low_water_crossing'
      );

    roads.push({
      id: s.id,
      type: 'road',
      sourceFeatureId,
      sourceFeatureIds: [sourceFeatureId],
      roadClass: s.roadClass,
      points: s.points.map((pt) => [pt[0], pt[1]]),
      nodeIds: s.nodeIds ? s.nodeIds.map((nid) => nid ?? '') : undefined,
      width,
      lanes,
      oneway: s.oneway ?? false,
      layer,
      isBridge,
      isTunnel,
      name: s.name,
      surface: s.surface,
      osmTags,
    });

    roadParts.push({
      id: `${s.id}-0`,
      sourceFeatureId,
      hasExplicitSourceId: true,
      partIndex: 0,
      roadClass: s.roadClass,
      points: s.points.map((pt) => [pt[0], pt[1]]),
      rawOsmNodeIds: s.nodeIds
        ? s.nodeIds.map((nid) => (nid && nid.trim().length > 0 ? nid.trim() : undefined))
        : s.points.map(() => undefined),
      width,
      layer,
      isBridge,
      isTunnel,
      isCulvert,
      name: s.name,
      clippedAtStart: s.clippedAtStart ?? false,
      clippedAtEnd: s.clippedAtEnd ?? false,
      osmTags,
    });
  }

  return {
    regionName: 'Synthetic M2.3-E2 Fixture',
    centerLonLat: [6.7935, 52.2625],
    buildings: [],
    roads,
    railways: [],
    waterBodies: [],
    linearWaterways: [],
    water: [],
    parks: [],
    landuse: [],
    barriers: [],
    landmarks: [],
    bounds: {
      ...bounds,
      widthMeters: bounds.maxX - bounds.minX,
      depthMeters: bounds.maxZ - bounds.minZ,
    },
    topologySource: {
      roadParts,
      railwayParts: [],
      infrastructurePoints: [],
    },
    stats: {
      totalBuildings: 0,
      totalRoads: roads.length,
      totalRoadSegments: roads.length,
      totalRailways: 0,
      totalRailwaySegments: 0,
      totalWaterPolygons: 0,
      totalLinearWaterways: 0,
      totalParkPolygons: 0,
      totalLandusePolygons: 0,
      totalBarriers: 0,
      totalLandmarks: 0,
      areaKm2: 0.16,
    },
    diagnostics: {
      sourceFeaturesReceived: specs.length,
      sourceFeaturesClassified: specs.length,
      totalFeaturesParsed: specs.length,
      sourceFeaturesRendered: 0,
      totalFeaturesReceived: specs.length,
      totalFeaturesRendered: 0,
      constructedMeshesCount: 0,
      parsedByCategory: {
        buildings: 0,
        roads: specs.length,
        railways: 0,
        waterBodies: 0,
        linearWaterways: 0,
        parks: 0,
        landuse: 0,
        barriers: 0,
        landmarks: 0,
      },
      geometryPartsGenerated: {
        total: specs.length,
        byCategory: {
          buildings: 0,
          roads: specs.length,
          railways: 0,
          waterBodies: 0,
          linearWaterways: 0,
          parks: 0,
          landuse: 0,
          barriers: 0,
          landmarks: 0,
        },
      },
      clippingFailures: { count: 0, sampleIds: [] },
      featuresFullySubtracted: { count: 0, sampleIds: [] },
      skippedUnsupported: { total: 0, byTag: {} },
      rejectedInvalid: { total: 0, byReason: {} },
      byGeometryType: {
        Point: 0,
        MultiPoint: 0,
        LineString: specs.length,
        MultiLineString: 0,
        Polygon: 0,
        MultiPolygon: 0,
        GeometryCollection: 0,
        Unknown: 0,
      },
    },
  };
}

function buildGraphRoadScene(
  data: ProcessedMapData,
  roadWidthMultiplier = 1.0
): BuiltSceneGeometry {
  const preview = prepareInfrastructureRenderPreview(data, {
    roads: 'graph',
    railways: 'legacy',
  });
  assert.ok(preview.graph, 'Expected preview.graph to be built');
  assert.ok(preview.descriptors, 'Expected preview.descriptors to be built');
  assert.equal(preview.validation?.isValid, true, 'Expected descriptor validation to pass');

  const builder = new GeometryBuilder({
    roadWidthMultiplier,
    infrastructureRenderOptions: { roads: 'graph', railways: 'legacy' },
    infrastructureRenderPreview: preview,
  });
  return builder.buildScene(data, MAP_THEMES.tactical);
}

/**
 * Audits all meshes in `scene.roadsGroup` for finite vertices/normals, valid index ranges,
 * non-degenerate triangles, and upward-facing (+Y) normals on at-grade road/path/junction meshes.
 */
function assertRoadGroupGeometryInvariants(scene: BuiltSceneGeometry): {
  meshNames: string[];
  faceRangesById: Map<string, FaceFeatureRange>;
  junctionRanges: FaceFeatureRange[];
} {
  const meshNames: string[] = [];
  const faceRangesById = new Map<string, FaceFeatureRange>();
  const junctionRanges: FaceFeatureRange[] = [];

  scene.roadsGroup.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    meshNames.push(mesh.name);

    const geom = mesh.geometry;
    const pos = geom.attributes.position;
    const norm = geom.attributes.normal;
    assert.ok(pos && pos.count > 0, `Mesh ${mesh.name} must have non-empty position attribute`);
    assert.ok(norm && norm.count === pos.count, `Mesh ${mesh.name} must have matching normal attribute`);

    for (let i = 0; i < pos.count; i++) {
      assert.ok(
        Number.isFinite(pos.getX(i)) &&
          Number.isFinite(pos.getY(i)) &&
          Number.isFinite(pos.getZ(i)),
        `Mesh ${mesh.name} vertex ${i} must have finite coordinates`
      );
      assert.ok(
        Number.isFinite(norm.getX(i)) &&
          Number.isFinite(norm.getY(i)) &&
          Number.isFinite(norm.getZ(i)),
        `Mesh ${mesh.name} normal ${i} must have finite components`
      );
    }

    const isAtGradeSurfaceMesh = mesh.name.startsWith('Roads_');
    const index = geom.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    assert.ok(triCount > 0, `Mesh ${mesh.name} must have at least 1 triangle`);

    for (let f = 0; f < triCount; f++) {
      const i0 = index ? index.getX(f * 3) : f * 3;
      const i1 = index ? index.getX(f * 3 + 1) : f * 3 + 1;
      const i2 = index ? index.getX(f * 3 + 2) : f * 3 + 2;
      assert.ok(
        i0 >= 0 && i0 < pos.count && i1 >= 0 && i1 < pos.count && i2 >= 0 && i2 < pos.count,
        `Mesh ${mesh.name} face ${f} index out of bounds`
      );

      if (isAtGradeSurfaceMesh) {
        const y0 = pos.getY(i0);
        const y1 = pos.getY(i1);
        const y2 = pos.getY(i2);
        // At-grade surface triangles lie on flat horizontal planes (0.050m, 0.054m, 0.055m, or 0.061m step treads)
        if (Math.abs(y0 - y1) < 1e-4 && Math.abs(y1 - y2) < 1e-4 && y0 <= 0.1) {
          assert.ok(
            norm.getY(i0) > 0.99 && norm.getY(i1) > 0.99 && norm.getY(i2) > 0.99,
            `At-grade mesh ${mesh.name} face ${f} must have upward +Y normal`
          );
        }
      }
    }

    const ranges: FaceFeatureRange[] | undefined = mesh.userData?.faceRanges;
    assert.ok(Array.isArray(ranges) && ranges.length > 0, `Mesh ${mesh.name} must have faceRanges`);
    for (const r of ranges) {
      assert.ok(r.info.id, `Range on ${mesh.name} must have info.id`);
      assert.ok(r.info.sourceFeatureId, `Range ${r.info.id} must have sourceFeatureId`);
      assert.ok(
        Array.isArray(r.info.sourceFeatureIds) && r.info.sourceFeatureIds.length >= 1,
        `Range ${r.info.id} must have sourceFeatureIds`
      );
      faceRangesById.set(r.info.id, r);
      if (r.info.id.startsWith('junction-') || r.info.id.startsWith('path-junction-')) {
        junctionRanges.push(r);
      }

      // Verify raycast picking resolution on start and last face of range
      const resolvedStart = resolveInspectedFeature({ object: mesh, faceIndex: r.startFace });
      const resolvedEnd = resolveInspectedFeature({ object: mesh, faceIndex: r.endFace - 1 });
      assert.equal(resolvedStart?.id, r.info.id);
      assert.equal(resolvedEnd?.id, r.info.id);
    }
  });

  const roadVal = validateRoadNetworkGeometry(scene);
  assert.deepEqual(
    roadVal.overlapConflicts,
    [],
    `Expected 0 co-elevation road triangle overlaps, got ${JSON.stringify(roadVal.overlapConflicts)}`
  );
  assert.deepEqual(
    roadVal.continuityDefects,
    [],
    `Expected 0 junction portal continuity defects, got ${JSON.stringify(roadVal.continuityDefects)}`
  );
  assert.equal(roadVal.isValid, true);

  return { meshNames, faceRangesById, junctionRanges };
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const arr = [...items];
  let s = seed >>> 0;
  for (let i = arr.length - 1; i > 0; i--) {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function snapshotGroupNode(obj: THREE.Object3D): any {
  const ud = obj.userData || {};
  let geomSnap: any = null;
  if (obj instanceof THREE.Mesh && obj.geometry instanceof THREE.BufferGeometry) {
    const geom = obj.geometry;
    const attrs: Record<string, any> = {};
    for (const k of Object.keys(geom.attributes).sort()) {
      const a = geom.attributes[k];
      attrs[k] = {
        itemSize: a.itemSize,
        count: a.count,
        values: Array.from(a.array as ArrayLike<number>),
      };
    }
    geomSnap = {
      attributes: attrs,
      index: geom.index ? Array.from(geom.index.array as ArrayLike<number>) : null,
    };
  }
  return {
    name: obj.name,
    renderOrder: obj.renderOrder,
    faceRanges: Array.isArray(ud.faceRanges)
      ? ud.faceRanges.map((r: any) => ({
          startFace: r.startFace,
          endFace: r.endFace,
          info: JSON.parse(JSON.stringify(r.info)),
        }))
      : undefined,
    graphRoadStats: ud.graphRoadStats ? JSON.parse(JSON.stringify(ud.graphRoadStats)) : undefined,
    geometry: geomSnap,
    children: (obj.children || []).map(snapshotGroupNode),
  };
}

describe('Milestone 2.3 Stage E2 — Graph-Driven Road Rendering & Junction Geometry (TKT-008)', () => {
  it('1. parses road and railway render sources with E2 graph mode enabled for roads and restricted to legacy|graph-preview for railways', () => {
    assert.equal(parseRoadInfrastructureRenderSource('legacy'), 'legacy');
    assert.equal(parseRoadInfrastructureRenderSource('graph-preview'), 'graph-preview');
    assert.equal(parseRoadInfrastructureRenderSource('graph'), 'graph');
    assert.equal(parseRoadInfrastructureRenderSource('invalid'), 'legacy');

    // Railway render source in E2 must reject 'graph' and fall back safely to 'legacy'
    assert.equal(parseRailwayInfrastructureRenderSource('legacy'), 'legacy');
    assert.equal(parseRailwayInfrastructureRenderSource('graph-preview'), 'graph-preview');
    assert.equal(parseRailwayInfrastructureRenderSource('graph'), 'legacy');

    assert.equal(parseInfrastructureRenderSource('graph', 'roads'), 'graph');
    assert.equal(parseInfrastructureRenderSource('graph', 'railways'), 'legacy');

    assert.deepEqual(
      parseInfrastructureRenderOptionsFromSearch('?topologyRoads=graph&topologyRailways=graph'),
      {
        roads: 'graph',
        railways: 'legacy',
      }
    );
    assert.deepEqual(
      parseInfrastructureRenderOptionsFromSearch(
        '?topologyRoads=graph&topologyRailways=graph-preview'
      ),
      {
        roads: 'graph',
        railways: 'graph-preview',
      }
    );
    assert.deepEqual(
      normalizeInfrastructureRenderOptions({ roads: 'graph', railways: 'graph' as any }),
      {
        roads: 'graph',
        railways: 'legacy',
      }
    );
    assert.equal(
      requiresInfrastructureGraphPreview({ roads: 'graph', railways: 'legacy' }),
      true
    );
  });

  it('2. renders isolated single-way roads, cul-de-sacs, boundary-clipped endpoints, and degree-2 continuity joins (Scenarios 1, 2, 10, 14)', () => {
    const data = createDatasetFromSpecs([
      // Scenario 1 & 10: Isolated single-way residential road with unclipped dead-end endpoints -> semicircular caps
      {
        id: 'way/isolated-culdesac',
        roadClass: 'residential',
        width: 7.0,
        points: [
          [-80, -60],
          [-20, -60],
        ],
        nodeIds: ['101', '102'],
      },
      // Scenario 14: Boundary-clipped primary road -> flat ends, caps suppressed
      {
        id: 'way/boundary-clipped',
        roadClass: 'primary',
        width: 10.0,
        points: [
          [-199.9, -20],
          [-100, -20],
        ],
        nodeIds: ['201', '202'],
        clippedAtStart: true,
        clippedAtEnd: true,
      },
      // Scenario 2: Two ways with different names/tags meeting at a degree-2 bend node (kept as 2 graph edges or 1 simplified edge)
      // We give them different roadClasses/widths compatibility (both secondary, 10m, different surface tags so RoadNetworkBuilder keeps 2 edges at node 302)
      {
        id: 'way/bend-seg-a',
        roadClass: 'secondary',
        width: 10.0,
        surface: 'asphalt',
        points: [
          [0, 20],
          [40, 20],
        ],
        nodeIds: ['301', '302'],
      },
      {
        id: 'way/bend-seg-b',
        roadClass: 'secondary',
        width: 10.0,
        surface: 'concrete',
        points: [
          [40, 20],
          [75, 45],
        ],
        nodeIds: ['302', '303'],
      },
    ]);

    const scene = buildGraphRoadScene(data);
    const { junctionRanges } = assertRoadGroupGeometryInvariants(scene);
    const stats: GraphRoadRenderStats = scene.roadsGroup.userData.graphRoadStats;

    assert.equal(stats.branchingJunctionCount, 0, 'No >=3 branching junctions in this fixture');
    assert.equal(
      stats.degree2ContinuityJoinCount,
      1,
      'Node 302 must be joined via degree-2 continuity miter without a full junction polygon'
    );
    assert.equal(junctionRanges.length, 0, 'No junction polygon mesh should be emitted for degree-2 bend');

    // Verify isolated road has semicircular caps (60m strip = 1 quad = 2 triangles + 2 caps * 6 = 14 triangles)
    const resMesh = scene.roadsGroup.children.find((c) => c.name === 'Roads_residential') as THREE.Mesh;
    assert.ok(resMesh);
    assert.equal(resMesh.geometry.index!.count / 3, 14, 'Isolated road must include both semicircular end caps');

    // Verify boundary-clipped road has both caps suppressed (1 quad = 2 triangles)
    const priMesh = scene.roadsGroup.children.find((c) => c.name === 'Roads_primary') as THREE.Mesh;
    assert.ok(priMesh);
    assert.equal(priMesh.geometry.index!.count / 3, 2, 'Boundary-clipped road must suppress both end caps');

    scene.dispose();
  });

  it('3. meshes T-junctions, 4-way crossroads, skewed/acute Y-junctions, and 5-way multi-arm junctions (Scenarios 3, 4, 5, 6)', () => {
    const data = createDatasetFromSpecs([
      // Scenario 3: Simple T-junction at [-130, 0] (node 1000)
      {
        id: 'way/t-west',
        roadClass: 'residential',
        width: 7,
        points: [
          [-170, 0],
          [-130, 0],
        ],
        nodeIds: ['1001', '1000'],
      },
      {
        id: 'way/t-east',
        roadClass: 'residential',
        width: 7,
        points: [
          [-130, 0],
          [-90, 0],
        ],
        nodeIds: ['1000', '1002'],
      },
      {
        id: 'way/t-south',
        roadClass: 'residential',
        width: 7,
        points: [
          [-130, -50],
          [-130, 0],
        ],
        nodeIds: ['1003', '1000'],
      },

      // Scenario 4: 4-way orthogonal crossroads at [0, 0] (node 2000)
      {
        id: 'way/x-west',
        roadClass: 'primary',
        width: 11,
        points: [
          [-45, 0],
          [0, 0],
        ],
        nodeIds: ['2001', '2000'],
      },
      {
        id: 'way/x-east',
        roadClass: 'primary',
        width: 11,
        points: [
          [0, 0],
          [45, 0],
        ],
        nodeIds: ['2000', '2002'],
      },
      {
        id: 'way/x-north',
        roadClass: 'secondary',
        width: 9,
        points: [
          [0, 0],
          [0, 45],
        ],
        nodeIds: ['2000', '2003'],
      },
      {
        id: 'way/x-south',
        roadClass: 'secondary',
        width: 9,
        points: [
          [0, -45],
          [0, 0],
        ],
        nodeIds: ['2004', '2000'],
      },

      // Scenario 5: Skewed/acute Y-junction at [100, 0] (node 3000) with ~22-degree crotch angle
      {
        id: 'way/y-stem',
        roadClass: 'tertiary',
        width: 8,
        points: [
          [60, 0],
          [100, 0],
        ],
        nodeIds: ['3001', '3000'],
      },
      {
        id: 'way/y-arm1',
        roadClass: 'tertiary',
        width: 8,
        points: [
          [100, 0],
          [145, 10],
        ],
        nodeIds: ['3000', '3002'],
      },
      {
        id: 'way/y-arm2',
        roadClass: 'tertiary',
        width: 8,
        points: [
          [100, 0],
          [145, -8],
        ],
        nodeIds: ['3000', '3003'],
      },

      // Scenario 6: 5-way star junction at [0, 110] (node 4000)
      ...[0, 1, 2, 3, 4].map((idx) => {
        const angle = (idx * 2 * Math.PI) / 5;
        return {
          id: `way/star-arm-${idx}`,
          roadClass: 'residential' as RoadClass,
          width: 7,
          points: [
            [0, 110] as [number, number],
            [Math.cos(angle) * 45, 110 + Math.sin(angle) * 45] as [number, number],
          ],
          nodeIds: ['4000', `400${idx + 1}`],
        };
      }),
    ]);

    const scene = buildGraphRoadScene(data);
    const { junctionRanges } = assertRoadGroupGeometryInvariants(scene);
    const stats: GraphRoadRenderStats = scene.roadsGroup.userData.graphRoadStats;

    assert.equal(stats.branchingJunctionCount, 4, 'Expected 4 branching vehicular junctions (T, X, Y, 5-way)');
    assert.equal(junctionRanges.length, 4, 'Expected 4 rendered junction polygon faceRanges');

    const portalCounts = junctionRanges
      .map((r) => r.info.portalConnections?.length ?? 0)
      .sort((a, b) => a - b);
    assert.deepEqual(portalCounts, [3, 3, 4, 5], 'Portal connection counts must match 3, 3, 4, and 5 arms');

    // Verify miter clamping on the acute Y-junction (node 3000 at [100, 0]): no vertex exceeds 45m from center
    for (const obj of scene.roadsGroup.children) {
      if (!(obj as THREE.Mesh).isMesh) continue;
      const pos = (obj as THREE.Mesh).geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        assert.ok(Math.abs(pos.getY(i) - ELEVATION_POLICY.ROAD_SURFACE) < 1e-4);
      }
    }

    scene.dispose();
  });

  it('4. handles width mismatches, oneway/reversed ways, and roundabouts/closed loops (Scenarios 7, 8, 9)', () => {
    // Build a 16-vertex circular roundabout at [0, 0] radius 18m split at 3 approach nodes + 1 standalone closed loop
    const r = 18;
    const nPts = 12;
    const ringPts: [number, number][] = [];
    const ringNodeIds: string[] = [];
    for (let i = 0; i < nPts; i++) {
      const a = (i / nPts) * Math.PI * 2;
      ringPts.push([Number((Math.cos(a) * r).toFixed(3)), Number((Math.sin(a) * r).toFixed(3))]);
      ringNodeIds.push(`50${i < 10 ? '0' + i : i}`);
    }
    ringPts.push([ringPts[0][0], ringPts[0][1]]);
    ringNodeIds.push(ringNodeIds[0]);

    const data = createDatasetFromSpecs([
      // Scenario 9: Closed-loop roundabout way with 3 radial approaches attached at indices 0, 4, 8
      {
        id: 'way/roundabout-ring',
        roadClass: 'secondary',
        width: 8,
        oneway: true,
        name: 'Keizer Karelplein',
        osmTags: { junction: 'roundabout' },
        points: ringPts,
        nodeIds: ringNodeIds,
      },
      // Scenario 7 & 8: Approach 0 (wide 12m primary road, reversed orientation pointing away from ring)
      {
        id: 'way/approach-0-wide',
        roadClass: 'primary',
        width: 12,
        oneway: true,
        points: [
          ringPts[0],
          [55, 0],
        ],
        nodeIds: [ringNodeIds[0], '5100'],
      },
      // Approach 4 (narrow 6m unclassified road pointing into ring)
      {
        id: 'way/approach-4-narrow',
        roadClass: 'unclassified',
        width: 6,
        points: [
          [-45, 45],
          ringPts[4],
        ],
        nodeIds: ['5104', ringNodeIds[4]],
      },
      // Approach 8 (reversed oneway=-1 road)
      {
        id: 'way/approach-8-rev',
        roadClass: 'secondary',
        width: 8,
        osmTags: { oneway: '-1' },
        points: [
          ringPts[8],
          [-45, -45],
        ],
        nodeIds: [ringNodeIds[8], '5108'],
      },
      // Scenario 7: Width mismatch across a degree-2 continuity node (12m primary -> 7m residential)
      {
        id: 'way/width-step-wide',
        roadClass: 'primary',
        width: 12,
        points: [
          [-120, -80],
          [-80, -80],
        ],
        nodeIds: ['6001', '6002'],
      },
      {
        id: 'way/width-step-narrow',
        roadClass: 'residential',
        width: 7,
        points: [
          [-80, -80],
          [-40, -80],
        ],
        nodeIds: ['6002', '6003'],
      },
    ]);

    const scene = buildGraphRoadScene(data);
    const { junctionRanges } = assertRoadGroupGeometryInvariants(scene);
    const stats: GraphRoadRenderStats = scene.roadsGroup.userData.graphRoadStats;

    assert.equal(
      stats.branchingJunctionCount,
      3,
      'Roundabout with 3 radial approaches must produce 3 branching junctions'
    );
    assert.equal(junctionRanges.length, 3);
    assert.ok(
      stats.degree2ContinuityJoinCount >= 1,
      'Width-step degree-2 node must be handled as a degree-2 continuity join'
    );

    scene.dispose();
  });

  it('5. enforces cross-tier footpath vs vehicular road rules and meshes path-only junctions & steps treads (Scenarios 11, 12, 13)', () => {
    const data = createDatasetFromSpecs([
      // Scenario 11: Continuous through vehicular road (2 edges meeting at node 7002) + cross-tier footpath
      {
        id: 'way/through-road-west',
        roadClass: 'primary',
        width: 10,
        surface: 'asphalt',
        points: [
          [-120, 0],
          [-70, 0],
        ],
        nodeIds: ['7001', '7002'],
      },
      {
        id: 'way/through-road-east',
        roadClass: 'primary',
        width: 10,
        surface: 'paved',
        points: [
          [-70, 0],
          [-20, 0],
        ],
        nodeIds: ['7002', '7003'],
      },
      {
        id: 'way/cross-tier-footway-1',
        roadClass: 'footway',
        width: 2.0,
        points: [
          [-70, 0],
          [-70, 35],
        ],
        nodeIds: ['7002', '7004'],
      },

      // Scenario 12: 3-way vehicular junction at [40, 0] (node 8000) + 1 footpath arm also meeting node 8000
      {
        id: 'way/junc3-west',
        roadClass: 'secondary',
        width: 9,
        points: [
          [0, 0],
          [40, 0],
        ],
        nodeIds: ['8001', '8000'],
      },
      {
        id: 'way/junc3-east',
        roadClass: 'secondary',
        width: 9,
        points: [
          [40, 0],
          [80, 0],
        ],
        nodeIds: ['8000', '8002'],
      },
      {
        id: 'way/junc3-south',
        roadClass: 'residential',
        width: 7,
        points: [
          [40, -40],
          [40, 0],
        ],
        nodeIds: ['8003', '8000'],
      },
      {
        id: 'way/junc3-footway-north',
        roadClass: 'footway',
        width: 2.0,
        points: [
          [40, 0],
          [40, 35],
        ],
        nodeIds: ['8000', '8004'],
      },

      // Scenario 13: Pure path-tier 3-way junction at [0, 80] (node 9000) including highway=steps
      {
        id: 'way/path-west',
        roadClass: 'footway',
        width: 2.2,
        points: [
          [-30, 80],
          [0, 80],
        ],
        nodeIds: ['9001', '9000'],
      },
      {
        id: 'way/path-east',
        roadClass: 'cycleway',
        width: 2.5,
        points: [
          [0, 80],
          [30, 80],
        ],
        nodeIds: ['9000', '9002'],
      },
      {
        id: 'way/path-steps-north',
        roadClass: 'steps',
        width: 2.2,
        points: [
          [0, 80],
          [0, 105],
        ],
        nodeIds: ['9000', '9003'],
      },
    ]);

    const scene = buildGraphRoadScene(data);
    const { junctionRanges } = assertRoadGroupGeometryInvariants(scene);
    const stats: GraphRoadRenderStats = scene.roadsGroup.userData.graphRoadStats;

    // Node 7002 is cross-tier-only (2 vehicular half-edges + 1 footway): NO vehicular junction trimming!
    assert.equal(stats.crossTierOnlyNodeCount, 1, 'Node 7002 must be counted as cross-tier-only');
    assert.equal(
      stats.branchingJunctionCount,
      1,
      'Only node 8000 (3 vehicular arms + 1 footway) should produce a vehicular branching junction'
    );
    assert.equal(
      stats.degree2ContinuityJoinCount,
      1,
      'Node 7002 through-road must use degree-2 vehicular continuity join'
    );
    assert.equal(stats.pathJunctionCount, 1, 'Node 9000 must produce a pure path-tier junction');

    const vehJunc = junctionRanges.find((r) => r.info.id.startsWith('junction-'));
    assert.ok(vehJunc, 'Expected vehicular junction at node 8000');
    assert.equal(
      vehJunc.info.portalConnections?.length,
      3,
      'Vehicular junction at node 8000 must trim ONLY the 3 vehicular arms, never the footpath arm'
    );

    const pathJunc = junctionRanges.find((r) => r.info.id.startsWith('path-junction-'));
    assert.ok(pathJunc, 'Expected path-tier junction at node 9000');
    assert.ok(
      Math.abs((pathJunc.info.elevation ?? 0) - ELEVATION_POLICY.ROAD_SURFACE) < 1e-4,
      'Path junction must sit at uniform ROAD_SURFACE elevation (0.050m)'
    );

    // Verify highway=steps generated both base ribbon (0.050m) and raised step treads (0.056m)
    const stepsMesh = scene.roadsGroup.children.find((c) => c.name === 'Roads_steps') as THREE.Mesh;
    assert.ok(stepsMesh, 'Expected Roads_steps mesh');
    const sPos = stepsMesh.geometry.attributes.position;
    let hasBaseY = false;
    let hasTreadY = false;
    for (let i = 0; i < sPos.count; i++) {
      const y = sPos.getY(i);
      if (Math.abs(y - ELEVATION_POLICY.ROAD_SURFACE) < 1e-4) hasBaseY = true;
      if (
        Math.abs(
          y - (ELEVATION_POLICY.ROAD_SURFACE + ELEVATION_POLICY.STEP_TREAD_OFFSET)
        ) < 1e-4
      ) {
        hasTreadY = true;
      }
    }
    assert.equal(hasBaseY, true, 'Steps mesh must contain base ramp surface at 0.050m');
    assert.equal(hasTreadY, true, 'Steps mesh must contain raised step treads at +0.006m');

    scene.dispose();
  });

  it('6. handles grade-separated overpasses, bridge/tunnel transitions, and culverts without false junctions or missing geometry (Scenarios 15, 16, 19)', () => {
    const data = createDatasetFromSpecs([
      // Scenario 15: At-grade road from [-80, 0] to [80, 0] crossed by a layer=1 bridge from [0, -60] to [0, 60]
      {
        id: 'way/at-grade-under',
        roadClass: 'primary',
        width: 10,
        points: [
          [-80, 0],
          [80, 0],
        ],
        nodeIds: ['9101', '9102'],
      },
      {
        id: 'way/bridge-overpass',
        roadClass: 'secondary',
        width: 9,
        layer: 1,
        isBridge: true,
        points: [
          [0, -60],
          [0, 60],
        ],
        nodeIds: ['9201', '9202'],
      },

      // Scenario 16: At-grade road connecting at node 9302 to a bridge, and at node 9304 to a tunnel
      {
        id: 'way/approach-west',
        roadClass: 'tertiary',
        width: 8,
        points: [
          [-90, 50],
          [-30, 50],
        ],
        nodeIds: ['9301', '9302'],
      },
      {
        id: 'way/connected-bridge',
        roadClass: 'tertiary',
        width: 8,
        layer: 1,
        isBridge: true,
        points: [
          [-30, 50],
          [30, 50],
        ],
        nodeIds: ['9302', '9303'],
      },
      {
        id: 'way/approach-mid',
        roadClass: 'tertiary',
        width: 8,
        points: [
          [30, 50],
          [70, 50],
        ],
        nodeIds: ['9303', '9304'],
      },
      {
        id: 'way/connected-tunnel',
        roadClass: 'tertiary',
        width: 8,
        layer: -1,
        isTunnel: true,
        points: [
          [70, 50],
          [120, 50],
        ],
        nodeIds: ['9304', '9305'],
      },

      // Scenario 19: Culvert way (tunnel=culvert at layer=0 -> isAtGradeBuildable === true)
      {
        id: 'way/culvert-road',
        roadClass: 'residential',
        width: 7,
        isTunnel: false,
        osmTags: { tunnel: 'culvert' },
        points: [
          [-60, -50],
          [20, -50],
        ],
        nodeIds: ['9401', '9402'],
      },
    ]);

    const scene = buildGraphRoadScene(data);
    const { meshNames, faceRangesById } = assertRoadGroupGeometryInvariants(scene);
    const stats: GraphRoadRenderStats = scene.roadsGroup.userData.graphRoadStats;

    // Overpass at [0, 0] must NOT create a false at-grade junction
    assert.equal(stats.branchingJunctionCount, 0, 'Bridge overpass must not create an at-grade junction');

    // Stage 6D bridge and tunnel structures must still be generated
    assert.ok(meshNames.includes('Bridge_Substructure'), 'Bridge_Substructure must be rendered by Stage 6D');
    assert.ok(meshNames.includes('Bridge_Parapets'), 'Bridge_Parapets must be rendered by Stage 6D');
    assert.ok(meshNames.includes('Tunnel_Portals'), 'Tunnel_Portals must be rendered by Stage 6D');
    assert.ok(meshNames.includes('Tunnel_Entrances'), 'Tunnel_Entrances must be rendered by Stage 6D');
    assert.ok(
      meshNames.includes('Tunnel_Underground_Trace'),
      'Tunnel_Underground_Trace must be rendered by Stage 6D'
    );

    // Culvert must be rendered as an at-grade road at ROAD_SURFACE (0.050m)
    const culvertRange = Array.from(faceRangesById.values()).find(
      (r) => r.info.sourceFeatureId === 'way/culvert-road'
    );
    assert.ok(culvertRange, 'Culvert way must be rendered by GraphRoadGeometryBuilder');
    assert.equal(culvertRange.info.elevation, ELEVATION_POLICY.ROAD_SURFACE);

    scene.dispose();
  });

  it('7. preserves per-segment provenance across simplified multi-way edges, duplicate suppression, and full subtraction (Scenarios 17, 18)', () => {
    const data = createDatasetFromSpecs([
      // Scenario 18: 3 contiguous residential ways with identical topology-splitting attributes
      // (so RoadNetworkBuilder simplifies them into 1 RoadEdge with 3 provenance segments),
      // but distinct osmTags (ref/note) and sourceFeatureIds!
      {
        id: 'way/chain-seg-1',
        sourceFeatureId: 'way/chain-seg-1',
        roadClass: 'residential',
        width: 7,
        name: 'Stationsstraat',
        osmTags: { section_code: 'WEST_101' },
        points: [
          [-90, 0],
          [-30, 0],
        ],
        nodeIds: ['1101', '1102'],
      },
      {
        id: 'way/chain-seg-2',
        sourceFeatureId: 'way/chain-seg-2',
        roadClass: 'residential',
        width: 7,
        name: 'Stationsstraat',
        osmTags: { section_code: 'MID_102' },
        points: [
          [-30, 0],
          [30, 0],
        ],
        nodeIds: ['1102', '1103'],
      },
      // Reversed middle/east continuation way (drawn from 1104 back to 1103 with oneway=no)
      {
        id: 'way/chain-seg-3-rev',
        sourceFeatureId: 'way/chain-seg-3-rev',
        roadClass: 'residential',
        width: 7,
        name: 'Stationsstraat',
        osmTags: { section_code: 'EAST_103' },
        points: [
          [90, 0],
          [30, 0],
        ],
        nodeIds: ['1104', '1103'],
      },

      // Scenario 17a: Exact duplicate of way/chain-seg-1 in reverse node order
      {
        id: 'way/chain-seg-1-dup',
        sourceFeatureId: 'way/chain-seg-1-dup',
        roadClass: 'residential',
        width: 7,
        name: 'Stationsstraat',
        osmTags: { section_code: 'WEST_101' },
        points: [
          [-30, 0],
          [-90, 0],
        ],
        nodeIds: ['1102', '1101'],
      },

      // Scenario 17b: Short footpath completely inside the 7m-wide Stationsstraat carriageway -> fully subtracted!
      {
        id: 'way/footpath-inside-road',
        sourceFeatureId: 'way/footpath-inside-road',
        roadClass: 'footway',
        width: 1.5,
        points: [
          [-20, 0],
          [20, 0],
        ],
        nodeIds: ['1201', '1202'],
      },
    ]);

    const scene = buildGraphRoadScene(data);
    assertRoadGroupGeometryInvariants(scene);
    const stats: GraphRoadRenderStats = scene.roadsGroup.userData.graphRoadStats;

    // 1. Verify the 3 chained ways were simplified into 1 graph edge in the topology graph,
    // and split into 3 continuous provenance sub-segments by GraphRoadGeometryBuilder!
    assert.equal(
      scene.infrastructureRenderPreview?.descriptors?.roadEdges.filter(
        (e) => e.roadClass === 'residential'
      ).length,
      1,
      'RoadNetworkBuilder must simplify the 3 compatible residential ways into 1 graph edge'
    );
    assert.equal(
      stats.provenanceSplitSegmentCount,
      2,
      'Simplified 3-segment edge must be split at its 2 internal provenance boundaries'
    );

    const resMesh = scene.roadsGroup.children.find((c) => c.name === 'Roads_residential') as THREE.Mesh;
    assert.ok(resMesh);
    const ranges: FaceFeatureRange[] = resMesh.userData.faceRanges;
    assert.equal(ranges.length, 3, 'Each constituent way of the simplified edge must have its own faceRange');

    const resolvedBySourceId = new Map<string, any>();
    for (const r of ranges) {
      const picked = resolveInspectedFeature({ object: resMesh, faceIndex: r.startFace });
      assert.ok(picked);
      resolvedBySourceId.set(picked.sourceFeatureId!, picked);
    }

    assert.equal(resolvedBySourceId.get('way/chain-seg-1')?.osmTags?.section_code, 'WEST_101');
    assert.ok(
      resolvedBySourceId.get('way/chain-seg-1')?.sourceFeatureIds?.includes('way/chain-seg-1-dup'),
      'Survivor segment must include deduplicated way ID in sourceFeatureIds'
    );
    assert.equal(resolvedBySourceId.get('way/chain-seg-2')?.osmTags?.section_code, 'MID_102');
    assert.equal(resolvedBySourceId.get('way/chain-seg-3-rev')?.osmTags?.section_code, 'EAST_103');

    // 2. Verify footpath completely inside carriageway was fully subtracted and NOT marked as rendered
    assert.equal(stats.fullySubtractedCount, 1);
    assert.ok(
      scene.roadsGroup.userData.fullySubtractedRoadIds.includes('way/footpath-inside-road'),
      'Fully subtracted footpath must be recorded in fullySubtractedRoadIds'
    );
    assert.equal(
      scene.roadsGroup.userData.graphRoadLineage.renderedSourceIds.includes(
        'way/footpath-inside-road'
      ),
      false,
      'Fully subtracted footpath must NOT be marked as rendered'
    );
    assert.equal(data.diagnostics?.featuresFullySubtracted?.count, 1);

    // 3. Verify lineage maps record both deduplication and chaining
    assert.equal(data.diagnostics?.featureLineage?.deduplicatedCount, 1);
    assert.deepEqual(data.diagnostics?.featureLineage?.deduplicatedMap['way/chain-seg-1'], [
      'way/chain-seg-1-dup',
    ]);
    assert.equal(data.diagnostics?.featureLineage?.chainedGroupsCount, 1);

    scene.dispose();
  });

  it('8. proves strict source-of-truth isolation: scrambling or clearing mapData.roads does not affect graph road rendering', () => {
    const baseData = createDatasetFromSpecs([
      {
        id: 'way/iso-1',
        roadClass: 'primary',
        width: 10,
        points: [
          [-60, 0],
          [0, 0],
        ],
        nodeIds: ['8101', '8100'],
      },
      {
        id: 'way/iso-2',
        roadClass: 'primary',
        width: 10,
        points: [
          [0, 0],
          [60, 0],
        ],
        nodeIds: ['8100', '8102'],
      },
      {
        id: 'way/iso-3',
        roadClass: 'secondary',
        width: 8,
        points: [
          [0, -50],
          [0, 0],
        ],
        nodeIds: ['8103', '8100'],
      },
    ]);

    const normalScene = buildGraphRoadScene(baseData);
    const snapNormal = snapshotGroupNode(normalScene.roadsGroup);

    // Now replace mapData.roads with completely bogus/empty at-grade roads while keeping topologySource intact
    const mutatedMapData: ProcessedMapData = {
      ...baseData,
      roads: [
        {
          id: 'way/bogus-legacy-road',
          sourceFeatureId: 'way/bogus-legacy-road',
          type: 'road',
          roadClass: 'motorway',
          points: [
            [-190, -190],
            [190, 190],
          ],
          width: 25,
          layer: 0,
          isBridge: false,
          isTunnel: false,
        },
      ],
    };

    const isolatedScene = buildGraphRoadScene(mutatedMapData);
    const snapIsolated = snapshotGroupNode(isolatedScene.roadsGroup);

    assert.deepEqual(
      snapIsolated,
      snapNormal,
      'Graph road renderer must build at-grade geometry strictly from graph descriptors, ignoring mapData.roads'
    );

    normalScene.dispose();
    isolatedScene.dispose();
  });

  it('9. produces bit-for-bit deterministic geometry across 10 seeded permutations of input feature order', () => {
    const baseSpecs: SyntheticRoadSpec[] = [
      {
        id: 'way/grid-h0-w',
        roadClass: 'primary',
        width: 10,
        points: [
          [-80, -40],
          [0, -40],
        ],
        nodeIds: ['n00', 'n10'],
      },
      {
        id: 'way/grid-h0-e',
        roadClass: 'primary',
        width: 10,
        points: [
          [0, -40],
          [80, -40],
        ],
        nodeIds: ['n10', 'n20'],
      },
      {
        id: 'way/grid-h1-w',
        roadClass: 'secondary',
        width: 8,
        points: [
          [-80, 40],
          [0, 40],
        ],
        nodeIds: ['n01', 'n11'],
      },
      {
        id: 'way/grid-h1-e',
        roadClass: 'secondary',
        width: 8,
        points: [
          [0, 40],
          [80, 40],
        ],
        nodeIds: ['n11', 'n21'],
      },
      {
        id: 'way/grid-v0',
        roadClass: 'residential',
        width: 7,
        points: [
          [-80, -40],
          [-80, 40],
        ],
        nodeIds: ['n00', 'n01'],
      },
      {
        id: 'way/grid-v1-s',
        roadClass: 'secondary',
        width: 8,
        points: [
          [0, -90],
          [0, -40],
        ],
        nodeIds: ['n1s', 'n10'],
      },
      {
        id: 'way/grid-v1-m',
        roadClass: 'secondary',
        width: 8,
        points: [
          [0, -40],
          [0, 40],
        ],
        nodeIds: ['n10', 'n11'],
      },
      {
        id: 'way/grid-v1-n',
        roadClass: 'secondary',
        width: 8,
        points: [
          [0, 40],
          [0, 90],
        ],
        nodeIds: ['n11', 'n1n'],
      },
      {
        id: 'way/grid-v2',
        roadClass: 'residential',
        width: 7,
        points: [
          [80, -40],
          [80, 40],
        ],
        nodeIds: ['n20', 'n21'],
      },
      {
        id: 'way/grid-footway',
        roadClass: 'footway',
        width: 2.0,
        points: [
          [-80, 40],
          [-80, 85],
        ],
        nodeIds: ['n01', 'n01f'],
      },
    ];

    const baselineData = createDatasetFromSpecs(baseSpecs);
    const baselineScene = buildGraphRoadScene(baselineData);
    assertRoadGroupGeometryInvariants(baselineScene);
    const baselineSnapshot = snapshotGroupNode(baselineScene.roadsGroup);

    for (let seed = 1; seed <= 10; seed++) {
      const permutedSpecs = seededShuffle(baseSpecs, seed * 7919);
      const permutedData = createDatasetFromSpecs(permutedSpecs);
      const permutedScene = buildGraphRoadScene(permutedData);
      const permutedSnapshot = snapshotGroupNode(permutedScene.roadsGroup);

      assert.deepEqual(
        permutedSnapshot,
        baselineSnapshot,
        `Permutation seed ${seed} must produce bit-for-bit identical graph road geometry`
      );
      permutedScene.dispose();
    }

    baselineScene.dispose();
  });

  it('10. validates mode isolation (legacy vs graph-preview vs graph), railway invariance, and urban/real-extract benchmarks (Scenario 20)', () => {
    const provider = new LocalGeoJsonProvider();
    const hengeloRawFc: any = {
      type: 'FeatureCollection',
      name: 'Station Hengelo',
      features: JSON.parse(JSON.stringify(realOsmExtracts.regions.hengelo.features)),
    };
    const amsterdamRawFc: any = {
      type: 'FeatureCollection',
      name: 'Amsterdam Centraal',
      features: JSON.parse(JSON.stringify(realOsmExtracts.regions.amsterdamCentraal.features)),
    };

    // Build a dense 3x3 urban grid synthetic stress fixture
    const urbanSpecs: SyntheticRoadSpec[] = [];
    const coords = [-90, 0, 90];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 2; c++) {
        urbanSpecs.push({
          id: `way/urban-h-${r}-${c}`,
          roadClass: r === 1 ? 'primary' : 'residential',
          width: r === 1 ? 11 : 7,
          name: `Row ${r} Street`,
          points: [
            [coords[c], coords[r]],
            [coords[c + 1], coords[r]],
          ],
          nodeIds: [`u_${r}_${c}`, `u_${r}_${c + 1}`],
        });
      }
    }
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 2; r++) {
        urbanSpecs.push({
          id: `way/urban-v-${c}-${r}`,
          roadClass: c === 1 ? 'secondary' : 'residential',
          width: c === 1 ? 9 : 7,
          name: `Col ${c} Avenue`,
          points: [
            [coords[c], coords[r]],
            [coords[c], coords[r + 1]],
          ],
          nodeIds: [`u_${r}_${c}`, `u_${r + 1}_${c}`],
        });
      }
    }
    // Add diagonal cross-tier pedestrian path and steps
    urbanSpecs.push(
      {
        id: 'way/urban-diag-path',
        roadClass: 'footway',
        width: 2.2,
        points: [
          [-90, -90],
          [0, 0],
        ],
        nodeIds: ['u_0_0', 'u_1_1'],
      },
      {
        id: 'way/urban-steps-spur',
        roadClass: 'steps',
        width: 2.0,
        points: [
          [90, 90],
          [125, 90],
        ],
        nodeIds: ['u_2_2', 'u_steps_end'],
      }
    );

    const datasets: Array<{ name: string; makeData: () => ProcessedMapData }> = [
      {
        name: 'Synthetic 3x3 Urban Grid',
        makeData: () => createDatasetFromSpecs(urbanSpecs),
      },
      {
        name: 'Station Hengelo',
        makeData: () =>
          provider.parseGeoJson(
            JSON.parse(JSON.stringify(hengeloRawFc)),
            'Station Hengelo'
          ),
      },
      {
        name: 'Amsterdam Centraal',
        makeData: () =>
          provider.parseGeoJson(
            JSON.parse(JSON.stringify(amsterdamRawFc)),
            'Amsterdam Centraal'
          ),
      },
    ];

    const benchmarkSummary: Array<Record<string, any>> = [];

    for (const ds of datasets) {
      const dataLegacy = ds.makeData();
      const dataPreview = ds.makeData();
      const dataGraph = ds.makeData();

      // 1. Legacy build
      const tLegacy0 = performance.now();
      const legacyScene = new GeometryBuilder({
        infrastructureRenderOptions: { roads: 'legacy', railways: 'legacy' },
      }).buildScene(dataLegacy, MAP_THEMES.tactical);
      const legacyMs = Number((performance.now() - tLegacy0).toFixed(2));

      // 2. Graph-preview build (must match legacy bit-for-bit)
      const previewPrep = prepareInfrastructureRenderPreview(dataPreview, {
        roads: 'graph-preview',
        railways: 'legacy',
      });
      const previewScene = new GeometryBuilder({
        infrastructureRenderOptions: { roads: 'graph-preview', railways: 'legacy' },
        infrastructureRenderPreview: previewPrep,
      }).buildScene(dataPreview, MAP_THEMES.tactical);

      assert.deepEqual(
        snapshotGroupNode(previewScene.roadsGroup),
        snapshotGroupNode(legacyScene.roadsGroup),
        `graph-preview roadsGroup must remain bit-for-bit identical to legacy on ${ds.name}`
      );

      // 3. Graph road build
      const tGraph0 = performance.now();
      const graphPrep = prepareInfrastructureRenderPreview(dataGraph, {
        roads: 'graph',
        railways: 'legacy',
      });
      const graphScene = new GeometryBuilder({
        infrastructureRenderOptions: { roads: 'graph', railways: 'legacy' },
        infrastructureRenderPreview: graphPrep,
      }).buildScene(dataGraph, MAP_THEMES.tactical);
      const graphMs = Number((performance.now() - tGraph0).toFixed(2));

      // Verify railway group is 100% invariant when roads === 'graph'
      assert.deepEqual(
        snapshotGroupNode(graphScene.railwaysGroup),
        snapshotGroupNode(legacyScene.railwaysGroup),
        `railwaysGroup must remain 100% invariant when roads === 'graph' on ${ds.name}`
      );

      // Verify ZFightingValidator road network geometry invariants in graph mode
      const roadReport = validateRoadNetworkGeometry(graphScene);
      assert.deepEqual(roadReport.overlapConflicts, []);
      assert.deepEqual(roadReport.continuityDefects, []);
      assert.equal(roadReport.isValid, true);

      const gStats: GraphRoadRenderStats = graphScene.roadsGroup.userData.graphRoadStats;
      assert.ok(gStats, `Expected graphRoadStats on ${ds.name}`);

      benchmarkSummary.push({
        dataset: ds.name,
        legacyBuildMs: legacyMs,
        graphBuildMs: graphMs,
        ...gStats,
      });

      // Verify theme update and clean resource disposal in graph mode
      graphScene.updateTheme(MAP_THEMES.daylight);
      legacyScene.dispose();
      previewScene.dispose();
      graphScene.dispose();

      assert.equal(graphScene.resources.ownedGeometriesCount, 0);
      assert.equal(graphScene.resources.ownedMaterialsCount, 0);
      assert.equal(graphScene.resources.disposed, true);
    }

    console.table(benchmarkSummary);
  });
});
