import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { GeometryBuilder, generateParkingStallMarkings } from './GeometryBuilder';
import { ELEVATION_POLICY } from './ElevationPolicy';
import { MAP_THEMES } from '../styles/mapThemes';
import { classifyGeoJsonFeature } from './FeatureCatalogue';
import { validateSceneZeroZFighting } from './ZFightingValidator';

// GeoJSON Fixture containing the exact test cases required by the code review:
// 1. A mainline railway line
// 2. A tram line
// 3. A linear river (LineString waterway)
// 4. A polygonal lake (Polygon water)
// 5. A road and a building
// 6. An unsupported OSM feature (e.g. power=line)
// 7. A malformed / degenerate geometry (LineString with 1 point)
const TEST_GEOJSON_FIXTURE = {
  type: 'FeatureCollection',
  name: 'Test Feature Coverage Area',
  features: [
    // 1. Mainline railway line
    {
      type: 'Feature',
      id: 'railway-mainline-1',
      properties: {
        name: 'Intercity Mainline',
        railway: 'rail',
        gauge: '1435',
        electrified: 'contact_line',
        layer: 0,
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [4.898, 52.378],
          [4.902, 52.379],
          [4.906, 52.380],
        ],
      },
    },
    // 2. Tram / Light-rail line
    {
      type: 'Feature',
      id: 'tram-line-2',
      properties: {
        name: 'City Tram 4',
        railway: 'tram',
        layer: 0,
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [4.899, 52.377],
          [4.901, 52.3775],
          [4.903, 52.378],
        ],
      },
    },
    // 3. Linear river (LineString waterway)
    {
      type: 'Feature',
      id: 'waterway-river-3',
      properties: {
        name: 'Amstel River',
        waterway: 'river',
        width: 25.0,
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [4.897, 52.375],
          [4.900, 52.376],
          [4.905, 52.377],
        ],
      },
    },
    // 4. Polygonal lake (Polygon natural=water)
    {
      type: 'Feature',
      id: 'lake-polygon-4',
      properties: {
        name: 'Marina Basin',
        natural: 'water',
        water: 'basin',
      },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [4.905, 52.381],
            [4.909, 52.381],
            [4.909, 52.384],
            [4.905, 52.384],
            [4.905, 52.381],
          ],
        ],
      },
    },
    // 5a. A road
    {
      type: 'Feature',
      id: 'road-primary-5a',
      properties: {
        name: 'Prins Hendrikkade',
        highway: 'primary',
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [4.898, 52.376],
          [4.903, 52.377],
          [4.908, 52.378],
        ],
      },
    },
    // 5b. A building
    {
      type: 'Feature',
      id: 'building-station-5b',
      properties: {
        name: 'Station Hall',
        building: 'train_station',
        height: '24',
        'building:levels': '4',
      },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [4.900, 52.3785],
            [4.904, 52.3785],
            [4.904, 52.380],
            [4.900, 52.380],
            [4.900, 52.3785],
          ],
        ],
      },
    },
    // 6. Unsupported OSM feature
    {
      type: 'Feature',
      id: 'unsupported-power-6',
      properties: {
        power: 'line',
        voltage: '110000',
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [4.895, 52.374],
          [4.899, 52.375],
        ],
      },
    },
    // 7. Malformed / degenerate geometry (LineString with only 1 point)
    {
      type: 'Feature',
      id: 'degenerate-line-7',
      properties: {
        highway: 'residential',
        name: 'Broken Point Line',
      },
      geometry: {
        type: 'LineString',
        coordinates: [[4.901, 52.376]], // degenerate: only 1 point!
      },
    },
  ],
};

test('FeatureCatalogue classifies supported and unsupported tags correctly', () => {
  // Test railway
  const rClass = classifyGeoJsonFeature({ railway: 'rail' }, 'LineString');
  assert.equal(rClass.category, 'railway');
  assert.equal(rClass.subtype, 'rail');
  assert.equal(rClass.defaultWidth, 4.8);

  // Test tram
  const tClass = classifyGeoJsonFeature({ railway: 'tram' }, 'LineString');
  assert.equal(tClass.category, 'railway');
  assert.equal(tClass.subtype, 'tram');
  assert.equal(tClass.defaultWidth, 3.2);

  // Test linear waterway
  const wLine = classifyGeoJsonFeature({ waterway: 'river' }, 'LineString');
  assert.equal(wLine.category, 'water_line');
  assert.equal(wLine.subtype, 'river');

  // Test polygonal water
  const wPoly = classifyGeoJsonFeature({ natural: 'water' }, 'Polygon');
  assert.equal(wPoly.category, 'water_polygon');

  // Test unsupported tag
  const unsupp = classifyGeoJsonFeature({ power: 'line' }, 'LineString');
  assert.equal(unsupp.category, 'unsupported');
  assert.equal(unsupp.primaryTag, 'power=line');
});

test('LocalGeoJsonProvider parses all feature types and records rich diagnostics', () => {
  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(TEST_GEOJSON_FIXTURE);

  // Assert feature extractions
  assert.equal(parsed.railways.length, 2, 'Must extract 2 railway features (mainline and tram)');
  assert.equal(parsed.railways[0].railwayType, 'rail');
  assert.equal(parsed.railways[0].electrified, true);
  assert.equal(parsed.railways[1].railwayType, 'tram');

  assert.equal(parsed.linearWaterways.length, 1, 'Must extract 1 linear waterway');
  assert.equal(parsed.linearWaterways[0].waterwayType, 'river');
  assert.equal(parsed.linearWaterways[0].width, 25.0);

  assert.equal(parsed.waterBodies.length, 1, 'Must extract 1 polygonal water body');
  assert.equal(parsed.roads.length, 1, 'Must extract 1 road feature');
  assert.equal(parsed.buildings.length, 1, 'Must extract 1 building feature');
  assert.equal(parsed.buildings[0].height, 24);

  // Assert Diagnostics
  const diag = parsed.diagnostics;
  assert.equal(diag.totalFeaturesReceived, 8, 'Total features received must be 8');
  assert.equal(diag.totalFeaturesParsed, 6, 'Total features parsed must be 6 (2 railways + 1 water line + 1 water poly + 1 road + 1 building)');
  assert.equal(diag.skippedUnsupported.total, 1, 'Must record 1 skipped unsupported feature');
  assert.ok(diag.skippedUnsupported.byTag['power=line'], 'Must identify power=line as skipped tag');
  assert.equal(diag.skippedUnsupported.byTag['power=line'].count, 1);

  assert.equal(diag.rejectedInvalid.total, 1, 'Must record 1 rejected invalid geometry');
  assert.ok(
    diag.rejectedInvalid.byReason['degenerate_road_linestring (< 2 points)'],
    'Must record degenerate road linestring reason'
  );
});

test('GeometryBuilder generates 3D geometries for railways, linear waterways, roads, and buildings', () => {
  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(TEST_GEOJSON_FIXTURE);

  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.tactical);

  // 1. Railways group verification (Ballast + Procedural UV-Ribbons + 3D Sleepers & Twin Steel Rails)
  assert.ok(scene.railwaysGroup, 'Railways group must exist');
  assert.equal(
    scene.railwaysGroup.children.length,
    5,
    'Railways group must contain Ballast, procedural Sleepers/Rails UV-ribbons, and 3D Sleepers/Rails targets'
  );
  const ballastTarget = scene.railwaysGroup.children.find((c) => c.name === 'Railway_Ballast') as any;
  const sleepersTarget = scene.railwaysGroup.children.find((c) => c.name === 'Railway_Sleepers') as any;
  const railsTarget = scene.railwaysGroup.children.find((c) => c.name === 'Railway_Rails') as any;
  const sleepers3DTarget = scene.railwaysGroup.children.find((c) =>
    c.name.startsWith('Railway_Sleepers_3D')
  ) as any;
  const rails3DTarget = scene.railwaysGroup.children.find((c) =>
    c.name.startsWith('Railway_Rails_3D')
  ) as any;
  assert.ok(ballastTarget, 'Railway ballast layer must be rendered');
  assert.ok(sleepersTarget, 'Railway procedural sleepers UV-ribbon layer must be rendered');
  assert.ok(railsTarget, 'Railway procedural rails UV-ribbon layer must be rendered');
  assert.ok(sleepers3DTarget, 'Railway 3D sleepers layer must be rendered');
  assert.ok(rails3DTarget, 'Railway 3D twin steel rails layer must be rendered');

  const ballastMesh = ballastTarget.isMesh ? ballastTarget : ballastTarget.children[0];
  const sleepersMesh = sleepersTarget.isMesh ? sleepersTarget : sleepersTarget.children[0];
  const railsMesh = railsTarget.isMesh ? railsTarget : railsTarget.children[0];

  const ballastY = ballastMesh.geometry.attributes.position.getY(0);
  const sleepersY = sleepersMesh.geometry.attributes.position.getY(0);
  const railsTopY = railsMesh.geometry.attributes.position.getY(0);
  assert.ok(
    ballastY < sleepersY && sleepersY < railsTopY,
    `Railway track hierarchy must enforce Ballast (${ballastY}) < Sleepers (${sleepersY}) < Rails (${railsTopY})`
  );
  assert.ok(
    Array.isArray(sleepersTarget.userData.faceRanges) && sleepersTarget.userData.faceRanges.length === 2,
    'Railway_Sleepers must preserve faceRanges for both mainline and tram tracks'
  );
  assert.ok(
    Array.isArray(railsTarget.userData.faceRanges) && railsTarget.userData.faceRanges.length === 4,
    'Railway_Rails UV-ribbon must preserve faceRanges for left and right rails of both mainline and tram tracks'
  );

  // 2. Water group verification (contains both polygon basin and linear river)
  assert.ok(scene.waterGroup, 'Water group must exist');
  assert.ok(scene.waterGroup.children.length > 0, 'Water group must contain merged water surfaces');

  // 3. Roads and Buildings
  assert.ok(scene.roadsGroup.children.length > 0, 'Roads group must contain road surfaces');
  assert.ok(scene.buildingsGroup.children.length > 0, 'Buildings group must contain 3D building extrusions');

  // 4. Feature render count
  assert.ok(scene.stats.renderedFeaturesCount >= 6, 'Rendered features count must be at least 6');
  assert.equal(parsed.diagnostics.totalFeaturesRendered, scene.stats.renderedFeaturesCount);
});

test('OSM Carto taxonomy, procedural 3D forests, barriers, landmarks, and universal raycast inspection work end-to-end', () => {
  // 1. Verify OSM Carto classification across newly supported categories
  const forestClass = classifyGeoJsonFeature({ landuse: 'forest', leaf_type: 'needleleaved' }, 'Polygon');
  assert.equal(forestClass.category, 'park');
  assert.equal(forestClass.subtype, 'forest');
  assert.equal(forestClass.has3DFoliage, true);
  assert.equal(forestClass.leafType, 'needleleaved');

  const trackClass = classifyGeoJsonFeature({ highway: 'track' }, 'LineString');
  assert.equal(trackClass.category, 'road');
  assert.equal(trackClass.subtype, 'track');

  const hedgeClass = classifyGeoJsonFeature({ barrier: 'hedge' }, 'LineString');
  assert.equal(hedgeClass.category, 'barrier');
  assert.equal(hedgeClass.subtype, 'hedge');

  const treePointClass = classifyGeoJsonFeature({ natural: 'tree', leaf_type: 'broadleaved' }, 'Point');
  assert.equal(treePointClass.category, 'landmark');
  assert.equal(treePointClass.subtype, 'tree');

  const churchClass = classifyGeoJsonFeature({ building: 'church', amenity: 'place_of_worship' }, 'Polygon');
  assert.equal(churchClass.category, 'building');
  assert.equal(churchClass.buildingArchetype, 'religious');

  // 2. Build a scene with a forest polygon, a hedge barrier, a track road, and a solitary tree
  const cartoFixture = {
    type: 'FeatureCollection',
    name: 'Carto Forest & Barrier Test',
    features: [
      {
        type: 'Feature',
        id: 'forest-poly-1',
        properties: {
          name: 'Twente Pine Forest',
          landuse: 'forest',
          leaf_type: 'needleleaved',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.790, 52.260],
              [6.792, 52.260],
              [6.792, 52.262],
              [6.790, 52.262],
              [6.790, 52.260],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'hedge-barrier-1',
        properties: {
          name: 'Station Hedge',
          barrier: 'hedge',
          height: '2.2',
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [6.790, 52.2595],
            [6.792, 52.2595],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'solitary-tree-1',
        properties: {
          name: 'Monumental Oak',
          natural: 'tree',
          leaf_type: 'broadleaved',
        },
        geometry: {
          type: 'Point',
          coordinates: [6.7925, 52.2605],
        },
      },
    ],
  };

  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(cartoFixture);

  assert.equal(parsed.parks.length, 1, 'Forest polygon extracted into parks');
  assert.equal(parsed.parks[0].has3DFoliage, true, 'Forest polygon flagged for 3D procedural foliage');
  assert.equal(parsed.barriers.length, 1, 'Hedge extracted into barriers');
  assert.equal(parsed.landmarks.length, 1, 'Solitary tree extracted into landmarks');

  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.tactical);

  assert.ok(scene.barriersGroup.children.length > 0, 'Barriers group must contain extruded hedge mesh');
  assert.ok(scene.foliageGroup.children.length > 0, 'Foliage group must contain instanced 3D tree meshes');
  assert.ok((scene.stats.forestTreesCount ?? 0) > 5, 'Must procedurally scatter 3D trees inside forest polygon and at tree point');

  // Verify faceRanges on merged park mesh for hover/click inspection
  const parkMesh = scene.parksGroup.children[0];
  assert.ok(Array.isArray(parkMesh.userData.faceRanges), 'Merged park mesh must store faceRanges for raycast inspection');
  assert.equal(parkMesh.userData.faceRanges[0].info.name, 'Twente Pine Forest');
  assert.equal(parkMesh.userData.faceRanges[0].info.primaryTag, 'landuse=forest + leaf_type=needleleaved');
});

test('Parking spaces eliminate Z-fighting against parent landuse, generate stall markings, and render 3D benches, bins, lamps, and open-air roofs with pillars', () => {
  // 1. Verify classification of new subtypes
  const spaceClass = classifyGeoJsonFeature({ amenity: 'parking_space' }, 'Polygon');
  assert.equal(spaceClass.category, 'landuse');
  assert.equal(spaceClass.subtype, 'parking_space');

  const benchClass = classifyGeoJsonFeature({ amenity: 'bench', backrest: 'yes' }, 'Point');
  assert.equal(benchClass.category, 'landmark');
  assert.equal(benchClass.subtype, 'bench');

  const binClass = classifyGeoJsonFeature({ amenity: 'waste_basket' }, 'Point');
  assert.equal(binClass.category, 'landmark');
  assert.equal(binClass.subtype, 'waste_basket');

  const lampClass = classifyGeoJsonFeature({ highway: 'street_lamp' }, 'Point');
  assert.equal(lampClass.category, 'landmark');
  assert.equal(lampClass.subtype, 'street_lamp');

  const roofClass = classifyGeoJsonFeature({ building: 'roof' }, 'Polygon');
  assert.equal(roofClass.category, 'building');
  assert.equal(roofClass.isRoofOnly, true);

  // 2. Build a scene with nested commercial landuse -> parking lot -> individual parking space,
  // plus a building=roof canopy, a sports pitch, stairway steps, and street furniture (bench, bin, lamp)
  const flairFixture = {
    type: 'FeatureCollection',
    name: 'Parking Z-Fighting & Urban Flair Fixture',
    features: [
      // Parent commercial landuse
      {
        type: 'Feature',
        id: 'commercial-zone-1',
        properties: { landuse: 'commercial', name: 'Station Commercial District' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.790, 52.260],
              [6.794, 52.260],
              [6.794, 52.263],
              [6.790, 52.263],
              [6.790, 52.260],
            ],
          ],
        },
      },
      // Surface parking lot inside commercial landuse
      {
        type: 'Feature',
        id: 'parking-lot-1',
        properties: { amenity: 'parking', parking: 'surface', name: 'P+R Station Lot' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.7905, 52.2605],
              [6.7915, 52.2605],
              [6.7915, 52.2612],
              [6.7905, 52.2612],
              [6.7905, 52.2605],
            ],
          ],
        },
      },
      // Individual parking space inside parking lot
      {
        type: 'Feature',
        id: 'parking-space-1',
        properties: { amenity: 'parking_space', name: 'EV Spot 1' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.7916, 52.2605],
              [6.79165, 52.2605],
              [6.79165, 52.26056],
              [6.7916, 52.26056],
              [6.7916, 52.2605],
            ],
          ],
        },
      },
      // Open-air platform roof canopy (`building=roof`)
      {
        type: 'Feature',
        id: 'station-canopy-roof',
        properties: { building: 'roof', name: 'Platform 1 Canopy', height: '5.5' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.7920, 52.2610],
              [6.7926, 52.2610],
              [6.7926, 52.2613],
              [6.7920, 52.2613],
              [6.7920, 52.2610],
            ],
          ],
        },
      },
      // Sports pitch (`leisure=pitch`)
      {
        type: 'Feature',
        id: 'soccer-pitch-1',
        properties: { leisure: 'pitch', sport: 'soccer', name: 'Community Pitch' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.7928, 52.2605],
              [6.7936, 52.2605],
              [6.7936, 52.2611],
              [6.7928, 52.2611],
              [6.7928, 52.2605],
            ],
          ],
        },
      },
      // Bench, Waste Basket, Street Lamp
      {
        type: 'Feature',
        id: 'bench-1',
        properties: { amenity: 'bench', backrest: 'yes' },
        geometry: { type: 'Point', coordinates: [6.7918, 52.2608] },
      },
      {
        type: 'Feature',
        id: 'bin-1',
        properties: { amenity: 'waste_basket' },
        geometry: { type: 'Point', coordinates: [6.79185, 52.2608] },
      },
      {
        type: 'Feature',
        id: 'lamp-1',
        properties: { highway: 'street_lamp' },
        geometry: { type: 'Point', coordinates: [6.7919, 52.2608] },
      },
    ],
  };

  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(flairFixture);
  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.tactical);

  // Verify flush ground-cover elevation (commercial === parking at GROUND_COVER_SURFACE) with Boolean carving
  // and strict vertical decal separation: (commercial === parking) < parking_space < Parking_Markings
  const commMesh = scene.landuseGroup.children.find((c) => c.name === 'Landuse_commercial') as any;
  const parkLotMesh = scene.landuseGroup.children.find((c) => c.name === 'Landuse_parking') as any;
  const parkSpaceMesh = scene.landuseGroup.children.find((c) => c.name === 'Landuse_parking_space') as any;
  const parkMarkMesh = scene.landuseGroup.children.find((c) => c.name === 'Parking_Markings') as any;

  assert.ok(commMesh, 'Commercial landuse mesh must exist');
  assert.ok(parkLotMesh, 'Parking lot mesh must exist');
  assert.ok(parkSpaceMesh, 'Individual parking space mesh must exist');
  assert.ok(parkMarkMesh, 'Procedural parking markings mesh must exist');

  const commY = commMesh.geometry.attributes.position.getY(0);
  const lotY = parkLotMesh.geometry.attributes.position.getY(0);
  const spaceY = parkSpaceMesh.geometry.attributes.position.getY(0);
  const markY = parkMarkMesh.geometry.attributes.position.getY(0);

  assert.ok(Math.abs(commY - lotY) < 1e-6, `Commercial landuse Y (${commY}) and parking lot Y (${lotY}) must be flush at GROUND_COVER_SURFACE`);
  assert.ok(lotY < spaceY, `Parking lot Y (${lotY}) must sit strictly below parking_space Y (${spaceY})`);
  assert.ok(spaceY < markY, `Parking space Y (${spaceY}) must sit strictly below parking markings Y (${markY})`);

  const zfReport = validateSceneZeroZFighting(scene, parsed.bounds);
  assert.equal(zfReport.isValid, true, `Flair scene must pass zero Z-fighting validation (conflicts=${zfReport.screenSpaceDepthConflicts.length})`);

  // Verify Pitch_Markings mesh exists in parksGroup
  const pitchMarkMesh = scene.parksGroup.children.find((c) => c.name === 'Pitch_Markings');
  assert.ok(pitchMarkMesh, 'Sports pitch markings mesh must be generated');

  // Verify Street Furniture meshes exist in foliageGroup
  const woodFurn = scene.foliageGroup.children.find((c) => c.name === 'StreetFurniture_wood');
  const metalFurn = scene.foliageGroup.children.find((c) => c.name === 'StreetFurniture_metal');
  const lampFurn = scene.foliageGroup.children.find((c) => c.name === 'StreetFurniture_lamp');
  assert.ok(woodFurn, '3D bench mesh (StreetFurniture_wood) must be generated');
  assert.ok(metalFurn, '3D waste bin mesh (StreetFurniture_metal) must be generated');
  assert.ok(lampFurn, '3D street lamp mesh (StreetFurniture_lamp) must be generated');

  // Verify open-air roof structure has both ground-level pillar vertices (Y ~ 0) and elevated canopy vertices (Y >= 4.5m)
  const bldgMesh = scene.buildingsGroup.children[0] as any;
  assert.ok(bldgMesh, 'Roof structure mesh must exist');
  const bPos = bldgMesh.geometry.attributes.position;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < bPos.count; i++) {
    const y = bPos.getY(i);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  assert.ok(minY <= 0.05, `Open-air roof support pillars must reach ground level (minY=${minY})`);
  assert.ok(maxY >= 5.0, `Open-air roof canopy must reach full height (maxY=${maxY})`);
});

test('Regression: generateParkingStallMarkings preserves all stripes on way/594073798-0, diagonal cutout lots, disconnected MultiPolygons, and street-side bays', () => {
  // 1. Exact local-meter polygon from Station Hengelo `way/594073798-0` (1,980.9 m²)
  // Previously threw `Unable to complete output ring` in polygonClipping.union due to collinear T-junctions
  // and returned null (0 triangles).
  const way594073798Polygon: [number, number][][] = [
    [
      [-199.812216313398, -24.46802407596518],
      [-208.76482831720406, 17.655271240481543],
      [-174.58956057663553, 21.67390485762251],
      [-174.22845826599553, 18.289792337508555],
      [-141.63386479089516, 21.840884094181813],
      [-141.374961247406, 19.32506360211969],
      [-140.5573711100782, 11.343456112302894],
      [-144.1479544632296, 10.88704620025363],
      [-143.05783428008553, 1.9703549871284984],
      [-175.67286750861606, -11.387983907558613],
      [-175.95902405669895, -11.499303398861805],
      [-174.68494609268333, -14.6941727847886],
      [-175.8363855360574, -15.13945074762845],
      [-199.812216313398, -24.46802407596518],
    ],
  ];

  const geom594 = generateParkingStallMarkings(
    way594073798Polygon,
    false,
    ELEVATION_POLICY.PARKING_MARKINGS,
    []
  );
  assert.ok(geom594, 'way/594073798-0 must generate non-null stall marking geometry');
  const triCount594 = (geom594.index?.count || 0) / 3;
  assert.ok(
    triCount594 >= 180,
    `way/594073798-0 must preserve all stall stripes (expected >= 180 triangles, got ${triCount594})`
  );
  geom594.computeBoundingBox();
  const bb594 = geom594.boundingBox!;
  assert.ok(
    bb594.max.x - bb594.min.x > 60 && bb594.max.z - bb594.min.z > 40,
    'way/594073798-0 stripes must cover the full 66m x 44m parking lot extent'
  );

  // 2. Disconnected MultiPolygon parking lot (2 separate sub-lots) + narrow street-side bay (spanV ~ 2.4m)
  const disconnectedMultiPoly: [number, number][][][] = [
    [
      [
        [0, 0],
        [24, 0],
        [24, 16],
        [0, 16],
        [0, 0],
      ],
    ],
    [
      [
        [40, 0],
        [64, 0],
        [64, 16],
        [40, 16],
        [40, 0],
      ],
    ],
  ];
  const multiGeo = generateParkingStallMarkings(
    disconnectedMultiPoly[0],
    false,
    ELEVATION_POLICY.PARKING_MARKINGS,
    [],
    undefined,
    disconnectedMultiPoly
  );
  assert.ok(multiGeo, 'Disconnected MultiPolygon parking lot must generate stall markings');
  multiGeo.computeBoundingBox();
  assert.ok(
    multiGeo.boundingBox!.min.x < 5 && multiGeo.boundingBox!.max.x > 58,
    'Disconnected MultiPolygon markings must preserve stripes in both west ([0,24]) and east ([40,64]) components'
  );

  // 3. Full scene build with overlapping diagonal feature (verifying higherOverlappingIds bbox does not wipe out lot swaths)
  // and narrow street-side parking lot (24m x 2.4m)
  const regressionFixture = {
    type: 'FeatureCollection',
    name: 'Parking Stripe Coverage Regression Fixture',
    features: [
      // Large parking lot (40m x 24m)
      {
        type: 'Feature',
        id: 'lot-main',
        properties: { amenity: 'parking', parking: 'surface', name: 'Main Kiss & Ride Lot' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.7900, 52.2600],
              [6.7906, 52.2600],
              [6.7906, 52.26022],
              [6.7900, 52.26022],
              [6.7900, 52.2600],
            ],
          ],
        },
      },
      // L-shaped narrow flowerbed border wrapping two outer edges (large AABB, small actual overlap)
      {
        type: 'Feature',
        id: 'border-flowerbed',
        properties: { landuse: 'flowerbed', name: 'Perimeter Planter' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.7900, 52.2600],
              [6.7906, 52.2600],
              [6.7906, 52.260015],
              [6.79002, 52.260015],
              [6.79002, 52.26022],
              [6.7900, 52.26022],
              [6.7900, 52.2600],
            ],
          ],
        },
      },
      // Narrow street-side parking bay (~25m x 2.4m)
      {
        type: 'Feature',
        id: 'lot-streetside',
        properties: { amenity: 'parking', parking: 'street_side', name: 'Street Side Bay' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [6.7910, 52.2600],
              [6.79138, 52.2600],
              [6.79138, 52.260022],
              [6.7910, 52.260022],
              [6.7910, 52.2600],
            ],
          ],
        },
      },
    ],
  };

  const provider = new LocalGeoJsonProvider();
  const parsed = provider.parseGeoJson(regressionFixture);
  const builder = new GeometryBuilder();
  const scene = builder.buildScene(parsed, MAP_THEMES.tactical);

  const markMesh = scene.landuseGroup.children.find((c) => c.name === 'Parking_Markings') as any;
  assert.ok(markMesh, 'Parking_Markings mesh must exist in built scene');
  const faceRanges = markMesh.userData.faceRanges as Array<{
    startFace: number;
    endFace: number;
    info: { id: string; name: string };
  }>;

  const mainLotRange = faceRanges.find((r) => r.info.name === 'Main Kiss & Ride Lot');
  const streetSideRange = faceRanges.find((r) => r.info.name === 'Street Side Bay');
  assert.ok(
    mainLotRange && mainLotRange.endFace - mainLotRange.startFace >= 30,
    `Main lot overlapped by L-shaped planter must retain its interior stall stripes (got ${
      mainLotRange ? mainLotRange.endFace - mainLotRange.startFace : 0
    } triangles)`
  );
  assert.ok(
    streetSideRange && streetSideRange.endFace - streetSideRange.startFace >= 12,
    `Street-side parking bay must generate stall divider stripes (got ${
      streetSideRange ? streetSideRange.endFace - streetSideRange.startFace : 0
    } triangles)`
  );

  const zfReport = validateSceneZeroZFighting(scene, parsed.bounds);
  assert.equal(zfReport.isValid, true, 'Regression fixture must pass zero Z-fighting validation');
});



