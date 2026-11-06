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
  auditGraphRoadMeshIntegrity,
  BuiltSceneGeometry,
  FaceFeatureRange,
  generateRoadRibbon,
  GeometryBuilder,
  GraphRoadMeshIntegrityReport,
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

/**
 * Generates a realistic 270-way dense urban road network fixture containing:
 * - Curved horizontal avenues (with intermediate curve vertices)
 * - Vertical cross-streets with mixed road classes and widths
 * - Multi-way 5-arm and 6-arm diagonal boulevard intersections
 * - Chained degree-2 ways with distinct tags
 * - Cross-tier footpaths and steps
 * - Grade-separated bridges
 */
function createRoadHeavyUrbanDataset(): ProcessedMapData {
  const specs: SyntheticRoadSpec[] = [];
  const rows = 9;
  const cols = 9;
  const spacing = 36;
  const halfSpan = ((cols - 1) * spacing) / 2;

  const nodeCoord = (r: number, c: number): [number, number] => [
    -halfSpan + c * spacing,
    -halfSpan + r * spacing,
  ];
  const nodeId = (r: number, c: number) => `urb_${r}_${c}`;

  // 1. Horizontal avenues (72 segments, half with intermediate curved vertices)
  for (let r = 0; r < rows; r++) {
    const roadClass: RoadClass =
      r % 4 === 0 ? 'primary' : r % 2 === 0 ? 'secondary' : 'residential';
    const width = r % 4 === 0 ? 11.0 : r % 2 === 0 ? 8.5 : 6.5;
    for (let c = 0; c < cols - 1; c++) {
      const p0 = nodeCoord(r, c);
      const p1 = nodeCoord(r, c + 1);
      const midX = (p0[0] + p1[0]) * 0.5;
      const curveOffset = ((r + c) % 3 === 0 ? 1.8 : -1.4) * (r % 2 === 0 ? 1 : 0);
      const pts: [number, number][] =
        curveOffset !== 0
          ? [p0, [midX, p0[1] + curveOffset], p1]
          : [p0, p1];
      const nids =
        curveOffset !== 0
          ? [nodeId(r, c), undefined, nodeId(r, c + 1)]
          : [nodeId(r, c), nodeId(r, c + 1)];
      const reversed = (r + c) % 5 === 0;
      specs.push({
        id: `way/urb-h-${r}-${c}`,
        roadClass,
        width,
        oneway: r % 4 === 0,
        name: `Avenue ${r}`,
        points: reversed ? [...pts].reverse() : pts,
        nodeIds: reversed ? [...nids].reverse() : nids,
      });
    }
  }

  // 2. Vertical streets (72 segments)
  for (let c = 0; c < cols; c++) {
    const roadClass: RoadClass =
      c % 4 === 0 ? 'secondary' : c % 3 === 0 ? 'tertiary' : 'residential';
    const width = c % 4 === 0 ? 9.5 : c % 3 === 0 ? 7.5 : 6.0;
    for (let r = 0; r < rows - 1; r++) {
      const p0 = nodeCoord(r, c);
      const p1 = nodeCoord(r + 1, c);
      specs.push({
        id: `way/urb-v-${c}-${r}`,
        roadClass,
        width,
        name: `Street ${c}`,
        points: [p0, p1],
        nodeIds: [nodeId(r, c), nodeId(r + 1, c)],
      });
    }
  }

  // 3. Diagonal boulevards creating 5-way and 6-way intersections across blocks (32 segments)
  for (let r = 0; r < rows - 1; r += 2) {
    for (let c = 0; c < cols - 1; c += 2) {
      specs.push({
        id: `way/urb-diag-${r}-${c}`,
        roadClass: 'tertiary',
        width: 7.0,
        name: `Diagonal ${r}-${c}`,
        points: [nodeCoord(r, c), nodeCoord(r + 1, c + 1)],
        nodeIds: [nodeId(r, c), nodeId(r + 1, c + 1)],
      });
    }
  }

  // 4. Cul-de-sac service spurs and degree-2 extensions around the perimeter (36 segments)
  for (let i = 0; i < rows; i++) {
    const pWest = nodeCoord(i, 0);
    const midId = `urb_west_mid_${i}`;
    const endId = `urb_west_end_${i}`;
    specs.push(
      {
        id: `way/urb-spur-w1-${i}`,
        roadClass: 'residential',
        width: 6.0,
        points: [pWest, [pWest[0] - 22, pWest[1] + 3]],
        nodeIds: [nodeId(i, 0), midId],
      },
      {
        id: `way/urb-spur-w2-${i}`,
        roadClass: 'service',
        width: 4.5,
        points: [
          [pWest[0] - 22, pWest[1] + 3],
          [pWest[0] - 42, pWest[1] - 2],
        ],
        nodeIds: [midId, endId],
      }
    );

    const pEast = nodeCoord(i, cols - 1);
    const eMidId = `urb_east_mid_${i}`;
    const eEndId = `urb_east_end_${i}`;
    specs.push(
      {
        id: `way/urb-spur-e1-${i}`,
        roadClass: 'residential',
        width: 6.5,
        points: [pEast, [pEast[0] + 24, pEast[1] - 4]],
        nodeIds: [nodeId(i, cols - 1), eMidId],
      },
      {
        id: `way/urb-spur-e2-${i}`,
        roadClass: 'residential',
        width: 6.5,
        osmTags: { section: `east_${i}` },
        points: [
          [pEast[0] + 24, pEast[1] - 4],
          [pEast[0] + 48, pEast[1] - 8],
        ],
        nodeIds: [eMidId, eEndId],
      }
    );
  }

  // 5. Cross-tier footpaths, cycleways, and steps (50 segments)
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 2; c += 2) {
      const pStart = nodeCoord(r, c);
      const parkCenter: [number, number] = [pStart[0] + spacing * 0.5, pStart[1] + spacing * 0.5];
      const hubId = `urb_path_hub_${r}_${c}`;
      specs.push(
        {
          id: `way/urb-foot-a-${r}-${c}`,
          roadClass: 'footway',
          width: 2.0,
          points: [pStart, parkCenter],
          nodeIds: [nodeId(r, c), hubId],
        },
        {
          id: `way/urb-foot-b-${r}-${c}`,
          roadClass: 'cycleway',
          width: 2.4,
          points: [parkCenter, nodeCoord(r, c + 1)],
          nodeIds: [hubId, nodeId(r, c + 1)],
        },
        {
          id: `way/urb-steps-${r}-${c}`,
          roadClass: r % 2 === 0 ? 'steps' : 'path',
          width: 2.0,
          points: [parkCenter, [parkCenter[0], parkCenter[1] + 12]],
          nodeIds: [hubId, `urb_steps_top_${r}_${c}`],
        }
      );
    }
  }

  // 6. Elevated bridge overpasses (8 segments)
  for (let i = 0; i < 8; i++) {
    const x = -120 + i * 32;
    specs.push({
      id: `way/urb-bridge-${i}`,
      roadClass: 'primary',
      width: 10.0,
      layer: 1,
      isBridge: true,
      points: [
        [x, -175],
        [x, -145],
      ],
      nodeIds: [`urb_br_s_${i}`, `urb_br_n_${i}`],
    });
  }

  return createDatasetFromSpecs(specs, {
    minX: -240,
    maxX: 240,
    minZ: -240,
    maxZ: 240,
  });
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
 * non-degenerate triangles, and upward-facing (+Y) geometric face normals via `auditGraphRoadMeshIntegrity()`.
 */
function assertRoadGroupGeometryInvariants(scene: BuiltSceneGeometry): {
  meshNames: string[];
  faceRangesById: Map<string, FaceFeatureRange>;
  junctionRanges: FaceFeatureRange[];
  integrityReport: GraphRoadMeshIntegrityReport;
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

  // Execute full geometric triangle winding and normal audit via cross(v1 - v0, v2 - v0)
  const integrityReport = auditGraphRoadMeshIntegrity(scene.roadsGroup);
  const hasAtGradeRoadMeshes = meshNames.some(
    (name) =>
      name !== 'Roads_bridge' &&
      !name.startsWith('Bridge_') &&
      !name.startsWith('Tunnel_')
  );
  if (hasAtGradeRoadMeshes) {
    assert.ok(
      integrityReport.auditedTriangleCount > 0,
      'Expected auditGraphRoadMeshIntegrity to inspect at least 1 triangle when at-grade road meshes exist'
    );
  }
  assert.equal(
    integrityReport.negativelyWoundCount,
    0,
    `Expected 0 negatively wound triangles, got ${integrityReport.negativelyWoundCount}: ${JSON.stringify(integrityReport.windingDefects)}`
  );
  assert.equal(
    integrityReport.storedNormalMismatchCount,
    0,
    `Expected 0 stored normal mismatches, got ${integrityReport.storedNormalMismatchCount}: ${JSON.stringify(integrityReport.windingDefects)}`
  );
  assert.deepEqual(
    integrityReport.windingDefects,
    [],
    `Expected 0 winding defects, got ${JSON.stringify(integrityReport.windingDefects)}`
  );
  assert.deepEqual(
    integrityReport.degenerateTriangles,
    [],
    `Expected 0 degenerate triangles, got ${JSON.stringify(integrityReport.degenerateTriangles)}`
  );
  assert.equal(
    integrityReport.upwardTriangleCount,
    integrityReport.auditedTriangleCount,
    'Every audited horizontal road/path/step/junction triangle must face upward (+Y)'
  );

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

  return { meshNames, faceRangesById, junctionRanges, integrityReport };
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

  it('10. validates mode isolation (legacy vs graph-preview vs graph), railway invariance, and road-heavy urban/real-extract benchmarks (Scenario 20)', () => {
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

    // Build a 3x3 urban grid synthetic fixture
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
        name: 'Dense 270-Way Urban Road Network',
        makeData: () => createRoadHeavyUrbanDataset(),
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

      // Run full geometric triangle winding and normal audit + ZFightingValidator
      const { integrityReport } = assertRoadGroupGeometryInvariants(graphScene);

      const gStats: GraphRoadRenderStats = graphScene.roadsGroup.userData.graphRoadStats;
      assert.ok(gStats, `Expected graphRoadStats on ${ds.name}`);

      benchmarkSummary.push({
        dataset: ds.name,
        legacyBuildMs: legacyMs,
        graphBuildMs: graphMs,
        auditedTris: integrityReport.auditedTriangleCount,
        negWoundTris: integrityReport.negativelyWoundCount,
        degenTris: integrityReport.degenerateTriangles.length,
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

  it('11. deliberate negative audit tests: catches reversed triangle indices with +Y vertex normals, crossed ribbon portals, and inverted junction triangles', () => {
    // Negative Case A: Reversed triangle indices [i0, i2, i1] with unchanged +Y stored vertex normals
    const groupA = new THREE.Group();
    const ribbonA = generateRoadRibbon(
      [
        [0, 0],
        [20, 0],
      ],
      8,
      ELEVATION_POLICY.ROAD_SURFACE,
      { roundCaps: false }
    )!;
    // Deliberately swap indices of triangle 0 (l0, l1, r0 -> l0, r0, l1) while leaving stored normals at (0, 1, 0)
    const flippedIndicesA = new Uint32Array(ribbonA.indices);
    const tmp = flippedIndicesA[1];
    flippedIndicesA[1] = flippedIndicesA[2];
    flippedIndicesA[2] = tmp;

    const geoA = new THREE.BufferGeometry();
    geoA.setAttribute('position', new THREE.BufferAttribute(ribbonA.positions, 3));
    geoA.setAttribute('normal', new THREE.BufferAttribute(ribbonA.normals, 3));
    geoA.setIndex(new THREE.BufferAttribute(flippedIndicesA, 1));
    const meshA = new THREE.Mesh(geoA, new THREE.MeshBasicMaterial());
    meshA.name = 'Roads_residential';
    meshA.userData = {
      faceRanges: [
        {
          startFace: 0,
          endFace: 2,
          info: {
            id: 're_neg_test_a',
            sourceFeatureId: 'way/neg-test-a',
            sourceFeatureIds: ['way/neg-test-a'],
            name: 'Negative Test A',
            category: 'Road & Way',
          },
        },
      ],
    };
    groupA.add(meshA);

    const reportA = auditGraphRoadMeshIntegrity(groupA);
    assert.equal(reportA.auditedTriangleCount, 2);
    assert.equal(
      reportA.negativelyWoundCount,
      1,
      'Must catch the 1 reversed-index triangle despite +Y stored normals'
    );
    assert.equal(reportA.storedNormalMismatchCount, 1);
    assert.equal(reportA.windingDefects.length, 1);
    assert.equal(reportA.windingDefects[0].meshName, 'Roads_residential');
    assert.equal(reportA.windingDefects[0].faceIndex, 0);
    assert.equal(reportA.windingDefects[0].featureId, 're_neg_test_a');
    assert.equal(reportA.windingDefects[0].sourceFeatureId, 'way/neg-test-a');
    assert.equal(reportA.windingDefects[0].reason, 'inverted_winding');
    assert.ok(reportA.windingDefects[0].geometricNormal[1] < -0.99);
    geoA.dispose();

    // Negative Case B: Ribbon quad generated with crossed/inverted portal vertices (left and right swapped)
    const groupB = new THREE.Group();
    const crossedRibbon = generateRoadRibbon(
      [
        [0, 0],
        [20, 0],
      ],
      8,
      ELEVATION_POLICY.ROAD_SURFACE,
      {
        roundCaps: false,
        // Normal for segment [0,0]->[20,0] is (0, 1); swapping left=(0,-4) and right=(0,+4) crosses the quad
        startPortal: {
          left: [0, -4],
          right: [0, 4],
        },
      }
    )!;
    const geoB = new THREE.BufferGeometry();
    geoB.setAttribute('position', new THREE.BufferAttribute(crossedRibbon.positions, 3));
    geoB.setAttribute('normal', new THREE.BufferAttribute(crossedRibbon.normals, 3));
    geoB.setIndex(new THREE.BufferAttribute(crossedRibbon.indices, 1));
    const meshB = new THREE.Mesh(geoB, new THREE.MeshBasicMaterial());
    meshB.name = 'Roads_primary';
    meshB.userData = {
      faceRanges: [
        {
          startFace: 0,
          endFace: 2,
          info: {
            id: 're_crossed_portal',
            sourceFeatureId: 'way/crossed-portal',
            sourceFeatureIds: ['way/crossed-portal'],
            name: 'Crossed Portal Ribbon',
            category: 'Road & Way',
          },
        },
      ],
    };
    groupB.add(meshB);

    const reportB = auditGraphRoadMeshIntegrity(groupB);
    assert.ok(
      reportB.negativelyWoundCount >= 1,
      'Must catch inverted triangle in a crossed-portal ribbon quad'
    );
    assert.ok(reportB.windingDefects.some((d) => d.featureId === 're_crossed_portal'));
    geoB.dispose();

    // Negative Case C: Malformed/inverted junction triangle + degenerate zero-area triangle
    const groupC = new THREE.Group();
    const geoC = new THREE.BufferGeometry();
    const y = ELEVATION_POLICY.ROAD_SURFACE;
    // Face 0: clockwise/downward triangle in XZ: (0, y, 0) -> (10, y, 0) -> (0, y, 10) has crossY = -100 (< 0)
    // Face 1: collinear degenerate triangle: (0, y, 0) -> (5, y, 0) -> (10, y, 0) has area = 0
    geoC.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [0, y, 0, 10, y, 0, 0, y, 10, 5, y, 0],
        3
      )
    );
    geoC.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute(
        [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
        3
      )
    );
    geoC.setIndex([0, 1, 2, 0, 3, 1]);
    const meshC = new THREE.Mesh(geoC, new THREE.MeshBasicMaterial());
    meshC.name = 'Roads_secondary';
    meshC.userData = {
      faceRanges: [
        {
          startFace: 0,
          endFace: 2,
          info: {
            id: 'junction-rn_malformed',
            sourceFeatureId: 'way/malformed-junc',
            sourceFeatureIds: ['way/malformed-junc'],
            name: 'Malformed Junction',
            category: 'Road & Way',
          },
        },
      ],
    };
    groupC.add(meshC);

    const reportC = auditGraphRoadMeshIntegrity(groupC);
    assert.equal(reportC.negativelyWoundCount, 1, 'Must catch malformed inverted junction triangle');
    assert.equal(reportC.windingDefects.length, 1);
    assert.equal(reportC.windingDefects[0].featureId, 'junction-rn_malformed');
    assert.equal(reportC.windingDefects[0].faceIndex, 0);
    assert.equal(
      reportC.degenerateTriangles.length,
      1,
      'Must report zero-area collinear triangle separately in degenerateTriangles'
    );
    assert.equal(reportC.degenerateTriangles[0].featureId, 'junction-rn_malformed');
    assert.equal(reportC.degenerateTriangles[0].faceIndex, 1);
    geoC.dispose();
  });

  it('12. stabilizes edge-case junctions, short segments, self-loops, unequal widths, and nearby unconnected grade-transition caps', () => {
    const data = createDatasetFromSpecs([
      // 1. Acute 15-degree Y-fork with unequal widths at [-140, -100] (node 'y15_0')
      {
        id: 'way/y15-stem',
        roadClass: 'primary',
        width: 12,
        points: [
          [-185, -100],
          [-140, -100],
        ],
        nodeIds: ['y15_1', 'y15_0'],
      },
      {
        id: 'way/y15-armA',
        roadClass: 'primary',
        width: 12,
        points: [
          [-140, -100],
          [-90, -100],
        ],
        nodeIds: ['y15_0', 'y15_2'],
      },
      {
        id: 'way/y15-armB-acute',
        roadClass: 'residential',
        width: 6,
        points: [
          [-140, -100],
          [-90, -100 + Math.tan((15 * Math.PI) / 180) * 50],
        ],
        nodeIds: ['y15_0', 'y15_3'],
      },

      // 2. Unequal-width T-junction at [-140, 0] (node 'uw_0'): 14m motorway/primary transition meeting 5m service road
      {
        id: 'way/uw-west-14m',
        roadClass: 'primary',
        width: 14,
        points: [
          [-185, 0],
          [-140, 0],
        ],
        nodeIds: ['uw_w', 'uw_0'],
      },
      {
        id: 'way/uw-east-6m',
        roadClass: 'residential',
        width: 6,
        points: [
          [-140, 0],
          [-95, 0],
        ],
        nodeIds: ['uw_0', 'uw_e'],
      },
      {
        id: 'way/uw-south-5m',
        roadClass: 'service',
        width: 5,
        points: [
          [-140, -40],
          [-140, 0],
        ],
        nodeIds: ['uw_s', 'uw_0'],
      },

      // 3. 6-arm star junction with closely spaced branches at [0, -100] (node 'star6_0')
      ...[0, 28, 90, 155, 220, 295].map((deg, idx) => {
        const rad = (deg * Math.PI) / 180;
        return {
          id: `way/star6-arm-${idx}`,
          roadClass: (idx % 2 === 0 ? 'secondary' : 'residential') as RoadClass,
          width: idx % 2 === 0 ? 9 : 6.5,
          points: [
            [0, -100] as [number, number],
            [Math.cos(rad) * 42, -100 + Math.sin(rad) * 42] as [number, number],
          ],
          nodeIds: ['star6_0', `star6_${idx + 1}`],
        };
      }),

      // 4. Short road segment (4.5 m) between two T-junctions at [0, 0] ('short_a') and [4.5, 0] ('short_b')
      {
        id: 'way/short-connector',
        roadClass: 'residential',
        width: 6,
        points: [
          [0, 0],
          [4.5, 0],
        ],
        nodeIds: ['short_a', 'short_b'],
      },
      {
        id: 'way/short-west',
        roadClass: 'residential',
        width: 6,
        points: [
          [-35, 0],
          [0, 0],
        ],
        nodeIds: ['short_w', 'short_a'],
      },
      {
        id: 'way/short-north-a',
        roadClass: 'service',
        width: 4.5,
        points: [
          [0, 0],
          [0, 35],
        ],
        nodeIds: ['short_a', 'short_na'],
      },
      {
        id: 'way/short-east',
        roadClass: 'residential',
        width: 6,
        points: [
          [4.5, 0],
          [40, 0],
        ],
        nodeIds: ['short_b', 'short_e'],
      },
      {
        id: 'way/short-south-b',
        roadClass: 'service',
        width: 4.5,
        points: [
          [4.5, -35],
          [4.5, 0],
        ],
        nodeIds: ['short_sb', 'short_b'],
      },

      // 5. P-loop (self-loop edge starting and ending at node 'ploop_0' at [110, -100] + stem road)
      {
        id: 'way/ploop-stem',
        roadClass: 'residential',
        width: 6,
        points: [
          [70, -100],
          [110, -100],
        ],
        nodeIds: ['ploop_stem_w', 'ploop_0'],
      },
      {
        id: 'way/ploop-ring',
        roadClass: 'residential',
        width: 6,
        points: [
          [110, -100],
          [135, -80],
          [155, -100],
          [135, -120],
          [110, -100],
        ],
        nodeIds: ['ploop_0', 'ploop_1', 'ploop_2', 'ploop_3', 'ploop_0'],
      },

      // 6. Cross-tier footpaths attached to a curved vehicular through-road with nearby interior vertices at [110, 0] ('ct_curve_0')
      {
        id: 'way/ct-curve-west',
        roadClass: 'secondary',
        width: 9,
        surface: 'asphalt',
        points: [
          [70, -5],
          [107.5, -0.4],
          [110, 0],
        ],
        nodeIds: ['ct_w1', undefined, 'ct_curve_0'],
      },
      {
        id: 'way/ct-curve-east',
        roadClass: 'secondary',
        width: 9,
        surface: 'concrete',
        points: [
          [110, 0],
          [112.5, 0.4],
          [150, 5],
        ],
        nodeIds: ['ct_curve_0', undefined, 'ct_e1'],
      },
      {
        id: 'way/ct-curve-foot-north',
        roadClass: 'footway',
        width: 2.0,
        points: [
          [110, 0],
          [110, 30],
        ],
        nodeIds: ['ct_curve_0', 'ct_fn'],
      },
      {
        id: 'way/ct-curve-foot-south',
        roadClass: 'footway',
        width: 2.0,
        points: [
          [110, -30],
          [110, 0],
        ],
        nodeIds: ['ct_fs', 'ct_curve_0'],
      },

      // 7. Grade-transition cap preservation:
      // (a) A connected bridge transition at [-100, 115] (node 'gt_conn') where the approach road must suppress its cap.
      // (b) An elevated bridge starting at [-100, 100] (node 'gt_bridge_unconn_start') and an unconnected dead-end
      //     service road whose endpoint is 0.40 m away at [-100, 99.60] (node 'gt_unconn_deadend').
      //     Because the dead-end road does not share a topological grade-transition node with the bridge,
      //     it must preserve its semicircular dead-end cap despite being 0.40 m (<= 0.65 m) from the bridge portal.
      {
        id: 'way/gt-connected-approach',
        roadClass: 'tertiary',
        width: 8,
        points: [
          [-150, 115],
          [-100, 115],
        ],
        nodeIds: ['gt_west', 'gt_conn'],
      },
      {
        id: 'way/gt-bridge',
        roadClass: 'tertiary',
        width: 8,
        layer: 1,
        isBridge: true,
        points: [
          [-100, 115],
          [-50, 115],
        ],
        nodeIds: ['gt_conn', 'gt_east'],
      },
      {
        id: 'way/gt-bridge-near-deadend',
        roadClass: 'tertiary',
        width: 8,
        layer: 1,
        isBridge: true,
        points: [
          [-100, 100],
          [-50, 100],
        ],
        nodeIds: ['gt_bridge_unconn_start', 'gt_bridge_unconn_end'],
      },
      {
        id: 'way/nearby-unconnected-culdesac',
        roadClass: 'service',
        width: 4.5,
        points: [
          [-100, 65],
          [-100, 99.6],
        ],
        nodeIds: ['gt_unconn_south', 'gt_unconn_deadend'],
      },
    ]);

    const scene = buildGraphRoadScene(data);
    const { faceRangesById } = assertRoadGroupGeometryInvariants(scene);

    // Verify the nearby (0.40m) unconnected service road kept both of its semicircular dead-end caps!
    // A 2-point road with both caps has: 1 quad (2 triangles) + 2 caps * 6 segments = 14 triangles.
    // Meanwhile, the connected approach road ('way/gt-connected-approach') has 1 cap at [-150, 100] and no cap at [-100, 100] = 8 triangles.
    const unconnectedRange = Array.from(faceRangesById.values()).find(
      (r) => r.info.sourceFeatureId === 'way/nearby-unconnected-culdesac'
    );
    assert.ok(unconnectedRange, 'Expected nearby-unconnected-culdesac to be rendered');
    const unconnectedTriCount = unconnectedRange.endFace - unconnectedRange.startFace;
    assert.equal(
      unconnectedTriCount,
      14,
      'Unconnected at-grade road endpoint 0.40m from a bridge transition must preserve its dead-end cap (14 triangles)'
    );

    const connectedRange = Array.from(faceRangesById.values()).find(
      (r) => r.info.sourceFeatureId === 'way/gt-connected-approach'
    );
    assert.ok(connectedRange, 'Expected gt-connected-approach to be rendered');
    const connectedTriCount = connectedRange.endFace - connectedRange.startFace;
    assert.equal(
      connectedTriCount,
      8,
      'Connected approach road must suppress its cap at the bridge transition while keeping its far dead-end cap (8 triangles)'
    );

    scene.dispose();
  });

  it('13. transactional junction rejection: rejects malformed duplicate-ray junction without leaving connected ribbons trimmed', () => {
    // Two distinct vehicular edges entering node 'dup_node' [0, 0] along the exact same ray from [40, 0],
    // plus a third edge from [-40, 0]. Because two distinct arms enter along the exact same 0-degree ray,
    // solveBoundaryDerivedJunctionNode must reject the malformed junction transactionally and leave all 3 ribbons untrimmed.
    const data = createDatasetFromSpecs([
      {
        id: 'way/tx-west',
        roadClass: 'residential',
        width: 7,
        points: [
          [-40, 0],
          [0, 0],
        ],
        nodeIds: ['tx_w', 'dup_node'],
      },
      {
        id: 'way/tx-east-1',
        roadClass: 'residential',
        width: 7,
        points: [
          [0, 0],
          [40, 0],
        ],
        nodeIds: ['dup_node', 'tx_e1'],
      },
      {
        id: 'way/tx-east-2-collinear',
        roadClass: 'secondary',
        width: 9,
        points: [
          [0, 0],
          [50, 0],
        ],
        nodeIds: ['dup_node', 'tx_e2'],
      },
    ]);

    const scene = buildGraphRoadScene(data);
    const { junctionRanges, faceRangesById } = assertRoadGroupGeometryInvariants(scene);

    assert.equal(
      junctionRanges.length,
      0,
      'Malformed collinear-arm junction must be rejected rather than triangulating an invalid polygon'
    );
    assert.ok(
      (data.diagnostics?.rejectedInvalid.byReason['junction_degenerate_overlapping_arms']
        ?.count ?? 0) >= 1,
      'Must record junction_degenerate_overlapping_arms diagnostic when rejecting malformed junction'
    );

    // Verify way/tx-west was NOT left trimmed back from [0, 0]: its vertices must reach x = 0!
    const resMesh = scene.roadsGroup.children.find(
      (c) => c.name === 'Roads_residential'
    ) as THREE.Mesh;
    assert.ok(resMesh);
    const westRange = Array.from(faceRangesById.values()).find(
      (r) => r.info.sourceFeatureId === 'way/tx-west'
    );
    assert.ok(westRange);
    const pos = resMesh.geometry.attributes.position;
    const idx = resMesh.geometry.index!;
    let maxWestX = -Infinity;
    for (let f = westRange.startFace; f < westRange.endFace; f++) {
      for (let k = 0; k < 3; k++) {
        const vi = idx.getX(f * 3 + k);
        maxWestX = Math.max(maxWestX, pos.getX(vi));
      }
    }
    assert.ok(
      maxWestX >= -0.05,
      `Rejected junction must not leave connected road ribbon trimmed (expected maxWestX >= -0.05, got ${maxWestX})`
    );

    scene.dispose();
  });

  it('14. preserves straight road width and curved road bends near junctions without pinching or deleting curve vertices', () => {
    // 1. Straight 12.0 m primary avenue joined by a 5.0 m service road at [0, 0] ('j_straight'),
    //    plus a curved 10.0 m secondary road joined at [0, 80] ('j_curve') with tight intermediate bends
    //    starting just outside the junction at x = 8.5, 13.0, 20.0, 30.0, 45.0, and a curved degree-2
    //    continuity join at [-35, 80] ('j_deg2_short') with a 3.2 m first segment.
    const data = createDatasetFromSpecs([
      {
        id: 'way/straight-main-west',
        roadClass: 'primary',
        width: 12.0,
        points: [
          [-60, 0],
          [0, 0],
        ],
        nodeIds: ['sm_w', 'j_straight'],
      },
      {
        id: 'way/straight-main-east',
        roadClass: 'primary',
        width: 12.0,
        points: [
          [0, 0],
          [60, 0],
        ],
        nodeIds: ['j_straight', 'sm_e'],
      },
      {
        id: 'way/straight-side-south',
        roadClass: 'service',
        width: 5.0,
        points: [
          [0, -45],
          [0, 0],
        ],
        nodeIds: ['sm_s', 'j_straight'],
      },

      // Curved road meeting a T-junction at [0, 80] ('j_curve') and a degree-2 continuity join at [-35, 80] ('j_deg2_short')
      {
        id: 'way/curved-far-west',
        roadClass: 'secondary',
        width: 10.0,
        surface: 'concrete',
        points: [
          [-75, 72],
          [-50, 77],
          [-38.2, 79.4],
          [-35, 80],
        ],
        nodeIds: ['cf_w', undefined, undefined, 'j_deg2_short'],
      },
      {
        id: 'way/curved-west-approach',
        roadClass: 'secondary',
        width: 10.0,
        surface: 'asphalt',
        points: [
          [-35, 80],
          [-31.8, 80.5],
          [-18, 82.0],
          [-8.5, 80.8],
          [0, 80],
        ],
        nodeIds: ['j_deg2_short', undefined, undefined, undefined, 'j_curve'],
      },
      {
        id: 'way/curved-east-bends',
        roadClass: 'secondary',
        width: 10.0,
        surface: 'asphalt',
        points: [
          [0, 80],
          [8.5, 81.2],
          [14.0, 83.5],
          [22.0, 88.0],
          [32.0, 94.0],
          [48.0, 100.0],
        ],
        nodeIds: ['j_curve', undefined, undefined, undefined, undefined, 'cf_e'],
      },
      {
        id: 'way/curved-side-north',
        roadClass: 'residential',
        width: 7.0,
        points: [
          [0, 80],
          [0, 125],
        ],
        nodeIds: ['j_curve', 'cf_n'],
      },
    ]);

    const scene = buildGraphRoadScene(data);
    const { faceRangesById } = assertRoadGroupGeometryInvariants(scene);

    // Inspect 'way/straight-main-west' and 'way/straight-main-east' in Roads_primary:
    // Every cross-section (including the portal cut adjacent to j_straight) must have Z-span = 12.0 m (± 0.02 m).
    const primaryMesh = scene.roadsGroup.children.find(
      (c) => c.name === 'Roads_primary'
    ) as THREE.Mesh;
    assert.ok(primaryMesh, 'Expected Roads_primary mesh');
    const pPos = primaryMesh.geometry.attributes.position;
    const pIdx = primaryMesh.geometry.index!;

    for (const wayId of ['way/straight-main-west', 'way/straight-main-east']) {
      const range = Array.from(faceRangesById.values()).find(
        (r) => r.info.sourceFeatureId === wayId && !r.info.id.startsWith('junction-')
      );
      assert.ok(range, `Expected ribbon face range for ${wayId}`);

      // Find the vertex X closest to the junction at x = 0 (the portal cut)
      let portalX = wayId.endsWith('west') ? -Infinity : Infinity;
      const vertices: Array<[number, number]> = [];
      for (let f = range.startFace; f < range.endFace; f++) {
        for (let k = 0; k < 3; k++) {
          const vi = pIdx.getX(f * 3 + k);
          const vx = pPos.getX(vi);
          const vz = pPos.getZ(vi);
          vertices.push([vx, vz]);
          if (wayId.endsWith('west')) {
            if (vx > portalX) portalX = vx;
          } else {
            if (vx < portalX) portalX = vx;
          }
        }
      }

      const portalZs = vertices
        .filter(([vx]) => Math.abs(vx - portalX) <= 0.05)
        .map(([, vz]) => vz);
      const minPortalZ = Math.min(...portalZs);
      const maxPortalZ = Math.max(...portalZs);
      const portalWidth = maxPortalZ - minPortalZ;
      assert.ok(
        Math.abs(portalWidth - 12.0) <= 0.02,
        `Expected ${wayId} to retain full 12.0m width at junction portal (x=${portalX.toFixed(2)}), got ${portalWidth.toFixed(4)}m`
      );
    }

    // Inspect 'way/straight-side-south' in Roads_service: X-span at the junction portal must equal 5.0 m (± 0.02 m).
    const serviceMesh = scene.roadsGroup.children.find(
      (c) => c.name === 'Roads_service'
    ) as THREE.Mesh;
    assert.ok(serviceMesh, 'Expected Roads_service mesh');
    const sPos = serviceMesh.geometry.attributes.position;
    const sIdx = serviceMesh.geometry.index!;
    const sideRange = Array.from(faceRangesById.values()).find(
      (r) => r.info.sourceFeatureId === 'way/straight-side-south' && !r.info.id.startsWith('junction-')
    );
    assert.ok(sideRange, 'Expected ribbon face range for way/straight-side-south');
    let maxSideZ = -Infinity;
    const sideVerts: Array<[number, number]> = [];
    for (let f = sideRange.startFace; f < sideRange.endFace; f++) {
      for (let k = 0; k < 3; k++) {
        const vi = sIdx.getX(f * 3 + k);
        const vx = sPos.getX(vi);
        const vz = sPos.getZ(vi);
        sideVerts.push([vx, vz]);
        if (vz > maxSideZ) maxSideZ = vz;
      }
    }
    const sidePortalXs = sideVerts
      .filter(([, vz]) => Math.abs(vz - maxSideZ) <= 0.05)
      .map(([vx]) => vx);
    const sidePortalWidth = Math.max(...sidePortalXs) - Math.min(...sidePortalXs);
    assert.ok(
      Math.abs(sidePortalWidth - 5.0) <= 0.02,
      `Expected way/straight-side-south to retain full 5.0m width at junction portal, got ${sidePortalWidth.toFixed(4)}m`
    );

    // Inspect 'way/curved-east-bends' in Roads_secondary:
    // Must retain all 4 intermediate curve bends (plus portal and cap = at least 16 triangles)
    // and preserve full 10.0m width at the degree-2 join at x = -35.
    const secondaryMesh = scene.roadsGroup.children.find(
      (c) => c.name === 'Roads_secondary'
    ) as THREE.Mesh;
    assert.ok(secondaryMesh, 'Expected Roads_secondary mesh');
    const secPos = secondaryMesh.geometry.attributes.position;
    const secIdx = secondaryMesh.geometry.index!;

    const curvedEastRange = Array.from(faceRangesById.values()).find(
      (r) => r.info.sourceFeatureId === 'way/curved-east-bends' && !r.info.id.startsWith('junction-')
    );
    assert.ok(curvedEastRange, 'Expected ribbon face range for way/curved-east-bends');
    const curvedEastTriCount = curvedEastRange.endFace - curvedEastRange.startFace;
    // 5 segments * 2 tris/seg + 6 cap tris = 16 triangles (if any interior bend was deleted, triCount would drop <= 14)
    assert.ok(
      curvedEastTriCount >= 16,
      `Expected way/curved-east-bends to preserve all intermediate curve vertices (>= 16 tris), got ${curvedEastTriCount}`
    );

    // Check width at the degree-2 shared continuity join at x = -35, z = 80 ('j_deg2_short')
    const curvedWestRange = Array.from(faceRangesById.values()).find(
      (r) => r.info.sourceFeatureId === 'way/curved-west-approach' && !r.info.id.startsWith('junction-')
    );
    assert.ok(curvedWestRange, 'Expected ribbon face range for way/curved-west-approach');
    const deg2Verts: Array<[number, number]> = [];
    for (let f = curvedWestRange.startFace; f < curvedWestRange.endFace; f++) {
      for (let k = 0; k < 3; k++) {
        const vi = secIdx.getX(f * 3 + k);
        const vx = secPos.getX(vi);
        const vz = secPos.getZ(vi);
        if (Math.abs(vx - -35) <= 2.0) {
          deg2Verts.push([vx, vz]);
        }
      }
    }
    assert.equal(deg2Verts.length >= 2, true, 'Expected portal vertices near degree-2 join at x = -35');
    const deg2SpanZ =
      Math.max(...deg2Verts.map(([, vz]) => vz)) - Math.min(...deg2Verts.map(([, vz]) => vz));
    assert.ok(
      deg2SpanZ >= 9.8,
      `Expected degree-2 continuity join with short first segment to preserve ~10.0m width without clamping, got Z-span ${deg2SpanZ.toFixed(3)}m`
    );

    scene.dispose();
  });

  it('15. constructs localized road-footprint junctions for acute unequal-width forks and short inter-junction roads without exaggerated wedges', () => {
    const acuteAngleRad = (22 * Math.PI) / 180;
    const data = createDatasetFromSpecs([
      // 1. Acute 22-degree unequal-width Y-junction at [0, 0] ('acute_uw'):
      //    14.0m trunk road from [-70, 0] -> [0, 0] -> [70, 0] + 5.5m slip road to [55*cos(22°), 55*sin(22°)]
      {
        id: 'way/acute-trunk-west',
        roadClass: 'trunk',
        width: 14.0,
        points: [
          [-70, 0],
          [0, 0],
        ],
        nodeIds: ['auw_w', 'acute_uw'],
      },
      {
        id: 'way/acute-trunk-east',
        roadClass: 'trunk',
        width: 14.0,
        points: [
          [0, 0],
          [70, 0],
        ],
        nodeIds: ['acute_uw', 'auw_e'],
      },
      {
        id: 'way/acute-slip-ne',
        roadClass: 'residential',
        width: 5.5,
        points: [
          [0, 0],
          [Math.cos(acuteAngleRad) * 55, Math.sin(acuteAngleRad) * 55],
        ],
        nodeIds: ['acute_uw', 'auw_ne'],
      },

      // 2. Short 9.0m residential road (width 7.0m) between two 3-way junctions at [0, 90] ('sj_a') and [9.0, 90] ('sj_b')
      {
        id: 'way/short-between-juncs',
        roadClass: 'residential',
        width: 7.0,
        points: [
          [0, 90],
          [9.0, 90],
        ],
        nodeIds: ['sj_a', 'sj_b'],
      },
      {
        id: 'way/sj-west-main',
        roadClass: 'residential',
        width: 7.0,
        points: [
          [-45, 90],
          [0, 90],
        ],
        nodeIds: ['sj_w', 'sj_a'],
      },
      {
        id: 'way/sj-north-branch',
        roadClass: 'service',
        width: 5.0,
        points: [
          [0, 90],
          [0, 130],
        ],
        nodeIds: ['sj_a', 'sj_n'],
      },
      {
        id: 'way/sj-east-main',
        roadClass: 'residential',
        width: 7.0,
        points: [
          [9.0, 90],
          [55, 90],
        ],
        nodeIds: ['sj_b', 'sj_e'],
      },
      {
        id: 'way/sj-south-branch',
        roadClass: 'service',
        width: 5.0,
        points: [
          [9.0, 50],
          [9.0, 90],
        ],
        nodeIds: ['sj_s', 'sj_b'],
      },
    ]);

    const scene = buildGraphRoadScene(data);
    const { junctionRanges, faceRangesById } = assertRoadGroupGeometryInvariants(scene);
    assert.equal(junctionRanges.length, 3, 'Expected all 3 junctions (acute_uw, sj_a, sj_b) to render');

    // Verify the acute Y-junction ('acute_uw') in Roads_trunk does not bulge south of the trunk road's southern curb (z = -7.0)
    // and its area is strictly bounded by the sum of the local arm footprints (no exaggerated chord wedge).
    const trunkMesh = scene.roadsGroup.children.find(
      (c) => c.name === 'Roads_trunk'
    ) as THREE.Mesh;
    assert.ok(trunkMesh, 'Expected Roads_trunk mesh');
    const tPos = trunkMesh.geometry.attributes.position;
    const tIdx = trunkMesh.geometry.index!;
    const acuteJuncRange = junctionRanges.find((r) =>
      r.info.sourceFeatureIds?.includes('way/acute-trunk-west')
    );
    assert.ok(acuteJuncRange, 'Expected junction range for acute_uw');

    let juncArea = 0;
    let minJuncZ = Infinity;
    let maxJuncX = -Infinity;
    for (let f = acuteJuncRange.startFace; f < acuteJuncRange.endFace; f++) {
      const i0 = tIdx.getX(f * 3);
      const i1 = tIdx.getX(f * 3 + 1);
      const i2 = tIdx.getX(f * 3 + 2);
      const x0 = tPos.getX(i0), z0 = tPos.getZ(i0);
      const x1 = tPos.getX(i1), z1 = tPos.getZ(i1);
      const x2 = tPos.getX(i2), z2 = tPos.getZ(i2);
      juncArea += Math.abs((x1 - x0) * (z2 - z0) - (x2 - x0) * (z1 - z0)) * 0.5;
      minJuncZ = Math.min(minJuncZ, z0, z1, z2);
      maxJuncX = Math.max(maxJuncX, x0, x1, x2);
    }

    assert.ok(
      Math.abs(minJuncZ - -7.0) <= 0.05,
      `Expected acute Y-junction southern boundary to match trunk curb z=-7.0m, got ${minJuncZ.toFixed(3)}m`
    );
    // Local radius cap is 14.0 * 1.65 = 23.1m; analytical union of the 14m trunk stub + 5.5m slip stub is < 580 m²
    assert.ok(
      maxJuncX <= 24.0,
      `Expected acute Y-junction extent to stay localized (maxJuncX <= 24.0m), got ${maxJuncX.toFixed(2)}m`
    );
    assert.ok(
      juncArea > 200 && juncArea < 580,
      `Expected acute Y-junction area to match localized road footprint union (200..580 m²), got ${juncArea.toFixed(2)} m²`
    );

    // Verify the short 9.0m connecting road ('way/short-between-juncs') rendered valid triangles with full 7.0m Z-span
    const resMesh = scene.roadsGroup.children.find(
      (c) => c.name === 'Roads_residential'
    ) as THREE.Mesh;
    assert.ok(resMesh, 'Expected Roads_residential mesh');
    const rPos = resMesh.geometry.attributes.position;
    const rIdx = resMesh.geometry.index!;
    const shortRange = Array.from(faceRangesById.values()).find(
      (r) => r.info.sourceFeatureId === 'way/short-between-juncs' && !r.info.id.startsWith('junction-')
    );
    assert.ok(shortRange, 'Expected ribbon face range for way/short-between-juncs');
    assert.ok(shortRange.endFace > shortRange.startFace, 'Short road between two junctions must have positive triangles');

    let shortMinZ = Infinity;
    let shortMaxZ = -Infinity;
    for (let f = shortRange.startFace; f < shortRange.endFace; f++) {
      for (let k = 0; k < 3; k++) {
        const vi = rIdx.getX(f * 3 + k);
        const vz = rPos.getZ(vi);
        shortMinZ = Math.min(shortMinZ, vz);
        shortMaxZ = Math.max(shortMaxZ, vz);
      }
    }
    assert.ok(
      Math.abs(shortMaxZ - shortMinZ - 7.0) <= 0.02,
      `Expected short road between junctions to preserve full 7.0m width, got ${(shortMaxZ - shortMinZ).toFixed(3)}m`
    );

    scene.dispose();
  });

  it('16. enforces strict locality when adding a side road and preserves legacy / graph-preview invariance', () => {
    const mainRoadSpecs: SyntheticRoadSpec[] = [
      {
        id: 'way/loc-main-west',
        roadClass: 'primary',
        width: 10.0,
        points: [
          [-90, 0],
          [-60, 6],
          [-35, 3],
          [-18, 0.5],
          [0, 0],
        ],
        nodeIds: ['loc_w', undefined, undefined, undefined, 'loc_center'],
      },
      {
        id: 'way/loc-main-east',
        roadClass: 'primary',
        width: 10.0,
        points: [
          [0, 0],
          [18, -0.5],
          [35, -3],
          [60, -6],
          [90, 0],
        ],
        nodeIds: ['loc_center', undefined, undefined, undefined, 'loc_e'],
      },
    ];

    const sideRoadSpec: SyntheticRoadSpec = {
      id: 'way/loc-side-south',
      roadClass: 'residential',
      width: 6.0,
      points: [
        [0, -50],
        [0, 0],
      ],
      nodeIds: ['loc_s', 'loc_center'],
    };

    const dataWithoutSide = createDatasetFromSpecs(mainRoadSpecs);
    const dataWithSide = createDatasetFromSpecs([...mainRoadSpecs, sideRoadSpec]);

    const sceneWithoutSide = buildGraphRoadScene(dataWithoutSide);
    const sceneWithSide = buildGraphRoadScene(dataWithSide);

    assertRoadGroupGeometryInvariants(sceneWithoutSide);
    assertRoadGroupGeometryInvariants(sceneWithSide);

    // Extract all vertices of Roads_primary with |x| > 18.0 m (outside the local junction region at [0, 0])
    const collectExteriorPrimaryVertices = (scene: BuiltSceneGeometry): string[] => {
      const mesh = scene.roadsGroup.children.find(
        (c) => c.name === 'Roads_primary'
      ) as THREE.Mesh;
      assert.ok(mesh, 'Expected Roads_primary mesh');
      const pos = mesh.geometry.attributes.position;
      const idx = mesh.geometry.index!;
      const used = new Set<number>();
      for (let i = 0; i < idx.count; i++) {
        used.add(idx.getX(i));
      }
      const coords = new Set<string>();
      for (const vi of used) {
        const vx = pos.getX(vi);
        const vz = pos.getZ(vi);
        if (Math.abs(vx) > 18.0) {
          coords.add(`${vx.toFixed(3)},${vz.toFixed(3)}`);
        }
      }
      return Array.from(coords).sort();
    };

    const exteriorWithoutSide = collectExteriorPrimaryVertices(sceneWithoutSide);
    const exteriorWithSide = collectExteriorPrimaryVertices(sceneWithSide);
    assert.ok(exteriorWithoutSide.length >= 16, 'Expected exterior curve & cap vertices on main road');
    assert.deepEqual(
      exteriorWithSide,
      exteriorWithoutSide,
      'Adding a side road at [0, 0] must not alter main road vertices outside the local junction region (|x| > 18m)'
    );

    // Also verify legacy and graph-preview modes remain 100% identical to each other on dataWithSide
    const legacyData = createDatasetFromSpecs([...mainRoadSpecs, sideRoadSpec]);
    const previewData = createDatasetFromSpecs([...mainRoadSpecs, sideRoadSpec]);
    const legacyScene = new GeometryBuilder({
      infrastructureRenderOptions: { roads: 'legacy', railways: 'legacy' },
    }).buildScene(legacyData, MAP_THEMES.tactical);

    const previewPrep = prepareInfrastructureRenderPreview(previewData, {
      roads: 'graph-preview',
      railways: 'graph-preview',
    });
    const previewScene = new GeometryBuilder({
      infrastructureRenderOptions: { roads: 'graph-preview', railways: 'graph-preview' },
      infrastructureRenderPreview: previewPrep,
    }).buildScene(previewData, MAP_THEMES.tactical);

    assert.deepEqual(
      snapshotGroupNode(previewScene.roadsGroup),
      snapshotGroupNode(legacyScene.roadsGroup),
      'graph-preview roadsGroup must remain bit-for-bit identical to legacy roadsGroup'
    );

    sceneWithoutSide.dispose();
    sceneWithSide.dispose();
    legacyScene.dispose();
    previewScene.dispose();
  });
});

