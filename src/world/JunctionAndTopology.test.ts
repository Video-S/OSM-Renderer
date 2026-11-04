import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  LocalGeoJsonProvider,
  TopologicalNodeIndex,
  clipPolygonRingsToBox,
  clipPolygonWithTopologyAwareFallback,
  computeRingArea2D,
  hasPolygonRingSelfIntersection,
} from './LocalGeoJsonProvider';
import { GeometryBuilder, SceneResourceManager, generateRoadRibbon } from './GeometryBuilder';
import { ELEVATION_POLICY, getRoadElevation } from './ElevationPolicy';
import { MAP_THEMES } from '../styles/mapThemes';
import { computeProjectedBoundsFraming } from '../scene/CameraController';
import { validateRoadNetworkGeometry } from './ZFightingValidator';
import {
  buildBridgeProfile3D,
  DEFAULT_BRIDGE_RAMP_MAX_FRACTION,
  DEFAULT_BRIDGE_RAMP_MAX_LENGTH_METERS,
  MIN_CENTRAL_DECK_FRACTION,
  MIN_RAMPED_BRIDGE_SPAN_METERS,
} from './BridgeAndTunnelBuilder';

test('TopologicalNodeIndex clusters nearby endpoints within tolerance without floating-point fragility', () => {
  const index = new TopologicalNodeIndex(0.15);

  // Exact coordinates
  const n1 = index.getOrCreateNode(100.0, 50.0);
  const n2 = index.getOrCreateNode(100.0, 50.0);
  assert.equal(n1, n2, 'Identical coordinates must yield identical node ID');

  // Slight floating-point variance (e.g. 5cm offset, well within 15cm tolerance)
  const n3 = index.getOrCreateNode(100.04, 50.03);
  assert.equal(n3, n1, 'Points within 15cm snapping radius must resolve to the same topological node ID');

  // Distant point (50cm away, outside 15cm tolerance)
  const n4 = index.getOrCreateNode(100.50, 50.0);
  assert.notEqual(n4, n1, 'Points separated by > 15cm must receive distinct topological node IDs');
});

test('Diagnostic provenance tracks retained, chained, and deduplicated features independently', () => {
  const fixture = {
    type: 'FeatureCollection',
    name: 'Lineage & Provenance Test Fixture',
    features: [
      // Road Segment A (West to Center)
      {
        type: 'Feature',
        id: 'way-101',
        properties: { name: 'Main St', highway: 'primary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.890, 52.378],
            [4.900, 52.378],
          ],
        },
      },
      // Road Segment B (Center to East) - contiguous with Segment A
      {
        type: 'Feature',
        id: 'way-102',
        properties: { name: 'Main St', highway: 'primary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.900, 52.378],
            [4.910, 52.378],
          ],
        },
      },
      // Exact reverse duplicate of Segment B
      {
        type: 'Feature',
        id: 'way-102-dup',
        properties: { name: 'Main St', highway: 'primary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.910, 52.378],
            [4.900, 52.378],
          ],
        },
      },
    ],
  };

  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(fixture);
  const diag = parsed.diagnostics;

  // 1. All 3 features received
  assert.equal(diag.sourceFeaturesReceived, 3);
  assert.equal(diag.sourceFeaturesClassified, 3);
  assert.equal(diag.totalFeaturesParsed, 3, 'Deduplicated feature is counted as successfully processed, not rejected');

  // 2. Lineage tracking: 1 deduplicated, 2 chained together
  assert.ok(diag.featureLineage, 'featureLineage diagnostics must be populated');
  assert.equal(diag.featureLineage.deduplicatedCount, 1, '1 duplicate way recorded in deduplicatedCount');
  assert.ok(
    diag.featureLineage.deduplicatedMap['way-102']?.includes('way-102-dup'),
    'Duplicate way-102-dup mapped to canonical way-102'
  );

  // 3. Chaining retains ALL constituent source IDs on the composite road feature
  assert.equal(parsed.roads.length, 1, 'Segment A and Segment B chained into 1 continuous roadway');
  const chainedRoad = parsed.roads[0];
  assert.ok(chainedRoad.sourceFeatureIds?.includes('way-101'));
  assert.ok(chainedRoad.sourceFeatureIds?.includes('way-102'));

  // 4. Geometry generation preserves all constituent source IDs into rendered count
  const builder = new GeometryBuilder();
  const built = builder.buildScene(parsed, MAP_THEMES.tactical);
  assert.equal(
    built.stats.renderedFeaturesCount,
    2,
    'Both constituent source features (way-101 and way-102) accounted for in rendered features count'
  );

  built.dispose();
});

test('Boundary-derived junction meshing trims incoming road ribbons and synthesizes coplanar junction polygon', () => {
  // T-Junction fixture: Main Avenue (East-West) crossed by Cross Street (South to Center)
  const tJunctionFixture = {
    type: 'FeatureCollection',
    name: 'T-Junction Boundary Test Fixture',
    features: [
      {
        type: 'Feature',
        id: 'road-main-east',
        properties: { name: 'Boulevard', highway: 'primary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.900, 52.378],
            [4.910, 52.378],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'road-main-west',
        properties: { name: 'Boulevard', highway: 'primary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.890, 52.378],
            [4.900, 52.378],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'road-side-south',
        properties: { name: 'Side Street', highway: 'residential', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.900, 52.370],
            [4.900, 52.378], // Intersection point!
          ],
        },
      },
    ],
  };

  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(tJunctionFixture);
  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.tactical);

  // Roads group must contain rendered mesh
  assert.ok(scene.roadsGroup.children.length > 0, 'Roads group must contain rendered meshes');

  // Verify that all road vertices sit at uniform physical elevation ELEVATION_POLICY.ROAD_SURFACE (0.050m)
  // and that every single triangle (both ribbons and synthesized junction polygons) has upward-facing CCW winding (crossY > 0)
  scene.roadsGroup.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      const posAttr = obj.geometry.attributes.position;
      for (let i = 0; i < posAttr.count; i++) {
        const y = posAttr.getY(i);
        assert.ok(
          Math.abs(y - ELEVATION_POLICY.ROAD_SURFACE) < 0.001,
          `At-grade road and junction vertex Y (${y}) must match uniform surface elevation (${ELEVATION_POLICY.ROAD_SURFACE})`
        );
      }

      const indexAttr = obj.geometry.getIndex();
      assert.ok(indexAttr, 'Merged road/junction geometry must be indexed');
      for (let t = 0; t < indexAttr.count; t += 3) {
        const i0 = indexAttr.getX(t);
        const i1 = indexAttr.getX(t + 1);
        const i2 = indexAttr.getX(t + 2);
        const ax = posAttr.getX(i1) - posAttr.getX(i0);
        const az = posAttr.getZ(i1) - posAttr.getZ(i0);
        const bx = posAttr.getX(i2) - posAttr.getX(i0);
        const bz = posAttr.getZ(i2) - posAttr.getZ(i0);
        const crossY = az * bx - ax * bz;
        assert.ok(
          crossY > 0,
          `Triangle ${t / 3} in ${obj.name} must have upward-facing CCW winding (crossY=${crossY} > 0) so junctions and ribbons light identically`
        );
      }
    }
  });

  const roadReport = validateRoadNetworkGeometry(scene);
  assert.equal(roadReport.overlapConflicts.length, 0, 'T-junction must have zero 2D triangle overlaps');
  assert.equal(roadReport.continuityDefects.length, 0, 'T-junction portals must connect with zero gap');

  scene.dispose();
});

test('Acute angle fork applies miter clamping and preserves zero road-vs-road triangle overlap', () => {
  // Two roads meeting at a ~20-degree sharp fork
  const acuteAngleFixture = {
    type: 'FeatureCollection',
    name: 'Acute Angle Fork Fixture',
    features: [
      {
        type: 'Feature',
        id: 'fork-branch-1',
        properties: { name: 'Branch 1', highway: 'secondary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.900, 52.378],
            [4.910, 52.378], // East
          ],
        },
      },
      {
        type: 'Feature',
        id: 'fork-branch-2',
        properties: { name: 'Branch 2', highway: 'secondary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.900, 52.378],
            [4.9094, 52.3814], // ~20 degrees from East
          ],
        },
      },
      {
        type: 'Feature',
        id: 'fork-stem',
        properties: { name: 'Stem', highway: 'secondary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.890, 52.378],
            [4.900, 52.378], // West approaching junction
          ],
        },
      },
    ],
  };

  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(acuteAngleFixture);
  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.tactical);

  assert.ok(scene.roadsGroup.children.length > 0, 'Acute junction must successfully build meshes');

  // Verify bounding box does not explode due to unclamped miter spikes
  scene.roadsGroup.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.computeBoundingBox();
      const bBox = obj.geometry.boundingBox!;
      const spanX = bBox.max.x - bBox.min.x;
      const spanZ = bBox.max.z - bBox.min.z;
      assert.ok(spanX < 2000, `Bounding box X span (${spanX}) must remain bounded without runaway miter spike`);
      assert.ok(spanZ < 2000, `Bounding box Z span (${spanZ}) must remain bounded without runaway miter spike`);
    }
  });

  const roadReport = validateRoadNetworkGeometry(scene);
  assert.equal(
    roadReport.overlapConflicts.length,
    0,
    `Acute fork must have zero 2D triangle overlaps, found: ${JSON.stringify(roadReport.overlapConflicts)}`
  );
  assert.equal(roadReport.continuityDefects.length, 0, 'Acute fork portals must connect with zero gap');

  scene.dispose();
});

test('Grade-separated bridge crossing an at-grade road is NOT merged into at-grade junction', () => {
  const bridgeFixture = {
    type: 'FeatureCollection',
    name: 'Bridge Crossing Fixture',
    features: [
      // Ground road (North-South)
      {
        type: 'Feature',
        id: 'ground-road',
        properties: { name: 'Underpass Road', highway: 'residential', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.900, 52.370],
            [4.900, 52.378],
            [4.900, 52.385],
          ],
        },
      },
      // Elevated bridge (East-West) passing over ground road at [4.900, 52.378]
      {
        type: 'Feature',
        id: 'bridge-flyover',
        properties: { name: 'Flyover Bridge', highway: 'motorway', bridge: 'yes', layer: 1 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.890, 52.378],
            [4.900, 52.378], // Crosses overhead!
            [4.910, 52.378],
          ],
        },
      },
    ],
  };

  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(bridgeFixture);
  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.tactical);

  // Verify ground road sits at 0.050m and bridge sits >= 2.85m
  const groundElev = getRoadElevation('residential', 0, false, false);
  const bridgeElev = getRoadElevation('motorway', 1, true, false);

  assert.equal(groundElev, ELEVATION_POLICY.ROAD_SURFACE);
  assert.ok(bridgeElev - groundElev >= 2.8, 'Bridge must maintain >= 2.8m physical vertical clearance');

  scene.dispose();
});

test('computeProjectedBoundsFraming fits loaded map bounds to viewport aspect ratio and tilt', () => {
  const bounds = {
    minX: -200,
    maxX: 200,
    minZ: -150,
    maxZ: 150,
    widthMeters: 400,
    depthMeters: 300,
  };

  const framing = computeProjectedBoundsFraming(bounds, 1200, 800);

  // Target center must be at centroid of bounding box
  assert.equal(framing.target[0], 0);
  assert.equal(framing.target[1], 0);
  assert.equal(framing.target[2], 0);

  // Zoom must be positive and non-zero
  assert.ok(framing.zoom > 0.5 && framing.zoom < 5.0, `Calculated zoom (${framing.zoom}) must be within reasonable view limits`);

  // Camera must be positioned along isometric azimuth (45 deg) with elevated Y
  assert.ok(framing.position[1] > 100, 'Camera Y must be elevated above ground plane');
  assert.ok(framing.position[0] > 0 && framing.position[2] > 0, 'Camera X and Z must be in positive octant for 45 deg azimuth');
});

test('SceneResourceManager executes single-pass, idempotent GPU cleanup including releaseIntermediateGeometry', () => {
  const manager = new SceneResourceManager();

  const geo1 = manager.registerGeometry(new THREE.BoxGeometry(1, 1, 1));
  const geo2 = manager.registerGeometry(new THREE.PlaneGeometry(10, 10));
  const unownedGeo = new THREE.BoxGeometry(2, 2, 2);
  const mat1 = manager.registerMaterial(new THREE.MeshStandardMaterial({ color: '#ff0000' }));
  const mat2 = manager.registerMaterial(new THREE.MeshStandardMaterial({ color: '#00ff00' }));

  assert.equal(manager.ownedGeometriesCount, 2);
  assert.equal(manager.ownedMaterialsCount, 2);

  let geo1DisposeCount = 0;
  let geo2DisposeCount = 0;
  let unownedDisposeCount = 0;
  let mat1DisposeCount = 0;
  geo1.addEventListener('dispose', () => {
    geo1DisposeCount++;
  });
  geo2.addEventListener('dispose', () => {
    geo2DisposeCount++;
  });
  unownedGeo.addEventListener('dispose', () => {
    unownedDisposeCount++;
  });
  mat1.addEventListener('dispose', () => {
    mat1DisposeCount++;
  });

  // Intermediate release: repeated calls on geo1 and unownedGeo must dispose each exactly once
  manager.releaseIntermediateGeometry(geo1);
  manager.releaseIntermediateGeometry(geo1);
  manager.releaseIntermediateGeometry(unownedGeo);
  manager.releaseIntermediateGeometry(unownedGeo);

  assert.equal(geo1DisposeCount, 1, 'Intermediate geometry must be disposed exactly once even if called twice');
  assert.equal(unownedDisposeCount, 0, 'Unowned geometry passed to releaseIntermediateGeometry must be safely ignored without disposal');
  assert.equal(manager.ownedGeometriesCount, 1, 'Remaining owned geometry count must be 1');

  // Full disposal: disposes remaining geo2 and materials, without re-disposing geo1
  manager.dispose();
  assert.equal(geo1DisposeCount, 1, 'Already-released intermediate geometry must not be double-disposed during dispose()');
  assert.equal(geo2DisposeCount, 1, 'Remaining owned geometry must be disposed once');
  assert.equal(mat1DisposeCount, 1, 'Material must be disposed once');
  assert.equal(manager.ownedGeometriesCount, 0);
  assert.equal(manager.ownedMaterialsCount, 0);

  // Second disposal: safe no-op (idempotent, does not throw or double-dispose)
  assert.doesNotThrow(() => {
    manager.dispose();
  }, 'Repeated dispose calls must be idempotent and safe');
  assert.equal(geo2DisposeCount, 1);
  assert.equal(mat1DisposeCount, 1);
});

test('Mid-polyline T-junctions split main road at shared interior vertex and narrow-stream culverts stay continuous at ROAD_SURFACE', () => {
  // Simulates Industriestraat / Industrieplein / Fabrieksstraat in Hengelo:
  // 1. Main road with 3 vertices where a side road meets the middle (interior) vertex
  // 2. Short ~10.2m culvert bridge segment crossing over a narrow stream way (Berflobeek)
  // 3. Top-level relation/998877 MultiLineString waterway collection that lacks f.properties.id
  const hengeloJunctionFixture = {
    type: 'FeatureCollection',
    name: 'Hengelo Mid-Polyline & Culvert Continuity Fixture',
    features: [
      {
        type: 'Feature',
        id: 'main-road-continuous',
        properties: { name: 'Industrieplein', highway: 'secondary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [6.7920, 52.2625],
            [6.7930, 52.2625], // Shared interior vertex!
            [6.7940, 52.2625],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'side-road-fabrieksstraat',
        properties: { name: 'Fabrieksstraat', highway: 'residential', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [6.7930, 52.2618],
            [6.7930, 52.2625], // Meets interior vertex of Industrieplein!
          ],
        },
      },
      {
        type: 'Feature',
        id: 'short-culvert-bridge',
        properties: {
          name: 'Industrieplein',
          highway: 'secondary',
          bridge: 'culvert',
          culvert: 'yes',
          layer: 0,
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [6.7940, 52.2625], // Connected to end of main-road-continuous
            [6.79415, 52.2625], // ~10.2m culvert span over Berflobeek stream
          ],
        },
      },
      {
        type: 'Feature',
        id: 'way/887766',
        properties: { name: 'Berflobeek', waterway: 'stream' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [6.79407, 52.2620],
            [6.79407, 52.2630],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'relation/998877',
        properties: { name: 'Berflobeek Collection Relation', waterway: 'stream' },
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [6.79405, 52.2615],
              [6.79405, 52.2635],
            ],
          ],
        },
      },
    ],
  };

  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(hengeloJunctionFixture);

  // Top-level relation/998877 waterway collection must be filtered out while way/887766 is retained
  assert.equal(parsed.linearWaterways.length, 1, 'Only way/887766 stream should be kept; relation/998877 skipped');

  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.tactical);

  // Verify that all road & junction vertices sit at uniform ROAD_SURFACE (0.050m)
  // because the short 10.2m stream-crossing culvert stays continuous with Industrieplein,
  // and every ear-clipped junction triangle has upward-facing CCW winding (crossY > 0).
  scene.roadsGroup.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      const posAttr = obj.geometry.attributes.position;
      for (let i = 0; i < posAttr.count; i++) {
        const y = posAttr.getY(i);
        assert.ok(
          Math.abs(y - ELEVATION_POLICY.ROAD_SURFACE) < 0.001,
          `Short culvert bridge and mid-polyline junction vertex Y (${y}) must remain flush at ${ELEVATION_POLICY.ROAD_SURFACE}`
        );
      }

      const indexAttr = obj.geometry.getIndex()!;
      for (let t = 0; t < indexAttr.count; t += 3) {
        const i0 = indexAttr.getX(t);
        const i1 = indexAttr.getX(t + 1);
        const i2 = indexAttr.getX(t + 2);
        const ax = posAttr.getX(i1) - posAttr.getX(i0);
        const az = posAttr.getZ(i1) - posAttr.getZ(i0);
        const bx = posAttr.getX(i2) - posAttr.getX(i0);
        const bz = posAttr.getZ(i2) - posAttr.getZ(i0);
        const crossY = az * bx - ax * bz;
        assert.ok(crossY > 0, `Ear-clipped junction triangle must have upward CCW winding (crossY=${crossY})`);
      }
    }
  });

  scene.dispose();
});

test('Short grade-separated bridge (< 15m) crossing a road or canal is NOT reclassified as an at-grade culvert', () => {
  const shortBridgeOverRoadFixture = {
    type: 'FeatureCollection',
    name: 'Short 11m Overpass Bridge Fixture',
    features: [
      // Lower road running North-South at grade
      {
        type: 'Feature',
        id: 'lower-road-ns',
        properties: { name: 'Lower Street', highway: 'residential', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.9000, 52.3775],
            [4.9000, 52.3785],
          ],
        },
      },
      // Short (~11m) elevated bridge span crossing East-West over Lower Street
      {
        type: 'Feature',
        id: 'short-overpass-bridge',
        properties: { name: 'Short Overpass', highway: 'secondary', bridge: 'yes', layer: 1 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.89992, 52.3780],
            [4.90008, 52.3780], // ~10.8m span
          ],
        },
      },
    ],
  };

  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(shortBridgeOverRoadFixture);

  const bridgeRoad = parsed.roads.find(
    (r) => r.sourceFeatureId === 'short-overpass-bridge' || r.id.includes('short-overpass-bridge')
  );
  assert.ok(bridgeRoad, 'Short overpass bridge must be present in parsed roads');
  assert.equal(bridgeRoad!.isBridge, true, 'Short bridge crossing a road must retain isBridge=true');
  assert.equal(bridgeRoad!.layer, 1, 'Short bridge crossing a road must retain layer=1');

  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.tactical);

  // Verify that the short bridge renders as an elevated 3D bridge with substructure & parapets
  let maxRoadVertexY = 0;
  let hasBridgeSubstructure = false;
  let hasBridgeParapets = false;
  scene.roadsGroup.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      if (obj.name === 'Bridge_Substructure') hasBridgeSubstructure = true;
      if (obj.name === 'Bridge_Parapets') hasBridgeParapets = true;
      const posAttr = obj.geometry.attributes.position;
      for (let i = 0; i < posAttr.count; i++) {
        if (posAttr.getY(i) > maxRoadVertexY) {
          maxRoadVertexY = posAttr.getY(i);
        }
      }
    }
  });

  assert.ok(
    maxRoadVertexY >= ELEVATION_POLICY.ROAD_SURFACE + ELEVATION_POLICY.BRIDGE_BASE_CLEARANCE - 0.05,
    `Short overpass bridge (< 15m) must reach elevated bridge deck height (>= 2.80m), got ${maxRoadVertexY}`
  );
  assert.ok(hasBridgeSubstructure, 'Short overpass bridge must generate Bridge_Substructure mesh');
  assert.ok(hasBridgeParapets, 'Short overpass bridge must generate Bridge_Parapets mesh');

  scene.dispose();
});

test('Degenerate or self-intersecting path clipping failure records diagnostic and never falls back to overlapping ribbon', () => {
  // Includes:
  // 1. An East-West primary vehicular road at Y = 0.050m
  // 2. A footpath with a 180-degree fold-back spike crossing the road (recoverable via Stage 2 cleanup)
  // 3. A self-crossing bow-tie figure-8 footpath directly inside/overlapping the road (triggers Stage 3 fallback)
  // 4. A footpath completely inside the vehicular carriageway (records featuresFullySubtracted and not rendered)
  const degeneratePathFixture = {
    type: 'FeatureCollection',
    name: 'Degenerate Path Clipping Failure Fixture',
    features: [
      {
        type: 'Feature',
        id: 'vehicular-main-road',
        properties: { name: 'Main Ave', highway: 'primary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.8990, 52.3780],
            [4.9010, 52.3780],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'path-with-foldback-spike',
        properties: { name: 'Spike Path', highway: 'footway', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.9000, 52.3777],
            [4.9000, 52.3781],
            [4.9000, 52.3778], // 180-degree fold-back spike!
            [4.9000, 52.3783],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'path-bowtie-unclippable',
        properties: { name: 'Bowtie Path', highway: 'path', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.8998, 52.3778],
            [4.9002, 52.3782],
            [4.8998, 52.3782],
            [4.9002, 52.3778], // Self-intersecting bow-tie crossing over the road!
            [4.8998, 52.3778],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'path-completely-inside-road',
        properties: { name: 'Submerged Sidewalk', highway: 'footway', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.8995, 52.3780],
            [4.8997, 52.3780],
          ],
        },
      },
    ],
  };

  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(degeneratePathFixture);
  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.tactical);

  // 1. Bow-tie self-crossing path must be recorded in clippingFailures and rejectedInvalid
  assert.ok(
    parsed.diagnostics.clippingFailures && parsed.diagnostics.clippingFailures.count >= 1,
    'Self-intersecting bow-tie path must increment diagnostics.clippingFailures.count'
  );
  assert.ok(
    parsed.diagnostics.clippingFailures!.sampleIds.includes('path-bowtie-unclippable'),
    'clippingFailures.sampleIds must record path-bowtie-unclippable'
  );
  assert.ok(
    parsed.diagnostics.rejectedInvalid.byReason['path_boolean_clipping_failed']?.count >= 1,
    'rejectedInvalid must record path_boolean_clipping_failed reason'
  );

  // 2. Submerged path completely inside the road carriageway must be recorded in featuresFullySubtracted
  assert.ok(
    parsed.diagnostics.featuresFullySubtracted &&
      parsed.diagnostics.featuresFullySubtracted.count >= 1 &&
      parsed.diagnostics.featuresFullySubtracted.sampleIds.includes('path-completely-inside-road'),
    'Path completely subtracted by vehicular road must be recorded in diagnostics.featuresFullySubtracted'
  );

  // 3. Zero coplanar 2D triangle overlaps across all generated road and path meshes at Y = 0.050m!
  const roadReport = validateRoadNetworkGeometry(scene);
  assert.equal(
    roadReport.overlapConflicts.length,
    0,
    `Failure path must NEVER generate overlapping coplanar road/path triangles, got: ${JSON.stringify(roadReport.overlapConflicts)}`
  );

  scene.dispose();
});

test('Road-network triangle overlap and portal continuity validator passes across all 7 intersection archetypes', () => {
  // Comprehensive fixture containing:
  // 1. Orthogonal 4-way intersection at [4.900, 52.378]
  // 2. T-junction at [4.902, 52.378]
  // 3. Acute fork (~25 deg) at [4.904, 52.378]
  // 4. 5-way star junction at [4.900, 52.380]
  // 5. Degree-2 bend & collinear continuation at [4.898, 52.378]
  // 6. Mixed-width junction (primary + secondary + service) at [4.902, 52.380]
  // 7. Pedestrian footway crossing & meeting vehicular roads
  const sevenScenariosFixture = {
    type: 'FeatureCollection',
    name: 'Seven Road Intersection Archetypes Fixture',
    features: [
      // 1 & 5: West approach with degree-2 bend at [4.898, 52.378] into 4-way at [4.900, 52.378]
      {
        type: 'Feature',
        id: 'road-west-outer',
        properties: { highway: 'primary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.896, 52.3779],
            [4.898, 52.3780],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'road-west-inner',
        properties: { highway: 'primary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.898, 52.3780],
            [4.900, 52.3780],
          ],
        },
      },
      // 1 & 2: Segment from 4-way [4.900, 52.378] to T-junction [4.902, 52.378] to Acute fork [4.904, 52.378]
      {
        type: 'Feature',
        id: 'road-center-east',
        properties: { highway: 'primary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.900, 52.3780],
            [4.902, 52.3780],
            [4.904, 52.3780],
          ],
        },
      },
      // 1: South and North arms of 4-way at [4.900, 52.378] (North arm goes to 5-way star at [4.900, 52.380])
      {
        type: 'Feature',
        id: 'road-4way-south',
        properties: { highway: 'secondary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.900, 52.3765],
            [4.900, 52.3780],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'road-4way-north-to-star',
        properties: { highway: 'secondary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.900, 52.3780],
            [4.900, 52.3800],
          ],
        },
      },
      // 2: T-junction south stem at [4.902, 52.378]
      {
        type: 'Feature',
        id: 'road-t-south',
        properties: { highway: 'residential', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.902, 52.3765],
            [4.902, 52.3780],
          ],
        },
      },
      // 3: Acute fork branches at [4.904, 52.378]
      {
        type: 'Feature',
        id: 'road-fork-1',
        properties: { highway: 'primary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.904, 52.3780],
            [4.906, 52.3780],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'road-fork-2',
        properties: { highway: 'secondary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.904, 52.3780],
            [4.9058, 52.3786],
          ],
        },
      },
      // 4: Remaining 4 branches of 5-way star at [4.900, 52.380]
      {
        type: 'Feature',
        id: 'road-star-n',
        properties: { highway: 'secondary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.900, 52.3800],
            [4.900, 52.3815],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'road-star-w',
        properties: { highway: 'residential', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.898, 52.3800],
            [4.900, 52.3800],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'road-star-nw',
        properties: { highway: 'tertiary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.8985, 52.3812],
            [4.900, 52.3800],
          ],
        },
      },
      // 4 & 6: East branch from 5-way star [4.900, 52.380] to mixed-width junction [4.902, 52.380]
      {
        type: 'Feature',
        id: 'road-star-to-mixed',
        properties: { highway: 'primary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.900, 52.3800],
            [4.902, 52.3800],
          ],
        },
      },
      // 6: Mixed-width branches at [4.902, 52.380] (secondary + narrow service alley)
      {
        type: 'Feature',
        id: 'road-mixed-north',
        properties: { highway: 'secondary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.902, 52.3800],
            [4.902, 52.3815],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'road-mixed-service',
        properties: { highway: 'service', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.902, 52.3800],
            [4.9035, 52.3800],
          ],
        },
      },
      // 7: Pedestrian footway crossing primary road and meeting residential road
      {
        type: 'Feature',
        id: 'footway-crossing',
        properties: { highway: 'footway', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.901, 52.3772],
            [4.901, 52.3788],
          ],
        },
      },
    ],
  };

  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(sevenScenariosFixture);
  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.tactical);

  const report = validateRoadNetworkGeometry(scene);
  assert.equal(
    report.overlapConflicts.length,
    0,
    `All 7 road intersection scenarios must have zero 2D triangle overlaps, got: ${JSON.stringify(report.overlapConflicts)}`
  );
  assert.equal(
    report.continuityDefects.length,
    0,
    `All 7 road intersection scenarios must have watertight junction-to-ribbon continuity, got: ${JSON.stringify(report.continuityDefects)}`
  );
  assert.equal(report.isValid, true);

  scene.dispose();
});

test('Region boundary clipping trims polylines and polygons to [-clipRadius, +clipRadius] and aligns bounds with geometry', () => {
  const center: [number, number] = [52.378, 4.900]; // [lat, lon]
  const boundaryFixture = {
    type: 'FeatureCollection',
    name: 'Region Boundary Clipping Fixture',
    features: [
      // Long highway extending ~2km East-West across a 150m clip radius
      {
        type: 'Feature',
        id: 'long-highway',
        properties: { highway: 'primary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.880, 52.378],
            [4.920, 52.378],
          ],
        },
      },
      // Huge park polygon extending well outside the 150m clip radius
      {
        type: 'Feature',
        id: 'huge-park',
        properties: { leisure: 'park', name: 'Regional Park' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [4.885, 52.370],
              [4.915, 52.370],
              [4.915, 52.386],
              [4.885, 52.386],
              [4.885, 52.370],
            ],
          ],
        },
      },
      // Far-away building completely outside the 150m clip radius
      {
        type: 'Feature',
        id: 'distant-building',
        properties: { building: 'yes' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [4.930, 52.390],
              [4.931, 52.390],
              [4.931, 52.391],
              [4.930, 52.391],
              [4.930, 52.390],
            ],
          ],
        },
      },
    ],
  };

  const clipRadius = 150;
  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(
    boundaryFixture,
    'Clipped Region',
    [center[1], center[0]], // [lon, lat]
    clipRadius
  );

  // Distant building outside clip box must be excluded
  assert.equal(parsed.buildings.length, 0, 'Building completely outside clip radius must be excluded');

  // Long highway and huge park must be clipped to [-150, +150]
  assert.equal(parsed.roads.length, 1);
  for (const [x, z] of parsed.roads[0].points) {
    assert.ok(
      Math.abs(x) <= clipRadius + 0.05 && Math.abs(z) <= clipRadius + 0.05,
      `Clipped road point [${x}, ${z}] must lie within clipRadius (${clipRadius}m)`
    );
  }
  assert.equal(parsed.parks.length, 1);
  for (const [x, z] of parsed.parks[0].polygon[0]) {
    assert.ok(
      Math.abs(x) <= clipRadius + 0.05 && Math.abs(z) <= clipRadius + 0.05,
      `Clipped park polygon vertex [${x}, ${z}] must lie within clipRadius (${clipRadius}m)`
    );
  }

  // Bounds must match clipped geometry within [-150, +150]
  assert.ok(parsed.bounds.minX >= -clipRadius - 0.1 && parsed.bounds.maxX <= clipRadius + 0.1);
  assert.ok(parsed.bounds.minZ >= -clipRadius - 0.1 && parsed.bounds.maxZ <= clipRadius + 0.1);
  assert.ok(
    parsed.diagnostics.featuresClippedByBoundary &&
      parsed.diagnostics.featuresClippedByBoundary.clippedCount >= 2,
    'featuresClippedByBoundary diagnostic must count clipped road and park'
  );
});

test('TopologicalNodeIndex unifies explicit OSM node IDs and coordinate-only fallback ways in the same layerScope', () => {
  // Way A has explicit _nodeIds [5001, 5002]; Way B lacks _nodeIds but shares the exact coordinate of node 5002
  const mixedTopologyFixture = {
    type: 'FeatureCollection',
    name: 'Mixed Explicit and Coordinate-Only Topology Fixture',
    features: [
      {
        type: 'Feature',
        id: 'way-explicit',
        properties: { name: 'Shared Road', highway: 'tertiary', layer: 0, _nodeIds: [5001, 5002] },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.898, 52.378],
            [4.900, 52.378],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'way-coord-only',
        properties: { name: 'Shared Road', highway: 'tertiary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.900, 52.378],
            [4.902, 52.378],
          ],
        },
      },
    ],
  };

  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(mixedTopologyFixture);

  // Because Way A and Way B share the same node at [4.900, 52.378] in layer 0, they must chain into 1 continuous road!
  assert.equal(
    parsed.roads.length,
    1,
    'Explicit-node way and coordinate-only way meeting at the same point must resolve to the same topological node and chain'
  );

  // Also verify two DISTINCT explicit OSM node IDs at identical coordinates are never merged together
  const topo = new TopologicalNodeIndex(0.25);
  const idA = topo.getOrCreateNode(10.0, 20.0, '0|false|false', '11111');
  const idB = topo.getOrCreateNode(10.0, 20.0, '0|false|false', '22222');
  assert.notEqual(idA, idB, 'Two distinct explicit OSM node IDs must never be merged even at identical coordinates');
  const idC = topo.getOrCreateNode(30.0, 40.0, '0|false|false', '33333');
  const coordFallback = topo.getOrCreateNode(30.05, 40.02, '0|false|false');
  assert.equal(coordFallback, idC, 'Coordinate-only fallback within tolerance must snap to indexed explicit node in same layerScope');
});

test('Bridge ramp profile transitions over min(12m, 30% of bridge length) as documented', () => {
  assert.equal(DEFAULT_BRIDGE_RAMP_MAX_LENGTH_METERS, 12.0);
  assert.equal(DEFAULT_BRIDGE_RAMP_MAX_FRACTION, 0.30);

  // 1. 60m bridge: 30% is 18m, so ramp is capped at 12.0m
  const longBridge = buildBridgeProfile3D({
    points: [
      [0, 0],
      [60, 0],
    ],
    baseElevation: 0.05,
    targetBridgeElevation: 2.85,
    connectsStartAtGrade: true,
    connectsEndAtGrade: true,
    connectsStartBridge: false,
    connectsEndBridge: false,
  });
  const at12m = longBridge.profile.find((p) => Math.abs(p.arcLength - 12.0) < 0.05);
  assert.ok(at12m && Math.abs(at12m.y - 2.85) < 1e-4, '60m bridge must reach full deck elevation at 12.0m');

  // 2. 20m bridge: 30% is 6.0m (< 12.0m), so ramp is 6.0m
  const shortBridge = buildBridgeProfile3D({
    points: [
      [0, 0],
      [20, 0],
    ],
    baseElevation: 0.05,
    targetBridgeElevation: 2.85,
    connectsStartAtGrade: true,
    connectsEndAtGrade: true,
    connectsStartBridge: false,
    connectsEndBridge: false,
  });
  const at6m = shortBridge.profile.find((p) => Math.abs(p.arcLength - 6.0) < 0.05);
  assert.ok(at6m && Math.abs(at6m.y - 2.85) < 1e-4, '20m bridge must reach full deck elevation at 6.0m (30% of 20m)');
});

test('Issue 1 Regression: validateRoadNetworkGeometry detects same-feature self-overlaps, junction portal gaps, and missing connected roads', () => {
  // Build a clean T-junction scene first
  const tJunctionFixture = {
    type: 'FeatureCollection',
    name: 'Validator Defect Detection Fixture',
    features: [
      {
        type: 'Feature',
        id: 'road-east',
        properties: { highway: 'primary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.900, 52.378],
            [4.902, 52.378],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'road-west',
        properties: { highway: 'primary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.898, 52.378],
            [4.900, 52.378],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'road-south',
        properties: { highway: 'residential', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.900, 52.3765],
            [4.900, 52.378],
          ],
        },
      },
    ],
  };

  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(tJunctionFixture);
  const builder = new GeometryBuilder();
  const cleanScene = builder.buildScene(parsed, MAP_THEMES.tactical);

  const cleanReport = validateRoadNetworkGeometry(cleanScene);
  assert.equal(cleanReport.isValid, true, 'Clean T-junction must pass validation');

  // A. Deliberately introduce a same-feature self-overlapping triangle into road-east
  let injectedSelfOverlap = false;
  cleanScene.roadsGroup.traverse((obj) => {
    if (injectedSelfOverlap || !(obj instanceof THREE.Mesh)) return;
    const ranges = obj.userData?.faceRanges;
    if (!Array.isArray(ranges)) return;
    const eastRange = ranges.find(
      (r: any) => r.info?.sourceFeatureId === 'road-east' && !String(r.info?.id).startsWith('junction-')
    );
    if (!eastRange) return;

    const posAttr = obj.geometry.attributes.position;
    const indexAttr = obj.geometry.getIndex()!;
    const oldIndices = Array.from(indexAttr.array);
    // Duplicate the first triangle of road-east with identical featureId so it self-overlaps with positive area
    const i0 = indexAttr.getX(eastRange.startFace * 3);
    const i1 = indexAttr.getX(eastRange.startFace * 3 + 1);
    const i2 = indexAttr.getX(eastRange.startFace * 3 + 2);
    // Insert at the end of eastRange and shift subsequent faceRanges
    const origEndFace = eastRange.endFace;
    const insertIdx = origEndFace * 3;
    oldIndices.splice(insertIdx, 0, i0, i1, i2);
    for (const r of ranges) {
      if (r === eastRange) {
        r.endFace += 1;
      } else if (r.startFace >= origEndFace) {
        r.startFace += 1;
        r.endFace += 1;
      }
    }
    obj.geometry.setIndex(oldIndices);
    assert.ok(posAttr.count > 0);
    injectedSelfOverlap = true;
  });
  assert.equal(injectedSelfOverlap, true, 'Must inject same-feature self-overlap');

  const selfOverlapReport = validateRoadNetworkGeometry(cleanScene);
  assert.equal(
    selfOverlapReport.isValid,
    false,
    'Validator must fail when a road feature contains self-overlapping coplanar triangles'
  );
  assert.ok(
    selfOverlapReport.overlapConflicts.some(
      (c) => c.featureA === c.featureB && c.featureA.includes('road-east')
    ),
    `Expected same-feature overlap conflict on road-east, got: ${JSON.stringify(selfOverlapReport.overlapConflicts)}`
  );
  cleanScene.dispose();

  // B. Deliberately introduce a 0.35m portal gap on road-south (while road-east and road-west remain connected)
  const gapScene = builder.buildScene(provider.parseGeoJson(tJunctionFixture), MAP_THEMES.tactical);
  let shiftedPortal = false;
  gapScene.roadsGroup.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const ranges = obj.userData?.faceRanges;
    if (!Array.isArray(ranges)) return;
    const southRange = ranges.find(
      (r: any) => r.info?.sourceFeatureId === 'road-south' && !String(r.info?.id).startsWith('junction-')
    );
    if (!southRange) return;

    const posAttr = obj.geometry.attributes.position;
    const indexAttr = obj.geometry.getIndex()!;
    const vertIndices = new Set<number>();
    for (let f = southRange.startFace; f < southRange.endFace; f++) {
      vertIndices.add(indexAttr.getX(f * 3));
      vertIndices.add(indexAttr.getX(f * 3 + 1));
      vertIndices.add(indexAttr.getX(f * 3 + 2));
    }
    // Pull road-south vertices 0.45m South (away from the junction portal)
    for (const vIdx of vertIndices) {
      posAttr.setZ(vIdx, posAttr.getZ(vIdx) + 0.45);
    }
    posAttr.needsUpdate = true;
    shiftedPortal = true;
  });
  assert.equal(shiftedPortal, true, 'Must shift road-south portal vertices to create a gap');

  const portalGapReport = validateRoadNetworkGeometry(gapScene);
  assert.equal(
    portalGapReport.isValid,
    false,
    'Validator must fail when a specific junction portal has a continuity gap even though other branches touch the junction'
  );
  assert.ok(
    portalGapReport.continuityDefects.some(
      (d) => d.roadFeatureId.includes('road-south') && d.reason === 'portal_gap' && d.minVertexGapMeters > 0.2
    ),
    `Expected portal_gap defect on road-south, got: ${JSON.stringify(portalGapReport.continuityDefects)}`
  );

  // C. Deliberately remove road-south from faceRanges to simulate a missing connected road
  gapScene.roadsGroup.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const ranges = obj.userData?.faceRanges;
    if (!Array.isArray(ranges)) return;
    obj.userData.faceRanges = ranges.filter(
      (r: any) => !(r.info?.sourceFeatureId === 'road-south' && !String(r.info?.id).startsWith('junction-'))
    );
  });

  const missingRoadReport = validateRoadNetworkGeometry(gapScene);
  assert.equal(missingRoadReport.isValid, false, 'Validator must fail when a connected road is missing');
  assert.ok(
    missingRoadReport.continuityDefects.some(
      (d) => d.roadFeatureId.includes('road-south') && d.reason === 'missing_connected_road'
    ),
    `Expected missing_connected_road defect on road-south, got: ${JSON.stringify(missingRoadReport.continuityDefects)}`
  );

  gapScene.dispose();
});

test('Issue 2 Regression: Short bridges preserve full agreed targetBridgeElevation (2.850m) across all 5 bridge/culvert scenarios', () => {
  const targetDeckY = Number((ELEVATION_POLICY.ROAD_SURFACE + ELEVATION_POLICY.BRIDGE_BASE_CLEARANCE).toFixed(4)); // 2.850m
  assert.equal(targetDeckY, 2.85);
  assert.equal(MIN_RAMPED_BRIDGE_SPAN_METERS, 5.0);
  assert.equal(MIN_CENTRAL_DECK_FRACTION, 0.40);

  // (a) Short bridge (~12m) connected to at-grade roads at BOTH ends (crossing a narrow stream without culvert tag)
  const shortConnectedBridgeFixture = {
    type: 'FeatureCollection',
    name: 'Short Connected Bridge Fixture',
    features: [
      {
        type: 'Feature',
        id: 'approach-west',
        properties: { name: 'Canal St', highway: 'secondary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.8995, 52.3780],
            [4.8999, 52.3780],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'short-bridge-12m',
        properties: { name: 'Canal St Bridge', highway: 'secondary', bridge: 'yes', layer: 1 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.8999, 52.3780],
            [4.9001, 52.3780], // ~13.5m span connected to at-grade roads at both ends
          ],
        },
      },
      {
        type: 'Feature',
        id: 'approach-east',
        properties: { name: 'Canal St', highway: 'secondary', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.9001, 52.3780],
            [4.9005, 52.3780],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'canal-underneath',
        properties: { name: 'City Canal', waterway: 'canal' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.9000, 52.3775],
            [4.9000, 52.3785],
          ],
        },
      },
    ],
  };

  const provider = new LocalGeoJsonProvider();
  const parsedShortConnected = provider.parseGeoJson(shortConnectedBridgeFixture);
  const builder = new GeometryBuilder();
  const sceneShortConnected = builder.buildScene(parsedShortConnected, MAP_THEMES.tactical);

  let maxShortConnectedY = 0;
  sceneShortConnected.roadsGroup.traverse((obj) => {
    if (
      obj instanceof THREE.Mesh &&
      obj.name !== 'Bridge_Parapets' &&
      obj.name !== 'Bridge_Substructure' &&
      obj.name !== 'Bridge_Piers'
    ) {
      const posAttr = obj.geometry.attributes.position;
      for (let i = 0; i < posAttr.count; i++) {
        if (posAttr.getY(i) > maxShortConnectedY) {
          maxShortConnectedY = posAttr.getY(i);
        }
      }
    }
  });
  assert.ok(
    Math.abs(maxShortConnectedY - targetDeckY) < 1e-3,
    `(a) Short bridge connected to at-grade roads at both ends must reach full targetBridgeElevation (${targetDeckY}m), got ${maxShortConnectedY}m`
  );
  sceneShortConnected.dispose();

  // Direct profile verification for (a) 12m bridge connected at both ends
  const profile12m = buildBridgeProfile3D({
    points: [
      [0, 0],
      [12, 0],
    ],
    baseElevation: ELEVATION_POLICY.ROAD_SURFACE,
    targetBridgeElevation: targetDeckY,
    connectsStartAtGrade: true,
    connectsEndAtGrade: true,
    connectsStartBridge: false,
    connectsEndBridge: false,
  });
  assert.equal(profile12m.peakElevation, targetDeckY, '12m bridge peakElevation must equal 2.850m');
  assert.equal(profile12m.rampMode, 'adapted_ramp', '12m bridge must use adapted_ramp mode');
  assert.ok(Math.abs(profile12m.rampStartLength - 3.6) < 1e-4, '12m bridge start ramp must be 3.6m (30%)');
  assert.ok(Math.abs(profile12m.rampEndLength - 3.6) < 1e-4, '12m bridge end ramp must be 3.6m (30%)');
  const flatDeckPoints = profile12m.profile.filter(
    (p) => p.arcLength >= 3.6 - 1e-4 && p.arcLength <= 8.4 + 1e-4
  );
  assert.ok(flatDeckPoints.length >= 2, 'Central 40% flat deck must contain multiple sampled points');
  for (const pt of flatDeckPoints) {
    assert.ok(
      Math.abs(pt.y - targetDeckY) < 1e-4,
      `Central deck sample at s=${pt.arcLength} must sit at full ${targetDeckY}m, got ${pt.y}`
    );
  }

  // (b) Short bridge (10m) crossing another road without at-grade endpoints (standalone approach extensions must not distort mappedBridgeLength)
  const profile10mStandalone = buildBridgeProfile3D({
    points: [
      [0, 0],
      [10, 0],
    ],
    baseElevation: ELEVATION_POLICY.ROAD_SURFACE,
    targetBridgeElevation: targetDeckY,
    connectsStartAtGrade: false,
    connectsEndAtGrade: false,
    connectsStartBridge: false,
    connectsEndBridge: false,
  });
  assert.equal(profile10mStandalone.peakElevation, targetDeckY);
  assert.equal(profile10mStandalone.mappedBridgeLength, 10.0, 'mappedBridgeLength must reflect original 10m span');

  // (c) Longer bridge (60m) with standard 12.0m approach ramps
  const profile60m = buildBridgeProfile3D({
    points: [
      [0, 0],
      [60, 0],
    ],
    baseElevation: ELEVATION_POLICY.ROAD_SURFACE,
    targetBridgeElevation: targetDeckY,
    connectsStartAtGrade: true,
    connectsEndAtGrade: true,
    connectsStartBridge: false,
    connectsEndBridge: false,
  });
  assert.equal(profile60m.rampMode, 'standard_ramp');
  assert.equal(profile60m.rampStartLength, 12.0);
  assert.equal(profile60m.rampEndLength, 12.0);
  assert.equal(profile60m.peakElevation, targetDeckY);

  // (d) Ultra-short bridge (3.5m < 5.0m MIN_RAMPED_BRIDGE_SPAN_METERS) using documented 'abutment_headwall' fallback
  const profileUltraShort = buildBridgeProfile3D({
    points: [
      [0, 0],
      [3.5, 0],
    ],
    baseElevation: ELEVATION_POLICY.ROAD_SURFACE,
    targetBridgeElevation: targetDeckY,
    connectsStartAtGrade: true,
    connectsEndAtGrade: true,
    connectsStartBridge: false,
    connectsEndBridge: false,
  });
  assert.equal(
    profileUltraShort.rampMode,
    'abutment_headwall',
    'Ultra-short bridge (< 5.0m) must use documented abutment_headwall fallback'
  );
  assert.equal(profileUltraShort.rampStartLength, 0);
  assert.equal(profileUltraShort.rampEndLength, 0);
  assert.equal(profileUltraShort.peakElevation, targetDeckY);
  for (const pt of profileUltraShort.profile) {
    assert.ok(
      Math.abs(pt.y - targetDeckY) < 1e-4,
      `Ultra-short bridge deck must sit at full ${targetDeckY}m across entire span, got ${pt.y}`
    );
  }

  // (e) Explicit culvert (`tunnel=culvert` / `culvert=yes`) stays at at-grade ROAD_SURFACE (0.050m)
  const explicitCulvertFixture = {
    type: 'FeatureCollection',
    name: 'Explicit Culvert Fixture',
    features: [
      {
        type: 'Feature',
        id: 'culvert-way',
        properties: { highway: 'tertiary', tunnel: 'culvert', culvert: 'yes', layer: -1 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.9000, 52.3780],
            [4.9002, 52.3780],
          ],
        },
      },
    ],
  };
  const parsedCulvert = provider.parseGeoJson(explicitCulvertFixture);
  assert.equal(parsedCulvert.roads.length, 1);
  assert.equal(parsedCulvert.roads[0].isBridge, false);
  assert.equal(parsedCulvert.roads[0].isTunnel, false);
  assert.equal(parsedCulvert.roads[0].layer, 0);
});

test('Issue 3 Regression: Explicit OSM node IDs (nodes, nodeIds, _nodeIds) drive road parsing, chaining, and junction creation end-to-end', () => {
  // End-to-end fixture testing:
  // 1. Explicit `nodes` array on way-n1 and `nodeIds` array on way-n2 sharing explicit node 9002 -> must unify at node 9002
  // 2. Coordinate-only way-coord-first placed BEFORE explicit-node way-explicit-second at node 9002 -> must still unify at node 9002 regardless of feature order!
  // 3. Two ways at identical coordinates [4.902, 52.378] with DISTINCT explicit node IDs (9101 vs 9102) -> must NOT merge or create a junction!
  // 4. Grade-separated bridge way at [4.900, 52.378] sharing raw OSM node ID 9002 with at-grade roads -> must NOT merge across layer/grade!
  const explicitNodeEndToEndFixture = {
    type: 'FeatureCollection',
    name: 'Explicit Node End-to-End Integration Fixture',
    features: [
      // Coordinate-only branch listed FIRST (approaching [4.900, 52.378] from South)
      {
        type: 'Feature',
        id: 'way-coord-first',
        properties: { name: 'South Stem', highway: 'residential', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.900, 52.377],
            [4.900, 52.378], // Matches node 9002 coordinate!
          ],
        },
      },
      // Explicit `nodes` property (West to Center [4.900, 52.378])
      {
        type: 'Feature',
        id: 'way-explicit-nodes',
        properties: {
          name: 'West Ave',
          highway: 'primary',
          layer: 0,
          nodes: [9001, 9002],
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.898, 52.378],
            [4.900, 52.378],
          ],
        },
      },
      // Explicit `nodeIds` property (Center [4.900, 52.378] to East [4.901, 52.378])
      {
        type: 'Feature',
        id: 'way-explicit-nodeids',
        properties: {
          name: 'East Ave',
          highway: 'secondary',
          layer: 0,
          nodeIds: ['9002', '9003'],
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.900, 52.378],
            [4.901, 52.378],
          ],
        },
      },
      // Two ways meeting at [4.902, 52.378] with DISTINCT explicit node IDs (9101 vs 9102)
      {
        type: 'Feature',
        id: 'way-distinct-a',
        properties: {
          name: 'Cul-de-sac A',
          highway: 'residential',
          layer: 0,
          nodes: [9100, 9101],
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.902, 52.377],
            [4.902, 52.378],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'way-distinct-b',
        properties: {
          name: 'Cul-de-sac B',
          highway: 'residential',
          layer: 0,
          nodes: [9102, 9103],
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.902, 52.378], // Identical coordinate to node 9101, but distinct explicit node ID 9102!
            [4.902, 52.379],
          ],
        },
      },
      // Grade-separated bridge passing over [4.900, 52.378] with raw node ID 9002
      {
        type: 'Feature',
        id: 'way-bridge-over-9002',
        properties: {
          name: 'Viaduct',
          highway: 'trunk',
          bridge: 'yes',
          layer: 1,
          nodes: [9201, 9002, 9202],
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.899, 52.379],
            [4.900, 52.378],
            [4.901, 52.377],
          ],
        },
      },
    ],
  };

  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(explicitNodeEndToEndFixture);

  // 1. Verify parsed RoadFeature.nodeIds retain explicit OSM node IDs
  const westRoad = parsed.roads.find((r) => r.sourceFeatureId === 'way-explicit-nodes');
  const eastRoad = parsed.roads.find((r) => r.sourceFeatureId === 'way-explicit-nodeids');
  const southRoad = parsed.roads.find((r) => r.sourceFeatureId === 'way-coord-first');
  const distinctA = parsed.roads.find((r) => r.sourceFeatureId === 'way-distinct-a');
  const distinctB = parsed.roads.find((r) => r.sourceFeatureId === 'way-distinct-b');
  const bridgeRoad = parsed.roads.find((r) => r.sourceFeatureId === 'way-bridge-over-9002');

  assert.ok(westRoad && eastRoad && southRoad && distinctA && distinctB && bridgeRoad);
  assert.equal(westRoad!.nodeIds?.[0], '0|false|false|osm_9001');
  assert.equal(westRoad!.nodeIds?.[1], '0|false|false|osm_9002');
  assert.equal(eastRoad!.nodeIds?.[0], '0|false|false|osm_9002');
  assert.equal(
    southRoad!.nodeIds?.[1],
    '0|false|false|osm_9002',
    'Coordinate-only way processed BEFORE explicit-node way must still promote its shared endpoint to 0|false|false|osm_9002'
  );

  // 2. Verify distinct explicit node IDs at identical coordinates do NOT merge or chain
  assert.equal(distinctA!.nodeIds?.[1], '0|false|false|osm_9101');
  assert.equal(distinctB!.nodeIds?.[0], '0|false|false|osm_9102');
  assert.notEqual(
    distinctA!.nodeIds?.[1],
    distinctB!.nodeIds?.[0],
    'Distinct explicit node IDs at identical coordinates must remain distinct'
  );

  // 3. Verify grade-separated bridge has layer-scoped node ID and never merges with at-grade node 9002
  assert.equal(bridgeRoad!.nodeIds?.[1], '1|true|false|osm_9002');
  assert.notEqual(bridgeRoad!.nodeIds?.[1], westRoad!.nodeIds?.[1]);

  // 4. Build scene and verify that node 9002 produces a 3-way junction connecting westRoad, eastRoad, and southRoad,
  //    while distinctA and distinctB do NOT form a junction!
  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.tactical);

  const junctionRanges: any[] = [];
  scene.roadsGroup.traverse((obj) => {
    if (obj instanceof THREE.Mesh && Array.isArray(obj.userData?.faceRanges)) {
      for (const r of obj.userData.faceRanges) {
        if (String(r.info?.id).startsWith('junction-')) {
          junctionRanges.push(r.info);
        }
      }
    }
  });

  assert.equal(
    junctionRanges.length,
    1,
    `Expected exactly 1 junction (at shared explicit node 9002) and none at distinct nodes 9101/9102, got ${junctionRanges.length}`
  );
  const jInfo = junctionRanges[0];
  assert.ok(jInfo.id.includes('osm_9002'), `Junction ID (${jInfo.id}) must reference canonical explicit node osm_9002`);
  assert.ok(jInfo.sourceFeatureIds.includes('way-explicit-nodes'));
  assert.ok(jInfo.sourceFeatureIds.includes('way-explicit-nodeids'));
  assert.ok(jInfo.sourceFeatureIds.includes('way-coord-first'));
  assert.ok(!jInfo.sourceFeatureIds.includes('way-bridge-over-9002'));

  const validation = validateRoadNetworkGeometry(scene);
  assert.equal(validation.isValid, true, 'Explicit-node junction must pass full road-network validation');

  scene.dispose();
});

test('Issue 4 Regression: Building polygon clipping at loaded-region boundary covers all 8 spatial and validity cases', () => {
  const center: [number, number] = [52.378, 4.900]; // [lat, lon]
  const clipRadius = 100; // [-100m, +100m] box in local meters

  // Helper to convert local meter offsets (x East, z South -> lat is -z, lon is +x) to [lon, lat]
  const metersPerDegLat = 111132.954;
  const metersPerDegLon = 111412.84 * Math.cos((center[0] * Math.PI) / 180);
  const toLonLat = (xMeters: number, zMeters: number): [number, number] => [
    center[1] + xMeters / metersPerDegLon,
    center[0] - zMeters / metersPerDegLat,
  ];

  const buildingBoundaryFixture = {
    type: 'FeatureCollection',
    name: 'Building Boundary Clipping 8-Case Suite',
    features: [
      // 1. Building entirely inside the region: [-30..30, -30..30]
      {
        type: 'Feature',
        id: 'bldg-inside',
        properties: { building: 'commercial', name: 'Inside Plaza', height: '18' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              toLonLat(-30, -30),
              toLonLat(30, -30),
              toLonLat(30, 30),
              toLonLat(-30, 30),
              toLonLat(-30, -30),
            ],
          ],
        },
      },
      // 2a. Building crossing North boundary (z = -100m), with centroid at z = -120m (OUTSIDE region!)
      {
        type: 'Feature',
        id: 'bldg-cross-north-centroid-outside',
        properties: { building: 'industrial', name: 'North Warehouse', 'building:levels': '4' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              toLonLat(-20, -160),
              toLonLat(20, -160),
              toLonLat(20, -80),
              toLonLat(-20, -80),
              toLonLat(-20, -160),
            ],
          ],
        },
      },
      // 2b. Building crossing South boundary (z = +100m)
      {
        type: 'Feature',
        id: 'bldg-cross-south',
        properties: { building: 'apartments', name: 'South Block' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              toLonLat(-20, 80),
              toLonLat(20, 80),
              toLonLat(20, 140),
              toLonLat(-20, 140),
              toLonLat(-20, 80),
            ],
          ],
        },
      },
      // 2c. Building crossing East boundary (x = +100m)
      {
        type: 'Feature',
        id: 'bldg-cross-east',
        properties: { building: 'office', name: 'East Wing' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              toLonLat(80, -20),
              toLonLat(140, -20),
              toLonLat(140, 20),
              toLonLat(80, 20),
              toLonLat(80, -20),
            ],
          ],
        },
      },
      // 2d. Building crossing West boundary (x = -100m)
      {
        type: 'Feature',
        id: 'bldg-cross-west',
        properties: { building: 'retail', name: 'West Arcade' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              toLonLat(-140, -20),
              toLonLat(-80, -20),
              toLonLat(-80, 20),
              toLonLat(-140, 20),
              toLonLat(-140, -20),
            ],
          ],
        },
      },
      // 3. Building intersecting South-East corner ([80..140, 80..140], centroid at [110, 110] outside!)
      {
        type: 'Feature',
        id: 'bldg-corner-se',
        properties: { building: 'yes', name: 'Corner Tower', height: '24' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              toLonLat(80, 80),
              toLonLat(140, 80),
              toLonLat(140, 140),
              toLonLat(80, 140),
              toLonLat(80, 80),
            ],
          ],
        },
      },
      // 4. Building completely outside the region ([200..250, 200..250])
      {
        type: 'Feature',
        id: 'bldg-outside',
        properties: { building: 'yes', name: 'Far Building' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              toLonLat(200, 200),
              toLonLat(250, 200),
              toLonLat(250, 250),
              toLonLat(200, 250),
              toLonLat(200, 200),
            ],
          ],
        },
      },
      // 5. Building with an interior courtyard hole crossing the West boundary
      {
        type: 'Feature',
        id: 'bldg-with-courtyard-hole',
        properties: { building: 'university', name: 'Courtyard Hall' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            // Outer ring: [-120..-40, -70..-30] (clipped to [-100..-40, -70..-30])
            [
              toLonLat(-120, -70),
              toLonLat(-40, -70),
              toLonLat(-40, -30),
              toLonLat(-120, -30),
              toLonLat(-120, -70),
            ],
            // Inner courtyard hole: [-90..-55, -60..-40] (retained inside clipped footprint)
            [
              toLonLat(-90, -60),
              toLonLat(-55, -60),
              toLonLat(-55, -40),
              toLonLat(-90, -40),
              toLonLat(-90, -60),
            ],
          ],
        },
      },
      // 6. MultiPolygon building whose clipped result has 2 separate components inside the region
      {
        type: 'Feature',
        id: 'bldg-multipolygon-two-wings',
        properties: { building: 'hospital', name: 'Twin Pavilion' },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                toLonLat(40, -80),
                toLonLat(70, -80),
                toLonLat(70, -50),
                toLonLat(40, -50),
                toLonLat(40, -80),
              ],
            ],
            [
              [
                toLonLat(40, 50),
                toLonLat(120, 50), // Crosses East boundary at x=100
                toLonLat(120, 75),
                toLonLat(40, 75),
                toLonLat(40, 50),
              ],
            ],
          ],
        },
      },
      // 8a. Invalid self-intersecting bow-tie building polygon -> must be rejected and reported
      {
        type: 'Feature',
        id: 'bldg-invalid-bowtie',
        properties: { building: 'yes', name: 'Broken Bowtie' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              toLonLat(-10, -10),
              toLonLat(25, 20),
              toLonLat(25, -10),
              toLonLat(-10, 10),
              toLonLat(-10, -10),
            ],
          ],
        },
      },
      // 8b. Invalid degenerate collinear building polygon (< 0.05m² area) -> must be rejected and reported
      {
        type: 'Feature',
        id: 'bldg-invalid-collinear',
        properties: { building: 'yes', name: 'Zero Area Sliver' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              toLonLat(0, 0),
              toLonLat(10, 0),
              toLonLat(20, 0),
              toLonLat(0, 0),
            ],
          ],
        },
      },
    ],
  };

  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(
    buildingBoundaryFixture,
    'Building Clipping Test',
    [center[1], center[0]],
    clipRadius
  );

  const retainedSourceIds = new Set(parsed.buildings.map((b) => b.sourceFeatureId));

  // Verify retained vs excluded buildings
  assert.ok(retainedSourceIds.has('bldg-inside'), '1. Inside building must be retained');
  assert.ok(
    retainedSourceIds.has('bldg-cross-north-centroid-outside'),
    '2a & 7. Partially intersecting building with centroid outside region must be clipped and retained'
  );
  assert.ok(retainedSourceIds.has('bldg-cross-south'), '2b. South-crossing building must be retained');
  assert.ok(retainedSourceIds.has('bldg-cross-east'), '2c. East-crossing building must be retained');
  assert.ok(retainedSourceIds.has('bldg-cross-west'), '2d. West-crossing building must be retained');
  assert.ok(retainedSourceIds.has('bldg-corner-se'), '3. SE corner-intersecting building must be retained');
  assert.ok(!retainedSourceIds.has('bldg-outside'), '4. Completely outside building must be excluded');
  assert.ok(retainedSourceIds.has('bldg-with-courtyard-hole'), '5. Courtyard building must be retained');
  assert.ok(retainedSourceIds.has('bldg-multipolygon-two-wings'), '6. MultiPolygon building must be retained');

  // Verify MultiPolygon produced 2 retained BuildingFeature parts sharing sourceFeatureId
  const multiParts = parsed.buildings.filter((b) => b.sourceFeatureId === 'bldg-multipolygon-two-wings');
  assert.equal(multiParts.length, 2, '6. MultiPolygon building with 2 clipped wings must emit 2 BuildingFeature parts');

  // Verify interior courtyard hole is preserved on bldg-with-courtyard-hole
  const courtyardBldg = parsed.buildings.find((b) => b.sourceFeatureId === 'bldg-with-courtyard-hole')!;
  assert.equal(
    courtyardBldg.footprint.length,
    2,
    '5. Clipped building with courtyard must preserve both outer ring and interior hole ring'
  );

  // Verify invalid geometries were rejected and recorded in diagnostics.rejectedInvalid
  assert.ok(!retainedSourceIds.has('bldg-invalid-bowtie'), '8a. Self-intersecting building must be rejected');
  assert.ok(!retainedSourceIds.has('bldg-invalid-collinear'), '8b. Collinear building must be rejected');
  assert.ok(
    parsed.diagnostics.rejectedInvalid.byReason['invalid_self_intersecting_building_polygon']?.sampleIds.includes(
      'bldg-invalid-bowtie'
    ),
    'Diagnostics must report invalid_self_intersecting_building_polygon for bldg-invalid-bowtie'
  );
  assert.ok(
    parsed.diagnostics.rejectedInvalid.byReason['degenerate_building_polygon (< 3 points or zero area)']?.sampleIds.includes(
      'bldg-invalid-collinear'
    ),
    'Diagnostics must report degenerate_building_polygon for bldg-invalid-collinear'
  );

  // Verify every single 2D vertex of every retained building lies within [-clipRadius, +clipRadius]
  for (const b of parsed.buildings) {
    for (const ring of b.footprint) {
      assert.ok(ring.length >= 4, `Building ${b.id} ring must be closed with >= 4 vertices`);
      for (const [x, z] of ring) {
        assert.ok(
          Math.abs(x) <= clipRadius + 0.05 && Math.abs(z) <= clipRadius + 0.05,
          `2D footprint vertex [${x.toFixed(2)}, ${z.toFixed(2)}] of ${b.id} must lie within [-${clipRadius}, +${clipRadius}]`
        );
      }
    }
  }

  // Verify 3D extruded building geometry in GeometryBuilder stays strictly inside [-clipRadius, +clipRadius]
  // and preserves building heights/attributes
  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.tactical);
  assert.ok(scene.buildingsGroup.children.length > 0, '3D buildingsGroup must contain extruded mesh');

  let maxBuilding3DY = 0;
  scene.buildingsGroup.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      const posAttr = obj.geometry.attributes.position;
      for (let i = 0; i < posAttr.count; i++) {
        const vx = posAttr.getX(i);
        const vy = posAttr.getY(i);
        const vz = posAttr.getZ(i);
        assert.ok(
          Math.abs(vx) <= clipRadius + 0.1 && Math.abs(vz) <= clipRadius + 0.1,
          `3D extruded building vertex [${vx.toFixed(2)}, ${vz.toFixed(2)}] must lie within [-${clipRadius}, +${clipRadius}]`
        );
        if (vy > maxBuilding3DY) maxBuilding3DY = vy;
      }
    }
  });
  assert.ok(maxBuilding3DY >= 24.0, `Corner Tower height (24m) must be preserved in 3D extrusion, got ${maxBuilding3DY}`);

  // Verify MapData.bounds and camera framing align with the clipped geometry (within [-100, +100])
  assert.ok(parsed.bounds.minX >= -clipRadius - 0.1 && parsed.bounds.maxX <= clipRadius + 0.1);
  assert.ok(parsed.bounds.minZ >= -clipRadius - 0.1 && parsed.bounds.maxZ <= clipRadius + 0.1);
  const framing = computeProjectedBoundsFraming(parsed.bounds, 1280, 720);
  assert.ok(
    Math.abs(framing.target[0]) <= 15 && Math.abs(framing.target[2]) <= 15,
    `Camera framing target [${framing.target[0]}, ${framing.target[2]}] must stay centered on clipped region`
  );

  scene.dispose();
});

test('clipPolygonRingsToBox topology-aware fallback handles concave polygons with disconnected components and boundary-crossing holes without malformation', () => {
  // 1. Concave U-shaped polygon whose base lies outside the box and prongs lie inside the box.
  // Clipping must produce a MultiPolygon with 2 distinct components (left and right prongs).
  // The naive Sutherland-Hodgman clipper would falsely connect them with a bridge edge across the bay
  // and retrace the edge in reverse, generating a single self-intersecting, self-touching malformed polygon.
  const uShapeRings: [number, number][][] = [
    [
      [-20, -50],
      [20, -50],
      [20, 40],
      [10, 40],
      [10, -30],
      [-10, -30],
      [-10, 40],
      [-20, 40],
      [-20, -50],
    ],
  ];

  // Clip box: keeps z in [-10, 50], clipping away base z in [-50, -10]
  const minX = -50;
  const minZ = -10;
  const maxX = 50;
  const maxZ = 50;

  // Force the fallback path
  const fallbackRes = clipPolygonRingsToBox(uShapeRings, minX, minZ, maxX, maxZ, { forceFallback: true });

  assert.equal(fallbackRes.wasClipped, true, 'Result must indicate clipping occurred');
  assert.equal(fallbackRes.fallbackUsed, true, 'Result must indicate fallback was executed');
  assert.equal(
    fallbackRes.polygons.length,
    2,
    'Topology-aware fallback MUST emit exactly 2 distinct polygon components, never a single collapsed malformed polygon'
  );

  // Sort components left-to-right by minimum X coordinate
  const sortedComponents = [...fallbackRes.polygons].sort((a, b) => a[0][0][0] - b[0][0][0]);
  const [leftProng, rightProng] = sortedComponents;

  // Verify Left Prong
  assert.equal(leftProng.length, 1, 'Left prong must have exactly 1 outer ring and no holes');
  const leftOuter = leftProng[0];
  assert.ok(leftOuter.length >= 4, 'Left prong outer ring must have >= 4 vertices');
  assert.deepEqual(
    leftOuter[0],
    leftOuter[leftOuter.length - 1],
    'Left prong outer ring must be closed (first vertex == last vertex)'
  );
  const leftArea = computeRingArea2D(leftOuter);
  assert.ok(
    Math.abs(leftArea - 500) < 1.0,
    `Left prong area must be approximately 500 m² (10m x 50m), got ${leftArea.toFixed(2)} m²`
  );
  assert.equal(
    hasPolygonRingSelfIntersection(leftOuter),
    false,
    'Left prong outer ring must have no self-intersections'
  );
  for (const [x, z] of leftOuter) {
    assert.ok(
      x >= -20.01 && x <= -9.99 && z >= -10.01 && z <= 40.01,
      `Left prong vertex [${x.toFixed(2)}, ${z.toFixed(2)}] must lie within x in [-20, -10] and z in [-10, 40]`
    );
  }

  // Verify Right Prong
  assert.equal(rightProng.length, 1, 'Right prong must have exactly 1 outer ring and no holes');
  const rightOuter = rightProng[0];
  assert.ok(rightOuter.length >= 4, 'Right prong outer ring must have >= 4 vertices');
  assert.deepEqual(
    rightOuter[0],
    rightOuter[rightOuter.length - 1],
    'Right prong outer ring must be closed (first vertex == last vertex)'
  );
  const rightArea = computeRingArea2D(rightOuter);
  assert.ok(
    Math.abs(rightArea - 500) < 1.0,
    `Right prong area must be approximately 500 m² (10m x 50m), got ${rightArea.toFixed(2)} m²`
  );
  assert.equal(
    hasPolygonRingSelfIntersection(rightOuter),
    false,
    'Right prong outer ring must have no self-intersections'
  );
  for (const [x, z] of rightOuter) {
    assert.ok(
      x >= 9.99 && x <= 20.01 && z >= -10.01 && z <= 40.01,
      `Right prong vertex [${x.toFixed(2)}, ${z.toFixed(2)}] must lie within x in [10, 20] and z in [-10, 40]`
    );
  }

  // Verify complete absence of bridge segments across the bay
  for (const poly of fallbackRes.polygons) {
    for (const [x, z] of poly[0]) {
      const inBay = x > -9.99 && x < 9.99 && Math.abs(z - minZ) < 0.1;
      assert.ok(!inBay, `No vertex may lie inside the empty bay [${x.toFixed(2)}, ${z.toFixed(2)}] at clip boundary`);
    }
  }

  // Also verify against primary polygonClipping output (both should yield identical 2-part MultiPolygon)
  const primaryRes = clipPolygonRingsToBox(uShapeRings, minX, minZ, maxX, maxZ, { forceFallback: false });
  assert.equal(primaryRes.fallbackUsed, false);
  assert.equal(primaryRes.polygons.length, 2);
  const primaryTotalArea = primaryRes.polygons.reduce((sum, p) => sum + computeRingArea2D(p[0]), 0);
  const fallbackTotalArea = fallbackRes.polygons.reduce((sum, p) => sum + computeRingArea2D(p[0]), 0);
  assert.ok(
    Math.abs(primaryTotalArea - fallbackTotalArea) < 1.0,
    `Fallback total area (${fallbackTotalArea}) must match primary total area (${primaryTotalArea})`
  );

  // 2. Polygon with an interior hole that crosses the region boundary.
  // Outer: 80m x 80m square [-40, -40] to [40, 40] (area = 6400 m²)
  // Hole: 40m x 40m square [-20, -20] to [20, 20] (area = 1600 m²)
  // Box: [-50, -50] to [50, 0] (clips along z = 0, which cuts straight through the middle of the hole).
  // Inside the box (z <= 0):
  // The outer area is 80m x 40m = 3200 m².
  // The hole portion is 40m x 20m = 800 m².
  // Since the hole crosses the z = 0 boundary, it cuts an indentation into the boundary rather than remaining an interior hole.
  // The resulting polygon must be a single polygon with 0 interior holes and net area = 3200 - 800 = 2400 m².
  const holedPolygonRings: [number, number][][] = [
    // Outer ring (CCW)
    [
      [-40, -40],
      [40, -40],
      [40, 40],
      [-40, 40],
      [-40, -40],
    ],
    // Interior hole ring (CW)
    [
      [-20, -20],
      [-20, 20],
      [20, 20],
      [20, -20],
      [-20, -20],
    ],
  ];

  const holeFallbackRes = clipPolygonRingsToBox(holedPolygonRings, -50, -50, 50, 0, { forceFallback: true });
  assert.equal(holeFallbackRes.wasClipped, true);
  assert.equal(holeFallbackRes.fallbackUsed, true);
  assert.equal(
    holeFallbackRes.polygons.length,
    1,
    'Boundary-crossing hole polygon must produce 1 outer polygon component with boundary indentation'
  );
  assert.equal(
    holeFallbackRes.polygons[0].length,
    1,
    'Hole that crosses the region boundary must NOT remain as an interior hole ring'
  );
  const boundaryCutOuter = holeFallbackRes.polygons[0][0];
  assert.ok(boundaryCutOuter.length >= 4, 'Boundary cut outer ring must have >= 4 vertices');
  assert.deepEqual(boundaryCutOuter[0], boundaryCutOuter[boundaryCutOuter.length - 1], 'Must be closed');
  const boundaryCutArea = computeRingArea2D(boundaryCutOuter);
  assert.ok(
    Math.abs(boundaryCutArea - 2400) < 2.0,
    `Boundary-cut polygon area must be 2400 m² (3200 outer - 800 hole cut), got ${boundaryCutArea.toFixed(2)} m²`
  );
  assert.equal(
    hasPolygonRingSelfIntersection(boundaryCutOuter),
    false,
    'Boundary-cut polygon ring must have no self-intersections'
  );

  // 3. Degenerate / invalid self-crossing polygon under fallback must be safely rejected ([])
  // rather than returning corrupted geometry.
  const invalidBowtieRings: [number, number][][] = [
    [
      [0, 0],
      [20, 20],
      [20, 0],
      [0, 20],
      [0, 0],
    ],
  ];
  const invalidFallbackRes = clipPolygonRingsToBox(invalidBowtieRings, -10, -10, 30, 30, { forceFallback: true });
  assert.equal(
    invalidFallbackRes.polygons.length,
    0,
    'Invalid self-intersecting polygon under fallback must be rejected and return 0 polygons'
  );
});

test('clipPolygonWithTopologyAwareFallback direct caller behavior: handles open rings, preserves fully interior holes, drops sliver holes, and maintains triangle seam integrity', () => {
  // A. Direct call with open rings & fully interior hole
  // Outer: 60x60 square [-30, -30] to [30, 30] (area = 3600 m²), passed OPEN (no duplicate end point)
  // Interior Hole: 20x20 square [-10, -10] to [10, 10] (area = 400 m²), passed OPEN
  const openOuter: [number, number][] = [
    [-30, -30],
    [30, -30],
    [30, 30],
    [-30, 30],
  ];
  const openHole: [number, number][] = [
    [-10, -10],
    [-10, 10],
    [10, 10],
    [10, -10],
  ];

  // Clip box enclosing the entire polygon
  const directResult = clipPolygonWithTopologyAwareFallback(
    [openOuter, openHole],
    -50,
    -50,
    50,
    50
  );

  assert.equal(directResult.length, 1, 'Direct fallback invocation must produce 1 polygon');
  const polyWithHole = directResult[0];
  assert.equal(
    polyWithHole.length,
    2,
    'Fully interior hole must be preserved as second ring (idx = 1) after triangulation and union'
  );

  // Outer ring verification
  const outer = polyWithHole[0];
  assert.ok(outer.length >= 4, 'Outer ring must have >= 4 vertices (closed)');
  assert.deepEqual(outer[0], outer[outer.length - 1], 'Outer ring must be closed');
  const outerArea = computeRingArea2D(outer);
  assert.ok(Math.abs(outerArea - 3600) < 1.0, `Outer area must be ~3600 m², got ${outerArea}`);
  assert.equal(hasPolygonRingSelfIntersection(outer), false);

  // Interior hole verification
  const hole = polyWithHole[1];
  assert.ok(hole.length >= 4, 'Hole ring must have >= 4 vertices (closed)');
  assert.deepEqual(hole[0], hole[hole.length - 1], 'Hole ring must be closed');
  const holeArea = computeRingArea2D(hole);
  assert.ok(Math.abs(holeArea - 400) < 1.0, `Hole area must be ~400 m², got ${holeArea}`);
  assert.equal(hasPolygonRingSelfIntersection(hole), false);

  // B. Robust hole filtering: sliver hole (< 0.05 m²) or self-intersecting hole is dropped
  // while preserving the valid outer building ring
  const tinySliverHole: [number, number][] = [
    [0, 0],
    [0.1, 0],
    [0.1, 0.1],
    [0, 0.1],
    [0, 0],
  ]; // Area = 0.01 m² (< 0.05 m² threshold)

  const selfIntersectingHole: [number, number][] = [
    [5, 5],
    [15, 15],
    [15, 5],
    [5, 15],
    [5, 5],
  ];

  const polyWithBadHoles = clipPolygonWithTopologyAwareFallback(
    [openOuter, tinySliverHole, selfIntersectingHole],
    -50,
    -50,
    50,
    50
  );

  assert.equal(
    polyWithBadHoles.length,
    1,
    'Valid outer ring must NOT be discarded because of a sliver or malformed hole'
  );
  assert.equal(
    polyWithBadHoles[0].length,
    1,
    'Offending sliver and self-intersecting holes must be dropped, leaving clean outer ring with 0 holes'
  );
  const retainedOuterArea = computeRingArea2D(polyWithBadHoles[0][0]);
  assert.ok(
    Math.abs(retainedOuterArea - 3600) < 1.0,
    `Retained outer area must be ~3600 m², got ${retainedOuterArea}`
  );

  // C. Large multi-bend concave polygon: triangle seams produce no pinholes or slivers
  // E-shaped building polygon with multiple concavities
  const eShapeRings: [number, number][][] = [
    [
      [0, 0],
      [50, 0],
      [50, 10],
      [15, 10],
      [15, 20],
      [40, 20],
      [40, 30],
      [15, 30],
      [15, 40],
      [50, 40],
      [50, 50],
      [0, 50],
      [0, 0],
    ],
  ];

  const eResult = clipPolygonWithTopologyAwareFallback(eShapeRings, -10, -10, 60, 60);
  assert.equal(eResult.length, 1, 'E-shaped polygon should remain a single component');
  assert.equal(
    eResult[0].length,
    1,
    'E-shaped polygon must have 0 interior pinhole artifacts or sliver holes along triangle seams'
  );
  // Expected area: 50*50 - (Cutout 1: 35*10) - (Cutout 2: 35*10) - (Recess: 10*10) = 2500 - 800 = 1700 m²
  const eArea = computeRingArea2D(eResult[0][0]);
  assert.ok(
    Math.abs(eArea - 1700) < 1.0,
    `E-shaped polygon area must be exactly 1700 m², got ${eArea.toFixed(2)} m²`
  );
  assert.equal(hasPolygonRingSelfIntersection(eResult[0][0]), false);
});




