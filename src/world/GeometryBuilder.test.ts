import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { generateRoadRibbon, createShapeFromRings } from './GeometryBuilder';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';

test('generateRoadRibbon computes correct vertex and index buffers for 2-point line', () => {
  const points: [number, number][] = [
    [0, 0],
    [10, 0],
  ];
  const width = 4;
  const ribbon = generateRoadRibbon(points, width, 0.1);

  assert.notEqual(ribbon, null);
  if (!ribbon) return;

  // 2 points * 2 vertices = 4 vertices
  assert.equal(ribbon.positions.length, 4 * 3);
  assert.equal(ribbon.normals.length, 4 * 3);
  // 1 quad = 2 triangles = 6 indices
  assert.equal(ribbon.indices.length, 6);

  // Elevation Y check
  assert.equal(Math.abs(ribbon.positions[1] - 0.1) < 1e-5, true);
  assert.equal(Math.abs(ribbon.positions[4] - 0.1) < 1e-5, true);

  // Normal Y check (pointing up)
  assert.equal(ribbon.normals[1], 1);
  assert.equal(ribbon.normals[4], 1);
});

test('generateRoadRibbon handles multi-segment polylines with corners', () => {
  const points: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
  ];
  const ribbon = generateRoadRibbon(points, 6, 0.05);

  assert.notEqual(ribbon, null);
  if (!ribbon) return;

  // 3 points * 2 vertices = 6 vertices
  assert.equal(ribbon.positions.length, 6 * 3);
  // 2 quads = 4 triangles = 12 indices
  assert.equal(ribbon.indices.length, 12);
});

test('generateRoadRibbon returns null for degenerate lines with less than 2 points', () => {
  assert.equal(generateRoadRibbon([], 5), null);
  assert.equal(generateRoadRibbon([[0, 0]], 5), null);
});

test('createShapeFromRings creates valid Three.js Shape with hole support', () => {
  const outerRing: [number, number][] = [
    [0, 0],
    [20, 0],
    [20, 20],
    [0, 20],
    [0, 0],
  ];
  const holeRing: [number, number][] = [
    [5, 5],
    [15, 5],
    [15, 15],
    [5, 15],
    [5, 5],
  ];

  const shape = createShapeFromRings([outerRing, holeRing]);
  assert.notEqual(shape, null);
  if (!shape) return;

  assert.equal(shape.holes.length, 1);
});

test('createShapeFromRings produces extruded geometry perfectly aligned with world X and Z coordinates', async () => {
  const THREE = await import('three');
  const inputRing: [number, number][] = [
    [10, 50],
    [30, 50],
    [30, 80],
    [10, 80],
    [10, 50],
  ];

  const shape = createShapeFromRings([inputRing]);
  assert.notEqual(shape, null);
  if (!shape) return;

  const extrude = new THREE.ExtrudeGeometry(shape, { depth: 15, bevelEnabled: false });
  extrude.rotateX(-Math.PI / 2);
  extrude.computeBoundingBox();

  const bbox = extrude.boundingBox!;
  assert.ok(Math.abs(bbox.min.x - 10) < 1e-4, `min.x should be 10, got ${bbox.min.x}`);
  assert.ok(Math.abs(bbox.max.x - 30) < 1e-4, `max.x should be 30, got ${bbox.max.x}`);
  assert.ok(Math.abs(bbox.min.z - 50) < 1e-4, `min.z should be 50, got ${bbox.min.z}`);
  assert.ok(Math.abs(bbox.max.z - 80) < 1e-4, `max.z should be 80, got ${bbox.max.z}`);
  assert.ok(Math.abs(bbox.min.y - 0) < 1e-4, `min.y should be 0, got ${bbox.min.y}`);
  assert.ok(Math.abs(bbox.max.y - 15) < 1e-4, `max.y should be 15, got ${bbox.max.y}`);
});

test('LocalGeoJsonProvider parses GeoJSON and extracts typed features correctly', () => {
  const provider = new LocalGeoJsonProvider();
  const sampleGeoJson = {
    type: 'FeatureCollection',
    name: 'Test Region',
    features: [
      {
        type: 'Feature',
        properties: {
          name: 'Main Church',
          building: 'church',
          height: '24.5m',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [2.348, 48.853],
              [2.349, 48.853],
              [2.349, 48.854],
              [2.348, 48.854],
              [2.348, 48.853],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        properties: {
          name: 'Avenue de la Cité',
          highway: 'primary',
          width: '12',
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [2.347, 48.853],
            [2.350, 48.853],
          ],
        },
      },
      {
        type: 'Feature',
        properties: {
          name: 'The River',
          natural: 'water',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [2.345, 48.850],
              [2.355, 48.850],
              [2.355, 48.851],
              [2.345, 48.851],
              [2.345, 48.850],
            ],
          ],
        },
      },
    ],
  };

  const parsed = provider.parseGeoJson(sampleGeoJson);
  assert.equal(parsed.buildings.length, 1);
  assert.equal(parsed.buildings[0].name, 'Main Church');
  assert.equal(parsed.buildings[0].height, 24.5);

  assert.equal(parsed.roads.length, 1);
  assert.equal(parsed.roads[0].roadClass, 'primary');
  assert.equal(parsed.roads[0].width, 12);

  assert.equal(parsed.water.length, 1);
  assert.equal(parsed.water[0].name, 'The River');
});

test('generateRoadRibbon with roundCaps adds smooth semicircular end caps', () => {
  const points: [number, number][] = [
    [0, 0],
    [20, 0],
  ];
  const width = 6;
  const capSegments = 6;
  const ribbon = generateRoadRibbon(points, width, 0.05, { roundCaps: true, capSegments });

  assert.notEqual(ribbon, null);
  if (!ribbon) return;

  // Base 2 points = 4 strip vertices
  // Each cap adds 1 center + (capSegments - 1) = capSegments vertices = 6 vertices
  // Total vertices = 4 + 6 * 2 = 16 vertices
  assert.equal(ribbon.positions.length, 16 * 3);
  assert.equal(ribbon.normals.length, 16 * 3);

  // Strip quads: 1 quad = 2 triangles = 6 indices
  // Each cap adds capSegments triangles = 6 triangles = 18 indices
  // Total indices = 6 + 18 * 2 = 42 indices
  assert.equal(ribbon.indices.length, 42);

  // All normals point upward
  for (let i = 1; i < ribbon.normals.length; i += 3) {
    assert.equal(ribbon.normals[i], 1);
  }
});

test('LocalGeoJsonProvider chains contiguous road segments and enforces consistent road width', () => {
  const provider = new LocalGeoJsonProvider();
  // Simulates the exact user scenario from Hengelo Industrieplein:
  // Two contiguous ways along the same carriageway with mismatched lanes tags
  const hengeloFixture = {
    type: 'FeatureCollection',
    name: 'Hengelo Industrieplein Test',
    features: [
      {
        type: 'Feature',
        id: 'way-730302529',
        properties: {
          name: 'Industrieplein',
          highway: 'secondary',
          oneway: 'yes',
          lanes: '1',
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [6.7930, 52.2620],
            [6.7935, 52.2625],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'way-730302533',
        properties: {
          name: 'Industrieplein',
          highway: 'secondary',
          oneway: 'yes',
          lanes: '3', // Mappers added lanes=3 near intersection
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [6.7935, 52.2625], // Connected at exact same node!
            [6.7940, 52.2630],
          ],
        },
      },
    ],
  };

  const parsed = provider.parseGeoJson(hengeloFixture);

  // 1. Both segments had identical road class and carriageway status,
  // so erratic per-segment lanes tags are ignored in favor of uniform corridor width
  assert.equal(parsed.roads.length, 1, 'Contiguous road segments must be chained into a single road polyline');
  assert.equal(parsed.roads[0].points.length, 3, 'Chained road must have 3 points: start, junction, end');
  assert.equal(parsed.roads[0].name, 'Industrieplein');
  assert.equal(parsed.roads[0].roadClass, 'secondary');

  // 2. Width is uniform and consistent along the entire chained corridor
  assert.ok(parsed.roads[0].width >= 4.0 && parsed.roads[0].width <= 5.0, 'One-way secondary carriageway has uniform width');
});

test('generateRoadRibbon produces strictly upward-facing CCW triangles for all faces including caps', () => {
  const points: [number, number][] = [
    [0, 0],
    [50, 0],
    [50, 50],
  ];
  const ribbon = generateRoadRibbon(points, 8, 0.1, { roundCaps: true, capSegments: 6 });
  assert.notEqual(ribbon, null);
  if (!ribbon) return;

  const { positions, indices } = ribbon;
  const numTriangles = indices.length / 3;

  for (let t = 0; t < numTriangles; t++) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];

    const ax = positions[i1 * 3] - positions[i0 * 3];
    const az = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];

    const bx = positions[i2 * 3] - positions[i0 * 3];
    const bz = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];

    // Cross product Y component in X-Z plane: az * bx - ax * bz
    const crossY = az * bx - ax * bz;
    assert.ok(
      crossY > 0,
      `Triangle ${t} (indices ${i0}, ${i1}, ${i2}) must be counter-clockwise with crossY > 0 (actual: ${crossY})`
    );
  }
});

test('trimPolylineByArcLength accurately trims across short terminal segments without inversion', async () => {
  const { trimPolylineByArcLength } = await import('./BridgeAndTunnelBuilder');
  // 2m short segment followed by 20m segment; trim start by 5m
  const pts: [number, number][] = [
    [0, 0],
    [2, 0],
    [22, 0],
  ];
  const trimmed = trimPolylineByArcLength(pts, 5, 3);
  assert.ok(trimmed.length === 2, `Expected 2 vertices after trimming past first short segment, got ${trimmed.length}`);
  assert.ok(Math.abs(trimmed[0][0] - 5) < 1e-4, `Start X should be at 5m, got ${trimmed[0][0]}`);
  assert.ok(Math.abs(trimmed[1][0] - 19) < 1e-4, `End X should be at 19m, got ${trimmed[1][0]}`);
});

test('3D Bridge approach ramps connect at-grade roads smoothly to elevated bridge spans with substructure and parapets', async () => {
  const THREE = await import('three');
  const { GeometryBuilder } = await import('./GeometryBuilder');
  const { MAP_THEMES } = await import('../styles/mapThemes');
  const { ELEVATION_POLICY } = await import('./ElevationPolicy');

  const provider = new LocalGeoJsonProvider();
  const bridgeFixture = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'approach-west',
        properties: { highway: 'secondary', name: 'Canal Bridge Approach W' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.8900, 52.3700],
            [4.8910, 52.3700],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'canal-bridge',
        properties: { highway: 'secondary', name: 'Canal Bridge', bridge: 'yes', layer: '1' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.8910, 52.3700],
            [4.8925, 52.3700],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'approach-east',
        properties: { highway: 'secondary', name: 'Canal Bridge Approach E' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.8925, 52.3700],
            [4.8935, 52.3700],
          ],
        },
      },
    ],
  };

  const parsed = provider.parseGeoJson(bridgeFixture);
  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.dusk);

  let roadMesh: THREE.Mesh | undefined;
  let bridgeSubstructure: THREE.Mesh | undefined;
  let bridgeParapets: THREE.Mesh | undefined;

  scene.roadsGroup.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      if (child.name === 'Roads_secondary') roadMesh = child as THREE.Mesh;
      if (child.name === 'Bridge_Substructure') bridgeSubstructure = child as THREE.Mesh;
      if (child.name === 'Bridge_Parapets') bridgeParapets = child as THREE.Mesh;
    }
  });

  assert.ok(roadMesh, 'Roads_secondary mesh must exist');
  assert.ok(bridgeSubstructure, 'Bridge_Substructure mesh (deck fascia + abutment embankment) must exist');
  assert.ok(bridgeParapets, 'Bridge_Parapets mesh (side guardrails) must exist');

  // Verify the bridge surface vertices smoothly transition from at-grade 0.050m up to elevated bridge deck ~2.850m
  const pos = roadMesh!.geometry.attributes.position;
  let minY = Infinity;
  let maxY = -Infinity;
  let intermediateRampVertices = 0;

  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (
      y > ELEVATION_POLICY.ROAD_SURFACE + 0.15 &&
      y < ELEVATION_POLICY.ROAD_SURFACE + ELEVATION_POLICY.BRIDGE_BASE_CLEARANCE - 0.15
    ) {
      intermediateRampVertices++;
    }
  }

  assert.ok(
    Math.abs(minY - ELEVATION_POLICY.ROAD_SURFACE) < 1e-3,
    `Bridge ramp base must meet at-grade road elevation (${ELEVATION_POLICY.ROAD_SURFACE}m), got ${minY}`
  );
  assert.ok(
    Math.abs(maxY - (ELEVATION_POLICY.ROAD_SURFACE + ELEVATION_POLICY.BRIDGE_BASE_CLEARANCE)) < 1e-2,
    `Bridge crest must reach bridge deck elevation, got ${maxY}`
  );
  assert.ok(
    intermediateRampVertices >= 8,
    `Bridge ramp must contain smooth intermediate slope vertices between at-grade and bridge crest, got ${intermediateRampVertices}`
  );
});

test('3D Tunnel portals, recessed dark entrance ramps, and dashed underground corridor traces are generated for tunnels', async () => {
  const THREE = await import('three');
  const { GeometryBuilder } = await import('./GeometryBuilder');
  const { MAP_THEMES } = await import('../styles/mapThemes');

  const provider = new LocalGeoJsonProvider();
  const tunnelFixture = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'road-before-tunnel',
        properties: { highway: 'primary', name: 'Tunnel Approach N' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.8900, 52.3700],
            [4.8910, 52.3700],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'underpass-tunnel',
        properties: { highway: 'primary', name: 'City Underpass', tunnel: 'yes', layer: '-1' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.8910, 52.3700],
            [4.8925, 52.3700],
          ],
        },
      },
    ],
  };

  const parsed = provider.parseGeoJson(tunnelFixture);
  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.dusk);

  let tunnelPortals: THREE.Mesh | undefined;
  let tunnelEntrances: THREE.Mesh | undefined;
  let tunnelTrace: THREE.Mesh | undefined;

  scene.roadsGroup.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      if (child.name === 'Tunnel_Portals') tunnelPortals = child as THREE.Mesh;
      if (child.name === 'Tunnel_Entrances') tunnelEntrances = child as THREE.Mesh;
      if (child.name === 'Tunnel_Underground_Trace') tunnelTrace = child as THREE.Mesh;
    }
  });

  assert.ok(tunnelPortals, 'Tunnel_Portals 3D headwall arch mesh must be generated');
  assert.ok(tunnelEntrances, 'Tunnel_Entrances dark recessed ramp mouth mesh must be generated');
  assert.ok(tunnelTrace, 'Tunnel_Underground_Trace dashed alignment mesh must be generated');
  assert.ok(tunnelPortals!.geometry.attributes.position.count > 20, 'Tunnel portal arch must have 3D geometry');
  assert.ok(tunnelTrace!.geometry.attributes.position.count >= 8, 'Dashed underground trace must have dash segments');
});

test('TopologicalNodeIndex preserves explicit OSM node IDs, isolates bridge/tunnel scopes, and never merges parallel roads', async () => {
  const { TopologicalNodeIndex } = await import('./TopologicalNodeIndex');
  const index = new TopologicalNodeIndex(0.15);

  // 1. Explicit OSM node IDs are preserved
  const explicitIds = index.resolveWayNodeIds(
    [
      [0, 0],
      [10, 0],
    ],
    '0|0|0',
    [1001, 1002]
  );
  assert.deepEqual(explicitIds, ['0|0|0|osm_1001', '0|0|0|osm_1002']);

  // 2. Parallel roads 1.5m apart must not share topological node IDs
  const roadANodes = index.resolveWayNodeIds(
    [
      [0, 0],
      [50, 0],
    ],
    '0|0|0'
  );
  const roadBNodes = index.resolveWayNodeIds(
    [
      [0, 1.5],
      [50, 1.5],
    ],
    '0|0|0'
  );
  assert.notEqual(roadANodes[0], roadBNodes[0], 'Parallel roads 1.5m apart must never merge nodes');

  // 3. Bridge and at-grade road at identical (X, Z) must not share node IDs
  const bridgeNodes = index.resolveWayNodeIds(
    [
      [0, 0],
      [50, 0],
    ],
    '1|1|0'
  );
  assert.notEqual(roadANodes[0], bridgeNodes[0], 'Bridge and at-grade road at same XZ must have isolated node scopes');
});

test('SceneResourceManager immediately disposes intermediate geometries during buildScene and supports idempotent dispose()', async () => {
  const { GeometryBuilder } = await import('./GeometryBuilder');
  const { MAP_THEMES } = await import('../styles/mapThemes');
  const provider = new LocalGeoJsonProvider();
  const fixture = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'r1',
        properties: { highway: 'primary', name: 'Road 1' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.890, 52.370],
            [4.895, 52.370],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'r2',
        properties: { highway: 'primary', name: 'Road 2' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.8925, 52.368],
            [4.8925, 52.372],
          ],
        },
      },
    ],
  };

  const parsed = provider.parseGeoJson(fixture);
  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.dusk);

  assert.ok(
    scene.resources.disposedGeometriesCount > 0,
    `Intermediate per-feature geometries must be disposed immediately after merging (disposed=${scene.resources.disposedGeometriesCount})`
  );
  assert.equal(scene.resources.disposed, false);

  const countBeforeFinalDispose = scene.resources.disposedGeometriesCount;
  scene.dispose();
  assert.equal(scene.resources.disposed, true);
  const countAfterFirstDispose = scene.resources.disposedGeometriesCount;
  assert.ok(countAfterFirstDispose > countBeforeFinalDispose, 'Final dispose() must release merged scene geometries');

  // Calling dispose() a second time must be a safe no-op
  scene.dispose();
  assert.equal(scene.resources.disposedGeometriesCount, countAfterFirstDispose, 'dispose() must be idempotent');
});

test('Road junctions preserve all contributing sourceFeatureIds on faceRanges', async () => {
  const THREE = await import('three');
  const { GeometryBuilder } = await import('./GeometryBuilder');
  const { MAP_THEMES } = await import('../styles/mapThemes');
  const provider = new LocalGeoJsonProvider();
  const crossingFixture = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'ew-road',
        properties: { highway: 'primary', name: 'East-West Ave' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.8900, 52.3700],
            [4.8920, 52.3700],
            [4.8940, 52.3700],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'ns-road',
        properties: { highway: 'secondary', name: 'North-South St' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.8920, 52.3690],
            [4.8920, 52.3700],
            [4.8920, 52.3710],
          ],
        },
      },
    ],
  };

  const parsed = provider.parseGeoJson(crossingFixture);
  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.dusk);

  let primaryMesh: THREE.Mesh | undefined;
  scene.roadsGroup.traverse((child) => {
    if ((child as THREE.Mesh).isMesh && child.name === 'Roads_primary') {
      primaryMesh = child as THREE.Mesh;
    }
  });

  assert.ok(primaryMesh, 'Primary road mesh must exist');
  const ranges = primaryMesh!.userData.faceRanges as Array<{ info: { id: string; sourceFeatureIds?: string[] } }>;
  const junctionRange = ranges.find((r) => r.info.id.startsWith('junction-'));
  assert.ok(junctionRange, 'Junction faceRange must exist on winning road class mesh');
  assert.ok(
    Array.isArray(junctionRange!.info.sourceFeatureIds) &&
      junctionRange!.info.sourceFeatureIds!.includes('ew-road') &&
      junctionRange!.info.sourceFeatureIds!.includes('ns-road'),
    `Junction faceRange must preserve all contributing road sourceFeatureIds, got ${JSON.stringify(junctionRange!.info.sourceFeatureIds)}`
  );
});

test('computeProjectedBoundsFraming and computeSceneFrustumPlanes produce valid framing and depth bounds', async () => {
  const { computeProjectedBoundsFraming, computeSceneFrustumPlanes } = await import('../scene/CameraController');
  const bounds = { minX: -220, maxX: 220, minZ: -180, maxZ: 180 };
  const framing = computeProjectedBoundsFraming(bounds, 1280, 800);

  assert.deepEqual(framing.target, [0, 0, 0]);
  assert.ok(framing.zoom > 0.2 && framing.zoom < 8.0, `Expected reasonable zoom, got ${framing.zoom}`);
  assert.ok(framing.position[1] > 100, `Expected positive camera elevation Y, got ${framing.position[1]}`);

  const frustum = computeSceneFrustumPlanes(bounds, framing.position, framing.target);
  assert.ok(frustum.near >= 0.1, `Near plane must be >= 0.1, got ${frustum.near}`);
  assert.ok(frustum.far > frustum.near + 100, `Far plane must enclose scene, got ${frustum.far}`);
});



