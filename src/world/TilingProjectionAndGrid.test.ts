import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  EPSG_25832_CODE,
  geoToUtm32N,
  RegionalProjection,
  utm32NToGeo,
} from './tiling/RegionalProjection';
import {
  createAlignedStudyGrid,
  createHengeloStudyGrid,
  DEFAULT_COLLAR_METERS,
  DEFAULT_TILE_SIZE_METERS,
  HENGELO_CENTER_LONLAT,
  pointInHalfOpenBox,
} from './tiling/TileGrid';
import {
  clipBufferGeometryToBoxXZ,
  clipMultiPolygonToBox2D,
} from './tiling/MeshBoxClipper';
import { auditCollarSufficiency } from './tiling/CollarAudit';
import {
  buildTiledStudyScenes,
  ingestCanonicalStudyGeoJson,
} from './tiling/TiledStudyPipeline';
import { MAP_THEMES } from '../styles/mapThemes';
import type { ProcessedMapData } from '../types/MapFeature';
import { prepareInfrastructureRenderPreview } from './infrastructure/rendering/InfrastructureRenderAdapter';
import { resolveGraphGradeSeparatedPlans } from './BridgeAndTunnelBuilder';
import { getRoadElevation } from './ElevationPolicy';

test('EPSG:25832 Transverse Mercator forward and inverse round-trip within 1e-6 m', () => {
  const [e0, n0] = geoToUtm32N(9.0, 0.0);
  assert.ok(Math.abs(e0 - 500000.0) < 1e-9, `Central meridian easting expected 500000, got ${e0}`);
  assert.ok(Math.abs(n0 - 0.0) < 1e-9, `Equator northing expected 0, got ${n0}`);

  const testPoints: Array<[number, number]> = [
    [6.7935, 52.2625], // Hengelo center
    [6.8936, 52.2215], // Enschede
    [6.0919, 52.5168], // Zwolle
    [9.0, 52.0], // Central meridian
    [7.5, 53.5],
  ];

  for (const [lon, lat] of testPoints) {
    const [e, n] = geoToUtm32N(lon, lat);
    const [rtLon, rtLat] = utm32NToGeo(e, n);
    const [rtE, rtN] = geoToUtm32N(rtLon, rtLat);
    assert.ok(Math.abs(rtE - e) < 1e-6, `Easting round-trip drift ${Math.abs(rtE - e)}`);
    assert.ok(Math.abs(rtN - n) < 1e-6, `Northing round-trip drift ${Math.abs(rtN - n)}`);
    assert.ok(Math.abs(rtLon - lon) < 1e-10);
    assert.ok(Math.abs(rtLat - lat) < 1e-10);
  }

  // Known approximate Hengelo UTM32N coordinates (~349.4 km E, ~5792.5 km N)
  const [hE, hN] = geoToUtm32N(HENGELO_CENTER_LONLAT[0], HENGELO_CENTER_LONLAT[1]);
  assert.ok(hE > 348000 && hE < 351000, `Unexpected Hengelo easting ${hE}`);
  assert.ok(hN > 5790000 && hN < 5795000, `Unexpected Hengelo northing ${hN}`);
});

test('RegionalProjection implements shifted Float64 local frame (+X East, +Z South)', () => {
  const proj = RegionalProjection.fromLonLatOrigin(6.7935, 52.2625);
  assert.equal(proj.crs, EPSG_25832_CODE);
  const [x0, z0] = proj.toLocal(proj.originLon, proj.originLat);
  assert.ok(Math.abs(x0) < 1e-7 && Math.abs(z0) < 1e-7);

  // Moving East along constant latitude increases +X (~680 m); because Hengelo (6.79E) is west of
  // the UTM Zone 32N central meridian (9E), meridian convergence shifts constant-latitude East slightly North (-Z ~ 25-35 m).
  const [xEast, zConvergence] = proj.toLocal(6.8035, proj.originLat);
  assert.ok(xEast > 600 && xEast < 800, `Expected ~680 m east, got ${xEast}`);
  assert.ok(Math.abs(zConvergence) < 40, `Expected small UTM convergence shift, got ${zConvergence}`);

  // Moving purely East in EPSG:25832 UTM keeps Z strictly 0
  const [xUtmEast, zUtmSame] = proj.utmToLocal(proj.originEasting + 500, proj.originNorthing);
  assert.equal(xUtmEast, 500);
  assert.equal(zUtmSame, 0);

  const [, zNorth] = proj.toLocal(proj.originLon, proj.originLat + 0.01);
  assert.ok(zNorth < -1000, `Expected negative Z north of origin, got ${zNorth}`);

  const [rtLon, rtLat] = proj.toGeo(xEast, zNorth);
  const [rtX, rtZ] = proj.toLocal(rtLon, rtLat);
  assert.ok(Math.abs(rtX - xEast) < 1e-6);
  assert.ok(Math.abs(rtZ - zNorth) < 1e-6);
});

test('Hengelo 8x8 study grid aligns deterministically on 512m EPSG:25832 boundaries and half-open ownership partitions cleanly', () => {
  const grid = createHengeloStudyGrid();
  assert.equal(grid.crs, EPSG_25832_CODE);
  assert.equal(grid.tileSizeMeters, DEFAULT_TILE_SIZE_METERS);
  assert.equal(grid.collarMeters, DEFAULT_COLLAR_METERS);
  assert.equal(grid.cols, 8);
  assert.equal(grid.rows, 8);
  assert.equal(grid.tiles.length, 64);

  const studyWidth = grid.studyLocalBounds.maxX - grid.studyLocalBounds.minX;
  const studyDepth = grid.studyLocalBounds.maxZ - grid.studyLocalBounds.minZ;
  assert.equal(studyWidth, 4096);
  assert.equal(studyDepth, 4096);
  assert.equal(grid.studyLocalBounds.minX, -2048);
  assert.equal(grid.studyLocalBounds.maxX, 2048);
  assert.equal(grid.studyLocalBounds.minZ, -2048);
  assert.equal(grid.studyLocalBounds.maxZ, 2048);

  for (const tile of grid.tiles) {
    assert.equal(tile.utmBounds.minEasting % 512, 0);
    assert.equal(tile.utmBounds.maxEasting % 512, 0);
    assert.equal(tile.utmBounds.minNorthing % 512, 0);
    assert.equal(tile.utmBounds.maxNorthing % 512, 0);
    assert.equal(tile.localBounds.maxX - tile.localBounds.minX, 512);
    assert.equal(tile.localBounds.maxZ - tile.localBounds.minZ, 512);
    assert.equal(tile.collarLocalBounds.minX, tile.localBounds.minX - 64);
    assert.equal(tile.collarLocalBounds.maxX, tile.localBounds.maxX + 64);
  }

  // Every interior grid point (including points exactly ON shared borders) belongs to strictly ONE tile
  const probePoints: Array<[number, number]> = [
    [0, 0],
    [-512, 0],
    [0, 512],
    [-2048, -2048],
    [2048, 2048],
    [256.5, -768.25],
    [1536, 1024],
  ];
  for (const [px, pz] of probePoints) {
    const owners = grid.tiles.filter((t) => pointInHalfOpenBox(px, pz, t.localBounds));
    assert.equal(
      owners.length,
      1,
      `Point (${px}, ${pz}) should belong to exactly 1 tile, got ${owners.map((o) => o.id).join(', ')}`
    );
  }
});

test('MeshBoxClipper conserves 2D polygon area and clips 3D BufferGeometry preserving attributes and faceRanges', () => {
  const square: [number, number][][][] = [
    [
      [
        [-50, -50],
        [50, -50],
        [50, 50],
        [-50, 50],
        [-50, -50],
      ],
    ],
  ];
  const left = clipMultiPolygonToBox2D(square, { minX: -100, maxX: 0, minZ: -100, maxZ: 100 });
  const right = clipMultiPolygonToBox2D(square, { minX: 0, maxX: 100, minZ: -100, maxZ: 100 });
  assert.equal(left.length, 1);
  assert.equal(right.length, 1);

  const area = (ring: [number, number][]) => {
    let s = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    return 0.5 * Math.abs(s);
  };
  assert.ok(Math.abs(area(left[0][0]) - 5000) < 1e-6);
  assert.ok(Math.abs(area(right[0][0]) - 5000) < 1e-6);

  // 3D sloping quad crossing X = 0 with UV, normal, aSwitchAttr, and faceRanges
  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        -10, 0, -5,
        10, 4, -5,
        10, 4, 5,
        -10, 0, 5,
      ],
      3
    )
  );
  geom.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute(
      [
        0, 1, 0,
        0, 1, 0,
        0, 1, 0,
        0, 1, 0,
      ],
      3
    )
  );
  geom.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute(
      [
        0, 0,
        10, 0,
        10, 1,
        0, 1,
      ],
      2
    )
  );
  geom.setAttribute(
    'aSwitchAttr',
    new THREE.Float32BufferAttribute(
      [
        1, 0.5,
        3, 1.0,
        3, 1.0,
        1, 0.5,
      ],
      2
    )
  );
  geom.setIndex([0, 2, 1, 0, 3, 2]);
  geom.userData.faceRanges = [
    {
      startFace: 0,
      endFace: 2,
      info: {
        id: 'bridge-1',
        sourceFeatureId: 'way/bridge-1',
        name: 'Test Bridge',
        category: 'Road & Way',
        cartoLabel: 'Bridge',
        primaryTag: 'highway=primary',
        subtype: 'primary',
      },
    },
  ];

  const cLeft = clipBufferGeometryToBoxXZ(geom, { minX: -20, maxX: 0, minZ: -10, maxZ: 10 });
  const cRight = clipBufferGeometryToBoxXZ(geom, { minX: 0, maxX: 20, minZ: -10, maxZ: 10 });
  assert.ok(cLeft && cRight);

  // At X = 0, interpolated Y must equal 2.0 and U must equal 5.0 on BOTH sides
  const collectX0 = (g: THREE.BufferGeometry) => {
    const pos = g.getAttribute('position');
    const uv = g.getAttribute('uv');
    const sw = g.getAttribute('aSwitchAttr');
    const hits: Array<{ y: number; z: number; u: number; sw0: number }> = [];
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getX(i)) < 1e-5) {
        hits.push({
          y: pos.getY(i),
          z: pos.getZ(i),
          u: uv.getX(i),
          sw0: sw.getX(i),
        });
      }
    }
    return hits;
  };
  const hitsL = collectX0(cLeft);
  const hitsR = collectX0(cRight);
  assert.ok(hitsL.length >= 2 && hitsR.length >= 2);
  for (const h of [...hitsL, ...hitsR]) {
    assert.ok(Math.abs(h.y - 2.0) < 1e-4, `Expected Y=2.0 at x=0, got ${h.y}`);
    assert.ok(Math.abs(h.u - 5.0) < 1e-4, `Expected U=5.0 at x=0, got ${h.u}`);
    assert.ok(Math.abs(h.sw0 - 2.0) < 1e-4, `Expected interpolated sw0=2.0 at x=0, got ${h.sw0}`);
  }
  assert.ok(Array.isArray(cLeft.userData.faceRanges) && cLeft.userData.faceRanges.length === 1);
  assert.equal(cLeft.userData.faceRanges[0].info.sourceFeatureId, 'way/bridge-1');
  const leftTris = cLeft.getIndex()
    ? cLeft.getIndex()!.count / 3
    : cLeft.getAttribute('position').count / 3;
  assert.equal(cLeft.userData.faceRanges[0].startFace, 0);
  assert.equal(cLeft.userData.faceRanges[0].endFace, leftTris);

  geom.dispose();
  cLeft.dispose();
  cRight.dispose();
});

test('CollarAudit explicitly detects > 64m planar, building, bridge, and railway phase overflows', () => {
  const grid = createAlignedStudyGrid({
    name: 'collar-audit-2x2',
    centerLonLat: HENGELO_CENTER_LONLAT,
    cols: 2,
    rows: 2,
    tileSizeMeters: 512,
    collarMeters: 64,
  });

  const data: ProcessedMapData = {
    regionName: 'collar-audit-2x2',
    centerLonLat: [grid.projection.originLon, grid.projection.originLat],
    bounds: {
      minX: -512,
      maxX: 512,
      minZ: -512,
      maxZ: 512,
      widthMeters: 1024,
      depthMeters: 1024,
    },
    buildings: [
      {
        id: 'bldg-wide',
        sourceFeatureId: 'way/bldg-wide',
        type: 'building',
        footprint: [
          [
            [-10, -20],
            [110, -20],
            [110, 20],
            [-10, 20],
            [-10, -20],
          ],
        ],
        height: 10,
        minHeight: 0,
        buildingType: 'industrial',
        osmTags: { building: 'industrial' },
      },
    ],
    roads: [
      {
        id: 'way/bridge-long',
        sourceFeatureId: 'way/bridge-long',
        type: 'road',
        points: [
          [-120, 40],
          [0, 40],
          [120, 40],
        ],
        roadClass: 'primary',
        width: 9,
        layer: 1,
        isBridge: true,
        isTunnel: false,
        osmTags: { highway: 'primary', bridge: 'yes', layer: '1' },
      },
    ],
    railways: [
      {
        id: 'way/rail-long',
        sourceFeatureId: 'way/rail-long',
        type: 'railway',
        points: [
          [-150, -60],
          [0, -60],
          [150, -60],
        ],
        railwayType: 'rail',
        width: 4.8,
        layer: 0,
        isBridge: false,
        isTunnel: false,
        osmTags: { railway: 'rail' },
      },
    ],
    waterBodies: [],
    linearWaterways: [],
    water: [],
    parks: [
      {
        id: 'park-wide',
        sourceFeatureId: 'way/park-wide',
        type: 'park',
        polygon: [
          [
            [-180, -100],
            [40, -100],
            [40, -10],
            [-180, -10],
            [-180, -100],
          ],
        ],
        subtype: 'forest',
        has3DFoliage: true,
        osmTags: { landuse: 'forest' },
      },
    ],
    landuse: [],
    barriers: [],
    landmarks: [],
    diagnostics: {
      sourceFeaturesReceived: 4,
      sourceFeaturesClassified: 4,
      totalFeaturesParsed: 4,
      sourceFeaturesRendered: 0,
      constructedMeshesCount: 0,
      parsedByCategory: {
        buildings: 1,
        roads: 1,
        railways: 1,
        waterBodies: 0,
        linearWaterways: 0,
        parks: 1,
        landuse: 0,
        barriers: 0,
        landmarks: 0,
      },
      geometryPartsGenerated: {
        total: 0,
        byCategory: {
          buildings: 0,
          roads: 0,
          railways: 0,
          waterBodies: 0,
          linearWaterways: 0,
          parks: 0,
          landuse: 0,
          barriers: 0,
          landmarks: 0,
        },
      },
      skippedUnsupported: { total: 0, byTag: {} },
      rejectedInvalid: { total: 0, byReason: {} },
      byGeometryType: {
        Point: 0,
        MultiPoint: 0,
        LineString: 2,
        MultiLineString: 0,
        Polygon: 2,
        MultiPolygon: 0,
        GeometryCollection: 0,
        Unknown: 0,
      },
      totalFeaturesReceived: 4,
      totalFeaturesRendered: 0,
    },
    stats: {
      totalBuildings: 1,
      totalRoads: 1,
      totalRoadSegments: 2,
      totalRailways: 1,
      totalRailwaySegments: 2,
      totalWaterPolygons: 0,
      totalLinearWaterways: 0,
      totalParkPolygons: 1,
      totalLandusePolygons: 0,
      totalBarriers: 0,
      totalLandmarks: 0,
      areaKm2: 1.048576,
    },
  };

  const preview = prepareInfrastructureRenderPreview(data);
  const roadPlans = preview.descriptors
    ? resolveGraphGradeSeparatedPlans(preview.descriptors, 'road', (e) =>
        getRoadElevation('primary', e.layer, e.isBridge, e.isTunnel, e.id)
      )
    : null;

  const audit = auditCollarSufficiency({
    data,
    grid,
    descriptors: preview.descriptors,
    roadGradeSeparatedPlans: roadPlans,
  });

  assert.equal(audit.isProposedCollarSufficientWithoutGlobalContext, false);
  assert.ok(audit.countsByKind.planar_polygon_extends_beyond_collar >= 1);
  assert.ok(audit.countsByKind.building_extends_beyond_collar >= 1);
  assert.ok(audit.countsByKind.bridge_or_tunnel_component_exceeds_collar >= 1);
  assert.ok(audit.countsByKind.railway_phase_or_switch_exceeds_collar >= 1);
  assert.ok(audit.maxRequiredCollarMeters >= 150);
  assert.equal(
    audit.resolvedByGlobalContextCount + audit.tileLocalCollarDependentCount,
    audit.totalInsufficiencyCases
  );
  assert.ok(audit.resolvedByGlobalContextCount >= 1);
  assert.ok(audit.tileLocalCollarDependentCount >= 1);
});

test('clipBufferGeometryToBoxXZ preserves exact half-open faceRanges across multiple features', () => {
  const geom = new THREE.BufferGeometry();
  // Feature A: 1 triangle strictly in x <= 0; Feature B: 1 triangle crossing x = 0
  geom.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        -5, 0, -2, -1, 0, -2, -1, 0, 2,
        -2, 0, -2, 2, 0, -2, 2, 0, 2,
      ],
      3
    )
  );
  geom.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute(new Array(18).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3)
  );
  geom.userData.faceRanges = [
    {
      startFace: 0,
      endFace: 1,
      info: {
        id: 'feat-A',
        sourceFeatureId: 'way/A',
        name: 'A',
        category: 'Road & Way',
        cartoLabel: 'Road',
        primaryTag: 'highway=residential',
      },
    },
    {
      startFace: 1,
      endFace: 2,
      info: {
        id: 'feat-B',
        sourceFeatureId: 'way/B',
        name: 'B',
        category: 'Road & Way',
        cartoLabel: 'Road',
        primaryTag: 'highway=residential',
      },
    },
  ];

  const clippedRight = clipBufferGeometryToBoxXZ(geom, {
    minX: 0,
    maxX: 10,
    minZ: -10,
    maxZ: 10,
  });
  assert.ok(clippedRight);
  const ranges = clippedRight.userData.faceRanges as Array<{
    startFace: number;
    endFace: number;
    info: { id: string };
  }>;
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].info.id, 'feat-B');
  assert.equal(ranges[0].startFace, 0);
  const triCount = clippedRight.getAttribute('position').count / 3;
  assert.equal(ranges[0].endFace, triCount);
  geom.dispose();
  clippedRight.dispose();
});

test('CollarAudit sanitizes Infinity portal distances and TiledStudyPipeline keeps peakMemory >= afterAllTiles', () => {
  const grid = createAlignedStudyGrid({
    name: 'collar-tunnel-and-peak-mem',
    centerLonLat: HENGELO_CENTER_LONLAT,
    cols: 2,
    rows: 1,
    tileSizeMeters: 512,
    collarMeters: 64,
  });
  const toLonLat = (x: number, z: number) => grid.projection.toGeo(x, z);
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'way/tunnel-1',
        properties: { id: 'way/tunnel-1', highway: 'primary', tunnel: 'yes', layer: '-1' },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(-150, 0), toLonLat(150, 0)],
        },
      },
    ],
  };

  const ingested = ingestCanonicalStudyGeoJson(geojson, grid);
  const tiled = buildTiledStudyScenes(ingested, MAP_THEMES.daylight);
  try {
    const serialized = JSON.stringify(tiled.collarAudit);
    assert.equal(serialized.includes('null'), false, `CollarAudit serialized unexpected null: ${serialized}`);
    assert.ok(Number.isFinite(tiled.collarAudit.maxRequiredCollarMeters));
    assert.ok(tiled.collarAudit.cases.length >= 1);
    for (const c of tiled.collarAudit.cases) {
      assert.ok(Number.isFinite(c.requiredCollarMeters));
      assert.ok(Number.isFinite(c.overflowMeters));
    }
    assert.ok(
      tiled.peakMemory.rssMB >= tiled.memoryAfterAllTiles.rssMB,
      `Expected peak rssMB (${tiled.peakMemory.rssMB}) >= afterAllTiles (${tiled.memoryAfterAllTiles.rssMB})`
    );
    assert.ok(
      tiled.peakMemory.heapUsedMB >= tiled.memoryAfterAllTiles.heapUsedMB,
      `Expected peak heapUsedMB (${tiled.peakMemory.heapUsedMB}) >= afterAllTiles (${tiled.memoryAfterAllTiles.heapUsedMB})`
    );
  } finally {
    tiled.dispose();
  }
});
