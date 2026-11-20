import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP_THEMES } from '../styles/mapThemes';
import { createAlignedStudyGrid, HENGELO_CENTER_LONLAT } from './tiling/TileGrid';
import {
  buildSingleSceneReference,
  buildTiledStudyScenes,
  ingestCanonicalStudyGeoJson,
} from './tiling/TiledStudyPipeline';
import { validateTiledSeamContinuity } from './tiling/SeamValidator';
import { runDiagnosticAbcComparison } from './tiling/TiledDiagnostics';
import type { StudyGridSpec } from './tiling/TileGrid';

function buildMultiTileCrossingGeoJson(grid: StudyGridSpec) {
  const toLonLat = (x: number, z: number): [number, number] => grid.projection.toGeo(x, z);
  const ringToLonLat = (pts: Array<[number, number]>) => [pts.map(([x, z]) => toLonLat(x, z))];
  const features: any[] = [];

  // 1. Landuse & Parks & Water crossing vertical (x=0) and horizontal (z=0) seams
  features.push({
    type: 'Feature',
    id: 'way/landuse-res-cross',
    properties: { id: 'way/landuse-res-cross', landuse: 'residential', name: 'Centrum North' },
    geometry: {
      type: 'Polygon',
      coordinates: ringToLonLat([
        [-220, -220],
        [220, -220],
        [220, 220],
        [-220, 220],
        [-220, -220],
      ]),
    },
  });

  // Parking lot straddling x=0 with stall markings (principal axis should NOT shift across tiles!)
  features.push({
    type: 'Feature',
    id: 'way/parking-cross',
    properties: { id: 'way/parking-cross', amenity: 'parking', surface: 'asphalt', name: 'P-Cross' },
    geometry: {
      type: 'Polygon',
      coordinates: ringToLonLat([
        [-90, 40],
        [90, 40],
        [90, 95],
        [-90, 95],
        [-90, 40],
      ]),
    },
  });

  // Sports pitch straddling z=0
  features.push({
    type: 'Feature',
    id: 'way/pitch-cross',
    properties: { id: 'way/pitch-cross', leisure: 'pitch', sport: 'soccer' },
    geometry: {
      type: 'Polygon',
      coordinates: ringToLonLat([
        [-190, -45],
        [-115, -45],
        [-115, 45],
        [-190, 45],
        [-190, -45],
      ]),
    },
  });

  // Forest polygon straddling x=0, z=0 with procedural 3D trees
  features.push({
    type: 'Feature',
    id: 'way/forest-cross',
    properties: { id: 'way/forest-cross', landuse: 'forest', leaf_type: 'mixed' },
    geometry: {
      type: 'Polygon',
      coordinates: ringToLonLat([
        [95, -90],
        [210, -90],
        [210, 90],
        [95, 90],
        [95, -90],
      ]),
    },
  });

  // Lake water body straddling x=0, z=-140
  features.push({
    type: 'Feature',
    id: 'way/water-cross',
    properties: { id: 'way/water-cross', natural: 'water', water: 'pond' },
    geometry: {
      type: 'Polygon',
      coordinates: ringToLonLat([
        [-70, -170],
        [70, -170],
        [70, -110],
        [-70, -110],
        [-70, -170],
      ]),
    },
  });

  // Linear canal crossing x=0 and z=0
  features.push({
    type: 'Feature',
    id: 'way/canal-cross',
    properties: { id: 'way/canal-cross', waterway: 'canal', width: '12' },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(-260, -140), toLonLat(-40, -100), toLonLat(260, 140)],
    },
  });

  // 2. E2+ Road Network crossing seams (primary + residential junction near seam + steps + bridge + tunnel)
  features.push({
    type: 'Feature',
    id: 'way/road-primary-w',
    properties: { id: 'way/road-primary-w', highway: 'primary', name: 'Enschedesestraat' },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(-300, -12), toLonLat(-2, -4), toLonLat(0, -4)],
    },
  });
  features.push({
    type: 'Feature',
    id: 'way/road-primary-e',
    properties: { id: 'way/road-primary-e', highway: 'primary', name: 'Enschedesestraat' },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(0, -4), toLonLat(280, -4)],
    },
  });
  // Branching residential road right near (0, -4) intersection crossing z=0 seam
  features.push({
    type: 'Feature',
    id: 'way/road-res-south',
    properties: { id: 'way/road-res-south', highway: 'residential', name: 'Zuidstraat' },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(-2, -4), toLonLat(8, 25), toLonLat(8, 220)],
    },
  });
  // Cross-road residential crossing x=0 at z=30
  features.push({
    type: 'Feature',
    id: 'way/road-res-cross',
    properties: { id: 'way/road-res-cross', highway: 'residential', name: 'Dwarsweg' },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(-180, 30), toLonLat(8, 30), toLonLat(190, 30)],
    },
  });
  // Steps crossing x=0 at z=160
  features.push({
    type: 'Feature',
    id: 'way/road-steps-cross',
    properties: { id: 'way/road-steps-cross', highway: 'steps' },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(-25, 160), toLonLat(25, 160)],
    },
  });

  // 3. Grade-separated Road Bridge crossing x=0 at z=-55 (approach ramps > 64m!)
  features.push({
    type: 'Feature',
    id: 'way/bridge-approach-w',
    properties: { id: 'way/bridge-approach-w', highway: 'secondary', name: 'Spoorbrug' },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(-210, -55), toLonLat(-95, -55)],
    },
  });
  features.push({
    type: 'Feature',
    id: 'way/bridge-span-cross',
    properties: { id: 'way/bridge-span-cross', highway: 'secondary', bridge: 'yes', layer: '1', name: 'Spoorbrug' },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(-95, -55), toLonLat(95, -55)],
    },
  });
  features.push({
    type: 'Feature',
    id: 'way/bridge-approach-e',
    properties: { id: 'way/bridge-approach-e', highway: 'secondary', name: 'Spoorbrug' },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(95, -55), toLonLat(210, -55)],
    },
  });

  // Road Tunnel crossing x=0 at z=135
  features.push({
    type: 'Feature',
    id: 'way/tunnel-road-cross',
    properties: { id: 'way/tunnel-road-cross', highway: 'tertiary', tunnel: 'yes', layer: '-1' },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(-85, 135), toLonLat(85, 135)],
    },
  });

  // 4. R+ Railway Network: Double-track + Switch Turnout crossing BOTH x=0 and z=0 seams!
  features.push({
    type: 'Feature',
    id: 'way/rail-main-1',
    properties: { id: 'way/rail-main-1', railway: 'rail', electrified: 'contact_line' },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(-280, -185), toLonLat(-20, -185), toLonLat(0, -185)],
    },
  });
  features.push({
    type: 'Feature',
    id: 'way/rail-main-2',
    properties: { id: 'way/rail-main-2', railway: 'rail', electrified: 'contact_line' },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(0, -185), toLonLat(260, -185)],
    },
  });
  // Parallel main track
  features.push({
    type: 'Feature',
    id: 'way/rail-parallel',
    properties: { id: 'way/rail-parallel', railway: 'rail', electrified: 'contact_line' },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(-280, -180.5), toLonLat(260, -180.5)],
    },
  });
  // Diverging turnout starting at (-20, -185) and crossing x=0 around z=-190
  features.push({
    type: 'Feature',
    id: 'way/rail-turnout-div',
    properties: { id: 'way/rail-turnout-div', railway: 'rail', service: 'siding' },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(-20, -185), toLonLat(-5, -187.5), toLonLat(40, -195), toLonLat(150, -195)],
    },
  });
  // Diagonal railway crossing z=0 seam around x=-60
  features.push({
    type: 'Feature',
    id: 'way/rail-ns-cross',
    properties: { id: 'way/rail-ns-cross', railway: 'rail' },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(-65, -240), toLonLat(-58, 0), toLonLat(-50, 240)],
    },
  });

  // 5. Discrete Buildings: courtyard building straddling x=0 + corner building with centroid at (0,0) + standard buildings
  features.push({
    type: 'Feature',
    id: 'way/bldg-courtyard-straddle',
    properties: { id: 'way/bldg-courtyard-straddle', building: 'commercial', height: '14', name: 'Station Arcade' },
    geometry: {
      type: 'Polygon',
      coordinates: [
        // outer ring (-80..80, 175..215) -> 160m wide (> 64m collar!)
        [
          toLonLat(-80, 175),
          toLonLat(80, 175),
          toLonLat(80, 215),
          toLonLat(-80, 215),
          toLonLat(-80, 175),
        ],
        // interior courtyard hole
        [
          toLonLat(-30, 185),
          toLonLat(-30, 205),
          toLonLat(30, 205),
          toLonLat(30, 185),
          toLonLat(-30, 185),
        ],
      ],
    },
  });
  // Building centered right on (0, 0) tile intersection
  features.push({
    type: 'Feature',
    id: 'way/bldg-origin-corner',
    properties: { id: 'way/bldg-origin-corner', building: 'apartments', 'building:levels': '4' },
    geometry: {
      type: 'Polygon',
      coordinates: ringToLonLat([
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
        [-10, -10],
      ]),
    },
  });
  // Roof-only canopy straddling z=0
  features.push({
    type: 'Feature',
    id: 'way/bldg-canopy-cross',
    properties: { id: 'way/bldg-canopy-cross', building: 'roof', height: '5' },
    geometry: {
      type: 'Polygon',
      coordinates: ringToLonLat([
        [45, -15],
        [75, -15],
        [75, 15],
        [45, 15],
        [45, -15],
      ]),
    },
  });

  // 6. Barriers & Tree rows & Street furniture crossing seams
  features.push({
    type: 'Feature',
    id: 'way/barrier-wall-cross',
    properties: { id: 'way/barrier-wall-cross', barrier: 'wall', height: '2.2' },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(-40, 20), toLonLat(40, 20)],
    },
  });
  features.push({
    type: 'Feature',
    id: 'way/tree-row-cross',
    properties: { id: 'way/tree-row-cross', natural: 'tree_row' },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(-35, -35), toLonLat(35, 35)],
    },
  });
  features.push({
    type: 'Feature',
    id: 'node/bench-on-seam',
    properties: { id: 'node/bench-on-seam', amenity: 'bench' },
    geometry: { type: 'Point', coordinates: toLonLat(0, 15) },
  });
  features.push({
    type: 'Feature',
    id: 'node/tree-on-seam',
    properties: { id: 'node/tree-on-seam', natural: 'tree', leaf_type: 'needleleaved' },
    geometry: { type: 'Point', coordinates: toLonLat(0, -25) },
  });

  return {
    type: 'FeatureCollection',
    name: grid.name,
    features,
  };
}

test('2x2 multi-tile pipeline preserves zero seam defects and exact parity with same-source single-scene reference', () => {
  const grid = createAlignedStudyGrid({
    name: 'synthetic-2x2-seam-stress',
    centerLonLat: HENGELO_CENTER_LONLAT,
    cols: 2,
    rows: 2,
    tileSizeMeters: 512,
    collarMeters: 64,
  });

  const geojson = buildMultiTileCrossingGeoJson(grid);
  const ingested = ingestCanonicalStudyGeoJson(geojson, grid);
  const reference = buildSingleSceneReference(ingested, MAP_THEMES.daylight);
  const tiled = buildTiledStudyScenes(ingested, MAP_THEMES.daylight);

  try {
    assert.equal(tiled.tiles.length, 4);
    assert.equal(tiled.collarAudit.isProposedCollarSufficientWithoutGlobalContext, false);
    assert.ok(
      tiled.collarAudit.totalInsufficiencyCases > 0,
      'CollarAudit must report >64m crossing features honestly'
    );

    const report = validateTiledSeamContinuity({ reference, tiled });

    assert.equal(
      report.defects.length,
      0,
      `Expected 0 seam defects, got:\n${report.defects.map((d) => `- [${d.category}] ${d.detail}`).join('\n')}`
    );
    assert.equal(report.isValid, true);
    assert.equal(report.internalSeamsChecked, 4);
    assert.equal(report.buildingParity.refCount, 3);
    assert.equal(report.buildingParity.tiledUniqueCount, 3);
    assert.equal(report.buildingParity.tiledTotalEmitted, 3);
    assert.equal(report.buildingParity.missingFromTiles.length, 0);
    assert.equal(report.buildingParity.duplicatedAcrossTiles.length, 0);
    assert.equal(report.buildingParity.triangleMismatches.length, 0);
    assert.ok(report.railwayParity.refSleeperCount > 50);
    assert.equal(report.railwayParity.tiledSleeperCount, report.railwayParity.refSleeperCount);
    assert.ok(report.railwayParity.maxPhaseDiscontinuityU <= 1e-3);
    assert.ok(report.bridgeContinuity.maxDeckElevationDiscontinuityM <= 1e-3);
    assert.equal(report.provenanceParity.missingSourceFeatureIds.length, 0);
    assert.equal(report.provenanceParity.extraSourceFeatureIds.length, 0);
    assert.equal(report.roadIntegrityFailures.length, 0);
  } finally {
    reference.dispose();
    tiled.dispose();
  }
});

test('Regression: single-building tile bucket preserves exact triangle parity against multi-building reference bucket', () => {
  const grid = createAlignedStudyGrid({
    name: 'single-bldg-tile-parity',
    centerLonLat: HENGELO_CENTER_LONLAT,
    cols: 2,
    rows: 1,
    tileSizeMeters: 512,
    collarMeters: 64,
  });
  const toLonLat = (x: number, z: number): [number, number] => grid.projection.toGeo(x, z);
  const ring = (pts: Array<[number, number]>) => [pts.map(([x, z]) => toLonLat(x, z))];
  const geojson = {
    type: 'FeatureCollection',
    features: [
      // Lone building in west tile [-512, 0]
      {
        type: 'Feature',
        id: 'way/bldg-west-lone',
        properties: { id: 'way/bldg-west-lone', building: 'house', height: '8' },
        geometry: {
          type: 'Polygon',
          coordinates: ring([
            [-200, -10],
            [-180, -10],
            [-180, 10],
            [-200, 10],
            [-200, -10],
          ]),
        },
      },
      // Two buildings in east tile [0, 512]
      {
        type: 'Feature',
        id: 'way/bldg-east-1',
        properties: { id: 'way/bldg-east-1', building: 'house', height: '8' },
        geometry: {
          type: 'Polygon',
          coordinates: ring([
            [180, -10],
            [200, -10],
            [200, 10],
            [180, 10],
            [180, -10],
          ]),
        },
      },
      {
        type: 'Feature',
        id: 'way/bldg-east-2',
        properties: { id: 'way/bldg-east-2', building: 'apartments', height: '14' },
        geometry: {
          type: 'Polygon',
          coordinates: ring([
            [240, -10],
            [260, -10],
            [260, 10],
            [240, 10],
            [240, -10],
          ]),
        },
      },
    ],
  };

  const ingested = ingestCanonicalStudyGeoJson(geojson, grid);
  const reference = buildSingleSceneReference(ingested, MAP_THEMES.daylight);
  const tiled = buildTiledStudyScenes(ingested, MAP_THEMES.daylight);
  try {
    const report = validateTiledSeamContinuity({ reference, tiled });
    assert.equal(report.isValid, true);
    assert.equal(report.buildingParity.triangleMismatches.length, 0);
    assert.equal(report.buildingParity.refCount, 3);
    assert.equal(report.buildingParity.tiledUniqueCount, 3);
  } finally {
    reference.dispose();
    tiled.dispose();
  }
});

test('Regression: curved railway bridge with distant parallel host track preserves zero UV phase discontinuity', () => {
  const grid = createAlignedStudyGrid({
    name: 'curved-rail-bridge-phase',
    centerLonLat: HENGELO_CENTER_LONLAT,
    cols: 2,
    rows: 1,
    tileSizeMeters: 512,
    collarMeters: 64,
  });
  const toLonLat = (x: number, z: number): [number, number] => grid.projection.toGeo(x, z);
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'way/rail-bridge-curved',
        properties: { id: 'way/rail-bridge-curved', railway: 'rail', bridge: 'yes', layer: '1' },
        geometry: {
          type: 'LineString',
          coordinates: [
            toLonLat(-140, -12),
            toLonLat(-50, -8),
            toLonLat(0, 0),
            toLonLat(55, 11),
            toLonLat(140, 28),
          ],
        },
      },
      // Host track starting inside east tile outside west tile's 64m collar
      {
        type: 'Feature',
        id: 'way/rail-host-east-only',
        properties: { id: 'way/rail-host-east-only', railway: 'rail', bridge: 'yes', layer: '1' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(90, 14), toLonLat(150, 26)],
        },
      },
    ],
  };

  const ingested = ingestCanonicalStudyGeoJson(geojson, grid);
  const reference = buildSingleSceneReference(ingested, MAP_THEMES.daylight);
  const tiled = buildTiledStudyScenes(ingested, MAP_THEMES.daylight);
  try {
    const report = validateTiledSeamContinuity({ reference, tiled });
    assert.equal(report.isValid, true, `Unexpected defects: ${JSON.stringify(report.defects)}`);
    assert.ok(report.railwayParity.maxPhaseDiscontinuityU <= 1e-3);
    assert.ok(report.railwayParity.maxRailElevationDiscontinuityM <= 1e-3);
    assert.equal(report.railwayParity.tiledSleeperCount, report.railwayParity.refSleeperCount);
  } finally {
    reference.dispose();
    tiled.dispose();
  }
});

test('Regression: global planar deduplication prevents extra forest trees and extra sourceFeatureIds across collars', () => {
  const grid = createAlignedStudyGrid({
    name: 'global-planar-forest-dedup',
    centerLonLat: HENGELO_CENTER_LONLAT,
    cols: 2,
    rows: 1,
    tileSizeMeters: 512,
    collarMeters: 64,
  });
  const toLonLat = (x: number, z: number): [number, number] => grid.projection.toGeo(x, z);
  const ring = (pts: Array<[number, number]>) => [pts.map(([x, z]) => toLonLat(x, z))];
  const geojson = {
    type: 'FeatureCollection',
    features: [
      // Duplicate forest polygons whose shared outer ring extends > 64m on west side
      {
        type: 'Feature',
        id: 'way/forest-canon',
        properties: { id: 'way/forest-canon', landuse: 'forest', leaf_type: 'broadleaved' },
        geometry: {
          type: 'Polygon',
          coordinates: ring([
            [-140, -40],
            [40, -40],
            [40, 40],
            [-140, 40],
            [-140, -40],
          ]),
        },
      },
      {
        type: 'Feature',
        id: 'way/forest-dup',
        properties: { id: 'way/forest-dup', landuse: 'forest', leaf_type: 'broadleaved' },
        geometry: {
          type: 'Polygon',
          coordinates: ring([
            [-140, -40],
            [40, -40],
            [40, 40],
            [-140, 40],
            [-140, -40],
          ]),
        },
      },
      // High-priority paved parking covering part of forest beyond east tile collar
      {
        type: 'Feature',
        id: 'way/parking-cover',
        properties: { id: 'way/parking-cover', amenity: 'parking', surface: 'asphalt' },
        geometry: {
          type: 'Polygon',
          coordinates: ring([
            [-120, -25],
            [-75, -25],
            [-75, 25],
            [-120, 25],
            [-120, -25],
          ]),
        },
      },
    ],
  };

  const ingested = ingestCanonicalStudyGeoJson(geojson, grid);
  const reference = buildSingleSceneReference(ingested, MAP_THEMES.daylight);
  const tiled = buildTiledStudyScenes(ingested, MAP_THEMES.daylight);
  try {
    const report = validateTiledSeamContinuity({ reference, tiled });
    assert.equal(report.isValid, true, `Unexpected defects: ${JSON.stringify(report.defects)}`);
    assert.equal(report.provenanceParity.missingSourceFeatureIds.length, 0);
    assert.equal(report.provenanceParity.extraSourceFeatureIds.length, 0);
  } finally {
    reference.dispose();
    tiled.dispose();
  }
});

test('Regression: road seam edge interval check ignores tangent cul-de-sacs, catches missing continuations, and passes Diagnostic A/B/C', () => {
  const grid = createAlignedStudyGrid({
    name: 'road-seam-and-abc',
    centerLonLat: HENGELO_CENTER_LONLAT,
    cols: 2,
    rows: 1,
    tileSizeMeters: 512,
    collarMeters: 64,
  });
  const toLonLat = (x: number, z: number): [number, number] => grid.projection.toGeo(x, z);
  const geojson = {
    type: 'FeatureCollection',
    features: [
      // Crossing primary road
      {
        type: 'Feature',
        id: 'way/road-cross-seam',
        properties: { id: 'way/road-cross-seam', highway: 'primary' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-120, 0), toLonLat(120, 0)],
        },
      },
      // Cul-de-sac stopping right next to x=0 without crossing into east tile
      {
        type: 'Feature',
        id: 'way/road-culdesac-near-seam',
        properties: { id: 'way/road-culdesac-near-seam', highway: 'residential' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-90, 45), toLonLat(-3.0005, 45)],
        },
      },
    ],
  };

  const ingested = ingestCanonicalStudyGeoJson(geojson, grid);
  const reference = buildSingleSceneReference(ingested, MAP_THEMES.daylight);
  const tiled = buildTiledStudyScenes(ingested, MAP_THEMES.daylight);
  try {
    const report = validateTiledSeamContinuity({ reference, tiled });
    assert.equal(report.isValid, true, `Unexpected defects: ${JSON.stringify(report.defects)}`);

    const abc = runDiagnosticAbcComparison({ ingested, reference, tiled });
    assert.equal(abc.aVsB.isValid, true, `A vs B failed: ${JSON.stringify(abc.aVsB.defects)}`);
    assert.equal(
      abc.bVsC.isExactMatch,
      true,
      `B vs C diverged: ${JSON.stringify(abc.bVsC.divergentTiles)}`
    );

    // Negative test: remove east tile's road meshes -> validator must catch road_boundary_end_cap
    const eastTile = tiled.tiles[1];
    eastTile.scene.roadsGroup.clear();
    const brokenReport = validateTiledSeamContinuity({ reference, tiled });
    assert.equal(brokenReport.isValid, false);
    assert.ok(brokenReport.defects.some((d) => d.category === 'road_boundary_end_cap'));
  } finally {
    reference.dispose();
    tiled.dispose();
  }
});

test('Regression (Phase 1 & 2): A->B and B->C conserve water (WaterBody + LinearWaterway), mixed road meshes, asymmetric border buildings, and overhanging street furniture', () => {
  const grid = createAlignedStudyGrid({
    name: 'abc-conservation-and-provenance',
    centerLonLat: HENGELO_CENTER_LONLAT,
    cols: 2,
    rows: 1,
    tileSizeMeters: 512,
    collarMeters: 64,
  });
  const toLonLat = (x: number, z: number): [number, number] => grid.projection.toGeo(x, z);
  const ring = (pts: Array<[number, number]>) => [pts.map(([x, z]) => toLonLat(x, z))];

  // Study bounds: X in [-512, 512], Z in [-256, 256]
  // Asymmetric L-shaped building near X = -512 border:
  // BBox X in [-520, -490] -> 2D bbox midpoint X = -505 (inside [-512, 0] west tile!),
  // while many dense vertices clustered around X = -518 pull the 3D vertex average below -512.
  const denseWestWallPts: Array<[number, number]> = [
    [-520, -20],
    [-519.5, -18],
    [-519, -16],
    [-518.5, -14],
    [-518, -12],
    [-517.5, -10],
    [-517, -8],
    [-516.5, -6],
    [-516, -4],
    [-515.5, -2],
    [-515, 0],
    [-490, 0],
    [-490, 10],
    [-520, 10],
    [-520, -20],
  ];

  const geojson = {
    type: 'FeatureCollection',
    features: [
      // WaterBody (ShapeGeometry) + LinearWaterway (ribbon) merged into WaterSurfaces
      {
        type: 'Feature',
        id: 'way/water-pond',
        properties: { id: 'way/water-pond', natural: 'water', water: 'pond' },
        geometry: {
          type: 'Polygon',
          coordinates: ring([
            [-180, -80],
            [-120, -80],
            [-120, -30],
            [-180, -30],
            [-180, -80],
          ]),
        },
      },
      {
        type: 'Feature',
        id: 'way/canal-twente',
        properties: { id: 'way/canal-twente', waterway: 'canal', width: '16' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-240, -10), toLonLat(0, 10), toLonLat(240, 30)],
        },
      },
      // At-grade secondary road + elevated secondary bridge merged into Roads_secondary
      {
        type: 'Feature',
        id: 'way/sec-at-grade-w',
        properties: { id: 'way/sec-at-grade-w', highway: 'secondary' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-220, -120), toLonLat(-80, -120)],
        },
      },
      {
        type: 'Feature',
        id: 'way/sec-bridge-mid',
        properties: { id: 'way/sec-bridge-mid', highway: 'secondary', bridge: 'yes', layer: '1' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-80, -120), toLonLat(80, -120)],
        },
      },
      {
        type: 'Feature',
        id: 'way/sec-at-grade-e',
        properties: { id: 'way/sec-at-grade-e', highway: 'secondary' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(80, -120), toLonLat(220, -120)],
        },
      },
      // Asymmetric border building
      {
        type: 'Feature',
        id: 'way/bldg-asymmetric-border',
        properties: { id: 'way/bldg-asymmetric-border', building: 'industrial', height: '12' },
        geometry: {
          type: 'Polygon',
          coordinates: ring(denseWestWallPts),
        },
      },
      // Overhanging 3D tower and shelter placed 0.4m west of seam x=0 (radius overhangs into east tile!)
      {
        type: 'Feature',
        id: 'node/tower-near-seam',
        properties: { id: 'node/tower-near-seam', man_made: 'cooling_tower', height: '18' },
        geometry: {
          type: 'Point',
          coordinates: toLonLat(-0.4, 75),
        },
      },
      {
        type: 'Feature',
        id: 'node/shelter-near-seam',
        properties: { id: 'node/shelter-near-seam', amenity: 'shelter' },
        geometry: {
          type: 'Point',
          coordinates: toLonLat(-0.3, -75),
        },
      },
    ],
  };

  const ingested = ingestCanonicalStudyGeoJson(geojson, grid);
  const reference = buildSingleSceneReference(ingested, MAP_THEMES.daylight);
  const tiled = buildTiledStudyScenes(ingested, MAP_THEMES.daylight);
  try {
    const report = validateTiledSeamContinuity({ reference, tiled });
    assert.equal(report.isValid, true, `A vs C defects: ${JSON.stringify(report.defects)}`);
    assert.ok(
      Math.abs(report.areaComparisons.water.diffM2) <= 1e-3,
      `Expected A vs C water diff <= 1e-3 m², got ${report.areaComparisons.water.diffM2}`
    );

    const abc = runDiagnosticAbcComparison({ ingested, reference, tiled });
    assert.equal(abc.aVsB.isValid, true, `A vs B defects: ${JSON.stringify(abc.aVsB.defects)}`);
    assert.ok(
      Math.abs(abc.aVsB.areaComparisons.water.diffM2) <= 1e-3,
      `Expected A vs B water diff <= 1e-3 m², got ${abc.aVsB.areaComparisons.water.diffM2}`
    );
    assert.equal(abc.aVsB.buildingParity.missingFromTiles.length, 0);
    assert.equal(
      abc.bVsC.isExactMatch,
      true,
      `B vs C divergent tiles: ${JSON.stringify(abc.bVsC.divergentTiles)}`
    );
    assert.equal(abc.bVsC.isGeometryExactMatch, true);
    assert.equal(abc.bVsC.tilesWithGeometryDivergence, 0);
    assert.equal(abc.bVsC.tilesWithMetadataDivergence, 0);
  } finally {
    reference.dispose();
    tiled.dispose();
  }
});

test('Regression (Phase 3): touching unnamed residential landuse and forest polygons unioned across collar preserve exact planar area and at-grade railway densification preserves UV phase', () => {
  const grid = createAlignedStudyGrid({
    name: 'phase3-unioned-planar-and-atgrade-rail',
    centerLonLat: HENGELO_CENTER_LONLAT,
    cols: 2,
    rows: 1,
    tileSizeMeters: 512,
    collarMeters: 64,
  });
  const toLonLat = (x: number, z: number): [number, number] => grid.projection.toGeo(x, z);
  const ring = (pts: Array<[number, number]>) => [pts.map(([x, z]) => toLonLat(x, z))];

  const geojson = {
    type: 'FeatureCollection',
    features: [
      // Canonical unnamed residential polygon A wholly in west tile outside east tile's 64m collar ([-260, -80])
      {
        type: 'Feature',
        id: 'way/res-seed-west',
        properties: { id: 'way/res-seed-west', landuse: 'residential' },
        geometry: {
          type: 'Polygon',
          coordinates: ring([
            [-260, -90],
            [-80, -90],
            [-80, 90],
            [-260, 90],
            [-260, -90],
          ]),
        },
      },
      // Overlapping unnamed residential polygon B deduplicated into A, extending across x=0 into east tile ([-100, 190])
      {
        type: 'Feature',
        id: 'way/res-partner-east',
        properties: { id: 'way/res-partner-east', landuse: 'residential' },
        geometry: {
          type: 'Polygon',
          coordinates: ring([
            [-100, -90],
            [190, -90],
            [190, 90],
            [-100, 90],
            [-100, -90],
          ]),
        },
      },
      // Canonical unnamed forest A wholly outside east tile's 64m collar ([-250, -75])
      {
        type: 'Feature',
        id: 'way/forest-seed-west',
        properties: { id: 'way/forest-seed-west', landuse: 'forest' },
        geometry: {
          type: 'Polygon',
          coordinates: ring([
            [-250, 110],
            [-75, 110],
            [-75, 200],
            [-250, 200],
            [-250, 110],
          ]),
        },
      },
      // Overlapping unnamed forest B deduplicated into A, extending into east tile ([-90, 160])
      {
        type: 'Feature',
        id: 'way/forest-partner-east',
        properties: { id: 'way/forest-partner-east', landuse: 'forest' },
        geometry: {
          type: 'Polygon',
          coordinates: ring([
            [-90, 110],
            [160, 110],
            [160, 200],
            [-90, 200],
            [-90, 110],
          ]),
        },
      },
      // At-grade main host track in west tile outside east tile's 64m collar ([-220, -75])
      {
        type: 'Feature',
        id: 'way/rail-atgrade-host-west',
        properties: { id: 'way/rail-atgrade-host-west', railway: 'rail' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-220, -140), toLonLat(-75, -140)],
        },
      },
      // Secondary at-grade track starting within 3.0m of host track at (-80, -142.8) and running on a single long segment
      // to a 3.5-degree bend right at (-2, -142.8) before crossing seam x=0 into east tile
      {
        type: 'Feature',
        id: 'way/rail-atgrade-cross-seam',
        properties: { id: 'way/rail-atgrade-cross-seam', railway: 'rail', service: 'siding' },
        geometry: {
          type: 'LineString',
          coordinates: [
            toLonLat(-80, -142.8),
            toLonLat(-2, -142.8),
            toLonLat(120, -135.3),
          ],
        },
      },
    ],
  };

  const ingested = ingestCanonicalStudyGeoJson(geojson, grid);
  const reference = buildSingleSceneReference(ingested, MAP_THEMES.daylight);
  const tiled = buildTiledStudyScenes(ingested, MAP_THEMES.daylight);
  try {
    const report = validateTiledSeamContinuity({ reference, tiled });
    assert.equal(report.isValid, true, `Unexpected defects: ${JSON.stringify(report.defects)}`);
    assert.equal(report.areaComparisons.landuseBySubtype.residential?.diffM2 ?? 0, 0);
    assert.equal(report.areaComparisons.parksBySubtype.forest?.diffM2 ?? 0, 0);
    assert.ok(report.railwayParity.maxPhaseDiscontinuityU <= 1e-3);

    const abc = runDiagnosticAbcComparison({ ingested, reference, tiled });
    assert.equal(abc.aVsB.isValid, true, `A vs B defects: ${JSON.stringify(abc.aVsB.defects)}`);
    assert.equal(
      abc.bVsC.isExactMatch,
      true,
      `B vs C divergent tiles: ${JSON.stringify(abc.bVsC.divergentTiles)}`
    );
  } finally {
    reference.dispose();
    tiled.dispose();
  }
});

