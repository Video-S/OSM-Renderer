import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import polygonClipping from 'polygon-clipping';
import {
  ProcessedMapData,
  RoadClass,
  RoadFeature,
} from '../types/MapFeature';
import { ELEVATION_POLICY } from './ElevationPolicy';
import { MultiPolygonCoords, computeMultiPolygonArea } from './PlanarLayerValidator';
import {
  auditGraphRoadMeshIntegrity,
  BuiltSceneGeometry,
  FaceFeatureRange,
  generateRoadRibbon,
  buildRoadRibbonOutlineRing,
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
import { ROAD_CLASS_WIDTHS } from './FeatureCatalogue';
import { MAP_THEMES } from '../styles/mapThemes';
import { UnchainedRoadPart } from './infrastructure/topology/types';
import realOsmExtracts from './prototype/realOsmRailwayExtracts.json';
import prinsHendrikkadeForkFixture from './prototype/PrinsHendrikkadeForkFixture.json';
import veloursstraatSplitFixture from './prototype/VeloursstraatSplitFixture.json';
import parallelwegSplitFixture from './prototype/ParallelwegSplitFixture.json';

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
    assert.equal(junctionRanges.length, 4,
      'Three roundabout junctions plus the new local unequal-width transition must be rendered');
    assert.ok(
      junctionRanges.some((range) =>
        range.info.sourceFeatureIds.includes('way/width-step-wide') &&
        range.info.sourceFeatureIds.includes('way/width-step-narrow')
      ),
      'The width-step transition must preserve both source ways'
    );
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

    // The graph edge is 180m long, but each original way contributes exactly
    // 60m. The older trimPolylineByArcLength helper capped 120m endpoint trims
    // at 45% of the graph edge, incorrectly expanding the west/east source
    // ribbons by 39m. Inspection IDs remained correct while their geometry
    // extended far beyond the underlying OSM ways.
    const maxAllowedX: Record<string, [number, number]> = {
      'way/chain-seg-1': [-94, -29.5], // free endpoint includes a 3.5m round cap
      'way/chain-seg-2': [-30.5, 30.5],
      'way/chain-seg-3-rev': [29.5, 94],
    };
    const vertexPositions = resMesh.geometry.getAttribute('position');
    const vertexIndex = resMesh.geometry.getIndex();
    for (const range of ranges) {
      const sourceId = range.info.sourceFeatureId;
      const expected = maxAllowedX[sourceId];
      assert.ok(expected, `Unexpected source range ${sourceId}`);
      let minX = Infinity;
      let maxX = -Infinity;
      for (let face = range.startFace; face < range.endFace; face++) {
        for (let k = 0; k < 3; k++) {
          const index = vertexIndex ? vertexIndex.getX(face * 3 + k) : face * 3 + k;
          const x = vertexPositions.getX(index);
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
      }
      assert.ok(
        minX >= expected[0] && maxX <= expected[1],
        `OSM way ${sourceId} escaped its original provenance span: [${minX}, ${maxX}] instead of [${expected[0]}, ${expected[1]}]`
      );
    }


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
      const { integrityReport, faceRangesById } = assertRoadGroupGeometryInvariants(graphScene);
      if (ds.name === 'Dense 270-Way Urban Road Network') {
        assert.ok(
          faceRangesById.has('road_edge:way/urb-v-6-0-0:seg_0:p_0'),
          'Clipping at the diagonal crossing must preserve the connected vertical road surface'
        );
      }

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
    // The first source segment may be legitimately consumed by the junction
    // patch, changing the ribbon's triangle count. Check the resulting surface
    // directly at every bend and across both sides of its intended width.
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
    const sourceCenterline: [number, number][] = [
      [0, 80], [8.5, 81.2], [14.0, 83.5], [22.0, 88.0], [32.0, 94.0], [48.0, 100.0],
    ];
    const containsSecondarySurface = (x: number, z: number): boolean => {
      for (let face = 0; face < secIdx.count / 3; face++) {
        const indices = [0, 1, 2].map((k) => secIdx.getX(face * 3 + k));
        const vertices = indices.map((id) =>
          [secPos.getX(id), secPos.getZ(id)] as [number, number]
        );
        const cross = (a: [number, number], b: [number, number]) =>
          (a[0] - x) * (b[1] - z) - (a[1] - z) * (b[0] - x);
        const ab = cross(vertices[0], vertices[1]);
        const bc = cross(vertices[1], vertices[2]);
        const ca = cross(vertices[2], vertices[0]);
        if ((ab >= -1e-4 && bc >= -1e-4 && ca >= -1e-4) ||
            (ab <= 1e-4 && bc <= 1e-4 && ca <= 1e-4)) return true;
      }
      return false;
    };
    // Source geometry with 10m width must remain covered on both sides of
    // each original intermediate bend, regardless of which mesh owns its faces.
    for (let i = 1; i < sourceCenterline.length - 1; i++) {
      const prev = sourceCenterline[i - 1];
      const point = sourceCenterline[i];
      const next = sourceCenterline[i + 1];
      const dx = next[0] - prev[0], dz = next[1] - prev[1];
      const len = Math.hypot(dx, dz);
      assert.ok(len > 0);
      const nx = -dz / len, nz = dx / len;
      for (const lateral of [-3.5, 0, 3.5]) {
        assert.ok(
          containsSecondarySurface(point[0] + nx * lateral, point[1] + nz * lateral),
          `Curved east road must preserve 10m-wide coverage at bend ${i}, lateral ${lateral}m`
        );
      }
    }

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

    // Boolean clipping can re-triangulate a whole road without changing its surface.
    // Compare occupied area outside the junction, not tessellation-dependent vertex IDs.
    const exteriorPrimarySurface = (scene: BuiltSceneGeometry): MultiPolygonCoords => {
      const mesh = scene.roadsGroup.children.find((c) => c.name === 'Roads_primary') as THREE.Mesh;
      assert.ok(mesh, 'Expected Roads_primary mesh');
      const pos = mesh.geometry.getAttribute('position');
      const idx = mesh.geometry.getIndex();
      const triPolys: MultiPolygonCoords = [];
      const faceCount = idx ? idx.count / 3 : pos.count / 3;
      for (let f = 0; f < faceCount; f++) {
        const ids = [0, 1, 2].map((i) => idx ? idx.getX(f * 3 + i) : f * 3 + i);
        if (ids.some((i) => Math.abs(pos.getY(i) - ELEVATION_POLICY.ROAD_SURFACE) > 0.001)) continue;
        const ring: [number, number][] = ids.map((i) => [pos.getX(i), pos.getZ(i)]);
        ring.push([ring[0][0], ring[0][1]]);
        triPolys.push([ring]);
      }
      assert.ok(triPolys.length > 0, 'Expected primary road surface triangles');
      const merged = polygonClipping.union(
        triPolys[0] as unknown as polygonClipping.Geom,
        ...(triPolys.slice(1) as unknown as polygonClipping.Geom[])
      ) as unknown as MultiPolygonCoords;
      const exteriorMask: MultiPolygonCoords = [
        [[[-200, -200], [-18, -200], [-18, 200], [-200, 200], [-200, -200]]],
        [[[18, -200], [200, -200], [200, 200], [18, 200], [18, -200]]],
      ];
      return polygonClipping.intersection(
        merged as unknown as polygonClipping.Geom,
        exteriorMask as unknown as polygonClipping.Geom
      ) as unknown as MultiPolygonCoords;
    };

    const exteriorBefore = exteriorPrimarySurface(sceneWithoutSide);
    const exteriorAfter = exteriorPrimarySurface(sceneWithSide);
    const lost = polygonClipping.difference(
      exteriorBefore as unknown as polygonClipping.Geom,
      exteriorAfter as unknown as polygonClipping.Geom
    ) as unknown as MultiPolygonCoords;
    const gained = polygonClipping.difference(
      exteriorAfter as unknown as polygonClipping.Geom,
      exteriorBefore as unknown as polygonClipping.Geom
    ) as unknown as MultiPolygonCoords;
    const changedArea = computeMultiPolygonArea(lost) + computeMultiPolygonArea(gained);
    assert.ok(
      changedArea <= 0.2,
      `Adding a side road changed ${changedArea.toFixed(4)}m² of main-road surface outside |x| <= 18m`
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
  it('17. covers full-width road corridors across T and acute junctions (including a negative control)', () => {
    const layouts: Array<Array<{ points: [number, number][]; width: number }>> = [
      [
        { points: [[-36, 0], [0, 0]], width: 12 },
        { points: [[0, 0], [36, 0]], width: 12 },
        { points: [[0, -36], [0, 0]], width: 6 },
      ],
      [
        { points: [[-36, 0], [0, 0]], width: 14 },
        { points: [[0, 0], [36, 0]], width: 14 },
        { points: [[0, 0], [30, 11]], width: 5.5 },
      ],
    ];
    for (const layout of layouts) {
      const specs: SyntheticRoadSpec[] = layout.map((road, i) => ({
        id: `way/coverage-${i}`,
        roadClass: i === 2 ? 'service' : 'primary',
        points: road.points as [number, number][],
        width: road.width,
        nodeIds: i === 0 || (i === 2 && road.points[1][0] === 0 && road.points[1][1] === 0)
          ? [`coverage-end-${i}`, 'coverage-center']
          : ['coverage-center', `coverage-end-${i}`],
      }));
      const scene = buildGraphRoadScene(createDatasetFromSpecs(specs));
      try {
        assertRoadGroupGeometryInvariants(scene);
        type Tri = [[number, number], [number, number], [number, number]];
        const visible: Tri[] = [];
        const withoutJunction: Tri[] = [];
        scene.roadsGroup.traverse((object) => {
          if (!(object as THREE.Mesh).isMesh || !object.name.startsWith('Roads_')) return;
          const mesh = object as THREE.Mesh;
          const positions = mesh.geometry.getAttribute('position');
          const index = mesh.geometry.getIndex();
          const count = index ? index.count / 3 : positions.count / 3;
          for (let f = 0; f < count; f++) {
            const ids = [0, 1, 2].map((k) => index ? index.getX(f * 3 + k) : f * 3 + k);
            if (ids.some((i) => Math.abs(positions.getY(i) - ELEVATION_POLICY.ROAD_SURFACE) > 0.001)) continue;
            const tri = ids.map((i) => [positions.getX(i), positions.getZ(i)] as [number, number]) as Tri;
            visible.push(tri);
            const info = resolveInspectedFeature({ object: mesh, faceIndex: f });
            if (!info?.id.startsWith('junction-')) withoutJunction.push(tri);
          }
        });
        const contains = (tri: Tri, x: number, z: number): boolean => {
          const cross = (a: [number, number], b: [number, number]) =>
            (a[0] - x) * (b[1] - z) - (a[1] - z) * (b[0] - x);
          const ab = cross(tri[0], tri[1]);
          const bc = cross(tri[1], tri[2]);
          const ca = cross(tri[2], tri[0]);
          return (ab >= -1e-4 && bc >= -1e-4 && ca >= -1e-4) ||
            (ab <= 1e-4 && bc <= 1e-4 && ca <= 1e-4);
        };
        const insideIntendedRoad = (x: number, z: number): boolean => layout.some((road) => {
          const [a, b] = road.points;
          const dx = b[0] - a[0], dz = b[1] - a[1];
          const lengthSq = dx * dx + dz * dz;
          const t = ((x - a[0]) * dx + (z - a[1]) * dz) / lengthSq;
          const lateral = Math.abs((x - a[0]) * dz - (z - a[1]) * dx) / Math.sqrt(lengthSq);
          return t >= 0.03 && t <= 0.97 && lateral < road.width / 2 - 0.45;
        });
        let sampled = 0, missing = 0, missingWithoutPatch = 0;
        for (let x = -18.13; x < 18; x += 0.45) {
          for (let z = -12.11; z < 12; z += 0.45) {
            if (!insideIntendedRoad(x, z)) continue;
            sampled++;
            if (!visible.some((tri) => contains(tri, x, z))) missing++;
            if (!withoutJunction.some((tri) => contains(tri, x, z))) missingWithoutPatch++;
          }
        }
        assert.ok(sampled > 300, 'Expected substantial source-footprint coverage');
        assert.equal(missing, 0, `Missing ${missing} of ${sampled} expected road interior points`);
        assert.ok(missingWithoutPatch > 0, 'Negative control must detect a hole without the junction patch');
      } finally {
        scene.dispose();
      }
    }
  });



  it('18. clips cycleway fork patches against actual at-grade roads without joining unrelated infrastructure', () => {
    const data = createDatasetFromSpecs([
      // Path-only fork with a separate road crossing its local junction footprint.
      { id: 'way/bike-west', roadClass: 'cycleway', width: 3.5,
        points: [[-30, 0], [0, 0]], nodeIds: ['bike-west', 'bike-fork'] },
      { id: 'way/bike-east', roadClass: 'cycleway', width: 3.5,
        points: [[0, 0], [30, 0]], nodeIds: ['bike-fork', 'bike-east'] },
      { id: 'way/bike-north', roadClass: 'cycleway', width: 3.5,
        points: [[0, 0], [0, 30]], nodeIds: ['bike-fork', 'bike-north'] },
      { id: 'way/veh-crossing-bike', roadClass: 'service', width: 2,
        points: [[-30, 2], [30, 2]], nodeIds: ['veh-west', 'veh-east'] },

      // Path fork meeting a single vehicular arm: neither a vehicular branch
      // junction nor a reason to leave the path-only fork unmeshed.
      { id: 'way/mixed-bike-west', roadClass: 'cycleway', width: 3.5,
        points: [[50, 0], [80, 0]], nodeIds: ['mixed-west', 'mixed-fork'] },
      { id: 'way/mixed-bike-east', roadClass: 'cycleway', width: 3.5,
        points: [[80, 0], [110, 0]], nodeIds: ['mixed-fork', 'mixed-east'] },
      { id: 'way/mixed-bike-north', roadClass: 'cycleway', width: 3.5,
        points: [[80, 0], [80, 30]], nodeIds: ['mixed-fork', 'mixed-north'] },
      { id: 'way/veh-terminating-at-fork', roadClass: 'residential', width: 7,
        points: [[80, -30], [80, 0]], nodeIds: ['veh-south', 'mixed-fork'] },

      // At-grade path must not be cut by this unrelated elevated bridge.
      { id: 'way/elevated-bike-overpass', roadClass: 'secondary', width: 9,
        points: [[-25, -25], [25, 25]], nodeIds: ['bridge-south', 'bridge-north'],
        layer: 1, isBridge: true },
    ]);
    const scene = buildGraphRoadScene(data);
    try {
      const { junctionRanges, faceRangesById } = assertRoadGroupGeometryInvariants(scene);
      const stats: GraphRoadRenderStats = scene.roadsGroup.userData.graphRoadStats;
      assert.equal(stats.branchingJunctionCount, 0,
        'Neither cycleway fork may create a vehicular branching junction');
      assert.equal(stats.pathJunctionCount, 2,
        'Pure and cross-tier cycleway forks both require local path-junction solutions');
      const pathPatches = junctionRanges.filter((range) => range.info.id.startsWith('path-junction-'));
      // A junction patch wholly beneath a wider terminating vehicular surface may be
      // intentionally absent after Boolean difference. Test visible geometry and
      // provenance rather than requiring an invisible overlapping patch.
      assert.ok(pathPatches.length >= 1,
        'At least one junction patch must remain visible and inspectable');
      assert.ok(
        [...faceRangesById.values()].some((range) =>
          range.info.sourceFeatureIds.includes('way/mixed-bike-north')
        ),
        'The cycleway must preserve source lineage even when its patch is fully occluded');

      const cyclewayMesh = scene.roadsGroup.children.find((obj) => obj.name === 'Roads_cycleway') as THREE.Mesh;
      assert.ok(cyclewayMesh, 'Expected the green cycleway surface to render');
      const positions = cyclewayMesh.geometry.getAttribute('position');
      const indices = cyclewayMesh.geometry.getIndex();
      const coversPoint = (x: number, z: number): boolean => {
        const triangles = indices ? indices.count / 3 : positions.count / 3;
        for (let face = 0; face < triangles; face++) {
          const ids = [0, 1, 2].map((k) => indices ? indices.getX(face * 3 + k) : face * 3 + k);
          if (ids.some((i) => Math.abs(positions.getY(i) - ELEVATION_POLICY.ROAD_SURFACE) > 0.001)) continue;
          const points = ids.map((i) => [positions.getX(i), positions.getZ(i)] as [number, number]);
          const cross = (a: [number, number], b: [number, number]) =>
            (a[0] - x) * (b[1] - z) - (a[1] - z) * (b[0] - x);
          const ab = cross(points[0], points[1]);
          const bc = cross(points[1], points[2]);
          const ca = cross(points[2], points[0]);
          if ((ab >= -1e-4 && bc >= -1e-4 && ca >= -1e-4) ||
              (ab <= 1e-4 && bc <= 1e-4 && ca <= 1e-4)) return true;
        }
        return false;
      };
      assert.ok(coversPoint(0, 0),
        'The unconnected elevated bridge must not remove the cycleway fork throat');
      assert.ok(coversPoint(80, 5),
        'Cross-tier bicycle arms must connect outside the overlapping vehicular surface');
    } finally {
      scene.dispose();
    }
  });

  it('19. tapers an unequal-width cycleway through-node rather than forming square shoulders', () => {
    const data = createDatasetFromSpecs([
      { id: 'way/width-wide', roadClass: 'cycleway', width: 6,
        points: [[0, -35], [0, 0]], nodeIds: ['width-south', 'width-join'] },
      { id: 'way/width-narrow', roadClass: 'cycleway', width: 2,
        points: [[0, 0], [0, 35]], nodeIds: ['width-join', 'width-north'] },
    ]);
    const scene = buildGraphRoadScene(data);
    try {
      const { junctionRanges } = assertRoadGroupGeometryInvariants(scene);
      const pathPatches = junctionRanges.filter((r) => r.info.id.startsWith('path-junction-'));
      assert.equal(pathPatches.length, 1, 'The width change must be represented by a local path patch');
      assert.deepEqual(
        [...pathPatches[0].info.sourceFeatureIds].sort(),
        ['way/width-narrow', 'way/width-wide'],
        'Width transition must retain both original OSM source feature identities'
      );

      const mesh = scene.roadsGroup.children.find((obj) => obj.name === 'Roads_cycleway') as THREE.Mesh;
      assert.ok(mesh, 'Cycleway geometry must exist');
      const pos = mesh.geometry.getAttribute('position');
      const index = mesh.geometry.getIndex();
      const containsPoint = (x: number, z: number): boolean => {
        const triangleCount = index ? index.count / 3 : pos.count / 3;
        const cross = (a: [number, number], b: [number, number]) =>
          (a[0] - x) * (b[1] - z) - (a[1] - z) * (b[0] - x);
        for (let face = 0; face < triangleCount; face++) {
          const ids = [0, 1, 2].map((k) => index ? index.getX(face * 3 + k) : face * 3 + k);
          if (ids.some((id) => Math.abs(pos.getY(id) - ELEVATION_POLICY.ROAD_SURFACE) > 0.001)) continue;
          const [a, b, c] = ids.map((id) => [pos.getX(id), pos.getZ(id)] as [number, number]);
          const ab = cross(a, b), bc = cross(b, c), ca = cross(c, a);
          if ((ab >= -1e-4 && bc >= -1e-4 && ca >= -1e-4) ||
              (ab <= 1e-4 && bc <= 1e-4 && ca <= 1e-4)) return true;
        }
        return false;
      };

      assert.ok(containsPoint(2.7, -10), 'Wide side must retain its full 6m corridor');
      assert.ok(containsPoint(-2.7, -10), 'Wide side must retain both curbs');
      assert.ok(containsPoint(0.8, 10), 'Narrow side must retain its full 2m corridor');
      assert.ok(containsPoint(-0.8, 10), 'Narrow side must retain both curbs');
      assert.ok(containsPoint(1.5, 0) && containsPoint(-1.5, 0),
        'Midpoint of a 6m-to-2m transition must remain covered');
      assert.ok(!containsPoint(2.6, 0) && !containsPoint(-2.6, 0),
        'Local taper must not preserve the wide road as a square shoulder at the shared node');
    } finally {
      scene.dispose();
    }
  });

  it('20. blends an unequal-width through-road into a connected three-arm cycleway fork', () => {
    const data = createDatasetFromSpecs([
      { id: 'way/fork-wide', roadClass: 'cycleway', width: 6,
        points: [[0, -35], [0, 0]], nodeIds: ['fork-south', 'fork-center'] },
      { id: 'way/fork-narrow', roadClass: 'cycleway', width: 2,
        points: [[0, 0], [0, 35]], nodeIds: ['fork-center', 'fork-north'] },
      { id: 'way/fork-branch', roadClass: 'cycleway', width: 2,
        points: [[0, 0], [30, 0]], nodeIds: ['fork-center', 'fork-east'] },
    ]);
    const scene = buildGraphRoadScene(data);
    try {
      const { junctionRanges } = assertRoadGroupGeometryInvariants(scene);
      const patches = junctionRanges.filter((r) => r.info.id.startsWith('path-junction-'));
      assert.equal(patches.length, 1, 'A three-way cycleway fork needs one connected local patch');
      assert.deepEqual(
        [...patches[0].info.sourceFeatureIds].sort(),
        ['way/fork-branch', 'way/fork-narrow', 'way/fork-wide'],
        'The fork must retain all three OSM source features'
      );
      const mesh = scene.roadsGroup.children.find((obj) => obj.name === 'Roads_cycleway') as THREE.Mesh;
      assert.ok(mesh);
      const pos = mesh.geometry.getAttribute('position');
      const idx = mesh.geometry.getIndex();
      const covers = (x: number, z: number): boolean => {
        const count = idx ? idx.count / 3 : pos.count / 3;
        const cross = (a: [number, number], b: [number, number]) =>
          (a[0] - x) * (b[1] - z) - (a[1] - z) * (b[0] - x);
        for (let face = 0; face < count; face++) {
          const ids = [0, 1, 2].map((k) => idx ? idx.getX(face * 3 + k) : face * 3 + k);
          if (ids.some((id) => Math.abs(pos.getY(id) - ELEVATION_POLICY.ROAD_SURFACE) > 0.001)) continue;
          const [a, b, c] = ids.map((id) => [pos.getX(id), pos.getZ(id)] as [number, number]);
          const ab = cross(a, b), bc = cross(b, c), ca = cross(c, a);
          if ((ab >= -1e-4 && bc >= -1e-4 && ca >= -1e-4) ||
              (ab <= 1e-4 && bc <= 1e-4 && ca <= 1e-4)) return true;
        }
        return false;
      };
      assert.ok(covers(-2.7, -10), 'Wider approach must retain its original width');
      assert.ok(covers(0.8, 10), 'Narrow through-road must retain its original width');
      assert.ok(covers(10, 0), 'The third branch must connect');
      assert.ok(covers(-1.2, 0), 'Taper and fork must cover the common origin');
      assert.ok(!covers(-2.6, 0), 'The wide arm must not create a square shoulder at the fork');
    } finally {
      scene.dispose();
    }
  });

  it('21. preserves smoothly tapered geometry at gentle cycleway bends and same-class vehicular forks', () => {
    const scenarios: Array<{
      label: string;
      type: 'cycleway' | 'residential';
      junctionPrefix: string;
      specs: SyntheticRoadSpec[];
      absentShoulder: [number, number];
      covered: Array<[number, number]>;
    }> = [
      {
        label: '25-degree continuous bicycle bend, 6m to 2m',
        type: 'cycleway',
        junctionPrefix: 'path-junction-',
        specs: [
          { id: 'way/bend-wide', roadClass: 'cycleway', width: 6,
            points: [[0, -35], [0, 0]], nodeIds: ['bend-south', 'bend-center'] },
          { id: 'way/bend-narrow', roadClass: 'cycleway', width: 2,
            points: [[0, 0], [14, 30]], nodeIds: ['bend-center', 'bend-north'] },
        ],
        absentShoulder: [-2.7, 0],
        covered: [[0, 0], [-2.7, -12], [2.7, -12], [4.7, 10]],
      },
      {
        label: 'connected three-arm residential junction with differing through widths',
        type: 'residential',
        junctionPrefix: 'junction-',
        specs: [
          { id: 'way/veh-wide', roadClass: 'residential', width: 6,
            points: [[0, -35], [0, 0]], nodeIds: ['veh-south', 'veh-center'] },
          { id: 'way/veh-narrow', roadClass: 'residential', width: 2,
            points: [[0, 0], [0, 35]], nodeIds: ['veh-center', 'veh-north'] },
          { id: 'way/veh-east', roadClass: 'residential', width: 2,
            points: [[0, 0], [30, 0]], nodeIds: ['veh-center', 'veh-east-end'] },
        ],
        absentShoulder: [-2.7, 0],
        covered: [[0, 0], [-2.7, -12], [0.8, 12], [10, 0]],
      },
    ];

    for (const scenario of scenarios) {
      const scene = buildGraphRoadScene(createDatasetFromSpecs(scenario.specs));
      try {
        const { junctionRanges } = assertRoadGroupGeometryInvariants(scene);
        const patches = junctionRanges.filter((range) =>
          range.info.id.startsWith(scenario.junctionPrefix)
        );
        assert.equal(patches.length, 1, scenario.label + ': expected one local transition patch');
        assert.deepEqual(
          [...patches[0].info.sourceFeatureIds].sort(),
          scenario.specs.map((spec) => spec.id).sort(),
          scenario.label + ': the connection must preserve original OSM provenance'
        );

        const mesh = scene.roadsGroup.children.find((obj) =>
          obj.name === 'Roads_' + scenario.type
        ) as THREE.Mesh;
        assert.ok(mesh, scenario.label + ': expected surface mesh');
        const pos = mesh.geometry.getAttribute('position');
        const idx = mesh.geometry.getIndex();
        const contains = (x: number, z: number): boolean => {
          const n = idx ? idx.count / 3 : pos.count / 3;
          const cross = (a: [number, number], b: [number, number]) =>
            (a[0] - x) * (b[1] - z) - (a[1] - z) * (b[0] - x);
          for (let f = 0; f < n; f++) {
            const ids = [0, 1, 2].map((i) => idx ? idx.getX(f * 3 + i) : f * 3 + i);
            if (ids.some((i) => Math.abs(pos.getY(i) - ELEVATION_POLICY.ROAD_SURFACE) > 0.001)) continue;
            const [a, b, c] = ids.map((i) => [pos.getX(i), pos.getZ(i)] as [number, number]);
            const ab = cross(a, b), bc = cross(b, c), ca = cross(c, a);
            if ((ab >= -1e-4 && bc >= -1e-4 && ca >= -1e-4) ||
                (ab <= 1e-4 && bc <= 1e-4 && ca <= 1e-4)) return true;
          }
          return false;
        };
        for (const [x, z] of scenario.covered) {
          assert.ok(contains(x, z), scenario.label + ': missing source-width road surface at ' + x + ',' + z);
        }
        assert.ok(!contains(...scenario.absentShoulder),
          scenario.label + ': wide road must transition instead of forming an abrupt shoulder');
      } finally {
        scene.dispose();
      }
    }
  });

  it('22. covers the source-derived acute Prins Hendrikkade cycleway fork beyond its overlapping branches', () => {
    // Metre-projected, translated coordinates from the Amsterdam Centraal GeoJSON
    // around OSM node/6387677253. The two outgoing 2.4m cycleways are only
    // ~17 degrees apart, so their physical footprints overlap for ~8m.
    // An arbitrary width*1.65 (~4m) junction cap leaves an exposed square end.
    const scene = buildGraphRoadScene(createDatasetFromSpecs([
      { id: 'way/682105412', roadClass: 'cycleway', width: 2.4, oneway: true,
        points: [[18.410, -17.616], [11.393, -9.023], [8.034, -6.196], [0, 0]],
        nodeIds: ['7412318359', '6937400522', '9768030085', '6387677253'] },
      { id: 'way/682105414', roadClass: 'cycleway', width: 2.4,
        points: [[0, 0], [-12.417, 11.656], [-17.381, 16.630], [-29.864, 28.586]],
        nodeIds: ['6387677253', '12568540632', '12715398409', '9768030061'] },
      { id: 'way/1068343582', roadClass: 'cycleway', width: 2.4, oneway: true,
        points: [[0, 0], [14.973, -21.309], [20.403, -28.945], [22.534, -32.097]],
        nodeIds: ['6387677253', '7412318360', '7283039106', '6937400524'] },
    ]));
    try {
      const { faceRangesById, junctionRanges } = assertRoadGroupGeometryInvariants(scene);
      assert.equal(junctionRanges.filter((r) => r.info.id.startsWith('path-junction-')).length, 0,
        'The acute equal-width fork must not introduce a cut-and-patch shoulder');
      for (const wayId of ['way/682105412', 'way/682105414', 'way/1068343582']) {
        assert.ok([...faceRangesById.values()].some((range) =>
          range.info.sourceFeatureIds.includes(wayId)
        ), 'Each original cycleway must retain inspectable geometry: ' + wayId);
      }
    } finally {
      scene.dispose();
    }
  });

  it('23. preserves the 2.13m Martelaarsgracht connector at its real cycleway crossing', () => {
    // Real GeoJSON way/326971927 is 2.13m long. It joins tertiary ways at
    // OSM nodes 2316882945 and 543807770, the latter also shared by two
    // cycleways. Keep complete provenance and avoid collapsed/overlapping faces.
    const scene = buildGraphRoadScene(createDatasetFromSpecs([
      { id: 'way/1358135035', roadClass: 'tertiary', width: 3.844, oneway: true,
        points: [[6.214, 18.662], [6.674, 12.239], [5.855, 7.86], [3.874, 3.924], [1.691, 1.302]],
        nodeIds: ['5791719653', '12568540650', '12568540649', '12568540648', '2316882945'] },
      { id: 'way/326971927', roadClass: 'tertiary', width: 3.844, oneway: true,
        points: [[1.691, 1.302], [0, 0]],
        nodeIds: ['2316882945', '543807770'] },
      { id: 'way/180236785', roadClass: 'tertiary', width: 3.844, oneway: true,
        points: [[0, 0], [-5.460, -2.789], [-31.224, -11.416], [-71.039, -25.567]],
        nodeIds: ['543807770', '3192274051', '9986193291', '3177828067'] },
      { id: 'way/740992986', roadClass: 'cycleway', width: 3.5,
        points: [[-4.809, 16.934], [-3.018, 11.870], [-1.716, 6.053], [0, 0]],
        nodeIds: ['801819126', '6937400532', '6961595180', '543807770'] },
      { id: 'way/741023803', roadClass: 'cycleway', width: 3.5,
        points: [[0, 0], [0.964, -2.377], [1.379, -3.436], [1.534, -3.682],
          [2.100, -4.598], [2.572, -5.258], [4.048, -7.560], [4.736, -8.600], [7.675, -13.015]],
        nodeIds: ['543807770', '11392634782', '9959600356', '9959600353',
          '6987414442', '9959600352', '6987414441', '6961595178', '3192273979'] },
    ], { minX: -90, maxX: 35, minZ: -45, maxZ: 45 }));
    try {
      const { faceRangesById } = assertRoadGroupGeometryInvariants(scene);
      assert.ok([...faceRangesById.values()].some((range) =>
        range.info.sourceFeatureIds.includes('way/326971927')
      ), 'The real 2.13m connector must remain inspectable after simplification');
    } finally {
      scene.dispose();
    }
  });

  it('24. loads the isolated real Prins Hendrikkade E2 dev fixture with explicit three-way connectivity and original widths', () => {
    const sourceIds = ['way/682105412', 'way/682105414', 'way/1068343582'];
    const provider = new LocalGeoJsonProvider();
    const data = provider.parseGeoJson(
      prinsHendrikkadeForkFixture,
      'M2.3-E2 Junction Lab · Prins Hendrikkade South',
      [4.8979247, 52.3773823],
      60
    );
    const rawParts = data.topologySource?.roadParts ?? [];
    assert.deepEqual(
      [...new Set(rawParts.map((part) => part.sourceFeatureId))].sort(),
      sourceIds.slice().sort(),
      'The fixture must include exactly the three source OSM cycleways'
    );
    assert.ok(
      rawParts.every((part) =>
        part.rawOsmNodeIds.includes('6387677253') &&
        part.points.length === part.rawOsmNodeIds.length
      ),
      'All three ways must retain verified source node/6387677253'
    );

    const preview = prepareInfrastructureRenderPreview(data, {
      roads: 'graph',
      railways: 'legacy',
    });
    assert.ok(preview.graph, 'The graph must be constructed for the junction lab');
    const junction = [...preview.graph.roads.nodes.values()].find(
      (node) => node.rawOsmNodeId === '6387677253'
    );
    assert.ok(junction, 'The shared explicit OSM junction node must survive graph simplification');
    assert.equal(junction.degree, 3, 'The node must have three incident half-edges');
    const widths = junction.incidentEdgeIds
      .map((id) => preview.graph!.roads.edges.get(id)?.width)
      .filter((width): width is number => typeof width === 'number')
      .sort((a, b) => a - b);
    assert.equal(widths.length, 3);
    assert.ok(widths.every((width) => Math.abs(width - 2.4) < 1e-3),
      'The southern acute OSM fork has three default-width 2.4m cycleways');

    const scene = new GeometryBuilder({
      infrastructureRenderOptions: { roads: 'graph', railways: 'legacy' },
      infrastructureRenderPreview: preview,
    }).buildScene(data, MAP_THEMES.tactical);
    try {
      assertRoadGroupGeometryInvariants(scene);
      const stats = scene.roadsGroup.userData.graphRoadStats as GraphRoadRenderStats;
      assert.equal(stats.pathJunctionCount, 0,
        'The acute equal-width cycleway fork must use its complete ribbons without a junction patch');
    } finally {
      scene.dispose();
    }
  });

  it('25. matches the real acute cycleway fork surface to the union of its full-width source ribbons', () => {
    const data = new LocalGeoJsonProvider().parseGeoJson(
      prinsHendrikkadeForkFixture,
      'M2.3-E2 Junction Lab · Prins Hendrikkade South',
      [4.8979247, 52.3773823],
      60
    );
    const preview = prepareInfrastructureRenderPreview(data, {
      roads: 'graph', railways: 'legacy',
    });
    assert.ok(preview.graph);
    const node = [...preview.graph.roads.nodes.values()].find((n) =>
      n.rawOsmNodeId === '6387677253'
    );
    assert.ok(node);
    const sourceRings = node.incidentEdgeIds.map((id) => {
      const edge = preview.graph!.roads.edges.get(id);
      assert.ok(edge);
      return buildRoadRibbonOutlineRing(
        edge.points.map((p) => [p[0], p[1]] as [number, number]),
        edge.width
      );
    });
    assert.ok(sourceRings.every((ring) => ring && ring.length > 0));
    const expected = polygonClipping.union(
      sourceRings[0] as unknown as polygonClipping.Geom,
      ...(sourceRings.slice(1) as unknown as polygonClipping.Geom[])
    ) as unknown as MultiPolygonCoords;

    const scene = new GeometryBuilder({
      infrastructureRenderOptions: { roads: 'graph', railways: 'legacy' },
      infrastructureRenderPreview: preview,
    }).buildScene(data, MAP_THEMES.tactical);
    try {
      assertRoadGroupGeometryInvariants(scene);
      const mesh = scene.roadsGroup.children.find((obj) =>
        obj.name === 'Roads_cycleway'
      ) as THREE.Mesh;
      assert.ok(mesh, 'The actual graph road renderer must emit the three cycleways');
      const pos = mesh.geometry.getAttribute('position');
      const idx = mesh.geometry.getIndex();

      // Use the exact *emitted* triangle footprints, not a sparse sampling grid.
      // A narrow square shoulder is visually obvious at 8px/m but might affect
      // only 1-2 samples in the former 0.48m lattice.
      const renderedTriangles: MultiPolygonCoords = [];
      for (let f = 0; f < (idx ? idx.count / 3 : pos.count / 3); f++) {
        const ids = [0, 1, 2].map((i) => idx ? idx.getX(f * 3 + i) : f * 3 + i);
        if (ids.some((id) => Math.abs(pos.getY(id) - ELEVATION_POLICY.ROAD_SURFACE) > 0.001)) continue;
        const vertices = ids.map((id) =>
          [pos.getX(id), pos.getZ(id)] as [number, number]
        );
        const twiceArea = Math.abs(
          (vertices[1][0] - vertices[0][0]) * (vertices[2][1] - vertices[0][1]) -
          (vertices[1][1] - vertices[0][1]) * (vertices[2][0] - vertices[0][0])
        );
        if (twiceArea < 1e-8) continue;
        renderedTriangles.push([[
          vertices[0], vertices[1], vertices[2], vertices[0],
        ]]);
      }
      assert.ok(renderedTriangles.length > 0, 'Expected cycleway triangles to compare');

      const renderedUnion = polygonClipping.union(
        renderedTriangles[0] as unknown as polygonClipping.Geom,
        ...(renderedTriangles.slice(1) as unknown as polygonClipping.Geom[])
      ) as unknown as MultiPolygonCoords;

      // The geometry can extend beyond this fixture. Restrict the comparison to
      // the first 12m around the explicit shared OSM junction, where the square
      // shoulder actually occurs; ignore remote caps and map boundary clipping.
      const cx = node.x, cz = node.z;
      const localBounds: MultiPolygonCoords = [[[
        [cx - 12, cz - 12], [cx + 12, cz - 12],
        [cx + 12, cz + 12], [cx - 12, cz + 12], [cx - 12, cz - 12],
      ]]];
      const expectedLocal = polygonClipping.intersection(
        expected as unknown as polygonClipping.Geom,
        localBounds as unknown as polygonClipping.Geom
      ) as unknown as MultiPolygonCoords;
      const renderedLocal = polygonClipping.intersection(
        renderedUnion as unknown as polygonClipping.Geom,
        localBounds as unknown as polygonClipping.Geom
      ) as unknown as MultiPolygonCoords;
      const missing = polygonClipping.difference(
        expectedLocal as unknown as polygonClipping.Geom,
        renderedLocal as unknown as polygonClipping.Geom
      ) as unknown as MultiPolygonCoords;
      const extra = polygonClipping.difference(
        renderedLocal as unknown as polygonClipping.Geom,
        expectedLocal as unknown as polygonClipping.Geom
      ) as unknown as MultiPolygonCoords;

      const missingSqm = computeMultiPolygonArea(missing);
      const extraSqm = computeMultiPolygonArea(extra);
      const extent = (multi: MultiPolygonCoords) => {
        const vertices = multi.flatMap((polygon) => polygon.flat());
        if (vertices.length === 0) return null;
        return {
          minX: Math.min(...vertices.map((v) => v[0])),
          minZ: Math.min(...vertices.map((v) => v[1])),
          maxX: Math.max(...vertices.map((v) => v[0])),
          maxZ: Math.max(...vertices.map((v) => v[1])),
        };
      };
      console.log('[E2 Prins southern fork exact surface delta]', JSON.stringify({
        nodeId: node.rawOsmNodeId,
        expectedSqm: computeMultiPolygonArea(expectedLocal),
        renderedSqm: computeMultiPolygonArea(renderedLocal),
        missingSqm, extraSqm,
        missingExtent: extent(missing),
        extraExtent: extent(extra),
        renderedTriangles: renderedTriangles.length,
      }));
      // A 0.03m² tolerance absorbs floating-point triangulation jitter without
      // silently accepting the centimetre-to-metre-scale rectangular shoulders
      // that the old sample-count test could miss.
      assert.ok(missingSqm <= 0.03 && extraSqm <= 0.03,
        'Rendered fork differs from the union of its source-width ribbons: ' +
        JSON.stringify({ missingSqm, extraSqm, missingExtent: extent(missing), extraExtent: extent(extra) }));
    } finally {
      scene.dispose();
    }
  });

  it('26. infers consistent physical widths for one-way versus bidirectional non-vehicular ways and comparable motor-vehicle segments without explicit width tags', () => {
    const provider = new LocalGeoJsonProvider();

    // 1. Verify Prins Hendrikkade southern cycleway fork (two oneway=yes ways + one bidirectional way)
    const prinsData = provider.parseGeoJson(
      prinsHendrikkadeForkFixture,
      'Prins Hendrikkade Width Consistency',
      [4.8979247, 52.3773823],
      60
    );
    assert.equal(prinsData.roads.length, 3);
    for (const r of prinsData.roads) {
      assert.equal(r.width, 2.4, `Expected mapData.roads[${r.id}] width 2.4m, got ${r.width}`);
    }
    for (const part of prinsData.topologySource?.roadParts ?? []) {
      assert.equal(part.width, 2.4, `Expected roadPart[${part.id}] width 2.4m, got ${part.width}`);
    }

    // 2. Verify all non-vehicular classes, service ways, and *_link classes receive identical widths
    // regardless of oneway=yes, oneway=-1, oneway=1, oneway=true, oneway=reverse, oneway=no, omitted oneway, or junction=roundabout.
    const directionInvariantCases: Array<{
      highway: string;
      expectedClass: RoadClass;
      expectedWidth: number;
      extraProps?: Record<string, string>;
    }> = [
      { highway: 'cycleway', expectedClass: 'cycleway', expectedWidth: ROAD_CLASS_WIDTHS.cycleway },
      { highway: 'footway', expectedClass: 'footway', expectedWidth: ROAD_CLASS_WIDTHS.footway },
      { highway: 'path', expectedClass: 'path', expectedWidth: ROAD_CLASS_WIDTHS.path },
      {
        highway: 'path',
        expectedClass: 'path',
        expectedWidth: ROAD_CLASS_WIDTHS.path,
        extraProps: { bicycle: 'yes' },
      },
      {
        highway: 'path',
        expectedClass: 'cycleway',
        expectedWidth: ROAD_CLASS_WIDTHS.cycleway,
        extraProps: { bicycle: 'designated' },
      },
      {
        highway: 'path',
        expectedClass: 'bridleway',
        expectedWidth: ROAD_CLASS_WIDTHS.bridleway,
        extraProps: { horse: 'designated' },
      },
      { highway: 'steps', expectedClass: 'steps', expectedWidth: ROAD_CLASS_WIDTHS.steps },
      { highway: 'bridleway', expectedClass: 'bridleway', expectedWidth: ROAD_CLASS_WIDTHS.bridleway },
      { highway: 'track', expectedClass: 'track', expectedWidth: ROAD_CLASS_WIDTHS.track },
      { highway: 'pedestrian', expectedClass: 'pedestrian', expectedWidth: ROAD_CLASS_WIDTHS.pedestrian },
      { highway: 'platform', expectedClass: 'platform', expectedWidth: ROAD_CLASS_WIDTHS.platform },
      { highway: 'service', expectedClass: 'service', expectedWidth: ROAD_CLASS_WIDTHS.service },
      {
        highway: 'service',
        expectedClass: 'service',
        expectedWidth: 3.0,
        extraProps: { service: 'parking_aisle' },
      },
      {
        highway: 'service',
        expectedClass: 'service',
        expectedWidth: 3.0,
        extraProps: { service: 'driveway' },
      },
      { highway: 'motorway_link', expectedClass: 'motorway', expectedWidth: 5.0 },
      { highway: 'primary_link', expectedClass: 'primary', expectedWidth: 4.675 },
      { highway: 'secondary_link', expectedClass: 'secondary', expectedWidth: 3.96 },
      { highway: 'tertiary_link', expectedClass: 'tertiary', expectedWidth: 3.6 },
    ];

    const directionVariants: Array<Record<string, string>> = [
      {},
      { oneway: 'no' },
      { oneway: 'yes' },
      { oneway: '1' },
      { oneway: 'true' },
      { oneway: '-1' },
      { oneway: 'reverse' },
      { junction: 'roundabout' },
    ];

    const motorVehicleClasses: Array<{
      highway: string;
      expectedClass: RoadClass;
      twoWayWidth: number;
      oneWayWidth: number;
    }> = [
      {
        highway: 'living_street',
        expectedClass: 'living_street',
        twoWayWidth: ROAD_CLASS_WIDTHS.living_street,
        oneWayWidth: Math.max(ROAD_CLASS_WIDTHS.living_street * 0.62, 3.6),
      },
      {
        highway: 'unclassified',
        expectedClass: 'unclassified',
        twoWayWidth: ROAD_CLASS_WIDTHS.unclassified,
        oneWayWidth: Math.max(ROAD_CLASS_WIDTHS.unclassified * 0.62, 3.6),
      },
      {
        highway: 'residential',
        expectedClass: 'residential',
        twoWayWidth: ROAD_CLASS_WIDTHS.residential,
        oneWayWidth: Math.max(ROAD_CLASS_WIDTHS.residential * 0.62, 3.6),
      },
      {
        highway: 'tertiary',
        expectedClass: 'tertiary',
        twoWayWidth: ROAD_CLASS_WIDTHS.tertiary,
        oneWayWidth: Math.max(ROAD_CLASS_WIDTHS.tertiary * 0.62, 3.6),
      },
      {
        highway: 'secondary',
        expectedClass: 'secondary',
        twoWayWidth: ROAD_CLASS_WIDTHS.secondary,
        oneWayWidth: Math.max(ROAD_CLASS_WIDTHS.secondary * 0.62, 3.6),
      },
      {
        highway: 'primary',
        expectedClass: 'primary',
        twoWayWidth: ROAD_CLASS_WIDTHS.primary,
        oneWayWidth: Math.max(ROAD_CLASS_WIDTHS.primary * 0.62, 3.6),
      },
      {
        highway: 'trunk',
        expectedClass: 'trunk',
        twoWayWidth: ROAD_CLASS_WIDTHS.trunk,
        oneWayWidth: Math.max(ROAD_CLASS_WIDTHS.trunk * 0.62, 3.6),
      },
      {
        highway: 'motorway',
        expectedClass: 'motorway',
        twoWayWidth: ROAD_CLASS_WIDTHS.motorway,
        oneWayWidth: Math.max(ROAD_CLASS_WIDTHS.motorway * 0.62, 3.6),
      },
    ];

    const features: any[] = [];
    let idx = 0;
    for (const c of directionInvariantCases) {
      for (const dirProps of directionVariants) {
        idx++;
        const latOffset = idx * 0.0001;
        features.push({
          type: 'Feature',
          id: `way/dir-test-${idx}`,
          properties: {
            id: `way/dir-test-${idx}`,
            highway: c.highway,
            ...(c.extraProps ?? {}),
            ...dirProps,
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [4.9000, 52.3700 + latOffset],
              [4.9005, 52.3700 + latOffset],
            ],
          },
        });
      }
    }

    for (const m of motorVehicleClasses) {
      for (const dirProps of directionVariants) {
        idx++;
        const latOffset = idx * 0.0001;
        features.push({
          type: 'Feature',
          id: `way/dir-test-${idx}`,
          properties: {
            id: `way/dir-test-${idx}`,
            highway: m.highway,
            ...dirProps,
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [4.9000, 52.3700 + latOffset],
              [4.9005, 52.3700 + latOffset],
            ],
          },
        });
      }
    }

    const parsed = provider.parseGeoJson(
      { type: 'FeatureCollection', features },
      'Directionality Invariance Suite'
    );
    const partsById = new Map(
      (parsed.topologySource?.roadParts ?? []).map((p) => [p.sourceFeatureId, p])
    );
    const roadsById = new Map(parsed.roads.map((r) => [r.sourceFeatureId, r]));

    let checkIdx = 0;
    for (const c of directionInvariantCases) {
      for (const dirProps of directionVariants) {
        checkIdx++;
        const fid = `way/dir-test-${checkIdx}`;
        const part = partsById.get(fid);
        const road = roadsById.get(fid);
        assert.ok(part, `Expected topology roadPart for ${fid}`);
        assert.ok(road, `Expected legacy road for ${fid}`);
        assert.equal(part.roadClass, c.expectedClass, `${fid} roadClass mismatch`);
        assert.ok(
          Math.abs(part.width - c.expectedWidth) < 1e-6,
          `Expected ${fid} (${c.highway} ${JSON.stringify(dirProps)}) width ${c.expectedWidth}m, got ${part.width}m`
        );
        assert.equal(road.width, part.width, `${fid} mapData.roads.width must match roadPart.width`);
      }
    }

    for (const m of motorVehicleClasses) {
      for (const dirProps of directionVariants) {
        checkIdx++;
        const fid = `way/dir-test-${checkIdx}`;
        const part = partsById.get(fid);
        const road = roadsById.get(fid);
        assert.ok(part, `Expected topology roadPart for ${fid}`);
        assert.ok(road, `Expected legacy road for ${fid}`);
        assert.equal(part.roadClass, m.expectedClass, `${fid} roadClass mismatch`);
        const isOneWayVariant =
          dirProps.oneway === 'yes' ||
          dirProps.oneway === '1' ||
          dirProps.oneway === 'true' ||
          dirProps.oneway === '-1' ||
          dirProps.oneway === 'reverse' ||
          dirProps.junction === 'roundabout';
        const expectedW = isOneWayVariant ? m.oneWayWidth : m.twoWayWidth;
        assert.ok(
          Math.abs(part.width - expectedW) < 1e-6,
          `Expected ${fid} (${m.highway} ${JSON.stringify(dirProps)}) width ${expectedW}m, got ${part.width}m`
        );
        assert.equal(road.width, part.width, `${fid} mapData.roads.width must match roadPart.width`);
      }
    }

    // 3. Verify that non-vehicular paths/footways transitioning from oneway=yes to bidirectional at a shared
    // degree-2 node maintain equal width (2.2m for footway, 1.8m for path) and use continuous shared portals
    // rather than an artificial 3.6m width discontinuity.
    const continuityGeoJson = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'way/path-oneway',
          properties: {
            id: 'way/path-oneway',
            highway: 'path',
            bicycle: 'yes',
            oneway: 'yes',
            nodes: ['n1', 'n2'],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [4.8995, 52.3780],
              [4.9000, 52.3780],
            ],
          },
        },
        {
          type: 'Feature',
          id: 'way/path-twoway',
          properties: {
            id: 'way/path-twoway',
            highway: 'path',
            bicycle: 'yes',
            nodes: ['n2', 'n3'],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [4.9000, 52.3780],
              [4.9005, 52.3780],
            ],
          },
        },
        {
          type: 'Feature',
          id: 'way/foot-oneway',
          properties: {
            id: 'way/foot-oneway',
            highway: 'footway',
            oneway: 'yes',
            nodes: ['f1', 'f2'],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [4.8995, 52.3783],
              [4.9000, 52.3783],
            ],
          },
        },
        {
          type: 'Feature',
          id: 'way/foot-twoway',
          properties: {
            id: 'way/foot-twoway',
            highway: 'footway',
            nodes: ['f2', 'f3'],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [4.9000, 52.3783],
              [4.9005, 52.3783],
            ],
          },
        },
      ],
    };

    const contData = provider.parseGeoJson(
      continuityGeoJson,
      'One-Way To Two-Way Continuity',
      [4.9000, 52.37815]
    );
    const contScene = buildGraphRoadScene(contData);
    try {
      const { junctionRanges } = assertRoadGroupGeometryInvariants(contScene);
      const stats = contScene.roadsGroup.userData.graphRoadStats as GraphRoadRenderStats;
      assert.equal(
        junctionRanges.length,
        0,
        'Equal-width one-way to two-way path/footway transitions must not emit artificial unequal-width junction patches'
      );
      assert.equal(
        stats.degree2ContinuityJoinCount,
        2,
        'Both path (1.8m) and footway (2.2m) degree-2 nodes must use shared continuity portals'
      );
    } finally {
      contScene.dispose();
    }
  });

  it('27. enforces explicit width=* tag precedence over inferred defaults across standard roads, sliproad links, parking aisles/driveways, and catalogue defaultWidth subtypes', () => {
    const provider = new LocalGeoJsonProvider();

    const explicitCases: Array<{
      id: string;
      props: Record<string, any>;
      expectedClass: RoadClass;
      expectedWidth: number;
    }> = [
      // Standard road & cycleway explicit overrides
      {
        id: 'way/exp-cycleway',
        props: { highway: 'cycleway', oneway: 'yes', width: '3.5' },
        expectedClass: 'cycleway',
        expectedWidth: 3.5,
      },
      {
        id: 'way/exp-residential-unit',
        props: { highway: 'residential', width: '7.2 m' },
        expectedClass: 'residential',
        expectedWidth: 7.2,
      },
      // Sliproad *_link explicit overrides (previously bypassed by early return)
      {
        id: 'way/exp-motorway-link',
        props: { highway: 'motorway_link', oneway: 'yes', width: '7.5' },
        expectedClass: 'motorway',
        expectedWidth: 7.5,
      },
      {
        id: 'way/exp-primary-link',
        props: { highway: 'primary_link', width: '6.4' },
        expectedClass: 'primary',
        expectedWidth: 6.4,
      },
      // Subordinated service way explicit overrides (previously bypassed by early return)
      {
        id: 'way/exp-parking-aisle',
        props: { highway: 'service', service: 'parking_aisle', width: '4.4' },
        expectedClass: 'service',
        expectedWidth: 4.4,
      },
      {
        id: 'way/exp-driveway',
        props: { highway: 'service', service: 'Driveway', width: '2.6' },
        expectedClass: 'service',
        expectedWidth: 2.6,
      },
      // Catalogue defaultWidth road-category subtypes (previously bypassed getRoadWidth via classification.defaultWidth || ...)
      {
        id: 'way/exp-runway',
        props: { aeroway: 'runway', width: '45' },
        expectedClass: 'runway',
        expectedWidth: 45.0,
      },
      {
        id: 'way/exp-taxiway',
        props: { aeroway: 'taxiway', width: '18.5' },
        expectedClass: 'taxiway',
        expectedWidth: 18.5,
      },
      {
        id: 'way/exp-pier',
        props: { man_made: 'pier', width: '6.0' },
        expectedClass: 'pier',
        expectedWidth: 6.0,
      },
      {
        id: 'way/exp-railway-platform',
        props: { railway: 'platform', width: '3.1' },
        expectedClass: 'platform',
        expectedWidth: 3.1,
      },
      {
        id: 'way/exp-leisure-track',
        props: { leisure: 'track', width: '6.2' },
        expectedClass: 'track',
        expectedWidth: 6.2,
      },
      {
        id: 'way/exp-ferry',
        props: { route: 'ferry', width: '5.5' },
        expectedClass: 'path',
        expectedWidth: 5.5,
      },
      {
        id: 'way/exp-cutline',
        props: { man_made: 'cutline', width: '4.8' },
        expectedClass: 'path',
        expectedWidth: 4.8,
      },
      // Invalid width strings must fall back cleanly to their respective subtype/class defaults
      {
        id: 'way/fallback-zero',
        props: { highway: 'residential', width: '0' },
        expectedClass: 'residential',
        expectedWidth: 5.4,
      },
      {
        id: 'way/fallback-negative',
        props: { highway: 'service', service: 'driveway', width: '-3.5' },
        expectedClass: 'service',
        expectedWidth: 3.0,
      },
      {
        id: 'way/fallback-nan',
        props: { highway: 'motorway_link', width: 'unknown' },
        expectedClass: 'motorway',
        expectedWidth: 5.0,
      },
      {
        id: 'way/fallback-infinity',
        props: { leisure: 'track', width: 'Infinity' },
        expectedClass: 'track',
        expectedWidth: 4.0,
      },
    ];

    const features = explicitCases.map((c, i) => ({
      type: 'Feature',
      id: c.id,
      properties: {
        id: c.id,
        ...c.props,
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [4.9000, 52.3700 + i * 0.0002],
          [4.9006, 52.3700 + i * 0.0002],
        ],
      },
    }));

    const data = provider.parseGeoJson(
      { type: 'FeatureCollection', features },
      'Explicit Width Precedence Suite'
    );
    const preview = prepareInfrastructureRenderPreview(data, {
      roads: 'graph',
      railways: 'legacy',
    });
    assert.ok(preview.graph);
    assert.ok(preview.descriptors);
    assert.equal(preview.validation?.isValid, true);

    const roadById = new Map(data.roads.map((r) => [r.sourceFeatureId, r]));
    const partById = new Map(
      (data.topologySource?.roadParts ?? []).map((p) => [p.sourceFeatureId, p])
    );
    const graphEdgeBySourceId = new Map(
      [...preview.graph.roads.edges.values()].map((e) => [e.provenance.sourceFeatureIds[0], e])
    );
    const descEdgeBySourceId = new Map(
      preview.descriptors.roadEdges.map((d) => [d.sourceFeatureId, d])
    );

    for (const c of explicitCases) {
      const road = roadById.get(c.id);
      const part = partById.get(c.id);
      const gEdge = graphEdgeBySourceId.get(c.id);
      const dEdge = descEdgeBySourceId.get(c.id);
      assert.ok(road && part && gEdge && dEdge, `Missing pipeline record for ${c.id}`);
      assert.equal(road.roadClass, c.expectedClass, `${c.id} roadClass`);
      assert.ok(
        Math.abs(road.width - c.expectedWidth) < 1e-6,
        `${c.id} mapData.roads width expected ${c.expectedWidth}, got ${road.width}`
      );
      assert.equal(part.width, road.width, `${c.id} topologySource.roadParts width mismatch`);
      assert.equal(gEdge.width, road.width, `${c.id} RoadEdge.width mismatch`);
      assert.equal(dEdge.width, road.width, `${c.id} RoadEdgeRenderDescriptor.width mismatch`);
    }

    const scene = new GeometryBuilder({
      infrastructureRenderOptions: { roads: 'graph', railways: 'legacy' },
      infrastructureRenderPreview: preview,
    }).buildScene(data, MAP_THEMES.tactical);
    try {
      const { faceRangesById } = assertRoadGroupGeometryInvariants(scene);
      for (const c of explicitCases) {
        const range = [...faceRangesById.values()].find(
          (r) => r.info.sourceFeatureId === c.id
        );
        assert.ok(range, `Expected rendered faceRange for ${c.id}`);
        assert.equal(
          range.info.width,
          Number(c.expectedWidth.toFixed(1)),
          `Expected inspectable width ${Number(c.expectedWidth.toFixed(1))} for ${c.id}`
        );
      }
    } finally {
      scene.dispose();
    }
  });

  it('28. preserves legitimate width differences and propagates exact scaled widths through graph edges, descriptors, and rendered 3D ribbons', () => {
    const provider = new LocalGeoJsonProvider();

    // Two connected cycleways along Z=0 (west -> center at 4.0m explicit width, center -> east at 2.4m default width)
    // plus an isolated primary_link (4.675m) vs primary (8.5m) vs parking_aisle (3.0m)
    const geojson = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'way/cyc-wide-explicit',
          properties: {
            id: 'way/cyc-wide-explicit',
            highway: 'cycleway',
            width: '4.0',
            nodes: ['c1', 'c2'],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [4.8995, 52.3780],
              [4.9000, 52.3780],
            ],
          },
        },
        {
          type: 'Feature',
          id: 'way/cyc-narrow-default',
          properties: {
            id: 'way/cyc-narrow-default',
            highway: 'cycleway',
            nodes: ['c2', 'c3'],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [4.9000, 52.3780],
              [4.9005, 52.3780],
            ],
          },
        },
      ],
    };

    const data = provider.parseGeoJson(geojson, 'Legitimate Width Difference Suite', [4.9000, 52.3780]);
    const preview = prepareInfrastructureRenderPreview(data, {
      roads: 'graph',
      railways: 'legacy',
    });
    assert.ok(preview.graph);
    assert.ok(preview.descriptors);

    // 1. Degree-2 simplification must be blocked at node c2 because 4.0m !== 2.4m
    assert.equal(
      preview.graph.roads.edges.size,
      2,
      'Genuine width difference (4.0m vs 2.4m) must block degree-2 edge contraction'
    );
    const sharedNode = [...preview.graph.roads.nodes.values()].find(
      (n) => n.rawOsmNodeId === 'c2'
    );
    assert.ok(sharedNode, 'Shared node c2 must be retained');
    assert.ok(
      sharedNode.roles.includes('attribute_break'),
      'Shared node c2 must be marked as an attribute_break'
    );

    const wideDesc = preview.descriptors.roadEdges.find(
      (e) => e.sourceFeatureId === 'way/cyc-wide-explicit'
    );
    const narrowDesc = preview.descriptors.roadEdges.find(
      (e) => e.sourceFeatureId === 'way/cyc-narrow-default'
    );
    assert.ok(wideDesc && narrowDesc);
    assert.equal(wideDesc.width, 4.0);
    assert.equal(narrowDesc.width, 2.4);

    // 2. Render with roadWidthMultiplier = 1.5 -> wide ribbon must span 6.0m (±3.0m in Z),
    // narrow ribbon must span 3.6m (±1.8m in Z), with a local transition patch at c2.
    const multiplier = 1.5;
    const scene = new GeometryBuilder({
      roadWidthMultiplier: multiplier,
      infrastructureRenderOptions: { roads: 'graph', railways: 'legacy' },
      infrastructureRenderPreview: preview,
    }).buildScene(data, MAP_THEMES.tactical);

    try {
      const { faceRangesById, junctionRanges } = assertRoadGroupGeometryInvariants(scene);
      assert.equal(
        junctionRanges.length,
        1,
        'Genuine unequal-width through-node must emit 1 local transition patch'
      );

      const wideRange = [...faceRangesById.values()].find(
        (r) =>
          r.info.sourceFeatureId === 'way/cyc-wide-explicit' &&
          !r.info.id.startsWith('path-junction-')
      );
      const narrowRange = [...faceRangesById.values()].find(
        (r) =>
          r.info.sourceFeatureId === 'way/cyc-narrow-default' &&
          !r.info.id.startsWith('path-junction-')
      );
      assert.ok(wideRange && narrowRange);
      assert.equal(wideRange.info.width, 6.0, 'Scaled wide cycleway inspectable width must be 6.0m');
      assert.equal(narrowRange.info.width, 3.6, 'Scaled narrow cycleway inspectable width must be 3.6m');

      const cycMesh = scene.roadsGroup.children.find(
        (c) => c.name === 'Roads_cycleway'
      ) as THREE.Mesh;
      assert.ok(cycMesh);
      const pos = cycMesh.geometry.attributes.position;
      const idx = cycMesh.geometry.index!;

      const spanZForRange = (range: FaceFeatureRange): number => {
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (let f = range.startFace; f < range.endFace; f++) {
          for (let k = 0; k < 3; k++) {
            const vi = idx.getX(f * 3 + k);
            const z = pos.getZ(vi);
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
          }
        }
        return maxZ - minZ;
      };

      const wideSpanZ = spanZForRange(wideRange);
      const narrowSpanZ = spanZForRange(narrowRange);
      assert.ok(
        Math.abs(wideSpanZ - 6.0) < 0.05,
        `Expected rendered wide ribbon Z-span ~6.0m, got ${wideSpanZ.toFixed(3)}m`
      );
      assert.ok(
        Math.abs(narrowSpanZ - 3.6) < 0.05,
        `Expected rendered narrow ribbon Z-span ~3.6m, got ${narrowSpanZ.toFixed(3)}m`
      );
    } finally {
      scene.dispose();
    }
  });

  it('29. softly joins the outer shoulders of the real Industriestraat 3- and 4-arm split junctions', () => {
    // Metric projection of the original OSM source centerlines in the second
    // Hengelo issue-report export, anchored at node/45928009. This retains
    // each explicit OSM node identity and both independently tagged widths.
    const specs: SyntheticRoadSpec[] = [
      { id: 'way/230163945', roadClass: 'secondary', width: 7.2, oneway: false,
        points: [[0, 0], [28.808, 33.630]],
        nodeIds: ['45928009', '45929045'] },
      { id: 'way/532064931', roadClass: 'secondary', width: 4.464, oneway: true,
        points: [[-9.682, -14.204], [-3.291, -6.212], [0, 0]],
        nodeIds: ['2386918158', '2386918165', '45928009'] },
      { id: 'way/230163947', roadClass: 'secondary', width: 4.464, oneway: true,
        points: [[0, 0], [-3.986, -2.594], [-8.020, -4.842]],
        nodeIds: ['45928009', '2386918164', '2386918160'] },
      { id: 'way/6671227', roadClass: 'secondary', width: 4.464, oneway: true,
        points: [[28.808, 33.630], [34.899, 36.969], [40.063, 42.224]],
        nodeIds: ['45929045', '45929507', '5163845620'] },
      { id: 'way/230163948', roadClass: 'secondary', width: 4.464, oneway: true,
        points: [[48.042, 64.699], [37.147, 49.515], [30.313, 41.311], [28.808, 33.630]],
        nodeIds: ['2386918196', '5163845616', '2386918181', '45929045'] },
      { id: 'way/6671166', roadClass: 'service', width: 3.6, oneway: true,
        points: [[28.808, 33.630], [23.820, 39.830], [12.258, 50.806],
          [9.607, 53.467], [4.708, 58.521]],
        nodeIds: ['45929045', '5163847839', '14076450996', '8006544523', '7589198827'] },
    ];
    const data = createDatasetFromSpecs(specs);
    const expectedRings = specs.map((spec) =>
      buildRoadRibbonOutlineRing(spec.points, spec.width!)
    );
    assert.ok(expectedRings.every((ring) => ring && ring.length > 0));
    const sourceUnion = polygonClipping.union(
      expectedRings[0] as unknown as polygonClipping.Geom,
      ...(expectedRings.slice(1) as unknown as polygonClipping.Geom[])
    ) as unknown as MultiPolygonCoords;

    const scene = buildGraphRoadScene(data);
    try {
      const { junctionRanges } = assertRoadGroupGeometryInvariants(scene);
      assert.ok(junctionRanges.some((r) =>
        r.info.id.includes('osm_45928009')), 'Southern three-arm junction must be meshed');
      assert.ok(junctionRanges.some((r) =>
        r.info.id.includes('osm_45929045')), 'Northern four-arm junction must be meshed');

      const triangles: MultiPolygonCoords = [];
      for (const obj of scene.roadsGroup.children) {
        if (obj.name !== 'Roads_secondary' && obj.name !== 'Roads_service') continue;
        const mesh = obj as THREE.Mesh;
        const pos = mesh.geometry.getAttribute('position');
        const idx = mesh.geometry.getIndex();
        for (let face = 0; face < (idx ? idx.count / 3 : pos.count / 3); face++) {
          const ids = [0, 1, 2].map((i) => idx ? idx.getX(face * 3 + i) : face * 3 + i);
          if (ids.some((id) =>
            Math.abs(pos.getY(id) - ELEVATION_POLICY.ROAD_SURFACE) > 0.001
          )) continue;
          const pts = ids.map((id) =>
            [pos.getX(id), pos.getZ(id)] as [number, number]
          );
          const twiceArea = Math.abs(
            (pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) -
            (pts[1][1] - pts[0][1]) * (pts[2][0] - pts[0][0])
          );
          if (twiceArea < 1e-8) continue;
          triangles.push([[pts[0], pts[1], pts[2], pts[0]]]);
        }
      }
      assert.ok(triangles.length > 0, 'The actual road meshes must contain triangles');
      const renderedUnion = polygonClipping.union(
        triangles[0] as unknown as polygonClipping.Geom,
        ...(triangles.slice(1) as unknown as polygonClipping.Geom[])
      ) as unknown as MultiPolygonCoords;

      for (const { node, center } of [
        { node: '45928009', center: [0, 0] },
        { node: '45929045', center: [28.808, 33.630] },
      ]) {
        const [x, z] = center;
        const box: MultiPolygonCoords = [[[
          [x - 9, z - 9], [x + 9, z - 9],
          [x + 9, z + 9], [x - 9, z + 9], [x - 9, z - 9],
        ]]];
        const original = polygonClipping.intersection(
          sourceUnion as unknown as polygonClipping.Geom,
          box as unknown as polygonClipping.Geom
        ) as unknown as MultiPolygonCoords;
        const emitted = polygonClipping.intersection(
          renderedUnion as unknown as polygonClipping.Geom,
          box as unknown as polygonClipping.Geom
        ) as unknown as MultiPolygonCoords;
        const missing = polygonClipping.difference(
          original as unknown as polygonClipping.Geom,
          emitted as unknown as polygonClipping.Geom
        ) as unknown as MultiPolygonCoords;
        const added = polygonClipping.difference(
          emitted as unknown as polygonClipping.Geom,
          original as unknown as polygonClipping.Geom
        ) as unknown as MultiPolygonCoords;
        const missingSqm = computeMultiPolygonArea(missing);
        const addedSqm = computeMultiPolygonArea(added);
        assert.ok(missingSqm < 0.10,
          'Split ' + node + ' must retain original source-width coverage: missing ' + missingSqm + 'm²');
        assert.ok(addedSqm > 0.20,
          'Split ' + node + ' must visibly change BOTH outside shoulders: added ' + addedSqm + 'm²');
        assert.ok(addedSqm < 16,
          'Split ' + node + ' must remain localized: added ' + addedSqm + 'm²');
      }

      // Between the diverging branches at 12m from either junction, the valid
      // central void must remain open; never bridge one narrow road to the other.
      const gaps: [number, number][] = [[-9.0, -9.0], [35.87, 43.40]];
      for (const [x, z] of gaps) {
        const gapBox: MultiPolygonCoords = [[[
          [x - 0.15, z - 0.15], [x + 0.15, z - 0.15],
          [x + 0.15, z + 0.15], [x - 0.15, z + 0.15], [x - 0.15, z - 0.15],
        ]]];
        const gapFootprint = polygonClipping.intersection(
          renderedUnion as unknown as polygonClipping.Geom,
          gapBox as unknown as polygonClipping.Geom
        ) as unknown as MultiPolygonCoords;
        assert.ok(computeMultiPolygonArea(gapFootprint) < 0.001,
          'Must preserve the central void between distinct split lanes near ' + x + ',' + z);
      }
    } finally {
      scene.dispose();
    }
  });

  it('30. blends the near-collinear Veloursstraat split without bridging its two lanes', () => {
    // Five complete original ways from the second real Developer Tools report.
    // node/5207303141 joins the 7.2m undivided secondary way to TWO
    // 4.464m one-way secondaries. One branch has a signed lateral cross of
    // only 0.042 against the trunk continuation, below the OLD 0.06 gate.
    const data = new LocalGeoJsonProvider().parseGeoJson(
      veloursstraatSplitFixture,
      'Veloursstraat split-merge regression',
      [6.7973, 52.2597],
      350
    );
    const sourceIds = [
      'way/537835346', 'way/537835350', 'way/537835352',
      'way/537835353', 'way/6669954',
    ];
    assert.deepEqual(
      [...new Set((data.topologySource?.roadParts ?? []).map((p) => p.sourceFeatureId))].sort(),
      sourceIds,
      'Real original OSM ways must survive ingestion and retain their identities'
    );
    const preview = prepareInfrastructureRenderPreview(data, {
      roads: 'graph', railways: 'legacy',
    });
    assert.ok(preview.graph);
    const graphNodes = [...preview.graph.roads.nodes.values()];
    const junctions = ['45922126', '5207303141'].map((id) => {
      const node = graphNodes.find((n) => n.rawOsmNodeId === id);
      assert.ok(node, 'Must preserve OSM node/' + id);
      assert.equal(node.degree, 3, 'Both split junctions have three actual arms');
      const widths = node.incidentEdgeIds.map((edgeId) =>
        preview.graph!.roads.edges.get(edgeId)?.width
      ).filter((w): w is number => typeof w === 'number').sort((a, b) => a - b);
      assert.equal(widths.length, 3);
      assert.ok(Math.abs(widths[0] - 4.464) < 1e-3 &&
                Math.abs(widths[1] - 4.464) < 1e-3 &&
                Math.abs(widths[2] - 7.2) < 1e-3,
        'Expected the actual 4.464 / 4.464 / 7.2m physical widths');
      return node;
    });

    const sourceRings = (data.topologySource?.roadParts ?? []).map((p) =>
      buildRoadRibbonOutlineRing(p.points as [number, number][], p.width)
    );
    assert.equal(sourceRings.length, 5);
    assert.ok(sourceRings.every((ring) => ring && ring.length > 0));
    const sourceUnion = polygonClipping.union(
      sourceRings[0] as unknown as polygonClipping.Geom,
      ...(sourceRings.slice(1) as unknown as polygonClipping.Geom[])
    ) as unknown as MultiPolygonCoords;

    const scene = new GeometryBuilder({
      infrastructureRenderOptions: { roads: 'graph', railways: 'legacy' },
      infrastructureRenderPreview: preview,
    }).buildScene(data, MAP_THEMES.tactical);
    try {
      const { junctionRanges } = assertRoadGroupGeometryInvariants(scene);
      for (const id of ['45922126', '5207303141']) {
        assert.ok(junctionRanges.some((range) => range.info.id.includes('osm_' + id)),
          'Expected a real graph junction patch at OSM node/' + id);
      }
      const mesh = scene.roadsGroup.children.find((o) => o.name === 'Roads_secondary') as THREE.Mesh;
      assert.ok(mesh, 'Expected a real secondary-road surface mesh');
      const pos = mesh.geometry.getAttribute('position');
      const idx = mesh.geometry.getIndex();
      const triangles: MultiPolygonCoords = [];
      for (let face = 0; face < (idx ? idx.count / 3 : pos.count / 3); face++) {
        const ids = [0, 1, 2].map((i) => idx ? idx.getX(face * 3 + i) : face * 3 + i);
        if (ids.some((id) => Math.abs(pos.getY(id) - ELEVATION_POLICY.ROAD_SURFACE) > 0.001)) continue;
        const p = ids.map((id) => [pos.getX(id), pos.getZ(id)] as [number, number]);
        const cross = Math.abs(
          (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) -
          (p[1][1] - p[0][1]) * (p[2][0] - p[0][0])
        );
        if (cross < 1e-8) continue;
        triangles.push([[p[0], p[1], p[2], p[0]]]);
      }
      assert.ok(triangles.length > 0);
      const rendered = polygonClipping.union(
        triangles[0] as unknown as polygonClipping.Geom,
        ...(triangles.slice(1) as unknown as polygonClipping.Geom[])
      ) as unknown as MultiPolygonCoords;

      for (const node of junctions) {
        const x = node.x, z = node.z;
        const localBox: MultiPolygonCoords = [[[
          [x - 9, z - 9], [x + 9, z - 9], [x + 9, z + 9],
          [x - 9, z + 9], [x - 9, z - 9],
        ]]];
        const original = polygonClipping.intersection(
          sourceUnion as unknown as polygonClipping.Geom,
          localBox as unknown as polygonClipping.Geom
        ) as unknown as MultiPolygonCoords;
        const emitted = polygonClipping.intersection(
          rendered as unknown as polygonClipping.Geom,
          localBox as unknown as polygonClipping.Geom
        ) as unknown as MultiPolygonCoords;
        const missingArea = computeMultiPolygonArea(polygonClipping.difference(
          original as unknown as polygonClipping.Geom,
          emitted as unknown as polygonClipping.Geom
        ) as unknown as MultiPolygonCoords);
        const addedArea = computeMultiPolygonArea(polygonClipping.difference(
          emitted as unknown as polygonClipping.Geom,
          original as unknown as polygonClipping.Geom
        ) as unknown as MultiPolygonCoords);
        assert.ok(missingArea < 0.30,
          'Must retain source road footprint at node ' + node.rawOsmNodeId + ': ' + missingArea + 'm²');
        assert.ok(addedArea > 0.40 && addedArea < 25,
          'Must measurably soften BOTH outer shoulders at node ' +
          node.rawOsmNodeId + ': ' + addedArea + 'm²');
      }

      // At 14m along the angular bisector of the two northern split arms,
      // their actual source-width road surfaces leave an open center gap.
      // The taper must never connect the branches through that void.
      const northern = junctions[1];
      const gx = northern.x + 4.57, gz = northern.z - 13.23;
      const gapBox: MultiPolygonCoords = [[[
        [gx - 0.20, gz - 0.20], [gx + 0.20, gz - 0.20],
        [gx + 0.20, gz + 0.20], [gx - 0.20, gz + 0.20],
        [gx - 0.20, gz - 0.20],
      ]]];
      const gapCovered = polygonClipping.intersection(
        rendered as unknown as polygonClipping.Geom,
        gapBox as unknown as polygonClipping.Geom
      ) as unknown as MultiPolygonCoords;
      assert.ok(computeMultiPolygonArea(gapCovered) < 0.001,
        'Must keep the genuine opening between the one-way split branches');
    } finally {
      scene.dispose();
    }
  });

  it('31. blends the asymmetric Parallelweg four-arm split without filling its central lane gap', () => {
    // Real OSM report around node/45922214: 7.2m two-way secondary,
    // two 4.464m one-way secondaries, and a 5.4m residential side arm.
    // The narrow branches straddle the trunk at signed crosses
    // +0.132 and -0.071. Their -0.00936 product narrowly missed the
    // former arbitrary -0.01 cutoff despite genuine two-sided geometry.
    const data = new LocalGeoJsonProvider().parseGeoJson(
      parallelwegSplitFixture,
      'Parallelweg LS four-arm split regression',
      [6.7960455, 52.259573],
      300
    );
    const sourceIds = [
      'way/1450932220', 'way/1450932221',
      'way/1450932222', 'way/6671177',
    ];
    const parts = data.topologySource?.roadParts ?? [];
    assert.deepEqual(
      [...new Set(parts.map((part) => part.sourceFeatureId))].sort(),
      sourceIds.slice().sort(),
      'All four complete original OSM ways must survive parsing'
    );
    assert.ok(parts.every((part) =>
      part.rawOsmNodeIds.length === part.points.length &&
      part.rawOsmNodeIds.includes('45922214')
    ), 'Every incident way must retain the same authoritative OSM junction node');

    const preview = prepareInfrastructureRenderPreview(data, {
      roads: 'graph', railways: 'legacy',
    });
    assert.ok(preview.graph);
    const junction = [...preview.graph.roads.nodes.values()].find(
      (node) => node.rawOsmNodeId === '45922214'
    );
    assert.ok(junction, 'The exact real OSM junction must survive graph simplification');
    assert.equal(junction.degree, 4, 'The residential side arm must not be dropped');
    const widths = junction.incidentEdgeIds.map((id) =>
      preview.graph!.roads.edges.get(id)?.width
    ).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
    assert.equal(widths.length, 4);
    for (const [actual, expected] of widths.map((v, i) => [v, [4.464, 4.464, 5.4, 7.2][i]])) {
      assert.ok(Math.abs(actual - expected) < 1e-3,
        'A real split must preserve measured branch widths: ' + actual + ' vs ' + expected);
    }

    const sourceRings = parts.map((part) =>
      buildRoadRibbonOutlineRing(part.points as [number, number][], part.width)
    );
    assert.equal(sourceRings.length, 4);
    assert.ok(sourceRings.every((ring) => ring && ring.length > 0));
    const originalUnion = polygonClipping.union(
      sourceRings[0] as unknown as polygonClipping.Geom,
      ...(sourceRings.slice(1) as unknown as polygonClipping.Geom[])
    ) as unknown as MultiPolygonCoords;

    const scene = new GeometryBuilder({
      infrastructureRenderOptions: { roads: 'graph', railways: 'legacy' },
      infrastructureRenderPreview: preview,
    }).buildScene(data, MAP_THEMES.tactical);
    try {
      const { junctionRanges } = assertRoadGroupGeometryInvariants(scene);
      assert.ok(junctionRanges.some((range) =>
        range.info.id.includes('osm_45922214')
      ), 'A provenance-traceable four-arm junction patch must be emitted');
      const triangles: MultiPolygonCoords = [];
      for (const obj of scene.roadsGroup.children) {
        if (obj.name !== 'Roads_secondary' && obj.name !== 'Roads_residential') continue;
        const mesh = obj as THREE.Mesh;
        const pos = mesh.geometry.getAttribute('position');
        const idx = mesh.geometry.getIndex();
        for (let f = 0; f < (idx ? idx.count / 3 : pos.count / 3); f++) {
          const ids = [0, 1, 2].map((n) => idx ? idx.getX(f * 3 + n) : f * 3 + n);
          if (ids.some((id) =>
            Math.abs(pos.getY(id) - ELEVATION_POLICY.ROAD_SURFACE) > 0.001
          )) continue;
          const p = ids.map((id) =>
            [pos.getX(id), pos.getZ(id)] as [number, number]
          );
          const signedArea = Math.abs(
            (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) -
            (p[1][1] - p[0][1]) * (p[2][0] - p[0][0])
          );
          if (signedArea > 1e-8) {
            triangles.push([[p[0], p[1], p[2], p[0]]]);
          }
        }
      }
      assert.ok(triangles.length > 0);
      const emittedUnion = polygonClipping.union(
        triangles[0] as unknown as polygonClipping.Geom,
        ...(triangles.slice(1) as unknown as polygonClipping.Geom[])
      ) as unknown as MultiPolygonCoords;

      // Compare ACTUAL emitted triangles to original-width source footprints
      // in a small square around the reported shoulder, not just solver stats.
      const x = junction.x, z = junction.z;
      const localBounds: MultiPolygonCoords = [[[
        [x - 9, z - 9], [x + 9, z - 9], [x + 9, z + 9],
        [x - 9, z + 9], [x - 9, z - 9],
      ]]];
      const sourceLocal = polygonClipping.intersection(
        originalUnion as unknown as polygonClipping.Geom,
        localBounds as unknown as polygonClipping.Geom
      ) as unknown as MultiPolygonCoords;
      const emittedLocal = polygonClipping.intersection(
        emittedUnion as unknown as polygonClipping.Geom,
        localBounds as unknown as polygonClipping.Geom
      ) as unknown as MultiPolygonCoords;
      const addedArea = computeMultiPolygonArea(polygonClipping.difference(
        emittedLocal as unknown as polygonClipping.Geom,
        sourceLocal as unknown as polygonClipping.Geom
      ) as unknown as MultiPolygonCoords);
      const missingArea = computeMultiPolygonArea(polygonClipping.difference(
        sourceLocal as unknown as polygonClipping.Geom,
        emittedLocal as unknown as polygonClipping.Geom
      ) as unknown as MultiPolygonCoords);
      assert.ok(addedArea > 2.0 && addedArea < 35,
        'Both external shoulders must be blended, not a square source union: ' + addedArea + 'm²');
      assert.ok(missingArea < 0.50,
        'Every original full-width road must remain covered near the junction: ' + missingArea + 'm²');

      // 35m southwest along the split, the lane centerlines are ~5.2m
      // apart. Their 2.232m half-widths leave a genuine open gap.
      const gx = x - 30.0, gz = z - 17.85;
      const gapBounds: MultiPolygonCoords = [[[
        [gx - 0.10, gz - 0.10], [gx + 0.10, gz - 0.10],
        [gx + 0.10, gz + 0.10], [gx - 0.10, gz + 0.10],
        [gx - 0.10, gz - 0.10],
      ]]];
      const gap = polygonClipping.intersection(
        emittedUnion as unknown as polygonClipping.Geom,
        gapBounds as unknown as polygonClipping.Geom
      ) as unknown as MultiPolygonCoords;
      assert.ok(computeMultiPolygonArea(gap) < 0.001,
        'The legitimate gap between the two one-way branches must stay open');
    } finally {
      scene.dispose();
    }
  });

  it('32. resolves OSM road widths from width:carriageway, width, lanes, directional lanes, turn:lanes, and on-road cycle lanes while excluding separate cycle tracks', () => {
    const originLat = 52.37;
    const originLon = 4.89;
    const dLon = 0.0006;

    const makeFeature = (id: string, rowIdx: number, props: Record<string, any>) => {
      const lat = originLat + rowIdx * 0.0003;
      return {
        type: 'Feature',
        id,
        properties: { id, ...props },
        geometry: {
          type: 'LineString',
          coordinates: [
            [originLon, lat],
            [originLon + dLon, lat],
          ],
        },
      };
    };

    const geojson = {
      type: 'FeatureCollection',
      features: [
        makeFeature('way/sym-default', 0, { highway: 'residential' }),
        makeFeature('way/carriageway-override', 1, {
          highway: 'primary',
          'width:carriageway': '6.4',
          width: '11.0',
          lanes: '3',
        }),
        makeFeature('way/explicit-width-unit', 2, {
          highway: 'secondary',
          width: '8.2 m',
          lanes: '2',
        }),
        makeFeature('way/lanes-3-primary', 3, {
          highway: 'primary',
          lanes: '3',
        }),
        makeFeature('way/dir-lanes-secondary', 4, {
          highway: 'secondary',
          'lanes:forward': '2',
          'lanes:backward': '1',
        }),
        makeFeature('way/turn-lanes-oneway', 5, {
          highway: 'primary',
          oneway: 'yes',
          'turn:lanes': 'left|through|right',
        }),
        makeFeature('way/cycle-lane-included', 6, {
          highway: 'secondary',
          lanes: '2',
          'cycleway:both': 'lane',
          'cycleway:both:width': '1.5',
        }),
        makeFeature('way/cycle-track-excluded', 7, {
          highway: 'secondary',
          lanes: '2',
          cycleway: 'track',
          'cycleway:right': 'track',
          'cycleway:width': '2.5',
        }),
      ],
    };

    const data = new LocalGeoJsonProvider().parseGeoJson(
      geojson,
      'OSM road width precedence and cycleway semantics test',
      [originLon, originLat],
      500
    );
    const partById = new Map(
      (data.topologySource?.roadParts ?? []).map((p) => [p.sourceFeatureId, p])
    );

    assert.equal(
      partById.get('way/sym-default')?.width,
      ROAD_CLASS_WIDTHS.residential,
      'Untagged residential road must preserve exact default class width'
    );
    assert.equal(
      partById.get('way/carriageway-override')?.width,
      6.4,
      'Explicit width:carriageway must take precedence over width and lanes'
    );
    assert.equal(
      partById.get('way/explicit-width-unit')?.width,
      8.2,
      'Explicit metric width tag must take precedence over inferred lane width'
    );
    assert.equal(
      partById.get('way/lanes-3-primary')?.width,
      10.5,
      'Explicit lanes=3 on primary road must resolve to 3 * 3.5m = 10.5m'
    );
    assert.equal(
      partById.get('way/dir-lanes-secondary')?.width,
      10.8,
      'Directional lanes:forward=2 + lanes:backward=1 on secondary road must resolve to 3 * 3.6m = 10.8m'
    );
    assert.equal(
      partById.get('way/turn-lanes-oneway')?.width,
      10.5,
      'One-way road with 3 turn:lanes compartments must resolve to 3 * 3.5m = 10.5m'
    );
    assert.equal(
      partById.get('way/cycle-lane-included')?.width,
      10.2,
      'On-carriageway cycleway:both=lane (2 * 1.5m) must widen 7.2m carriageway to 10.2m'
    );
    assert.equal(
      partById.get('way/cycle-track-excluded')?.width,
      ROAD_CLASS_WIDTHS.secondary,
      'Physically separated cycleway=track must never be added to the motor-vehicle carriageway width'
    );

    const scene = buildGraphRoadScene(data);
    try {
      assertRoadGroupGeometryInvariants(scene);
    } finally {
      scene.dispose();
    }
  });

  it('33. renders asymmetric placement offsets and respects oneway=-1 and graph-reversed segments', () => {
    const extractZBoundsForSourceId = (
      scene: BuiltSceneGeometry,
      meshName: string,
      sourceFeatureId: string
    ): { minZ: number; maxZ: number } => {
      const mesh = scene.roadsGroup.children.find((c) => c.name === meshName) as THREE.Mesh;
      assert.ok(mesh, `Expected mesh ${meshName}`);
      const pos = mesh.geometry.getAttribute('position');
      const idx = mesh.geometry.getIndex()!;
      const ranges: FaceFeatureRange[] = mesh.userData.faceRanges;
      const range = ranges.find((r) => r.info.sourceFeatureId === sourceFeatureId);
      assert.ok(range, `Expected faceRange for ${sourceFeatureId}`);

      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let f = range.startFace; f < range.endFace; f++) {
        for (let k = 0; k < 3; k++) {
          const vi = idx.getX(f * 3 + k);
          const z = pos.getZ(vi);
          minZ = Math.min(minZ, z);
          maxZ = Math.max(maxZ, z);
        }
      }
      return { minZ, maxZ };
    };

    const specs: SyntheticRoadSpec[] = [
      // 1. Forward oneway=yes (+X direction: left is -Z, right is +Z), width=7.0m, lanes=2, placement=middle_of:1
      // Lane 1 center is at centerline (z=0): left curb = -1.75m, right curb = +5.25m
      {
        id: 'way/asym-forward',
        roadClass: 'primary',
        width: 7.0,
        lanes: 2,
        oneway: true,
        points: [
          [-40, 0],
          [40, 0],
        ],
        nodeIds: ['af_0', 'af_1'],
        osmTags: {
          lanes: '2',
          oneway: 'yes',
          placement: 'middle_of:1',
        },
      },
      // 2. Reversed oneway=-1 digitized West-to-East ([-40, 30] -> [40, 30]), traffic flows East-to-West (-X).
      // In traffic flow direction (-X), driver's left is +Z (South) and driver's right is -Z (North).
      // So placement=middle_of:1 places 0.5 lanes (+1.75m) on +Z and 1.5 lanes (-5.25m) on -Z:
      // minZ = 30 - 5.25 = 24.75, maxZ = 30 + 1.75 = 31.75.
      {
        id: 'way/asym-oneway-reverse',
        roadClass: 'primary',
        width: 7.0,
        lanes: 2,
        points: [
          [-40, 30],
          [40, 30],
        ],
        nodeIds: ['ar_0', 'ar_1'],
        osmTags: {
          lanes: '2',
          oneway: '-1',
          placement: 'middle_of:1',
        },
      },
      // 3. Two-segment bidirectional chain where the second way is digitized in reverse ([40, 60] -> [0, 60])
      // so RoadNetworkBuilder sets reversedRelativeToSource=true on way/chain-rev-b.
      // Way A ([0, 60] -> [20, 60], +X) has placement=middle_of:1 (left=-1.75, right=+5.25 -> z in [58.25, 65.25]).
      // Way B ([40, 60] -> [20, 60], -X) has placement=middle_of:2 in its digitized -X direction
      // (which in -X has left=5.25 on +Z and right=1.75 on -Z -> z in [58.25, 65.25] in world space!).
      {
        id: 'way/chain-fwd-a',
        roadClass: 'secondary',
        width: 7.0,
        lanes: 2,
        name: 'Asym Chain',
        points: [
          [0, 60],
          [20, 60],
        ],
        nodeIds: ['ch_0', 'ch_1'],
        osmTags: {
          lanes: '2',
          placement: 'middle_of:1',
        },
      },
      {
        id: 'way/chain-rev-b',
        roadClass: 'secondary',
        width: 7.0,
        lanes: 2,
        name: 'Asym Chain',
        points: [
          [40, 60],
          [20, 60],
        ],
        nodeIds: ['ch_2', 'ch_1'],
        osmTags: {
          lanes: '2',
          placement: 'middle_of:2',
        },
      },
    ];

    const data = createDatasetFromSpecs(specs);
    const scene = buildGraphRoadScene(data);
    try {
      assertRoadGroupGeometryInvariants(scene);

      const fwdBounds = extractZBoundsForSourceId(scene, 'Roads_primary', 'way/asym-forward');
      assert.ok(
        Math.abs(fwdBounds.minZ - -1.75) < 0.02 && Math.abs(fwdBounds.maxZ - 5.25) < 0.02,
        `Expected forward placement=middle_of:1 Z bounds [-1.75, 5.25], got [${fwdBounds.minZ.toFixed(3)}, ${fwdBounds.maxZ.toFixed(3)}]`
      );

      const revOnewayBounds = extractZBoundsForSourceId(
        scene,
        'Roads_primary',
        'way/asym-oneway-reverse'
      );
      assert.ok(
        Math.abs(revOnewayBounds.minZ - 24.75) < 0.02 &&
          Math.abs(revOnewayBounds.maxZ - 31.75) < 0.02,
        `Expected oneway=-1 placement=middle_of:1 Z bounds [24.75, 31.75], got [${revOnewayBounds.minZ.toFixed(3)}, ${revOnewayBounds.maxZ.toFixed(3)}]`
      );

      const chainABounds = extractZBoundsForSourceId(scene, 'Roads_secondary', 'way/chain-fwd-a');
      const chainBBounds = extractZBoundsForSourceId(scene, 'Roads_secondary', 'way/chain-rev-b');
      assert.ok(
        Math.abs(chainABounds.minZ - 58.25) < 0.02 && Math.abs(chainABounds.maxZ - 65.25) < 0.02,
        `Expected way/chain-fwd-a Z bounds [58.25, 65.25], got [${chainABounds.minZ.toFixed(3)}, ${chainABounds.maxZ.toFixed(3)}]`
      );
      assert.ok(
        Math.abs(chainBBounds.minZ - 58.25) < 0.02 && Math.abs(chainBBounds.maxZ - 65.25) < 0.02,
        `Expected graph-reversed way/chain-rev-b Z bounds [58.25, 65.25], got [${chainBBounds.minZ.toFixed(3)}, ${chainBBounds.maxZ.toFixed(3)}]`
      );
    } finally {
      scene.dispose();
    }
  });

  it('34. supports placement:start / placement:end transitions and smooth degree-2 joins between segments with different offsets or widths', () => {
    const specs: SyntheticRoadSpec[] = [
      // 1. Single way with placement:start=middle_of:1 -> placement:end=middle_of:2 along x in [0, 40], z=0
      {
        id: 'way/placement-transition',
        roadClass: 'primary',
        width: 7.0,
        lanes: 2,
        oneway: true,
        points: [
          [0, 0],
          [20, 0],
          [40, 0],
        ],
        nodeIds: ['pt_0', undefined, 'pt_1'],
        osmTags: {
          lanes: '2',
          oneway: 'yes',
          'placement:start': 'middle_of:1',
          'placement:end': 'middle_of:2',
          'turn:lanes': 'left|right',
        },
      },
      // Crossing footway at x=20 to verify 2D clipping footprint matches the transitioning 3D ribbon
      {
        id: 'way/crossing-footway',
        roadClass: 'footway',
        width: 2.0,
        points: [
          [20, -15],
          [20, 15],
        ],
        nodeIds: ['fw_s', 'fw_n'],
      },
      // 2. Two adjacent ways with a step change in lateral placement (left_of:1 meeting right_of:2) at [0, 40]
      {
        id: 'way/step-offset-west',
        roadClass: 'secondary',
        width: 7.0,
        lanes: 2,
        oneway: true,
        points: [
          [-35, 40],
          [0, 40],
        ],
        nodeIds: ['so_w', 'so_mid'],
        osmTags: {
          lanes: '2',
          oneway: 'yes',
          placement: 'left_of:1',
        },
      },
      {
        id: 'way/step-offset-east',
        roadClass: 'secondary',
        width: 7.0,
        lanes: 2,
        oneway: true,
        points: [
          [0, 40],
          [35, 40],
        ],
        nodeIds: ['so_mid', 'so_e'],
        osmTags: {
          lanes: '2',
          oneway: 'yes',
          placement: 'right_of:2',
        },
      },
    ];

    const data = createDatasetFromSpecs(specs);
    const scene = buildGraphRoadScene(data);
    try {
      const { junctionRanges } = assertRoadGroupGeometryInvariants(scene);
      const zReport = validateRoadNetworkGeometry(scene);
      assert.equal(
        zReport.overlapConflicts.length,
        0,
        'Expected 0 same-layer overlaps on transitioning and step-offset roads'
      );

      // Verify that at x=0 (start of way/placement-transition), z spans [-1.75, +5.25],
      // at x=20 (midpoint), z spans [-3.5, +3.5], and at x=40 (end), z spans [-5.25, +1.75].
      const primMesh = scene.roadsGroup.children.find((c) => c.name === 'Roads_primary') as THREE.Mesh;
      assert.ok(primMesh, 'Expected Roads_primary mesh');
      const pos = primMesh.geometry.getAttribute('position');
      const startZs: number[] = [];
      const midZs: number[] = [];
      const endZs: number[] = [];
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        if (Math.abs(x - 0) < 0.05) startZs.push(z);
        if (Math.abs(x - 20) < 0.05) midZs.push(z);
        if (Math.abs(x - 40) < 0.05) endZs.push(z);
      }
      assert.ok(
        Math.abs(Math.min(...startZs) - -1.75) < 0.05 &&
          Math.abs(Math.max(...startZs) - 5.25) < 0.05,
        `Expected start cross-section [-1.75, 5.25] at x=0, got [${Math.min(...startZs)}, ${Math.max(...startZs)}]`
      );
      assert.ok(
        Math.abs(Math.min(...midZs) - -3.5) < 0.05 && Math.abs(Math.max(...midZs) - 3.5) < 0.05,
        `Expected midpoint cross-section [-3.5, 3.5] at x=20, got [${Math.min(...midZs)}, ${Math.max(...midZs)}]`
      );
      assert.ok(
        Math.abs(Math.min(...endZs) - -5.25) < 0.05 && Math.abs(Math.max(...endZs) - 1.75) < 0.05,
        `Expected end cross-section [-5.25, 1.75] at x=40, got [${Math.min(...endZs)}, ${Math.max(...endZs)}]`
      );

      // Verify the degree-2 lateral offset jump at node 'so_mid' emitted a local transition patch
      assert.ok(
        junctionRanges.some((r) => r.info.sourceFeatureIds?.includes('way/step-offset-west')),
        'Expected degree-2 lateral placement jump to emit a smooth local transition polygon'
      );
    } finally {
      scene.dispose();
    }
  });

  it('35. handles missing, malformed, and conflicting OSM width, lane, and placement tags safely without NaN or self-intersection', () => {
    const originLat = 52.37;
    const originLon = 4.89;
    const dLon = 0.0005;

    const makeFeature = (id: string, rowIdx: number, props: Record<string, any>) => {
      const lat = originLat + rowIdx * 0.0003;
      return {
        type: 'Feature',
        id,
        properties: { id, ...props },
        geometry: {
          type: 'LineString',
          coordinates: [
            [originLon, lat],
            [originLon + dLon, lat],
          ],
        },
      };
    };

    const geojson = {
      type: 'FeatureCollection',
      features: [
        makeFeature('way/malformed-width', 0, {
          highway: 'residential',
          width: 'narrow',
          'width:carriageway': '-5',
          lanes: 'many',
        }),
        makeFeature('way/out-of-range-width', 1, {
          highway: 'tertiary',
          width: '999',
          lanes: '99',
          placement: 'middle_of:99',
        }),
        makeFeature('way/conflicting-placement', 2, {
          highway: 'secondary',
          lanes: '2',
          placement: 'middle_of:5',
          'placement:start': 'diagonal:2',
          'placement:end': 'left_of:0',
        }),
      ],
    };

    const data = new LocalGeoJsonProvider().parseGeoJson(
      geojson,
      'Malformed and conflicting OSM tag safety test',
      [originLon, originLat],
      500
    );
    const partById = new Map(
      (data.topologySource?.roadParts ?? []).map((p) => [p.sourceFeatureId, p])
    );

    assert.equal(
      partById.get('way/malformed-width')?.width,
      ROAD_CLASS_WIDTHS.residential,
      'Malformed negative/non-numeric width and lanes must fall back to class default'
    );
    assert.equal(
      partById.get('way/out-of-range-width')?.width,
      ROAD_CLASS_WIDTHS.tertiary,
      'Out-of-bounds width=999 and lanes=99 must fall back to class default'
    );
    assert.equal(
      partById.get('way/conflicting-placement')?.width,
      ROAD_CLASS_WIDTHS.secondary,
      'Secondary road with lanes=2 and conflicting placement must retain valid 7.2m width'
    );

    const scene = buildGraphRoadScene(data);
    try {
      const { faceRangesById } = assertRoadGroupGeometryInvariants(scene);
      assert.equal(
        faceRangesById.size,
        3,
        'All 3 roads with malformed/conflicting tags must render valid symmetric fallback ribbons'
      );
    } finally {
      scene.dispose();
    }
  });

  it('36. preserves per-segment source-feature provenance and inspection metadata across simplified multi-segment asymmetric and transitioning roads', () => {
    const specs: SyntheticRoadSpec[] = [
      {
        id: 'way/prov-seg-0',
        roadClass: 'primary',
        name: 'Provenance Corridor',
        width: 7.0,
        lanes: 2,
        oneway: true,
        points: [
          [0, 0],
          [30, 0],
        ],
        nodeIds: ['p0', 'p1'],
        osmTags: {
          name: 'Provenance Corridor West',
          lanes: '2',
          oneway: 'yes',
          placement: 'middle_of:1',
        },
      },
      {
        id: 'way/prov-seg-1',
        roadClass: 'primary',
        name: 'Provenance Corridor',
        width: 7.0,
        lanes: 2,
        oneway: true,
        points: [
          [30, 0],
          [60, 0],
        ],
        nodeIds: ['p1', 'p2'],
        osmTags: {
          name: 'Provenance Corridor Transition',
          lanes: '2',
          oneway: 'yes',
          'placement:start': 'middle_of:1',
          'placement:end': 'middle_of:2',
        },
      },
      {
        id: 'way/prov-seg-2',
        roadClass: 'primary',
        name: 'Provenance Corridor',
        width: 7.0,
        lanes: 2,
        oneway: true,
        points: [
          [60, 0],
          [90, 0],
        ],
        nodeIds: ['p2', 'p3'],
        osmTags: {
          name: 'Provenance Corridor East',
          lanes: '2',
          oneway: 'yes',
          placement: 'middle_of:2',
        },
      },
    ];

    const data = createDatasetFromSpecs(specs);
    const preview = prepareInfrastructureRenderPreview(data, {
      roads: 'graph',
      railways: 'legacy',
    });
    assert.equal(
      preview.graph?.roads.edges.size,
      1,
      'Continuous-offset degree-2 chain must contract into 1 simplified graph edge'
    );
    const contractedEdge = Array.from(preview.graph!.roads.edges.values())[0];
    assert.equal(
      contractedEdge.provenance.segments.length,
      3,
      'Contracted graph edge must retain all 3 constituent provenance segments'
    );

    const scene = new GeometryBuilder({
      infrastructureRenderOptions: { roads: 'graph', railways: 'legacy' },
      infrastructureRenderPreview: preview,
    }).buildScene(data, MAP_THEMES.tactical);

    try {
      const { faceRangesById } = assertRoadGroupGeometryInvariants(scene);
      assert.equal(
        faceRangesById.size,
        3,
        'Simplified edge must emit 3 distinct provenance sub-segment faceRanges (#seg0, #seg1, #seg2)'
      );

      const primMesh = scene.roadsGroup.children.find(
        (c) => c.name === 'Roads_primary'
      ) as THREE.Mesh;
      assert.ok(primMesh, 'Expected Roads_primary mesh');

      const ranges: FaceFeatureRange[] = primMesh.userData.faceRanges;
      const sourceIds = ranges.map((r) => r.info.sourceFeatureId);
      assert.deepEqual(
        sourceIds,
        ['way/prov-seg-0', 'way/prov-seg-1', 'way/prov-seg-2'],
        'Each sub-segment faceRange must resolve back to its exact upstream OSM way ID'
      );

      for (let i = 0; i < ranges.length; i++) {
        const hitInfo = resolveInspectedFeature({
          object: primMesh,
          faceIndex: ranges[i].startFace,
        });
        assert.equal(hitInfo?.sourceFeatureId, `way/prov-seg-${i}`);
      }
    } finally {
      scene.dispose();
    }
  });

});


