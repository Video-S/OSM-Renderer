import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { GeometryBuilder } from './GeometryBuilder';
import { MAP_THEMES } from '../styles/mapThemes';
import { classifyGeoJsonFeature } from './FeatureCatalogue';
import {
  ELEVATION_POLICY,
  DEPTH_OFFSET_CONFIG,
  getRoadElevation,
  getRailwayElevations,
  hashFeatureId,
} from './ElevationPolicy';
import {
  ALL_SEMANTIC_SURFACE_CLASSES,
  conditionPolygonToMultiPolygon,
  isConfirmedDuplicateSurface,
  isGeometricallyContained,
  MAX_ALLOWED_SURFACE_FILL_OVERLAP_AREA,
  MIN_VALIDATED_Y_GAP,
  resolveAndValidatePlanarPolygons,
  resolvePairwiseOutcome,
  validatePlanarLayering,
} from './PlanarLayerValidator';
import { computeSceneFrustumPlanes } from '../scene/CameraController';
import { validateSceneZeroZFighting } from './ZFightingValidator';

// Comprehensive test fixture matching review section 1E:
// - Two roads intersecting at the same level
// - Roads with different widths and classifications (primary vs residential)
// - Duplicate road geometry
// - A road crossing over another road on a bridge (grade separation)
// - A road beside or crossing a waterway
// - Road surfaces adjacent to ground or landuse polygons
// - Multipart geometry (MultiLineString)
// - Point infrastructure (traffic signal, railway switch)
const Z_FIGHTING_REGRESSION_FIXTURE = {
  type: 'FeatureCollection',
  name: 'Z-Fighting and Layering Test Fixture',
  features: [
    // 1. Primary Road (East-West)
    {
      type: 'Feature',
      id: 'road-primary-ew',
      properties: {
        name: 'Main Avenue',
        highway: 'primary',
        layer: 0,
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [4.890, 52.378],
          [4.900, 52.378],
          [4.910, 52.378],
        ],
      },
    },
    // 2. Residential Road intersecting Primary Road at [4.900, 52.378] (North-South)
    {
      type: 'Feature',
      id: 'road-residential-ns',
      properties: {
        name: 'Cross Street',
        highway: 'residential',
        layer: 0,
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [4.900, 52.370],
          [4.900, 52.378], // Intersection point!
          [4.900, 52.385],
        ],
      },
    },
    // 3. Second Residential Road intersecting Cross Street at [4.900, 52.374] (same class)
    {
      type: 'Feature',
      id: 'road-residential-side',
      properties: {
        name: 'Side Alley',
        highway: 'residential',
        layer: 0,
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [4.895, 52.374],
          [4.900, 52.374],
          [4.905, 52.374],
        ],
      },
    },
    // 4. Duplicate road geometry (same street mapped twice in reverse)
    {
      type: 'Feature',
      id: 'road-duplicate-reverse',
      properties: {
        name: 'Main Avenue Reverse Dup',
        highway: 'primary',
        layer: 0,
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [4.910, 52.378],
          [4.900, 52.378],
          [4.890, 52.378],
        ],
      },
    },
    // 5. Grade-separated Flyover Bridge (Motorway Bridge over Main Avenue at layer 1)
    {
      type: 'Feature',
      id: 'road-motorway-bridge',
      properties: {
        name: 'Highway Overpass',
        highway: 'motorway',
        bridge: 'yes',
        layer: 1,
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [4.902, 52.372],
          [4.902, 52.378], // Crosses above Primary Road!
          [4.902, 52.384],
        ],
      },
    },
    // 6. Linear Canal crossing underneath the area
    {
      type: 'Feature',
      id: 'waterway-canal-1',
      properties: {
        name: 'City Canal',
        waterway: 'canal',
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [4.892, 52.376],
          [4.900, 52.376],
          [4.908, 52.376],
        ],
      },
    },
    // 7. Landuse commercial polygon underneath the roads
    {
      type: 'Feature',
      id: 'landuse-commercial-zone',
      properties: {
        name: 'Business District',
        landuse: 'commercial',
      },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [4.895, 52.372],
            [4.905, 52.372],
            [4.905, 52.382],
            [4.895, 52.382],
            [4.895, 52.372],
          ],
        ],
      },
    },
    // 8. Multipart feature: MultiLineString railway
    {
      type: 'Feature',
      id: 'railway-multipart',
      properties: {
        name: 'Dual Track Railway',
        railway: 'rail',
        layer: 0,
      },
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [4.890, 52.382],
            [4.910, 52.382],
          ],
          [
            [4.890, 52.383],
            [4.910, 52.383],
          ],
        ],
      },
    },
    // 9. Point infrastructure: traffic signal node (should be classified as unsupported, not broken road)
    {
      type: 'Feature',
      id: 'point-traffic-signal',
      properties: {
        highway: 'traffic_signals',
      },
      geometry: {
        type: 'Point',
        coordinates: [4.900, 52.378],
      },
    },
    // 10. Point infrastructure: railway switch node (should be classified as unsupported, not broken rail)
    {
      type: 'Feature',
      id: 'point-rail-switch',
      properties: {
        railway: 'switch',
      },
      geometry: {
        type: 'Point',
        coordinates: [4.905, 52.382],
      },
    },
  ],
};

test('ElevationPolicy enforces strict surface hierarchy', () => {
  // Ground < Landuse < Water < Parks < At-Grade Roads < Bridges
  assert.ok(
    ELEVATION_POLICY.GROUND < ELEVATION_POLICY.LANDUSE,
    'Ground (-0.10) must sit below Landuse (-0.04)'
  );
  assert.ok(
    ELEVATION_POLICY.LANDUSE < ELEVATION_POLICY.WATER_SURFACE,
    'Landuse (-0.04) must sit below Water Surface (0.015)'
  );
  assert.ok(
    ELEVATION_POLICY.WATER_SURFACE < ELEVATION_POLICY.PARKS,
    'Water Surface (0.015) must sit below Parks (0.026)'
  );
  assert.ok(
    ELEVATION_POLICY.PARKS < ELEVATION_POLICY.ROAD_SURFACE,
    'Parks (0.026) must sit below uniform at-grade road surface (0.050)'
  );
});

test('At-grade road surfaces share a uniform physical elevation', () => {
  const primaryElev = getRoadElevation('primary', 0, false, false, 'feat-primary');
  const residentialElev = getRoadElevation('residential', 0, false, false, 'feat-residential');
  const motorwayElev = getRoadElevation('motorway', 0, false, false, 'feat-motorway');

  // Physical elevation invariant: ordinary at-grade roads are not tiered by class
  assert.equal(
    primaryElev,
    ELEVATION_POLICY.ROAD_SURFACE,
    'Primary road must sit at uniform road surface elevation'
  );
  assert.equal(
    residentialElev,
    ELEVATION_POLICY.ROAD_SURFACE,
    'Residential road must sit at uniform road surface elevation'
  );
  assert.equal(
    motorwayElev,
    ELEVATION_POLICY.ROAD_SURFACE,
    'Motorway road must sit at uniform road surface elevation'
  );
});

test('Bridge elevations provide real grade separation over ground roads', () => {
  const groundRoadElev = getRoadElevation('primary', 0, false, false, 'ground-primary');
  const bridgeElev = getRoadElevation('motorway', 1, true, false, 'bridge-motorway');

  const clearance = bridgeElev - groundRoadElev;
  assert.ok(
    clearance >= 2.5,
    `Bridge must have >= 2.5m clearance over ground road (actual: ${clearance.toFixed(2)}m)`
  );
});

test('Tunnel elevations provide subterranean clearance', () => {
  const tunnelElev = getRoadElevation('primary', -1, false, true, 'tunnel-primary');
  assert.ok(
    tunnelElev <= ELEVATION_POLICY.TUNNEL_DEPTH,
    `Tunnel elevation (${tunnelElev}) must be at subterranean depth (<= -2.0m)`
  );
});

test('Classification correctly filters point infrastructure into unsupported rather than malformed', () => {
  const trafficSignal = classifyGeoJsonFeature({ highway: 'traffic_signals' }, 'Point');
  assert.equal(trafficSignal.category, 'unsupported');
  assert.equal(trafficSignal.primaryTag, 'highway=traffic_signals:point');

  const railSwitch = classifyGeoJsonFeature({ railway: 'switch' }, 'Point');
  assert.equal(railSwitch.category, 'unsupported');
  assert.equal(railSwitch.primaryTag, 'railway=switch:point');
});

test('LocalGeoJsonProvider processes fixture with deduplication and accurate diagnostic accounting', () => {
  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(Z_FIGHTING_REGRESSION_FIXTURE);

  const diag = parsed.diagnostics;

  // 1. Raw source features received
  assert.equal(diag.sourceFeaturesReceived, 10, 'Received all 10 raw features');

  // 2. Skipped unsupported (2 point infrastructure features: traffic signals & rail switch)
  assert.equal(diag.skippedUnsupported.total, 2, '2 point infrastructure features marked unsupported');

  // 3. Classified source features: 8 features (3 roads + 1 dup + 1 bridge + 1 canal + 1 landuse + 1 railway)
  assert.equal(diag.sourceFeaturesClassified, 8);

  // 4. Multipart feature: MultiLineString railway yielded 2 parsed feature parts during parseGeoJson
  assert.equal(diag.parsedFeatureParts?.byCategory.railways, 2, 'MultiLineString generated 2 parsed railway parts');
  assert.equal(diag.geometryPartsGenerated.total, 0, 'geometryPartsGenerated remains 0 until buildScene executes');

  // 5. Duplicate road was filtered out
  const primaryRoads = parsed.roads.filter((r) => r.roadClass === 'primary');
  assert.equal(primaryRoads.length, 1, 'Duplicate reverse primary road must be deduplicated to 1');
});

test('GeometryBuilder builds scene, tracks rendered features, and supports clean disposal and updateTheme', () => {
  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(Z_FIGHTING_REGRESSION_FIXTURE);

  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.tactical);

  // Verify buildScene populates geometryPartsGenerated from actual 3D geometry parts
  assert.ok(
    parsed.diagnostics.geometryPartsGenerated.byCategory.railways >= 2,
    'buildScene must populate geometryPartsGenerated.byCategory.railways with actual 3D geometry parts'
  );
  assert.ok(
    parsed.diagnostics.geometryPartsGenerated.total > parsed.diagnostics.sourceFeaturesRendered,
    'geometryPartsGenerated.total reflects 3D sub-geometries built during scene construction'
  );

  // Scene contains rendered groups
  assert.ok(scene.roadsGroup.children.length > 0, 'Must build road meshes');
  assert.ok(scene.railwaysGroup.children.length > 0, 'Must build railway meshes');
  assert.ok(scene.waterGroup.children.length > 0, 'Must build water meshes');
  assert.ok(scene.landuseGroup.children.length > 0, 'Must build landuse meshes');

  // In-place theme update does not crash and updates colors
  assert.doesNotThrow(() => {
    scene.updateTheme(MAP_THEMES.daylight);
  }, 'updateTheme must update colors smoothly without error');

  // Clean disposal frees GPU resources without error
  assert.doesNotThrow(() => {
    scene.dispose();
  }, 'dispose must recursively release geometries and materials without error');

  // After disposal, groups are cleared
  assert.equal(scene.roadsGroup.children.length, 0, 'Roads group must be empty after disposal');
  assert.equal(scene.buildingsGroup.children.length, 0, 'Buildings group must be empty after disposal');
});

test('Water layer renders on top of landuse and does not cull out with distance', () => {
  const provider = new LocalGeoJsonProvider();
  // Coincident landuse and water polygon
  const coincidentFixture = {
    type: 'FeatureCollection',
    name: 'Coincident Landuse and Water',
    features: [
      {
        type: 'Feature',
        id: 'landuse-industrial-1',
        properties: { landuse: 'industrial' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [[4.89, 52.37], [4.91, 52.37], [4.91, 52.39], [4.89, 52.39], [4.89, 52.37]],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'water-basin-1',
        properties: { natural: 'water', water: 'basin' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [[4.895, 52.375], [4.905, 52.375], [4.905, 52.385], [4.895, 52.385], [4.895, 52.375]],
          ],
        },
      },
    ],
  };

  const parsed = provider.parseGeoJson(coincidentFixture);
  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.tactical);

  // 1. Water layer exists
  assert.ok(scene.waterGroup.children.length > 0, 'Water group must have mesh');
  const waterMesh = scene.waterGroup.children[0] as THREE.Mesh;
  const landuseMesh = scene.landuseGroup.children[0] as THREE.Mesh;

  // 2. Physical elevation of water sits above landuse
  const waterGeo = waterMesh.geometry;
  const waterPosY = waterGeo.attributes.position.getY(0);
  assert.ok(
    waterPosY > ELEVATION_POLICY.LANDUSE,
    `Water vertex Y (${waterPosY}) must be above Landuse elevation (${ELEVATION_POLICY.LANDUSE})`
  );

  // 3. Render order guarantees water renders after substrate landuse
  assert.ok(
    waterMesh.renderOrder > landuseMesh.renderOrder,
    `Water renderOrder (${waterMesh.renderOrder}) must be greater than Landuse renderOrder (${landuseMesh.renderOrder})`
  );

  // 4. Frustum culling disabled on water mesh to eliminate popping at distance and screen edges
  assert.equal(
    waterMesh.frustumCulled,
    false,
    'Water mesh must have frustumCulled=false to prevent popping in and out'
  );

  // 5. Negative polygon offset pulls water forward in depth buffer
  assert.ok(
    DEPTH_OFFSET_CONFIG.water.polygonOffsetFactor < 0,
    'Water polygon offset factor must be negative to resolve coplanar depth against substrate'
  );
});

test('Underground waterways (culverts, covered streams, layer < 0) are excluded from surface water mesh', () => {
  const provider = new LocalGeoJsonProvider();
  const culvertFixture = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'surface-stream-1',
        properties: { name: 'Surface Stream', waterway: 'stream' },
        geometry: {
          type: 'LineString',
          coordinates: [[4.890, 52.378], [4.895, 52.378]],
        },
      },
      {
        type: 'Feature',
        id: 'culvert-stream-2',
        properties: { name: 'Berflobeek Culvert', waterway: 'stream', tunnel: 'culvert', layer: '-1' },
        geometry: {
          type: 'LineString',
          coordinates: [[4.895, 52.378], [4.905, 52.378]],
        },
      },
    ],
  };

  const parsed = provider.parseGeoJson(culvertFixture);
  assert.equal(parsed.linearWaterways.length, 2);
  const culvertFeature = parsed.linearWaterways.find(w => w.id.includes('culvert-stream-2'));
  assert.ok(culvertFeature, 'Culvert feature must be parsed');
  assert.equal(culvertFeature.isTunnel, true, 'Culvert must be classified with isTunnel=true');

  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.dusk);
  assert.ok(scene.waterGroup.children.length > 0, 'Surface stream must generate water mesh');
  const waterMesh = scene.waterGroup.children[0] as THREE.Mesh;
  const vertCount = waterMesh.geometry.attributes.position.count;
  // A single 2-point ribbon with caps has around 10-20 vertices, 2 ribbons would double that
  assert.ok(vertCount < 30, `Only surface stream must be in water mesh, count=${vertCount}`);
});

test('At-grade vehicular roads and pedestrian paths share unified 0.050m baseline while vehicular roads take renderOrder and Boolean clipping precedence', () => {
  const secondaryElev = getRoadElevation('secondary', 0, false, false);
  const footwayElev = getRoadElevation('footway', 0, false, false);
  const cyclewayElev = getRoadElevation('cycleway', 0, false, false);

  assert.strictEqual(
    secondaryElev,
    ELEVATION_POLICY.ROAD_SURFACE,
    `Vehicular road elevation (${secondaryElev}) must equal the agreed 0.050m baseline`
  );
  assert.strictEqual(
    footwayElev,
    ELEVATION_POLICY.ROAD_SURFACE,
    `Footway elevation (${footwayElev}) must share the unified 0.050m at-grade road baseline`
  );
  assert.strictEqual(
    cyclewayElev,
    ELEVATION_POLICY.ROAD_SURFACE,
    `Cycleway elevation (${cyclewayElev}) must share the unified 0.050m at-grade road baseline`
  );

  const provider = new LocalGeoJsonProvider();
  const crossingFixture = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'secondary-carriageway',
        properties: { name: 'Main Carriageway', highway: 'secondary' },
        geometry: {
          type: 'LineString',
          coordinates: [[4.890, 52.378], [4.910, 52.378]],
        },
      },
      {
        type: 'Feature',
        id: 'crossing-footpath',
        properties: { name: 'Footpath', highway: 'footway' },
        geometry: {
          type: 'LineString',
          coordinates: [[4.900, 52.370], [4.900, 52.385]],
        },
      },
    ],
  };

  const parsed = provider.parseGeoJson(crossingFixture);
  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.dusk);

  let secondaryMesh: THREE.Mesh | undefined;
  let footwayMesh: THREE.Mesh | undefined;

  scene.roadsGroup.traverse(child => {
    if ((child as THREE.Mesh).isMesh) {
      if (child.name === 'Roads_secondary') secondaryMesh = child as THREE.Mesh;
      if (child.name === 'Roads_footway') footwayMesh = child as THREE.Mesh;
    }
  });

  assert.ok(secondaryMesh, 'Secondary road mesh must exist');
  assert.ok(footwayMesh, 'Footway road mesh must exist');
  assert.ok(
    secondaryMesh.renderOrder > footwayMesh.renderOrder,
    `Vehicular carriageway renderOrder (${secondaryMesh.renderOrder}) must be higher than footway (${footwayMesh.renderOrder})`
  );
});

test('Subterranean road tunnels and pedestrian tunnels are excluded from surface road meshes', () => {
  const provider = new LocalGeoJsonProvider();
  const tunnelFixture = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'surface-road',
        properties: { name: 'Surface Street', highway: 'secondary' },
        geometry: {
          type: 'LineString',
          coordinates: [[4.890, 52.378], [4.900, 52.378]],
        },
      },
      {
        type: 'Feature',
        id: 'tunnel-road',
        properties: { name: 'Underground Tunnel', highway: 'secondary', tunnel: 'yes', layer: '-1' },
        geometry: {
          type: 'LineString',
          coordinates: [[4.900, 52.378], [4.910, 52.378]],
        },
      },
    ],
  };

  const parsed = provider.parseGeoJson(tunnelFixture);
  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.dusk);

  let secondaryMesh: THREE.Mesh | undefined;
  scene.roadsGroup.traverse(child => {
    if ((child as THREE.Mesh).isMesh && child.name === 'Roads_secondary') {
      secondaryMesh = child as THREE.Mesh;
    }
  });

  assert.ok(secondaryMesh, 'Secondary mesh must exist for surface segment');
  const pos = secondaryMesh.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    assert.ok(y >= 0, `Surface road mesh must not contain subterranean vertices (found y=${y})`);
  }
});

test('PlanarLayerValidator guarantees strict vertical separation for football pitches, baseball fields, and nested polygons', () => {
  const provider = new LocalGeoJsonProvider();
  const sportsComplexFixture = {
    type: 'FeatureCollection',
    name: 'Overlapping Football & Baseball Sports Complex',
    features: [
      // 1. Macro municipal park containing the entire sports complex
      {
        type: 'Feature',
        id: 'macro-park',
        properties: { leisure: 'park', name: 'Sportpark Hengelo' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.790, 52.260],
              [6.798, 52.260],
              [6.798, 52.266],
              [6.790, 52.266],
              [6.790, 52.260],
            ],
          ],
        },
      },
      // 2. Sports centre polygon overlapping inside the park
      {
        type: 'Feature',
        id: 'sports-centre-1',
        properties: { leisure: 'sports_centre', name: 'Athletic Complex' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.7905, 52.2605],
              [6.7975, 52.2605],
              [6.7975, 52.2655],
              [6.7905, 52.2655],
              [6.7905, 52.2605],
            ],
          ],
        },
      },
      // 3. Grass ground polygon under the football pitches
      {
        type: 'Feature',
        id: 'grass-turf-base',
        properties: { landuse: 'grass', name: 'Turf Field Base' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.7908, 52.2608],
              [6.7942, 52.2608],
              [6.7942, 52.2645],
              [6.7908, 52.2645],
              [6.7908, 52.2608],
            ],
          ],
        },
      },
      // 4. Full-size 11v11 Football (Soccer) Pitch
      {
        type: 'Feature',
        id: 'football-main-11v11',
        properties: { leisure: 'pitch', sport: 'soccer', name: 'Main Football Pitch 1' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.7910, 52.2610],
              [6.7926, 52.2610],
              [6.7926, 52.2622],
              [6.7910, 52.2622],
              [6.7910, 52.2610],
            ],
          ],
        },
      },
      // 5. Cross-field 7v7 Youth Football Pitch overlapping the West half of Main Football Pitch 1
      {
        type: 'Feature',
        id: 'football-youth-7v7-west',
        properties: { leisure: 'pitch', sport: 'soccer', name: 'Youth Cross Pitch A' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.79105, 52.26105],
              [6.79175, 52.26105],
              [6.79175, 52.26215],
              [6.79105, 52.26215],
              [6.79105, 52.26105],
            ],
          ],
        },
      },
      // 6. Baseball Outfield Pitch (large sector/rectangle)
      {
        type: 'Feature',
        id: 'baseball-outfield-pitch',
        properties: { leisure: 'pitch', sport: 'baseball', name: 'Baseball Field Outfield' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.7945, 52.2610],
              [6.7968, 52.2610],
              [6.7968, 52.2630],
              [6.7945, 52.2630],
              [6.7945, 52.2610],
            ],
          ],
        },
      },
      // 7. Baseball Infield Pitch (nested inside Baseball Outfield Pitch)
      {
        type: 'Feature',
        id: 'baseball-infield-pitch',
        properties: { leisure: 'pitch', sport: 'baseball', name: 'Baseball Infield Diamond' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.7948, 52.2612],
              [6.7956, 52.2612],
              [6.7956, 52.2619],
              [6.7948, 52.2619],
              [6.7948, 52.2612],
            ],
          ],
        },
      },
      // 8. Sand Pitcher's Mound / Base Cutout nested inside Baseball Infield Pitch
      {
        type: 'Feature',
        id: 'baseball-sand-mound',
        properties: { natural: 'sand', name: 'Pitchers Mound' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.7951, 52.26145],
              [6.7953, 52.26145],
              [6.7953, 52.26165],
              [6.7951, 52.26165],
              [6.7951, 52.26145],
            ],
          ],
        },
      },
      // 9. Surface parking lot inside sports centre with a nested green grass island inside the parking lot
      {
        type: 'Feature',
        id: 'complex-parking-lot',
        properties: { amenity: 'parking', parking: 'surface', name: 'Stadium Parking' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.7945, 52.2635],
              [6.7970, 52.2635],
              [6.7970, 52.2650],
              [6.7945, 52.2650],
              [6.7945, 52.2635],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'parking-grass-island',
        properties: { landuse: 'grass', name: 'Parking Planter Island' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.7952, 52.2640],
              [6.7958, 52.2640],
              [6.7958, 52.2644],
              [6.7952, 52.2644],
              [6.7952, 52.2640],
            ],
          ],
        },
      },
    ],
  };

  const parsed = provider.parseGeoJson(sportsComplexFixture);
  const { resolvedById, report } = resolveAndValidatePlanarPolygons(parsed.landuse, parsed.parks);

  // 1. Validator report must pass with zero violations and zero residual 2D surface-fill overlap
  assert.equal(
    report.isValid,
    true,
    `PlanarLayerValidator must report zero violations (found: ${JSON.stringify(report.violations)})`
  );
  assert.ok(
    report.maxResidualFillOverlapSqMeters <= MAX_ALLOWED_SURFACE_FILL_OVERLAP_AREA,
    `Residual 2D surface-fill overlap (${report.maxResidualFillOverlapSqMeters} m²) must be <= ${MAX_ALLOWED_SURFACE_FILL_OVERLAP_AREA} m²`
  );

  // 2. Verify semantic ownership hierarchy (topologicalRank) AND uniform flush ground-cover plane (+0.025m)
  const getLayer = (prefix: string) => {
    for (const [id, layer] of resolvedById.entries()) {
      if (id.includes(prefix)) return layer;
    }
    throw new Error(`Missing resolved layer for ${prefix}`);
  };

  const parkLayer = getLayer('macro-park');
  const centreLayer = getLayer('sports-centre-1');
  const grassLayer = getLayer('grass-turf-base');
  const mainFootball = getLayer('football-main-11v11');
  const youthFootball = getLayer('football-youth-7v7-west');

  assert.ok(parkLayer.topologicalRank < centreLayer.topologicalRank, 'Park must be replaced by sports_centre');
  assert.ok(centreLayer.topologicalRank < grassLayer.topologicalRank, 'Sports centre must be replaced by grass turf base');
  assert.ok(grassLayer.topologicalRank < mainFootball.topologicalRank, 'Grass turf base must be replaced by main 11v11 football pitch');
  assert.ok(
    mainFootball.topologicalRank < youthFootball.topologicalRank,
    'Main 11v11 football pitch must be replaced by contained 7v7 youth cross-pitch'
  );

  // 3. Verify baseball ownership hierarchy: sports_centre < baseball outfield < baseball infield < sand pitcher's mound
  const baseballOutfield = getLayer('baseball-outfield-pitch');
  const baseballInfield = getLayer('baseball-infield-pitch');
  const sandMound = getLayer('baseball-sand-mound');

  assert.ok(centreLayer.topologicalRank < baseballOutfield.topologicalRank, 'Sports centre must be replaced by baseball outfield');
  assert.ok(
    baseballOutfield.topologicalRank < baseballInfield.topologicalRank,
    'Baseball outfield must be replaced by contained baseball infield'
  );
  assert.ok(
    baseballInfield.topologicalRank < sandMound.topologicalRank,
    'Baseball infield must be replaced by contained sand pitcher mound (without mutual subtraction!)'
  );
  assert.ok(
    sandMound.resolvedArea > 20,
    `Sand pitcher's mound must retain its full resolved area (${sandMound.resolvedArea.toFixed(1)} m²) without being subtracted by the pitch`
  );

  // 4. Verify parking lot & nested grass island ownership AND flush elevation (+0.025m, 0.0mm seam step)
  const parkingLot = getLayer('complex-parking-lot');
  const grassIsland = getLayer('parking-grass-island');
  assert.ok(
    parkingLot.topologicalRank < grassIsland.topologicalRank,
    'Enclosing parking lot must have nested grass planter island cut out of its footprint'
  );
  assert.equal(
    parkingLot.elevationY,
    ELEVATION_POLICY.GROUND_COVER_SURFACE,
    'Parking lot must sit on the uniform flush ground-cover plane (+0.025m)'
  );
  assert.equal(
    grassIsland.elevationY,
    ELEVATION_POLICY.GROUND_COVER_SURFACE,
    'Grass planter island must sit on the uniform flush ground-cover plane (+0.025m) with 0.0mm height step'
  );
  assert.ok(
    parkingLot.resolvedArea < parkingLot.area - grassIsland.resolvedArea * 0.95,
    'Parking lot resolved area must have the grass island area subtracted'
  );

  // 5. Build 3D scene and verify diagnostics.planarValidation AND full 3D ZFightingValidator pass
  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.daylight);
  assert.ok(parsed.diagnostics.planarValidation, 'diagnostics.planarValidation must be recorded by GeometryBuilder');
  assert.equal(parsed.diagnostics.planarValidation?.isValid, true);

  // Compute world coordinates of interior sample points for grass island, parking lot, and sand mound
  const grassRing = parsed.parks.find((p) => p.id.includes('parking-grass-island'))!.polygon[0];
  const grassCenterX = (grassRing[0][0] + grassRing[2][0]) * 0.5;
  const grassCenterZ = (grassRing[0][1] + grassRing[2][1]) * 0.5;

  const sandRing = parsed.parks.find((p) => p.id.includes('baseball-sand-mound'))!.polygon[0];
  const sandCenterX = (sandRing[0][0] + sandRing[2][0]) * 0.5;
  const sandCenterZ = (sandRing[0][1] + sandRing[2][1]) * 0.5;

  const zReport = validateSceneZeroZFighting(scene, parsed.bounds, [
    {
      label: 'Grass Planter Island Interior inside Parking Lot (Close-Up 12m Scale)',
      worldX: grassCenterX,
      worldZ: grassCenterZ,
      expectedFeatureIdSubstring: 'parking-grass-island',
      expectedMeshNameSubstring: 'ParkSurfaces_grass',
      viewScaleMeters: 12,
    },
    {
      label: 'Sand Pitcher Mound Interior inside Baseball Infield (Close-Up 12m Scale)',
      worldX: sandCenterX,
      worldZ: sandCenterZ,
      expectedFeatureIdSubstring: 'baseball-sand-mound',
      expectedMeshNameSubstring: 'ParkSurfaces_sand',
      viewScaleMeters: 12,
    },
  ]);

  assert.equal(
    zReport.surfaceFillOverlapConflicts.length,
    0,
    `Must have 0 overlapping surface-fill triangle pairs (found: ${JSON.stringify(zReport.surfaceFillOverlapConflicts)})`
  );
  assert.equal(
    zReport.parkingMarkingSelfOverlaps,
    0,
    'Parking_Markings must have 0 self-overlapping triangles at stall-to-spine T-junctions'
  );
  assert.equal(
    zReport.pitchMarkingSelfOverlaps,
    0,
    'Pitch_Markings must have 0 self-overlapping triangles at corners and halfway line junctions'
  );
  assert.equal(
    zReport.screenSpaceDepthConflicts.length,
    0,
    `Must have 0 screen-space depth conflicts across 15°..72° tilts (found: ${JSON.stringify(zReport.screenSpaceDepthConflicts)})`
  );
  for (const sRes of zReport.sampleWinnerResults) {
    assert.equal(
      sRes.passed,
      true,
      `Interior sample "${sRes.label}" must win and remain stable under 16-bit & 24-bit perturbations (got feature=${sRes.observedFeatureId}, mesh=${sRes.observedMeshName})`
    );
  }

  // 6. Verify validator actively catches artificial Z-fighting violations if two unclipped layers share an elevation
  const brokenLayers = [
    { ...mainFootball, resolvedMultiPolygon: [], elevationY: 0.140, markingElevationY: 0.144 },
    { ...youthFootball, resolvedMultiPolygon: [], elevationY: 0.141, markingElevationY: 0.145 },
  ];
  const brokenReport = validatePlanarLayering(brokenLayers);
  assert.equal(brokenReport.isValid, false, 'Validator must reject unclipped overlapping polygons with < 6mm separation');
  assert.ok(brokenReport.violations.length > 0, 'Validator must report specific violation details');

  scene.dispose();
});

test('Exhaustive pairwise ownership policy is total and strictly antisymmetric across all surface classes', () => {
  const containmentStates: Array<[boolean, boolean]> = [
    [true, false],  // A strictly contained in B
    [false, true],  // B strictly contained in A
    [false, false], // Partial overlap
    [true, true],   // Co-extensive / mutual containment
  ];

  for (const classA of ALL_SEMANTIC_SURFACE_CLASSES) {
    for (const classB of ALL_SEMANTIC_SURFACE_CLASSES) {
      for (const [aInB, bInA] of containmentStates) {
        const nodeA = {
          id: 'feat-a',
          category: (classA === 'WATER_BODY' ? 'water' : 'park') as 'landuse' | 'park' | 'water',
          subtype: classA.toLowerCase(),
          semanticClass: classA,
          area: aInB && !bInA ? 100 : !aInB && bInA ? 1000 : 400,
        };
        const nodeB = {
          id: 'feat-b',
          category: (classB === 'WATER_BODY' ? 'water' : 'park') as 'landuse' | 'park' | 'water',
          subtype: classB.toLowerCase(),
          semanticClass: classB,
          area: aInB && !bInA ? 1000 : !aInB && bInA ? 100 : 600,
        };

        const outAB = resolvePairwiseOutcome(nodeA, nodeB, aInB, bInA, false);
        const outBA = resolvePairwiseOutcome(nodeB, nodeA, bInA, aInB, false);

        assert.ok(
          outAB === 'A_REPLACES_B' || outAB === 'B_REPLACES_A',
          `Pair (${classA}, ${classB}) state=[${aInB},${bInA}] must resolve to a single owner, got ${outAB}`
        );
        // Antisymmetry invariant: A_REPLACES_B(A, B) <=> B_REPLACES_A(B, A)
        if (outAB === 'A_REPLACES_B') {
          assert.equal(
            outBA,
            'B_REPLACES_A',
            `Antisymmetry violated for (${classA}, ${classB}) state=[${aInB},${bInA}]`
          );
        } else {
          assert.equal(
            outBA,
            'A_REPLACES_B',
            `Antisymmetry violated for (${classA}, ${classB}) state=[${aInB},${bInA}]`
          );
        }
      }
    }
  }
});

test('Pure geometric containment has no 92% area cutoff and rejects large protruding polygons via collar & excursion bounds', () => {
  // 1. A courtyard garden covering 96% of a 10m x 10m courtyard (9.8m x 9.8m = 96.04 m² inside 100 m²)
  // must be classified as geometrically contained (no 92% area heuristic!)
  const outerCourtyard = conditionPolygonToMultiPolygon([
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
  ]);
  const innerGarden96Pct = conditionPolygonToMultiPolygon([
    [
      [0.1, 0.1],
      [9.9, 0.1],
      [9.9, 9.9],
      [0.1, 9.9],
      [0.1, 0.1],
    ],
  ]);
  assert.equal(
    isGeometricallyContained(innerGarden96Pct, outerCourtyard),
    true,
    'A garden covering 96% of a courtyard and strictly inside its boundary must be classified as geometrically contained'
  );

  // 2. A polygon that protrudes 2.0m outside the parent boundary (excursion = 2.0m > 0.25m limit)
  // must NOT be classified as contained even if > 95% of its area lies inside the parent
  const largeOuter = conditionPolygonToMultiPolygon([
    [
      [0, 0],
      [200, 0],
      [200, 200],
      [0, 200],
      [0, 0],
    ],
  ]);
  const protrudingPoly = conditionPolygonToMultiPolygon([
    [
      [-2.0, 50], // Protrudes 2.0m outside X=0!
      [100, 50],
      [100, 150],
      [-2.0, 150],
      [-2.0, 50],
    ],
  ]);
  assert.equal(
    isGeometricallyContained(protrudingPoly, largeOuter),
    false,
    'A polygon protruding 2.0m outside the parent boundary must be rejected by the perimeter collar & 0.25m linear excursion bounds'
  );
});

test('Symmetric duplicate detection, same-type partial overlap resolution, and small Boolean remainder preservation', () => {
  const polyA = conditionPolygonToMultiPolygon([
    [
      [0, 0],
      [30, 0],
      [30, 20],
      [0, 20],
      [0, 0],
    ],
  ]);
  // Slightly shifted by 4cm along one edge (within 15cm Hausdorff & collar tolerance)
  const polyB = conditionPolygonToMultiPolygon([
    [
      [0, 0],
      [30, 0],
      [30, 20.04],
      [0, 20.04],
      [0, 0],
    ],
  ]);

  const descA = { category: 'landuse', subtype: 'parking', name: 'Station Lot', mp: polyA, perimeter: 100 };
  const descB = { category: 'landuse', subtype: 'parking', name: 'Station Lot', mp: polyB, perimeter: 100.08 };

  assert.equal(isConfirmedDuplicateSurface(descA, descB), true, 'Near-identical duplicate parking polygons must match');
  assert.equal(
    isConfirmedDuplicateSurface(descA, descB),
    isConfirmedDuplicateSurface(descB, descA),
    'Duplicate detection must be strictly symmetric'
  );

  // Distinctly named overlapping parking lots must NOT be treated as duplicates,
  // and must resolve into mutually exclusive flush polygons at +0.025m with zero raised step edges
  const provider = new LocalGeoJsonProvider();
  const overlappingParkingFixture = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'parking-lot-north',
        properties: { amenity: 'parking', name: 'North Retail Parking' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.7900, 52.2600],
              [6.7910, 52.2600],
              [6.7910, 52.2608],
              [6.7900, 52.2608],
              [6.7900, 52.2600],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'parking-lot-south',
        properties: { amenity: 'parking', name: 'South Station Parking' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.7904, 52.2604],
              [6.7914, 52.2604],
              [6.7914, 52.2612],
              [6.7904, 52.2612],
              [6.7904, 52.2604],
            ],
          ],
        },
      },
    ],
  };

  const parsed = provider.parseGeoJson(overlappingParkingFixture);
  const { resolvedById, report } = resolveAndValidatePlanarPolygons(parsed.landuse, parsed.parks);
  assert.equal(report.isValid, true);
  assert.ok(report.maxResidualFillOverlapSqMeters <= MAX_ALLOWED_SURFACE_FILL_OVERLAP_AREA);

  const north = Array.from(resolvedById.values()).find((l) => l.id.includes('parking-lot-north'))!;
  const south = Array.from(resolvedById.values()).find((l) => l.id.includes('parking-lot-south'))!;
  assert.equal(north.elevationY, south.elevationY, 'Overlapping parking lots must share the same flush elevation without raised steps');
});

test('Scene-derived orthographic frustum tightens depth range by >7x and guarantees multi-step 16-bit road margin at 72° tilt', () => {
  const bounds = { minX: -220, maxX: 220, minZ: -220, maxZ: 220 };
  const camPos: [number, number, number] = [380, 460, 380];
  const camTarget: [number, number, number] = [0, 0, 0];

  const legacySpan50k = 50000 - 1;
  const legacySpan10k = 10000 - 5;
  const derived = computeSceneFrustumPlanes(bounds, camPos, camTarget, { minY: -2.0, maxY: 24.0 });

  assert.ok(derived.near >= 0.1, `Derived near plane (${derived.near}m) must be positive`);
  assert.ok(
    derived.depthSpan < 1400,
    `Derived depthSpan (${derived.depthSpan}m) for a 440m tile must be < 1400m`
  );

  const step24Legacy50k = legacySpan50k / 16777215;
  const step24Legacy10k = legacySpan10k / 16777215;
  const step24Derived = derived.depthSpan / 16777215;

  assert.ok(
    step24Legacy50k / step24Derived > 35,
    `Derived frustum must improve depth precision by >35x over 50km frustum`
  );
  assert.ok(
    step24Legacy10k / step24Derived > 7,
    `Derived frustum must improve depth precision by >7x over 10km frustum`
  );

  // Verify 16-bit depth step at 72° polar tilt for unified at-grade road (+0.050m vs +0.025m ground cover) + DEPTH_OFFSET_CONFIG
  const step16Derived = derived.depthSpan / 65535;
  const cos72 = Math.cos((72 * Math.PI) / 180);
  const roadPhysicalViewDelta = (ELEVATION_POLICY.ROAD_SURFACE - ELEVATION_POLICY.GROUND_COVER_SURFACE) * cos72;
  const effectiveStepsWithOffset =
    roadPhysicalViewDelta / step16Derived + Math.abs(DEPTH_OFFSET_CONFIG.roads.polygonOffsetUnits);

  assert.ok(
    roadPhysicalViewDelta > 0,
    `At-grade road physical depth delta over ground cover at 72° tilt (${(roadPhysicalViewDelta * 1000).toFixed(2)}mm) must be positive`
  );
  assert.ok(
    effectiveStepsWithOffset >= 2.5,
    `At-grade road total 16-bit depth separation over ground cover at 72° tilt (${effectiveStepsWithOffset.toFixed(2)} steps) must be >= 2.5 steps`
  );
});

test('TKT-002 Regression: DEPTH_OFFSET_CONFIG enforces clear non-fighting hierarchy across Railway_Ballast, Railway_Sleepers, and Railway_Rails', () => {
  // 1. Verify physical elevation hierarchy (0.060m < 0.072m < 0.085m)
  assert.equal(ELEVATION_POLICY.RAILWAY_BALLAST, 0.060);
  assert.equal(ELEVATION_POLICY.RAILWAY_SLEEPERS, 0.072);
  assert.equal(ELEVATION_POLICY.RAILWAY_RAILS, 0.085);

  // 2. Verify DEPTH_OFFSET_CONFIG enforces progressive negative polygonOffset across all three railway layers
  assert.equal(DEPTH_OFFSET_CONFIG.railways.polygonOffset, true);
  assert.equal(DEPTH_OFFSET_CONFIG.railwaySleepers.polygonOffset, true);
  assert.equal(DEPTH_OFFSET_CONFIG.railwayRails.polygonOffset, true);

  assert.ok(
    DEPTH_OFFSET_CONFIG.railways.polygonOffsetFactor < 0,
    'Railway_Ballast polygonOffsetFactor must be negative'
  );
  assert.ok(
    DEPTH_OFFSET_CONFIG.railwaySleepers.polygonOffsetFactor <
      DEPTH_OFFSET_CONFIG.railways.polygonOffsetFactor,
    `Railway_Sleepers factor (${DEPTH_OFFSET_CONFIG.railwaySleepers.polygonOffsetFactor}) must be more negative than Railway_Ballast (${DEPTH_OFFSET_CONFIG.railways.polygonOffsetFactor})`
  );
  assert.ok(
    DEPTH_OFFSET_CONFIG.railwayRails.polygonOffsetFactor <
      DEPTH_OFFSET_CONFIG.railwaySleepers.polygonOffsetFactor,
    `Railway_Rails factor (${DEPTH_OFFSET_CONFIG.railwayRails.polygonOffsetFactor}) must be more negative than Railway_Sleepers (${DEPTH_OFFSET_CONFIG.railwaySleepers.polygonOffsetFactor})`
  );
  assert.ok(
    DEPTH_OFFSET_CONFIG.railwayRails.polygonOffsetUnits <
      DEPTH_OFFSET_CONFIG.railwaySleepers.polygonOffsetUnits &&
      DEPTH_OFFSET_CONFIG.railwaySleepers.polygonOffsetUnits <
        DEPTH_OFFSET_CONFIG.railways.polygonOffsetUnits,
    'polygonOffsetUnits must strictly progress from ballast to sleepers to rails'
  );

  // 3. Verify all map themes use balanced brushed steel rail tones rather than blown-out white
  for (const [themeKey, theme] of Object.entries(MAP_THEMES)) {
    const railColor = theme.railwayColors.rail.toLowerCase();
    assert.notEqual(railColor, '#ffffff', `Theme ${themeKey} railway rail must not be pure white #ffffff`);
    assert.notEqual(railColor, '#f8fafc', `Theme ${themeKey} railway rail must not be #f8fafc`);
    assert.notEqual(railColor, '#f1f5f9', `Theme ${themeKey} railway rail must not be #f1f5f9`);
  }
});

test('TKT-001 Regression: At-grade Railway_Rails render as flat coplanar UV-ribbons with uniform [0, 1, 0] normals, castShadow=false, stencil layer locking, and hybrid 3D detail meshes', () => {
  const provider = new LocalGeoJsonProvider();
  const builder = new GeometryBuilder();
  const theme = MAP_THEMES.tactical;

  const railwayFixture = {
    type: 'FeatureCollection',
    name: 'Railway Switch and Crossing Test Fixture',
    features: [
      {
        type: 'Feature',
        id: 'railway-through-track',
        properties: {
          railway: 'rail',
          name: 'Main Line Through',
          layer: 0,
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.890, 52.378],
            [4.900, 52.378],
            [4.910, 52.378],
            [4.920, 52.378],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'railway-turnout-diverging',
        properties: {
          railway: 'rail',
          name: 'Turnout Branch',
          layer: 0,
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.900, 52.378], // Diverges at switch point
            [4.910, 52.3792], // ~6.8 degree angle
            [4.920, 52.3804],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'railway-diamond-crossing',
        properties: {
          railway: 'rail',
          name: 'Perpendicular Spur',
          layer: 0,
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.905, 52.372],
            [4.905, 52.378], // Perpendicular diamond crossing
            [4.905, 52.384],
          ],
        },
      },
    ],
  };

  const parsed = provider.parseGeoJson(railwayFixture);
  assert.equal(parsed.railways.length, 3, 'Must parse all 3 railway tracks');

  const scene = builder.buildScene(parsed, theme);

  const railwayTargets = scene.railwaysGroup.children;
  const ballastTarget = railwayTargets.find((m) => m.name === 'Railway_Ballast')!;
  const sleepersTarget = railwayTargets.find((m) => m.name === 'Railway_Sleepers')!;
  const railsTarget = railwayTargets.find((m) => m.name === 'Railway_Rails')!;
  const sleepers3DTarget = railwayTargets.find((m) => m.name.startsWith('Railway_Sleepers_3D'))!;
  const rails3DTarget = railwayTargets.find((m) => m.name.startsWith('Railway_Rails_3D'))!;

  assert.ok(ballastTarget, 'Railway_Ballast target must exist');
  assert.ok(sleepersTarget, 'Railway_Sleepers procedural UV-ribbon target must exist');
  assert.ok(railsTarget, 'Railway_Rails procedural UV-ribbon target must exist');
  assert.ok(sleepers3DTarget, 'Railway_Sleepers_3D instanced target must exist');
  assert.ok(rails3DTarget, 'Railway_Rails_3D extruded rail target must exist');

  const firstMesh = (obj: THREE.Object3D): THREE.Mesh =>
    (obj as THREE.Mesh).isMesh ? (obj as THREE.Mesh) : (obj.children[0] as THREE.Mesh);

  const ballastMesh = firstMesh(ballastTarget);
  const sleepersMesh = firstMesh(sleepersTarget);
  const railsMesh = firstMesh(railsTarget);
  const sleepers3DMesh = firstMesh(sleepers3DTarget);
  const rails3DMesh = firstMesh(rails3DTarget);

  // 1. Verify castShadow is false on all at-grade railway sub-meshes to prevent shadow acne and normal bias artifacts
  assert.equal(railsMesh.castShadow, false, 'Railway_Rails must have castShadow = false');
  assert.equal(sleepersMesh.castShadow, false, 'Railway_Sleepers must have castShadow = false');
  assert.equal(ballastMesh.castShadow, false, 'Railway_Ballast must have castShadow = false');
  assert.equal(sleepers3DMesh.castShadow, false, 'Railway_Sleepers_3D must have castShadow = false');
  assert.equal(rails3DMesh.castShadow, false, 'Railway_Rails_3D must have castShadow = false');

  // 2. Verify every single vertex of at-grade Railway_Rails sits at Y=0.085m with exact upward normal [0, 1, 0] and continuous UV attribute
  const railPos = railsMesh.geometry.attributes.position;
  const railNorm = railsMesh.geometry.attributes.normal;
  const railUv = railsMesh.geometry.attributes.uv;
  assert.ok(railUv, 'Railway_Rails must have continuous arc-length and signed lateral UV attribute');

  for (let i = 0; i < railNorm.count; i++) {
    assert.ok(
      Math.abs(railPos.getY(i) - ELEVATION_POLICY.RAILWAY_RAILS) <= 1e-4,
      `At-grade rail vertex ${i} Y (${railPos.getY(i)}) must equal ${ELEVATION_POLICY.RAILWAY_RAILS}m`
    );
    assert.ok(
      Math.abs(railNorm.getX(i)) <= 1e-5 &&
        Math.abs(railNorm.getY(i) - 1.0) <= 1e-5 &&
        Math.abs(railNorm.getZ(i)) <= 1e-5,
      `At-grade rail vertex ${i} normal ([${railNorm.getX(i)}, ${railNorm.getY(i)}, ${railNorm.getZ(i)}]) must be [0, 1, 0]`
    );
  }

  // 3. Verify stencil write-once layer locking and polygonOffset hierarchy on railway materials
  const ballastMat = ballastMesh.material as THREE.MeshStandardMaterial;
  const sleepersMat = sleepersMesh.material as THREE.MeshStandardMaterial;
  const railsMat = railsMesh.material as THREE.MeshStandardMaterial;

  for (const [label, mat, expectedRef] of [
    ['Railway_Ballast', ballastMat, 14],
    ['Railway_Sleepers', sleepersMat, 15],
    ['Railway_Rails', railsMat, 16],
  ] as const) {
    assert.equal(mat.side, THREE.FrontSide, `${label} must use FrontSide`);
    assert.equal(mat.polygonOffset, true, `${label} must enable polygonOffset`);
    assert.equal(mat.depthFunc, THREE.LessEqualDepth, `${label} must use LessEqualDepth`);
    assert.equal(mat.stencilWrite, true, `${label} must enable stencilWrite for idempotent sub-layer locking`);
    assert.equal(mat.stencilFunc, THREE.NotEqualStencilFunc, `${label} must use NotEqualStencilFunc`);
    assert.equal(mat.stencilZPass, THREE.ReplaceStencilOp, `${label} must use ReplaceStencilOp`);
    assert.equal(mat.stencilRef, expectedRef, `${label} must use stencilRef=${expectedRef}`);
  }

  scene.dispose();
});

test('TKT-001 Regression: Cross-tie sleepers and continuous rails render across switches, overlapping tracks, and short split OSM segments without dropouts', () => {
  const provider = new LocalGeoJsonProvider();
  const builder = new GeometryBuilder();
  const theme = MAP_THEMES.tactical;

  // 1. Switch turnout + overlapping track fixture: verify continuous sleepers and shared turnout bearers
  const switchFixture = {
    type: 'FeatureCollection',
    name: 'Switch Sleeper Continuity Fixture',
    features: [
      {
        type: 'Feature',
        id: 'main-track',
        properties: { railway: 'rail', name: 'Main Track', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.890, 52.378],
            [4.894, 52.378],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'switch-branch-track',
        properties: { railway: 'rail', name: 'Switch Branch', layer: 0 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.890, 52.378],
            [4.894, 52.37815], // Shallow turnout diverging over ~270m
          ],
        },
      },
    ],
  };

  const parsedSwitch = provider.parseGeoJson(switchFixture);
  const sceneSwitch = builder.buildScene(parsedSwitch, theme);
  const switchSleepersTarget = sceneSwitch.railwaysGroup.children.find(
    (m) => m.name === 'Railway_Sleepers'
  )!;
  const switchRanges = (switchSleepersTarget.userData as any).faceRanges as Array<{
    startFace: number;
    endFace: number;
    info: any;
  }>;

  assert.equal(switchRanges.length, 2, 'Both main track and switch branch must generate sleeper UV-ribbon ranges');

  const switchSleepers3DTarget = sceneSwitch.railwaysGroup.children.find((m) =>
    m.name.startsWith('Railway_Sleepers_3D')
  )!;
  const totalSwitch3DSleepers = ((switchSleepers3DTarget.userData as any).instanceInfos || []).length;
  assert.ok(
    totalSwitch3DSleepers >= 350,
    `Turnout fixture must generate continuous 3D sleepers across main and diverging branch tracks (got ${totalSwitch3DSleepers})`
  );
  sceneSwitch.dispose();

  // 2. Fragmented short OSM segments (< 1.45m each) chained end-to-end:
  // Verify continuous phase propagation places sleepers across short segments without dropping ties
  const splitCoords: [number, number][] = [
    [4.90000, 52.378],
    [4.90001, 52.378], // ~0.68m
    [4.90002, 52.378], // ~0.68m
    [4.90003, 52.378], // ~0.68m
    [4.90004, 52.378], // ~0.68m
    [4.90005, 52.378], // ~0.68m
    [4.90006, 52.378], // ~0.68m
    [4.90007, 52.378], // ~0.68m (total ~4.76m across 7 segments < 1.45m each)
  ];
  const splitFeatures = [];
  for (let i = 0; i < splitCoords.length - 1; i++) {
    splitFeatures.push({
      type: 'Feature',
      id: `short-rail-seg-${i}`,
      properties: { railway: 'rail', name: `Short Seg ${i}`, layer: 0 },
      geometry: {
        type: 'LineString',
        coordinates: [splitCoords[i], splitCoords[i + 1]],
      },
    });
  }

  const parsedSplit = provider.parseGeoJson({
    type: 'FeatureCollection',
    features: splitFeatures,
  });
  const sceneSplit = builder.buildScene(parsedSplit, theme);
  const splitSleepersTarget = sceneSplit.railwaysGroup.children.find(
    (m) => m.name === 'Railway_Sleepers'
  )!;
  assert.ok(
    splitSleepersTarget,
    'Chained short railway segments (< 1.45m each) must generate Railway_Sleepers UV-ribbon target'
  );
  const splitSleepers3DTarget = sceneSplit.railwaysGroup.children.find((m) =>
    m.name.startsWith('Railway_Sleepers_3D')
  )!;
  const totalSplit3DSleepers = ((splitSleepers3DTarget.userData as any).instanceInfos || []).length;
  assert.ok(
    totalSplit3DSleepers >= 3,
    `4.76m track split into 0.68m segments must generate >= 3 continuous 3D sleepers (got ${totalSplit3DSleepers})`
  );
  sceneSplit.dispose();

  // 3. Shallow-angle (~3.8°) crossover between two parallel mainline tracks (4.3m apart, Station Hengelo geometry):
  // Verify Candidate B emits unbroken continuous rails across all 3 tracks and clips overlapping sleepers in the throat.
  const crossoverData = {
    ...parsedSplit,
    bounds: { minX: -150, maxX: 150, minZ: -50, maxZ: 50, widthMeters: 300, depthMeters: 100 },
    buildings: [],
    roads: [],
    waterBodies: [],
    linearWaterways: [],
    parks: [],
    landuse: [],
    barriers: [],
    landmarks: [],
    transitStops: [],
    pois: [],
    railways: [
      {
        id: 'crossover-diagonal',
        type: 'railway' as const,
        sourceFeatureId: 'way/97083511',
        name: 'Crossover',
        railwayType: 'rail' as const,
        width: 3.8,
        layer: 0,
        isBridge: false,
        isTunnel: false,
        points: [
          [0, 0],
          [10, 0.25],
          [32, 2.15],
          [54, 4.05],
          [64, 4.3],
        ] as [number, number][],
      },
      {
        id: 'mainline-south',
        type: 'railway' as const,
        sourceFeatureId: 'way/375453822',
        name: 'Mainline South',
        railwayType: 'rail' as const,
        width: 3.8,
        layer: 0,
        isBridge: false,
        isTunnel: false,
        points: [
          [-80, 0],
          [0, 0],
          [64, 0],
          [140, 0],
        ] as [number, number][],
      },
      {
        id: 'mainline-north',
        type: 'railway' as const,
        sourceFeatureId: 'way/375453814',
        name: 'Mainline North',
        railwayType: 'rail' as const,
        width: 3.8,
        layer: 0,
        isBridge: false,
        isTunnel: false,
        points: [
          [-80, 4.3],
          [0, 4.3],
          [64, 4.3],
          [140, 4.3],
        ] as [number, number][],
      },
    ],
  };

  const sceneCrossover = builder.buildScene(crossoverData, theme);
  const crossoverRailsTarget = sceneCrossover.railwaysGroup.children.find(
    (m) => m.name === 'Railway_Rails'
  )!;
  const railRanges = (crossoverRailsTarget.userData as any).faceRanges as Array<{
    startFace: number;
    endFace: number;
    info: any;
  }>;
  assert.equal(railRanges.length, 6, 'All 3 tracks (both mainlines and crossover) must emit left and right continuous rail UV-ribbons (6 ranges)');
  const crossoverRange = railRanges.find((r) => r.info.id === 'crossover-diagonal')!;
  assert.ok(crossoverRange, 'Crossover must emit continuous rail range');
  sceneCrossover.dispose();
});
