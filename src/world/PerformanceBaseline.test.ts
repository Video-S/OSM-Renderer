import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { MAP_THEMES } from '../styles/mapThemes';
import {
  buildRailwayPrototypeGroup,
  RAILWAY_DIMENSION_SPEC,
  SleeperBearerBox3D,
  subtractIntervalFromList,
  subtractLateralInterval,
} from './prototype/RailwayPrototypeBuilder';
import { resolveInspectedFeature } from './GeometryBuilder';
import {
  buildUvRibbonGeometry2D,
  subdivideSharpPolylineCorners2D,
} from './prototype/UvRibbonBuilder';
import { createRailwayPrototypeFixtureData } from './prototype/RailwayTestFixtures';
import { runCpuAndLifecycleBenchmark } from './prototype/PerformanceBaselineHarness';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const URBAN_CORRIDOR_GEOJSON_FIXTURE = {
  type: 'FeatureCollection',
  name: 'Urban Corridor Benchmark Fixture',
  features: [
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
          [4.906, 52.38],
        ],
      },
    },
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
          [4.9, 52.376],
          [4.905, 52.377],
        ],
      },
    },
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
    {
      type: 'Feature',
      id: 'building-station-5b',
      properties: {
        name: 'Centraal Station Hall',
        building: 'train_station',
        height: '24',
      },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [4.899, 52.3785],
            [4.9015, 52.3785],
            [4.9015, 52.3795],
            [4.899, 52.3795],
            [4.899, 52.3785],
          ],
        ],
      },
    },
  ],
};

test('M2.1: defines consistent canonical railway dimensions distinguishing inner gauge, physical rail head, and visual rail width', () => {
  assert.equal(RAILWAY_DIMENSION_SPEC.innerGaugeMeters, 1.435);
  assert.equal(RAILWAY_DIMENSION_SPEC.physicalRailHeadWidthMeters, 0.072);
  assert.ok(
    Math.abs(RAILWAY_DIMENSION_SPEC.physicalCenterToCenterGaugeMeters - (1.435 + 0.072)) < 1e-5
  );
  assert.equal(RAILWAY_DIMENSION_SPEC.visualRailWidthMeters, 0.2);
  // Visual center-to-center rail spacing must equal innerGauge + visualRailWidth so clear inner gauge remains 1.435 m
  assert.ok(
    Math.abs(
      RAILWAY_DIMENSION_SPEC.visualCenterToCenterGaugeMeters -
        RAILWAY_DIMENSION_SPEC.visualRailWidthMeters -
        RAILWAY_DIMENSION_SPEC.innerGaugeMeters
    ) < 1e-5
  );
  assert.ok(Math.abs(RAILWAY_DIMENSION_SPEC.sleeperStepHeightMeters - 0.012) < 1e-5);
  assert.ok(Math.abs(RAILWAY_DIMENSION_SPEC.railStepHeightMeters - 0.013) < 1e-5);
});

test('M2.1: builds continuous UV-parameterized ribbons with automatic sharp-corner subdivision', () => {
  const rawPts: [number, number][] = [
    [0, 0],
    [20, 0],
    [35, 10], // > 6 deg bend
    [55, 10],
  ];
  const subdivided = subdivideSharpPolylineCorners2D(rawPts);
  assert.ok(subdivided.length > rawPts.length);

  const geo = buildUvRibbonGeometry2D(rawPts, 0.072, {
    width: 2.5,
    startPhaseU: 0.72,
  });
  assert.ok(geo !== null);
  const uvs = geo.attributes.uv;
  assert.ok(uvs.count >= 8);
  // First vertex pair has u = startPhaseU (0.72) and v = +/- 1.25
  assert.ok(Math.abs(uvs.getX(0) - 0.72) < 1e-3);
  assert.ok(Math.abs(uvs.getY(0) - 1.25) < 1e-3);
  assert.ok(Math.abs(uvs.getY(1) - -1.25) < 1e-3);
  // Final vertex pair has monotonically increased u > 50m
  assert.ok(uvs.getX(uvs.count - 1) > 50);
  geo.dispose();
});

test('M2.2: benchmarks production Candidate B renderer and compares Candidate A vs Candidate B on Switchyard fixture with zero resource leaks', () => {
  const switchyardData = createRailwayPrototypeFixtureData();
  assert.ok(switchyardData.railways.length >= 45);

  const productionReport = runCpuAndLifecycleBenchmark(
    switchyardData,
    MAP_THEMES.tactical,
    'production',
    5
  );
  const candidateAReport = runCpuAndLifecycleBenchmark(
    switchyardData,
    MAP_THEMES.tactical,
    'candidateA',
    5
  );
  const candidateBReport = runCpuAndLifecycleBenchmark(
    switchyardData,
    MAP_THEMES.tactical,
    'candidateB',
    5
  );

  // 1. Warmed-up production lifecycle check: zero net leaked geometries or materials across 5 reload cycles
  assert.equal(productionReport.lifecycleAudit.warmedUpOwnedGeometriesAfterDispose, 0);
  assert.equal(productionReport.lifecycleAudit.warmedUpOwnedMaterialsAfterDispose, 0);
  assert.equal(productionReport.lifecycleAudit.netLeakedGeometriesAfterCycles, 0);
  assert.equal(productionReport.lifecycleAudit.netLeakedMaterialsAfterCycles, 0);

  assert.equal(candidateAReport.lifecycleAudit.netLeakedGeometriesAfterCycles, 0);
  assert.equal(candidateAReport.lifecycleAudit.netLeakedMaterialsAfterCycles, 0);
  assert.equal(candidateBReport.lifecycleAudit.netLeakedGeometriesAfterCycles, 0);
  assert.equal(candidateBReport.lifecycleAudit.netLeakedMaterialsAfterCycles, 0);

  // 2. Candidate A (Pure Procedural UV Ribbon) uses dramatically fewer railway vertices/triangles than discrete 3D sleepers
  assert.ok(
    candidateAReport.railwayGroupStats.vertices < productionReport.railwayGroupStats.vertices
  );
  assert.ok(
    candidateAReport.railwayGroupStats.triangles < productionReport.railwayGroupStats.triangles
  );
  assert.ok(
    candidateAReport.railwayGroupStats.vertices < candidateBReport.railwayGroupStats.vertices
  );

  console.table({
    'Switchyard Production (Candidate B)': {
      totalBuildMs: productionReport.buildTimeMs,
      railBuildMs: productionReport.railwayBuildTimeMs,
      railMeshes: productionReport.railwayGroupStats.meshCount,
      railVertices: productionReport.railwayGroupStats.vertices,
      railTriangles: productionReport.railwayGroupStats.triangles,
      railCpuKB: Number((productionReport.railwayGroupStats.cpuBufferBytes / 1024).toFixed(1)),
      sceneCpuMB: productionReport.cpuBufferMB,
    },
    'Switchyard Candidate A (Procedural UV)': {
      totalBuildMs: candidateAReport.buildTimeMs,
      railBuildMs: candidateAReport.railwayBuildTimeMs,
      railMeshes: candidateAReport.railwayGroupStats.meshCount,
      railVertices: candidateAReport.railwayGroupStats.vertices,
      railTriangles: candidateAReport.railwayGroupStats.triangles,
      railCpuKB: Number((candidateAReport.railwayGroupStats.cpuBufferBytes / 1024).toFixed(1)),
      sceneCpuMB: candidateAReport.cpuBufferMB,
    },
    'Switchyard Candidate B (Hybrid 3D + UV)': {
      totalBuildMs: candidateBReport.buildTimeMs,
      railBuildMs: candidateBReport.railwayBuildTimeMs,
      railMeshes: candidateBReport.railwayGroupStats.meshCount,
      railVertices: candidateBReport.railwayGroupStats.vertices,
      railTriangles: candidateBReport.railwayGroupStats.triangles,
      railCpuKB: Number((candidateBReport.railwayGroupStats.cpuBufferBytes / 1024).toFixed(1)),
      sceneCpuMB: candidateBReport.cpuBufferMB,
    },
  });
});

test('M2.2: rejects misleading baseline benchmark mode with explanatory error', () => {
  const switchyardData = createRailwayPrototypeFixtureData();
  assert.throws(
    () => {
      runCpuAndLifecycleBenchmark(
        switchyardData,
        MAP_THEMES.tactical,
        'baseline' as any,
        1
      );
    },
    (err: any) => {
      return (
        err instanceof Error &&
        err.message.includes("The 'baseline' benchmark mode represents the historical Goalpost 1 renderer") &&
        err.message.includes("do not contain the superseded Goalpost 1 railway implementation")
      );
    }
  );
});

test('M2.2: records reproducible production Candidate B on multi-category Urban Corridor GeoJSON fixture', () => {
  const provider = new LocalGeoJsonProvider();
  const mapData = provider.parseGeoJson(
    URBAN_CORRIDOR_GEOJSON_FIXTURE,
    'Urban Corridor Benchmark Fixture'
  );

  const productionReport = runCpuAndLifecycleBenchmark(
    mapData,
    MAP_THEMES.tactical,
    'production',
    3
  );
  assert.ok(productionReport.totalTriangles > 100);
  assert.ok(productionReport.cpuBufferBytes > 1024);
  assert.equal(productionReport.lifecycleAudit.netLeakedGeometriesAfterCycles, 0);
  assert.equal(productionReport.lifecycleAudit.netLeakedMaterialsAfterCycles, 0);

  console.table({
    'Urban Corridor GeoJSON Production (Candidate B)': {
      totalBuildMs: productionReport.buildTimeMs,
      railBuildMs: productionReport.railwayBuildTimeMs,
      meshes: productionReport.constructedMeshesCount,
      totalVertices: productionReport.totalVertices,
      totalTriangles: productionReport.totalTriangles,
      sceneCpuMB: productionReport.cpuBufferMB,
    },
  });
});

test('M2.1: verifies Candidate A and Candidate B preserve faceRanges feature inspection, theme switching, and zoom LOD transitions', () => {
  const switchyardData = createRailwayPrototypeFixtureData();
  const protoA = buildRailwayPrototypeGroup(
    switchyardData,
    MAP_THEMES.tactical,
    'candidateA',
    8.0
  );
  const protoB = buildRailwayPrototypeGroup(
    switchyardData,
    MAP_THEMES.tactical,
    'candidateB',
    8.0
  );

  // Check Candidate A meshes and faceRanges
  const ballastA = protoA.railwaysGroup.getObjectByName('Railway_Ballast');
  const sleepersA = protoA.railwaysGroup.getObjectByName('Railway_Sleepers');
  const railsA = protoA.railwaysGroup.getObjectByName('Railway_Rails');
  assert.ok(ballastA !== undefined);
  assert.ok(sleepersA !== undefined);
  assert.ok(railsA !== undefined);
  assert.ok(sleepersA.userData.faceRanges.length >= 45);
  assert.ok(railsA.userData.faceRanges.length >= 90);

  // Check Candidate B close-zoom (zoom = 8.0 > 4.5) vs medium-zoom (zoom = 3.0 <= 4.5) LOD switching
  const sleepers3DB = protoB.railwaysGroup.getObjectByName('Railway_Sleepers_3D');
  const rails3DB = protoB.railwaysGroup.getObjectByName('Railway_Rails_3D');
  const sleepersRibbonB = protoB.railwaysGroup.getObjectByName('Railway_Sleepers');
  const railsRibbonB = protoB.railwaysGroup.getObjectByName('Railway_Rails');

  assert.equal(sleepers3DB?.visible, true);
  assert.equal(rails3DB?.visible, true);
  assert.equal(sleepersRibbonB?.visible, false);
  assert.equal(railsRibbonB?.visible, false);

  protoB.updateCameraZoom(3.0);
  assert.equal(sleepers3DB?.visible, false);
  assert.equal(rails3DB?.visible, false);
  assert.equal(sleepersRibbonB?.visible, true);
  assert.equal(railsRibbonB?.visible, true);

  // Verify in-place theme switching across all 4 themes
  for (const themeKey of ['tactical', 'daylight', 'dusk', 'blueprint']) {
    protoA.updateTheme(MAP_THEMES[themeKey]);
    protoB.updateTheme(MAP_THEMES[themeKey]);
  }

  protoA.dispose();
  protoB.dispose();
  assert.equal(protoA.resources.ownedGeometriesCount, 0);
  assert.equal(protoB.resources.ownedGeometriesCount, 0);
});

/**
 * Helper: Tests whether a world-space point (px, pz) lies within a 3D sleeper/bearer box's
 * horizontal footprint (expanded by longitudinalPad along track tangent and lateralPad across track normal).
 */
function isPointSupportedBySleeperBox(
  px: number,
  pz: number,
  box: SleeperBearerBox3D,
  longitudinalPad: number,
  lateralPad: number
): boolean {
  const dx = px - box.cx;
  const dz = pz - box.cz;
  const u = dx * box.tx + dz * box.tz;
  if (Math.abs(u) > box.halfLen + longitudinalPad) return false;
  const w = dx * box.nx + dz * box.nz;
  return w >= -box.halfWidthRight - lateralPad && w <= box.halfWidthLeft + lateralPad;
}

/**
 * Helper: Exact 2D Separating Axis Theorem (SAT) test between two SleeperBearerBox3D footprints,
 * shrunk by `shrinkMargin` (e.g., 0.02m) so edge-abutting sleepers do not count as penetrating overlaps.
 */
function doSleeperBoxesOverlap2D(
  a: SleeperBearerBox3D,
  b: SleeperBearerBox3D,
  shrinkMargin = 0.02
): boolean {
  const aMidV = (a.halfWidthLeft - a.halfWidthRight) * 0.5;
  const aCx = a.cx + a.nx * aMidV;
  const aCz = a.cz + a.nz * aMidV;
  const aHalfU = Math.max(0.01, a.halfLen - shrinkMargin);
  const aHalfV = Math.max(0.01, (a.halfWidthLeft + a.halfWidthRight) * 0.5 - shrinkMargin);

  const bMidV = (b.halfWidthLeft - b.halfWidthRight) * 0.5;
  const bCx = b.cx + b.nx * bMidV;
  const bCz = b.cz + b.nz * bMidV;
  const bHalfU = Math.max(0.01, b.halfLen - shrinkMargin);
  const bHalfV = Math.max(0.01, (b.halfWidthLeft + b.halfWidthRight) * 0.5 - shrinkMargin);

  const dx = bCx - aCx;
  const dz = bCz - aCz;
  if (dx * dx + dz * dz > (aHalfU + aHalfV + bHalfU + bHalfV) ** 2) return false;

  const axes: [number, number][] = [
    [a.tx, a.tz],
    [a.nx, a.nz],
    [b.tx, b.tz],
    [b.nx, b.nz],
  ];

  for (const [ax, az] of axes) {
    const distProj = Math.abs(dx * ax + dz * az);
    const rA =
      aHalfU * Math.abs(a.tx * ax + a.tz * az) +
      aHalfV * Math.abs(a.nx * ax + a.nz * az);
    const rB =
      bHalfU * Math.abs(b.tx * ax + b.tz * az) +
      bHalfV * Math.abs(b.nx * ax + b.nz * az);
    if (distProj >= rA + rB) {
      return false; // Separated along this axis
    }
  }
  return true;
}

test('M2.1 Geometric Acceptance 1: Sleeper/bearer support beneath every rail within documented tolerance across all 4 zones', () => {
  const switchyardData = createRailwayPrototypeFixtureData();
  const theme = MAP_THEMES.tactical;

  const resB = buildRailwayPrototypeGroup(switchyardData, theme, 'candidateB', 8.0);
  const boxes = resB.sleeperBoxes3D;
  assert.ok(boxes.length > 600, `Expected > 600 3D sleeper/bearer boxes at 0.725m spacing, got ${boxes.length}`);
  assert.ok(
    resB.stats.turnoutBearerCount >= 20,
    `Expected >= 20 elongated shared turnout bearers across turnouts/crossovers, got ${resB.stats.turnoutBearerCount}`
  );

  // Documented geometric tolerances:
  // - Sample step along each rail centerline: ds = 0.10 m
  // - A rail station s is supported when it lies directly above any SleeperBearerBox3D within
  //   longitudinal pad = 0.08m (rail baseplate seat) and lateral pad = 0.06m.
  // - Because sleepers are discrete timbers placed every P = 0.725m (0.826m for tram),
  //   normal ballast cribs between consecutive sleepers measure ~0.45m, and across oblique switch/crossover
  //   transition boundaries or track ends, the maximum unsupported rail span between consecutive sleeper
  //   supports must not exceed MAX_UNSUPPORTED_SPAN_METERS = 1.65m (compared to > 10.5m before the fix).
  const SAMPLE_STEP_M = 0.10;
  const MAX_UNSUPPORTED_SPAN_METERS = 1.65;

  let totalRailsTested = 0;
  let globalMaxUnsupportedSpan = 0;
  let worstRailDesc = '';

  for (const r of switchyardData.railways) {
    if (r.isTunnel || r.layer < 0 || !r.points || r.points.length < 2) continue;
    const isTram = r.railwayType === 'tram';
    const gaugeOffsetHalf =
      (isTram
        ? RAILWAY_DIMENSION_SPEC.visualTramCenterToCenterGaugeMeters
        : RAILWAY_DIMENSION_SPEC.visualCenterToCenterGaugeMeters) * 0.5;

    const bev = subdivideSharpPolylineCorners2D(r.points);
    if (bev.length < 2) continue;

    for (const sideSign of [1, -1] as const) {
      totalRailsTested++;
      const latOffset = sideSign * gaugeOffsetHalf;
      const supportedStations: number[] = [];
      let totalLen = 0;

      for (let i = 0; i < bev.length - 1; i++) {
        const p0 = bev[i];
        const p1 = bev[i + 1];
        const segDx = p1[0] - p0[0];
        const segDz = p1[1] - p0[1];
        const segLen = Math.hypot(segDx, segDz);
        if (segLen < 1e-4) continue;
        const tx = segDx / segLen;
        const tz = segDz / segLen;
        const nx = -tz;
        const nz = tx;

        const steps = Math.max(1, Math.ceil(segLen / SAMPLE_STEP_M));
        for (let k = 0; k <= steps; k++) {
          const s = totalLen + (k / steps) * segLen;
          const cx = p0[0] + segDx * (k / steps) + nx * latOffset;
          const cz = p0[1] + segDz * (k / steps) + nz * latOffset;

          let supported = false;
          for (const b of boxes) {
            if (isPointSupportedBySleeperBox(cx, cz, b, 0.08, 0.06)) {
              supported = true;
              break;
            }
          }
          if (supported) {
            supportedStations.push(s);
          }
        }
        totalLen += segLen;
      }

      assert.ok(
        supportedStations.length > 0,
        `Rail (track=${r.id}, side=${sideSign > 0 ? 'left' : 'right'}, len=${totalLen.toFixed(2)}m) has ZERO sleeper support`
      );

      // Compute max unsupported span along [0, totalLen]
      let maxGap = supportedStations[0]; // gap from s=0 to first supported station
      for (let i = 1; i < supportedStations.length; i++) {
        const gap = supportedStations[i] - supportedStations[i - 1];
        if (gap > maxGap) maxGap = gap;
      }
      const endGap = totalLen - supportedStations[supportedStations.length - 1];
      if (endGap > maxGap) maxGap = endGap;

      if (maxGap > globalMaxUnsupportedSpan) {
        globalMaxUnsupportedSpan = maxGap;
        worstRailDesc = `${r.id} (${sideSign > 0 ? 'left' : 'right'})`;
      }

      assert.ok(
        maxGap <= MAX_UNSUPPORTED_SPAN_METERS,
        `Rail ${r.id} (${sideSign > 0 ? 'left' : 'right'}) has unsupported gap ${maxGap.toFixed(2)}m > ${MAX_UNSUPPORTED_SPAN_METERS}m`
      );
    }
  }

  assert.equal(totalRailsTested, 130, 'Must test all 130 rails (left & right across 65 switchyard ways)');
  console.log(
    `[Geometric Acceptance 1] Verified all ${totalRailsTested} rails: max unsupported longitudinal span = ${globalMaxUnsupportedSpan.toFixed(3)}m on ${worstRailDesc} (tolerance <= ${MAX_UNSUPPORTED_SPAN_METERS}m), turnoutBearers = ${resB.stats.turnoutBearerCount}`
  );

  resB.dispose();
});

test('M2.1 Geometric Acceptance 2: Shared turnout bearers in switch zones and zero unintended 2D OBB sleeper overlaps', () => {
  const switchyardData = createRailwayPrototypeFixtureData();
  const resB = buildRailwayPrototypeGroup(switchyardData, MAP_THEMES.tactical, 'candidateB', 8.0);
  const boxes = resB.sleeperBoxes3D;

  // 1. Verify shared turnout bearers exist in Zone 2 (Turnout), Zone 3 (Scissors), and Zone 4 (Station Throat)
  const zone2Bearers = boxes.filter((b) => b.isTurnoutBearer && b.trackId.includes('z2'));
  const zone3Bearers = boxes.filter((b) => b.isTurnoutBearer && b.trackId.includes('z3'));
  const zone4Bearers = boxes.filter((b) => b.isTurnoutBearer && b.trackId.includes('z4'));

  assert.ok(zone2Bearers.length >= 3, `Zone 2 (Single Turnout) must have >= 3 shared turnout bearers, got ${zone2Bearers.length}`);
  assert.ok(zone3Bearers.length >= 6, `Zone 3 (Scissors Crossover) must have >= 6 shared turnout bearers, got ${zone3Bearers.length}`);
  assert.ok(zone4Bearers.length >= 8, `Zone 4 (Station Throat) must have >= 8 shared turnout bearers, got ${zone4Bearers.length}`);

  // Verify turnout bearers are wider than ordinary 2.50m sleepers (spanning 2.60m .. 4.90m)
  for (const tb of [...zone2Bearers, ...zone3Bearers, ...zone4Bearers]) {
    const totalWidth = tb.halfWidthLeft + tb.halfWidthRight;
    assert.ok(
      totalWidth > RAILWAY_DIMENSION_SPEC.sleeperWidthMeters + 0.08 && totalWidth <= 5.0,
      `Turnout bearer on ${tb.trackId} must be elongated (> 2.58m and <= 5.0m), got ${totalWidth.toFixed(2)}m`
    );
  }

  // 2. Full 2D Separating Axis Theorem (SAT) OBB overlap check across all inter-track sleeper/bearer pairs
  let overlappingPairs = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.trackId === b.trackId) continue;
      if (Math.abs(a.yBottom - b.yBottom) > 0.05) continue; // Different vertical bridge/grade layers
      if (doSleeperBoxesOverlap2D(a, b, 0.02)) {
        overlappingPairs++;
      }
    }
  }

  assert.equal(
    overlappingPairs,
    0,
    `Expected 0 overlapping 2D inter-track sleeper/bearer boxes (shrunk by 2cm touch tolerance), found ${overlappingPairs}`
  );

  resB.dispose();
});

test('M2.1 Geometric Acceptance 3 & 4: Continuous rail geometry through crossings and 3.2m switch blade taper in Candidate A & B', () => {
  const switchyardData = createRailwayPrototypeFixtureData();
  const theme = MAP_THEMES.tactical;

  const resA = buildRailwayPrototypeGroup(switchyardData, theme, 'candidateA', 8.0);
  const railA = resA.railwaysGroup.getObjectByName('Railway_Rails') as THREE.Mesh;
  assert.ok(railA, 'Candidate A must produce Railway_Rails mesh');

  const posA = railA.geometry.attributes.position;
  const switchAttrA = railA.geometry.attributes.aSwitchAttr;
  const faceRangesA = railA.userData.faceRanges as Array<{
    startFace: number;
    endFace: number;
    info: { id: string };
  }>;
  assert.equal(faceRangesA.length, 130, 'Candidate A must have 130 continuous rail ribbon faceRanges (2 per track)');

  // Verify every single rail ribbon in Candidate A has unbroken positive width and monotonic progression
  let taperedRibbonsCountA = 0;
  for (const fr of faceRangesA) {
    const triCount = fr.endFace - fr.startFace;
    assert.ok(triCount >= 2, `Rail ribbon for ${fr.info.id} must have >= 2 triangles`);
    const indexAttr = railA.geometry.index!;
    const firstVert = indexAttr.getX(fr.startFace * 3);
    let minTaper = 1.0;
    let maxTaper = 0.0;
    const vertCount = (triCount / 2 + 1) * 2;
    for (let v = 0; v < vertCount; v += 2) {
      const idxL = firstVert + v;
      const idxR = firstVert + v + 1;
      const w = Math.hypot(posA.getX(idxL) - posA.getX(idxR), posA.getZ(idxL) - posA.getZ(idxR));
      assert.ok(w >= 0.04 && w <= 0.25, `Candidate A rail width ${w.toFixed(3)}m out of bounds on ${fr.info.id}`);
      const tVal = switchAttrA.getY(idxL);
      minTaper = Math.min(minTaper, tVal);
      maxTaper = Math.max(maxTaper, tVal);
    }
    if (minTaper < 0.5) {
      taperedRibbonsCountA++;
      assert.ok(maxTaper >= 0.98, `Tapered rail on ${fr.info.id} must widen back to nominal 1.0`);
    }
  }
  assert.ok(taperedRibbonsCountA >= 12, `Expected >= 12 switch-blade tapered rails across turnouts/crossovers, got ${taperedRibbonsCountA}`);

  // Verify Candidate B 3D extruded rail continuity and physical 3D blade width taper
  const resB = buildRailwayPrototypeGroup(switchyardData, theme, 'candidateB', 8.0);
  const railB = resB.railwaysGroup.getObjectByName('Railway_Rails_3D') as THREE.Mesh;
  assert.ok(railB, 'Candidate B must produce Railway_Rails_3D mesh');
  const posB = railB.geometry.attributes.position;
  const idxB = railB.geometry.index!;
  const faceRangesB = railB.userData.faceRanges as Array<{
    startFace: number;
    endFace: number;
    info: { id: string };
  }>;
  assert.equal(faceRangesB.length, 130, 'Candidate B must have 130 3D rail faceRanges (2 per track)');

  let tapered3DRailsCount = 0;
  for (const fr of faceRangesB) {
    // Each segment of a 3D rail has 6 triangles (left wall, top head, right wall) and 8 vertices per ring
    const triCount = fr.endFace - fr.startFace;
    const numSegs = triCount / 6;
    assert.ok(numSegs >= 1, `3D rail for ${fr.info.id} must have >= 1 segment`);
    const baseVert = idxB.getX(fr.startFace * 3);
    let minWidth3D = Infinity;
    let maxWidth3D = 0;
    for (let ring = 0; ring <= numSegs; ring++) {
      const vTopLeft = baseVert + ring * 6 + 0;
      const vTopRight = baseVert + ring * 6 + 1;
      const w3D = Math.hypot(
        posB.getX(vTopLeft) - posB.getX(vTopRight),
        posB.getZ(vTopLeft) - posB.getZ(vTopRight)
      );
      assert.ok(w3D >= 0.04 && w3D <= 0.25, `Candidate B 3D rail head width ${w3D.toFixed(3)}m out of bounds`);
      minWidth3D = Math.min(minWidth3D, w3D);
      maxWidth3D = Math.max(maxWidth3D, w3D);
    }
    if (minWidth3D < 0.09) {
      tapered3DRailsCount++;
      assert.ok(maxWidth3D >= 0.19, '3D tapered switch blade must widen back to full 0.20m head width');
    }
  }
  assert.ok(tapered3DRailsCount >= 12, `Expected >= 12 physically tapered 3D switch blades in Candidate B, got ${tapered3DRailsCount}`);

  resA.dispose();
  resB.dispose();
});

test('M2.1 Close-Zoom Sleeper Density Evaluation: compares 0.60m physical, 0.725m half-harmonic, and 1.45m sparse spacings', () => {
  const switchyardData = createRailwayPrototypeFixtureData();
  const theme = MAP_THEMES.tactical;

  const proto060 = buildRailwayPrototypeGroup(switchyardData, theme, 'candidateB', 8.0, {
    closeZoomSleeperPeriodMeters: 0.60,
  });
  const proto0725 = buildRailwayPrototypeGroup(switchyardData, theme, 'candidateB', 8.0, {
    closeZoomSleeperPeriodMeters: 0.725,
  });
  const proto145 = buildRailwayPrototypeGroup(switchyardData, theme, 'candidateB', 8.0, {
    closeZoomSleeperPeriodMeters: 1.45,
  });

  // Verify each 3D sleeper box contributes exactly 20 vertices and 10 triangles
  const sleeperMesh0725 = proto0725.railwaysGroup.getObjectByName('Railway_Sleepers_3D') as THREE.Mesh;
  assert.equal(
    sleeperMesh0725.geometry.attributes.position.count,
    proto0725.stats.sleeper3DBoxCount * 20,
    'Each merged 3D sleeper box must have exactly 20 vertices (5 visible faces * 4 vertices)'
  );
  assert.equal(
    sleeperMesh0725.geometry.index!.count / 3,
    proto0725.stats.sleeper3DBoxCount * 10,
    'Each merged 3D sleeper box must have exactly 10 triangles (5 visible faces * 2 triangles)'
  );

  // Verify monotonic density scaling: 0.60m > 0.725m > 1.45m
  assert.ok(proto060.stats.sleeper3DBoxCount > proto0725.stats.sleeper3DBoxCount);
  assert.ok(proto0725.stats.sleeper3DBoxCount > proto145.stats.sleeper3DBoxCount);
  assert.ok(proto060.stats.totalVertices > proto0725.stats.totalVertices);
  assert.ok(proto0725.stats.totalVertices > proto145.stats.totalVertices);

  console.table({
    'Candidate B @ 0.60m (Physical)': {
      periodM: proto060.stats.closeZoomSleeperPeriodMeters,
      sleeperBoxes: proto060.stats.sleeper3DBoxCount,
      turnoutBearers: proto060.stats.turnoutBearerCount,
      totalVertices: proto060.stats.totalVertices,
      totalTriangles: proto060.stats.totalTriangles,
      cpuBufferKB: Number((proto060.stats.cpuBufferBytes / 1024).toFixed(1)),
    },
    'Candidate B @ 0.725m (Default Half-Harmonic)': {
      periodM: proto0725.stats.closeZoomSleeperPeriodMeters,
      sleeperBoxes: proto0725.stats.sleeper3DBoxCount,
      turnoutBearers: proto0725.stats.turnoutBearerCount,
      totalVertices: proto0725.stats.totalVertices,
      totalTriangles: proto0725.stats.totalTriangles,
      cpuBufferKB: Number((proto0725.stats.cpuBufferBytes / 1024).toFixed(1)),
    },
    'Candidate B @ 1.45m (Sparse Procedural Period)': {
      periodM: proto145.stats.closeZoomSleeperPeriodMeters,
      sleeperBoxes: proto145.stats.sleeper3DBoxCount,
      turnoutBearers: proto145.stats.turnoutBearerCount,
      totalVertices: proto145.stats.totalVertices,
      totalTriangles: proto145.stats.totalTriangles,
      cpuBufferKB: Number((proto145.stats.cpuBufferBytes / 1024).toFixed(1)),
    },
  });

  proto060.dispose();
  proto0725.dispose();
  proto145.dispose();
});

test('M2.1 Real OSM Data Verification: Station Hengelo and Amsterdam Centraal Overpass API extracts', () => {
  const extractPath = path.resolve(__dirname, 'prototype', 'realOsmRailwayExtracts.json');
  assert.ok(fs.existsSync(extractPath), 'realOsmRailwayExtracts.json must exist');
  const rawExtract = JSON.parse(fs.readFileSync(extractPath, 'utf-8'));

  const provider = new LocalGeoJsonProvider();

  for (const [regionKey, regionData] of Object.entries<any>(rawExtract.regions)) {
    const fc = {
      type: 'FeatureCollection',
      name: regionData.name,
      features: regionData.features,
    };
    const evalRadius = regionKey === 'amsterdamCentraal' ? 180 : regionData.radiusMeters;
    const parsed = provider.parseGeoJson(fc, regionData.name, regionData.center, evalRadius);
    assert.ok(parsed.railways.length >= 20, `${regionKey} must contain >= 20 real OSM railway ways`);

    let shortWaysUnder2m = 0;
    let untaggedServiceOrUsage = 0;
    let bridgeWays = 0;
    let tunnelWays = 0;
    const sampleWayIds: string[] = [];

    for (const r of parsed.railways) {
      if (sampleWayIds.length < 8 && r.sourceFeatureId) {
        sampleWayIds.push(r.sourceFeatureId);
      }
      if (r.isBridge || r.layer > 0) bridgeWays++;
      if (r.isTunnel || r.layer < 0) tunnelWays++;
      if (!r.osmTags?.service && !r.osmTags?.usage) untaggedServiceOrUsage++;
      if (r.points && r.points.length >= 2) {
        let len = 0;
        for (let i = 0; i < r.points.length - 1; i++) {
          len += Math.hypot(r.points[i + 1][0] - r.points[i][0], r.points[i + 1][1] - r.points[i][1]);
        }
        if (len < 2.0) shortWaysUnder2m++;
      }
    }

    const resA = buildRailwayPrototypeGroup(parsed, MAP_THEMES.tactical, 'candidateA', 8.0);
    const resB = buildRailwayPrototypeGroup(parsed, MAP_THEMES.tactical, 'candidateB', 8.0);

    assert.ok(resA.stats.totalTriangles > 100);
    assert.ok(resB.stats.totalTriangles > resA.stats.totalTriangles);
    assert.ok(resB.stats.sleeper3DBoxCount > 100);
    assert.ok(resB.stats.turnoutBearerCount > 0, `${regionKey} real OSM throat must generate shared turnout bearers`);

    console.log(`[Real OSM Verification: ${regionData.name}]`, {
      extractedAt: rawExtract.extractedAt,
      rawRailwayFeatures: regionData.features.length,
      parsedRailwayWays: parsed.railways.length,
      bridgeWays,
      tunnelWays,
      untaggedServiceOrUsage,
      shortWaysUnder2m,
      sampleWayIds,
      candidateAVertices: resA.stats.totalVertices,
      candidateBVertices: resB.stats.totalVertices,
      candidateB3DSleeperBoxes: resB.stats.sleeper3DBoxCount,
      candidateBTurnoutBearers: resB.stats.turnoutBearerCount,
    });

    resA.dispose();
    resB.dispose();
    assert.equal(resA.resources.ownedGeometriesCount, 0);
    assert.equal(resB.resources.ownedGeometriesCount, 0);
  }
});

test('M2.1 Runtime Investigation Experiment B: subtractIntervalFromList preserves both outer rail-supporting segments when an interior cut splits a sleeper', () => {
  // Suppose a sleeper interval [-1.25, +1.25] (width 2.50m) has an interior forbidden cut [-0.30, +0.30]
  // Legacy single-interval subtractLateralInterval discards one of the two 0.95m outer segments:
  const singleResult = subtractLateralInterval(-1.25, 1.25, -0.30, 0.30);
  assert.ok(singleResult !== null);
  assert.ok(
    Math.abs((singleResult[1] - singleResult[0]) - 0.95) < 1e-6,
    'Legacy single-interval subtraction keeps only one 0.95m outer segment'
  );

  // Multi-interval subtractIntervalFromList preserves BOTH outer rail-supporting segments [-1.25, -0.30] and [0.30, 1.25]:
  const multiResult = subtractIntervalFromList([[-1.25, 1.25]], -0.30, 0.30);
  assert.equal(multiResult.length, 2, 'Multi-interval subtraction must preserve both valid >= 0.38m outer segments');
  assert.deepEqual(multiResult[0], [-1.25, -0.30]);
  assert.deepEqual(multiResult[1], [0.30, 1.25]);

  // Verify sequential interior cuts on a wide 4.2m bearer [-2.10, +2.10]
  const afterTwoCuts = subtractIntervalFromList(
    subtractIntervalFromList([[-2.10, 2.10]], -1.10, -0.50),
    0.50,
    1.10
  );
  assert.equal(afterTwoCuts.length, 3, 'Two interior cuts leaving 1.0m spans must yield 3 valid segments');
});

test('M2.1 Runtime Investigation Experiment C & D: THREE.InstancedMesh 3D sleepers and static spatial chunking preserve feature inspection, variable-length bearers, and zero leaks', () => {
  const switchyardData = createRailwayPrototypeFixtureData();
  const theme = MAP_THEMES.tactical;

  const protoMerged = buildRailwayPrototypeGroup(switchyardData, theme, 'candidateB', 8.0, {
    sleeper3DMode: 'merged',
    spatialChunkSizeMeters: 0,
  });
  const protoInstancedChunked = buildRailwayPrototypeGroup(switchyardData, theme, 'candidateB', 8.0, {
    sleeper3DMode: 'instanced',
    spatialChunkSizeMeters: 128,
  });

  // 1. Both modes emit the exact same number of 3D sleeper/bearer boxes and shared turnout bearers
  assert.equal(
    protoInstancedChunked.stats.sleeper3DBoxCount,
    protoMerged.stats.sleeper3DBoxCount
  );
  assert.equal(
    protoInstancedChunked.stats.turnoutBearerCount,
    protoMerged.stats.turnoutBearerCount
  );
  assert.equal(
    protoInstancedChunked.stats.renderedTrianglesWithInstances,
    protoMerged.stats.renderedTrianglesWithInstances
  );

  // 2. Instanced mode uses dramatically fewer unique BufferGeometry vertices and CPU buffer bytes than merged 3D sleepers
  assert.ok(
    protoInstancedChunked.stats.totalVertices < protoMerged.stats.totalVertices,
    `Expected instanced unique vertices (${protoInstancedChunked.stats.totalVertices}) < merged vertices (${protoMerged.stats.totalVertices})`
  );
  assert.ok(
    protoInstancedChunked.stats.cpuBufferBytes < protoMerged.stats.cpuBufferBytes,
    `Expected instanced CPU buffer bytes (${protoInstancedChunked.stats.cpuBufferBytes}) < merged bytes (${protoMerged.stats.cpuBufferBytes})`
  );

  // 3. Verify spatial chunking creates tight bounding spheres (< 150m radius) with frustumCulled = true
  assert.ok(protoInstancedChunked.stats.spatialChunkCount >= 2);
  const sleepers3DGroup = protoInstancedChunked.railwaysGroup.getObjectByName(
    'Railway_Sleepers_3D'
  ) as THREE.Group;
  assert.ok(sleepers3DGroup && sleepers3DGroup.children.length >= 2);

  const firstInstMesh = sleepers3DGroup.children[0] as THREE.InstancedMesh;
  assert.equal(firstInstMesh.isInstancedMesh, true);
  assert.equal(firstInstMesh.frustumCulled, true);
  assert.ok(firstInstMesh.boundingSphere !== null);
  assert.ok(
    firstInstMesh.boundingSphere!.radius > 0 && firstInstMesh.boundingSphere!.radius < 150,
    `Chunked InstancedMesh boundingSphere radius (${firstInstMesh.boundingSphere!.radius.toFixed(1)}m) must be tight (< 150m)`
  );

  // 4. Verify resolveInspectedFeature resolves instanceId on InstancedMesh sleepers
  const resolvedInfo = resolveInspectedFeature({
    object: firstInstMesh,
    instanceId: 0,
  });
  assert.ok(resolvedInfo !== null, 'resolveInspectedFeature must resolve instanceId=0 on InstancedMesh sleeper');
  assert.equal(resolvedInfo?.category, 'Railway & Aerial');

  protoMerged.dispose();
  protoInstancedChunked.dispose();
  assert.equal(protoMerged.resources.ownedGeometriesCount, 0);
  assert.equal(protoInstancedChunked.resources.ownedGeometriesCount, 0);
});

test('M2.1 Runtime Investigation 4-Configuration Isolation: disabled, candidateA, and candidateB share an identical non-railway map without duplicate railway bridges', () => {
  const switchyardData = createRailwayPrototypeFixtureData();
  const theme = MAP_THEMES.tactical;

  const repDisabled = runCpuAndLifecycleBenchmark(switchyardData, theme, 'disabled', 2);
  const repProduction = runCpuAndLifecycleBenchmark(switchyardData, theme, 'production', 2);
  const repCandA = runCpuAndLifecycleBenchmark(switchyardData, theme, 'candidateA', 2);
  const repCandB = runCpuAndLifecycleBenchmark(switchyardData, theme, 'candidateB', 2, {
    sleeper3DMode: 'instanced',
    spatialChunkSizeMeters: 128,
  });

  // Non-railway groups (buildingsGroup and roadsGroup) must be 100% identical across disabled, candidateA, and candidateB
  assert.equal(repDisabled.railwayGroupStats.triangles, 0);
  assert.equal(repCandA.buildingsGroupStats.triangles, repDisabled.buildingsGroupStats.triangles);
  assert.equal(repCandB.buildingsGroupStats.triangles, repDisabled.buildingsGroupStats.triangles);
  assert.equal(repCandA.roadsGroupStats.triangles, repDisabled.roadsGroupStats.triangles);
  assert.equal(repCandB.roadsGroupStats.triangles, repDisabled.roadsGroupStats.triangles);

  // In production, railway bridge structures are in railwaysGroup, not in roadsGroup
  assert.equal(repProduction.roadsGroupStats.triangles, repDisabled.roadsGroupStats.triangles);
  assert.equal(repDisabled.lifecycleAudit.netLeakedGeometriesAfterCycles, 0);
  assert.equal(repProduction.lifecycleAudit.netLeakedGeometriesAfterCycles, 0);
  assert.equal(repCandB.lifecycleAudit.netLeakedGeometriesAfterCycles, 0);
});

/**
 * Helper: Verifies that a rail point `(px, pz)` belonging to `trackId` is BOTH geometrically
 * supported by `box` AND structurally associated with `trackId` (`box.trackId === trackId` or
 * `box.supportedTrackIds` explicitly includes `trackId`). An arbitrary sleeper from an adjacent
 * parallel track is never counted as support for `trackId`.
 */
function isRailPointStructurallySupportedByBox(
  px: number,
  pz: number,
  trackId: string,
  box: SleeperBearerBox3D,
  longitudinalPad: number = 0.08,
  lateralPad: number = 0.04
): boolean {
  const isAssociated =
    box.trackId === trackId || Boolean(box.supportedTrackIds?.includes(trackId));
  if (!isAssociated) return false;
  return isPointSupportedBySleeperBox(px, pz, box, longitudinalPad, lateralPad);
}

/**
 * Helper: Computes the maximum unsupported longitudinal span along both rails (left `+1` and right `-1`)
 * of `track`, considering ONLY sleepers structurally associated with `track.id`.
 */
function evaluateStructuralSupportPerRail(
  track: { id: string; points: [number, number][]; railwayType?: string },
  boxes: SleeperBearerBox3D[],
  requireOwnTrackSleepersOnly: boolean = false
): {
  leftMaxGapMeters: number;
  rightMaxGapMeters: number;
  ownSleeperCount: number;
  supportingBoxCountLeft: number;
  supportingBoxCountRight: number;
} {
  const isTram = track.railwayType === 'tram';
  const gaugeOffsetHalf =
    (isTram
      ? RAILWAY_DIMENSION_SPEC.visualTramCenterToCenterGaugeMeters
      : RAILWAY_DIMENSION_SPEC.visualCenterToCenterGaugeMeters) * 0.5;
  const bev = subdivideSharpPolylineCorners2D(track.points);
  const sampleStep = 0.08;

  const ownSleeperCount = boxes.filter((b) => b.trackId === track.id).length;
  const eligibleBoxes = requireOwnTrackSleepersOnly
    ? boxes.filter((b) => b.trackId === track.id)
    : boxes.filter(
        (b) => b.trackId === track.id || Boolean(b.supportedTrackIds?.includes(track.id))
      );

  const measureSide = (sideSign: 1 | -1) => {
    const latOffset = sideSign * gaugeOffsetHalf;
    const supportedStations: number[] = [];
    const supportingIds = new Set<SleeperBearerBox3D>();
    let totalLen = 0;

    for (let i = 0; i < bev.length - 1; i++) {
      const p0 = bev[i];
      const p1 = bev[i + 1];
      const segDx = p1[0] - p0[0];
      const segDz = p1[1] - p0[1];
      const segLen = Math.hypot(segDx, segDz);
      if (segLen < 1e-4) continue;
      const nx = -(segDz / segLen);
      const nz = segDx / segLen;
      const steps = Math.max(1, Math.ceil(segLen / sampleStep));
      for (let k = 0; k <= steps; k++) {
        const s = totalLen + (k / steps) * segLen;
        const cx = p0[0] + segDx * (k / steps) + nx * latOffset;
        const cz = p0[1] + segDz * (k / steps) + nz * latOffset;
        let supported = false;
        for (const b of eligibleBoxes) {
          if (isRailPointStructurallySupportedByBox(cx, cz, track.id, b, 0.08, 0.04)) {
            supported = true;
            supportingIds.add(b);
            break;
          }
        }
        if (supported) {
          supportedStations.push(s);
        }
      }
      totalLen += segLen;
    }

    if (supportedStations.length === 0) {
      return { maxGap: totalLen, count: 0 };
    }
    let maxGap = supportedStations[0];
    for (let i = 1; i < supportedStations.length; i++) {
      const gap = supportedStations[i] - supportedStations[i - 1];
      if (gap > maxGap) maxGap = gap;
    }
    const endGap = totalLen - supportedStations[supportedStations.length - 1];
    if (endGap > maxGap) maxGap = endGap;
    return { maxGap, count: supportingIds.size };
  };

  const left = measureSide(1);
  const right = measureSide(-1);
  return {
    leftMaxGapMeters: left.maxGap,
    rightMaxGapMeters: right.maxGap,
    ownSleeperCount,
    supportingBoxCountLeft: left.count,
    supportingBoxCountRight: right.count,
  };
}

/**
 * Helper: Compares normalized sleeper placements for a given `trackId` between two runs
 * (`boxesA` and `boxesB`), verifying that every sleeper box has identical world center `(cx, cz)`,
 * total width, world-space lateral interval, turnout-bearer flag, and `supportedTrackIds` association.
 */
function assertNormalizedTrackSleepersIdentical(
  trackId: string,
  boxesA: SleeperBearerBox3D[],
  boxesB: SleeperBearerBox3D[],
  contextLabel: string
): void {
  const normalize = (boxes: SleeperBearerBox3D[]) =>
    boxes
      .filter((b) => b.trackId === trackId)
      .map((b) => {
        const { nx, nz } = b;
        const pLeftX = b.cx + nx * b.halfWidthLeft;
        const pLeftZ = b.cz + nz * b.halfWidthLeft;
        const pRightX = b.cx - nx * b.halfWidthRight;
        const pRightZ = b.cz - nz * b.halfWidthRight;
        return {
          cx: b.cx,
          cz: b.cz,
          width: b.halfWidthLeft + b.halfWidthRight,
          minX: Math.min(pLeftX, pRightX),
          maxX: Math.max(pLeftX, pRightX),
          minZ: Math.min(pLeftZ, pRightZ),
          maxZ: Math.max(pLeftZ, pRightZ),
          isTurnoutBearer: Boolean(b.isTurnoutBearer),
          supportedTrackIds: [...(b.supportedTrackIds ?? [b.trackId])].sort().join(','),
        };
      })
      .sort((a, b) => (Math.abs(a.cx - b.cx) > 1e-4 ? a.cx - b.cx : a.cz - b.cz));

  const normA = normalize(boxesA);
  const normB = normalize(boxesB);
  assert.equal(
    normA.length,
    normB.length,
    `${contextLabel} (${trackId}): sleeper count must be identical when track priority order is reversed`
  );
  for (let i = 0; i < normA.length; i++) {
    const a = normA[i];
    const b = normB[i];
    assert.ok(
      Math.abs(a.cx - b.cx) < 1e-5 &&
        Math.abs(a.cz - b.cz) < 1e-5 &&
        Math.abs(a.width - b.width) < 1e-5 &&
        Math.abs(a.minX - b.minX) < 1e-5 &&
        Math.abs(a.maxX - b.maxX) < 1e-5 &&
        Math.abs(a.minZ - b.minZ) < 1e-5 &&
        Math.abs(a.maxZ - b.maxZ) < 1e-5,
      `${contextLabel} (${trackId}) sleeper[${i}] placement/width differed on reversed priority: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`
    );
    assert.equal(a.isTurnoutBearer, b.isTurnoutBearer);
    assert.equal(a.supportedTrackIds, b.supportedTrackIds);
  }
}

test('M2.1 Closely Spaced Tracks Regression 1: Straight, curved concentric, and chained short-segment parallel tracks retain per-rail sleeper support and normalized placement order-independence', () => {
  const theme = MAP_THEMES.tactical;

  // Sub-case 1A: Straight parallel tracks across spacings 1.90m, 2.05m, 2.20m, 2.38m
  for (const spacingMeters of [1.90, 2.05, 2.20, 2.38]) {
    const track1 = {
      id: 'parallel_track_1',
      sourceFeatureId: 'parallel_track_1',
      sourceFeatureIds: ['parallel_track_1'],
      type: 'railway' as const,
      name: 'Parallel Track 1',
      points: [
        [-25, 0],
        [25, 0],
      ] as [number, number][],
      railwayType: 'rail' as const,
      cartoLabel: 'Standard Railway',
      primaryTag: 'railway=rail',
      width: 3.5,
      gauge: 1435,
      layer: 0,
      isBridge: false,
      isTunnel: false,
      osmTags: { railway: 'rail', usage: 'main' },
    };
    const track2 = {
      ...track1,
      id: 'parallel_track_2',
      sourceFeatureId: 'parallel_track_2',
      sourceFeatureIds: ['parallel_track_2'],
      name: 'Parallel Track 2',
      points: [
        [-25, spacingMeters],
        [25, spacingMeters],
      ] as [number, number][],
      osmTags: { railway: 'rail', usage: 'branch', service: 'siding' },
    };

    const forwardData = {
      roads: [],
      buildings: [],
      buildingsGroup: [],
      parks: [],
      landuse: [],
      railways: [track1, track2],
    } as any;
    const reverseData = {
      roads: [],
      buildings: [],
      parks: [],
      landuse: [],
      railways: [
        { ...track2, osmTags: { railway: 'rail', usage: 'main' } },
        { ...track1, osmTags: { railway: 'rail', usage: 'branch', service: 'siding' } },
      ],
    } as any;

    const resForward = buildRailwayPrototypeGroup(forwardData, theme, 'candidateB', 8.0);
    const resReverse = buildRailwayPrototypeGroup(reverseData, theme, 'candidateB', 8.0);

    // 1. Neither track may steal the other via false turnout bearers (0 turnout bearers on parallel tracks)
    assert.equal(
      resForward.stats.turnoutBearerCount,
      0,
      `Independent parallel tracks at ${spacingMeters}m spacing must not emit shared turnout bearers`
    );

    // 2. Both tracks must retain their own sleeper boxes supporting both of their own rails
    const sup1 = evaluateStructuralSupportPerRail(track1, resForward.sleeperBoxes3D, true);
    const sup2 = evaluateStructuralSupportPerRail(track2, resForward.sleeperBoxes3D, true);

    assert.ok(
      sup1.ownSleeperCount >= 65 && sup2.ownSleeperCount >= 65,
      `At ${spacingMeters}m spacing, each 50m track must retain >= 65 of its own sleepers (got T1=${sup1.ownSleeperCount}, T2=${sup2.ownSleeperCount})`
    );
    assert.ok(
      sup1.leftMaxGapMeters <= 0.85 && sup1.rightMaxGapMeters <= 0.85,
      `Track 1 at ${spacingMeters}m must have continuous per-rail support <= 0.85m (got L=${sup1.leftMaxGapMeters.toFixed(3)}m, R=${sup1.rightMaxGapMeters.toFixed(3)}m)`
    );
    assert.ok(
      sup2.leftMaxGapMeters <= 0.85 && sup2.rightMaxGapMeters <= 0.85,
      `Track 2 at ${spacingMeters}m must have continuous per-rail support <= 0.85m (got L=${sup2.leftMaxGapMeters.toFixed(3)}m, R=${sup2.rightMaxGapMeters.toFixed(3)}m)`
    );

    // 3. Verify negative test: if Track 2's own sleepers are removed, Track 1's nearby sleepers MUST NOT make Track 2 pass
    const boxesWithoutTrack2 = resForward.sleeperBoxes3D.filter((b) => b.trackId !== track2.id);
    const sup2WithoutOwn = evaluateStructuralSupportPerRail(track2, boxesWithoutTrack2, false);
    assert.equal(
      sup2WithoutOwn.supportingBoxCountLeft,
      0,
      'Adjacent parallel track sleepers must never count as structural support for Track 2'
    );
    assert.equal(sup2WithoutOwn.supportingBoxCountRight, 0);

    // 4. Verify deterministic order independence on normalized sleeper positions, widths, bounds, and associations
    assertNormalizedTrackSleepersIdentical(
      track1.id,
      resForward.sleeperBoxes3D,
      resReverse.sleeperBoxes3D,
      `Straight parallel ${spacingMeters}m`
    );
    assertNormalizedTrackSleepersIdentical(
      track2.id,
      resForward.sleeperBoxes3D,
      resReverse.sleeperBoxes3D,
      `Straight parallel ${spacingMeters}m`
    );

    // 5. Verify zero 2D OBB overlaps between the two closely spaced parallel tracks
    for (let i = 0; i < resForward.sleeperBoxes3D.length; i++) {
      for (let j = i + 1; j < resForward.sleeperBoxes3D.length; j++) {
        const a = resForward.sleeperBoxes3D[i];
        const b = resForward.sleeperBoxes3D[j];
        if (a.trackId === b.trackId) continue;
        assert.equal(
          doSleeperBoxesOverlap2D(a, b, 0.015),
          false,
          `Sleepers from ${a.trackId} and ${b.trackId} must not overlap at ${spacingMeters}m spacing`
        );
      }
    }

    resForward.dispose();
    resReverse.dispose();
  }

  // Sub-case 1B: Concentric curved parallel tracks at 2.10m radial spacing (R1 = 80.0m, R2 = 77.9m)
  {
    const r1 = 80.0;
    const r2 = 77.9;
    const segments = 16;
    const maxAngle = Math.PI / 5; // ~50m arc length
    const curvePoints1: [number, number][] = [];
    const curvePoints2: [number, number][] = [];
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * maxAngle;
      curvePoints1.push([Math.sin(theta) * r1, (1 - Math.cos(theta)) * r1]);
      curvePoints2.push([Math.sin(theta) * r2, (1 - Math.cos(theta)) * r2 + (r1 - r2)]);
    }
    const curved1 = {
      id: 'curved_parallel_1',
      sourceFeatureId: 'curved_parallel_1',
      sourceFeatureIds: ['curved_parallel_1'],
      type: 'railway' as const,
      name: 'Curved Parallel 1',
      points: curvePoints1,
      railwayType: 'rail' as const,
      cartoLabel: 'Standard Railway',
      primaryTag: 'railway=rail',
      width: 3.5,
      gauge: 1435,
      layer: 0,
      isBridge: false,
      isTunnel: false,
      osmTags: { railway: 'rail', usage: 'main' },
    };
    const curved2 = {
      ...curved1,
      id: 'curved_parallel_2',
      sourceFeatureId: 'curved_parallel_2',
      sourceFeatureIds: ['curved_parallel_2'],
      name: 'Curved Parallel 2',
      points: curvePoints2,
      osmTags: { railway: 'rail', usage: 'branch', service: 'siding' },
    };

    const resCurvedFwd = buildRailwayPrototypeGroup(
      { roads: [], buildings: [], parks: [], landuse: [], railways: [curved1, curved2] } as any,
      theme,
      'candidateB',
      8.0
    );
    const resCurvedRev = buildRailwayPrototypeGroup(
      {
        roads: [],
        buildings: [],
        parks: [],
        landuse: [],
        railways: [
          { ...curved2, osmTags: { railway: 'rail', usage: 'main' } },
          { ...curved1, osmTags: { railway: 'rail', usage: 'branch', service: 'siding' } },
        ],
      } as any,
      theme,
      'candidateB',
      8.0
    );

    assert.equal(resCurvedFwd.stats.turnoutBearerCount, 0, 'Concentric curved parallel tracks must not emit false turnout bearers');
    const cSup1 = evaluateStructuralSupportPerRail(curved1, resCurvedFwd.sleeperBoxes3D, true);
    const cSup2 = evaluateStructuralSupportPerRail(curved2, resCurvedFwd.sleeperBoxes3D, true);
    assert.ok(cSup1.ownSleeperCount >= 60 && cSup2.ownSleeperCount >= 60);
    assert.ok(cSup1.leftMaxGapMeters <= 0.90 && cSup1.rightMaxGapMeters <= 0.90);
    assert.ok(cSup2.leftMaxGapMeters <= 0.90 && cSup2.rightMaxGapMeters <= 0.90);
    assertNormalizedTrackSleepersIdentical(
      curved1.id,
      resCurvedFwd.sleeperBoxes3D,
      resCurvedRev.sleeperBoxes3D,
      'Concentric curved parallel 2.10m'
    );
    assertNormalizedTrackSleepersIdentical(
      curved2.id,
      resCurvedFwd.sleeperBoxes3D,
      resCurvedRev.sleeperBoxes3D,
      'Concentric curved parallel 2.10m'
    );

    for (let i = 0; i < resCurvedFwd.sleeperBoxes3D.length; i++) {
      for (let j = i + 1; j < resCurvedFwd.sleeperBoxes3D.length; j++) {
        if (resCurvedFwd.sleeperBoxes3D[i].trackId === resCurvedFwd.sleeperBoxes3D[j].trackId) continue;
        assert.equal(doSleeperBoxesOverlap2D(resCurvedFwd.sleeperBoxes3D[i], resCurvedFwd.sleeperBoxes3D[j], 0.015), false);
      }
    }
    resCurvedFwd.dispose();
    resCurvedRev.dispose();
  }

  // Sub-case 1C: Chained short-segment parallel tracks at 2.10m spacing (0.85m and 1.15m vertex chains)
  {
    const chainPoints1: [number, number][] = [];
    for (let x = -15; x <= 15.001; x += 0.85) {
      chainPoints1.push([Number(x.toFixed(3)), 0]);
    }
    const chainPoints2: [number, number][] = [];
    for (let x = -15; x <= 15.001; x += 1.15) {
      chainPoints2.push([Number(x.toFixed(3)), 2.1]);
    }
    const chained1 = {
      id: 'chained_parallel_1',
      sourceFeatureId: 'chained_parallel_1',
      sourceFeatureIds: ['chained_parallel_1'],
      type: 'railway' as const,
      name: 'Chained Parallel 1',
      points: chainPoints1,
      railwayType: 'rail' as const,
      cartoLabel: 'Standard Railway',
      primaryTag: 'railway=rail',
      width: 3.5,
      gauge: 1435,
      layer: 0,
      isBridge: false,
      isTunnel: false,
      osmTags: { railway: 'rail', usage: 'main' },
    };
    const chained2 = {
      ...chained1,
      id: 'chained_parallel_2',
      sourceFeatureId: 'chained_parallel_2',
      sourceFeatureIds: ['chained_parallel_2'],
      name: 'Chained Parallel 2',
      points: chainPoints2,
      osmTags: { railway: 'rail', usage: 'branch', service: 'siding' },
    };

    const resChainFwd = buildRailwayPrototypeGroup(
      { roads: [], buildings: [], parks: [], landuse: [], railways: [chained1, chained2] } as any,
      theme,
      'candidateB',
      8.0
    );
    const resChainRev = buildRailwayPrototypeGroup(
      {
        roads: [],
        buildings: [],
        parks: [],
        landuse: [],
        railways: [
          { ...chained2, osmTags: { railway: 'rail', usage: 'main' } },
          { ...chained1, osmTags: { railway: 'rail', usage: 'branch', service: 'siding' } },
        ],
      } as any,
      theme,
      'candidateB',
      8.0
    );

    assert.equal(resChainFwd.stats.turnoutBearerCount, 0);
    const chSup1 = evaluateStructuralSupportPerRail(chained1, resChainFwd.sleeperBoxes3D, true);
    const chSup2 = evaluateStructuralSupportPerRail(chained2, resChainFwd.sleeperBoxes3D, true);
    assert.ok(chSup1.ownSleeperCount >= 38 && chSup2.ownSleeperCount >= 38);
    assert.ok(chSup1.leftMaxGapMeters <= 0.85 && chSup1.rightMaxGapMeters <= 0.85);
    assert.ok(chSup2.leftMaxGapMeters <= 0.85 && chSup2.rightMaxGapMeters <= 0.85);
    assertNormalizedTrackSleepersIdentical(
      chained1.id,
      resChainFwd.sleeperBoxes3D,
      resChainRev.sleeperBoxes3D,
      'Chained short-segment parallel 2.10m'
    );
    assertNormalizedTrackSleepersIdentical(
      chained2.id,
      resChainFwd.sleeperBoxes3D,
      resChainRev.sleeperBoxes3D,
      'Chained short-segment parallel 2.10m'
    );

    for (let i = 0; i < resChainFwd.sleeperBoxes3D.length; i++) {
      for (let j = i + 1; j < resChainFwd.sleeperBoxes3D.length; j++) {
        if (resChainFwd.sleeperBoxes3D[i].trackId === resChainFwd.sleeperBoxes3D[j].trackId) continue;
        assert.equal(doSleeperBoxesOverlap2D(resChainFwd.sleeperBoxes3D[i], resChainFwd.sleeperBoxes3D[j], 0.015), false);
      }
    }
    resChainFwd.dispose();
    resChainRev.dispose();
  }
});

test('M2.1 Closely Spaced Tracks Regression 2: Five closely spaced parallel tracks with competing longitudinal phases each maintain full per-rail support', () => {
  const theme = MAP_THEMES.tactical;
  // 5 tracks at tight spacings (z = 0.0, 2.00, 4.10, 6.05, 8.20) with staggered start X coordinates
  // so their longitudinal sleeper stations compete out-of-phase across interior tracks.
  const zPositions = [0.0, 2.0, 4.1, 6.05, 8.2];
  const xPhaseOffsets = [0.0, 0.19, 0.37, 0.53, 0.11];
  const tracks = zPositions.map((z, idx) => ({
    id: `corridor_track_${idx + 1}`,
    sourceFeatureId: `corridor_track_${idx + 1}`,
    sourceFeatureIds: [`corridor_track_${idx + 1}`],
    type: 'railway' as const,
    name: `Corridor Track ${idx + 1}`,
    points: [
      [-20 + xPhaseOffsets[idx], z],
      [20 + xPhaseOffsets[idx], z],
    ] as [number, number][],
    railwayType: 'rail' as const,
    cartoLabel: 'Standard Railway',
    primaryTag: 'railway=rail',
    width: 3.5,
    gauge: 1435,
    layer: 0,
    isBridge: false,
    isTunnel: false,
    osmTags: {
      railway: 'rail',
      usage: idx % 2 === 0 ? 'main' : 'branch',
      ...(idx % 2 === 1 ? { service: 'yard' } : {}),
    },
  }));

  const res = buildRailwayPrototypeGroup(
    { roads: [], buildings: [], parks: [], landuse: [], railways: tracks } as any,
    theme,
    'candidateB',
    8.0
  );

  for (const t of tracks) {
    const sup = evaluateStructuralSupportPerRail(t, res.sleeperBoxes3D, true);
    assert.ok(
      sup.ownSleeperCount >= 52,
      `${t.id} in 5-track tight corridor must retain >= 52 own sleepers, got ${sup.ownSleeperCount}`
    );
    assert.ok(
      sup.leftMaxGapMeters <= 0.85 && sup.rightMaxGapMeters <= 0.85,
      `${t.id} must have continuous per-rail support <= 0.85m on both rails (got L=${sup.leftMaxGapMeters.toFixed(3)}m, R=${sup.rightMaxGapMeters.toFixed(3)}m)`
    );
  }

  // Zero 2D OBB overlaps across all 5 competing tracks
  let overlaps = 0;
  for (let i = 0; i < res.sleeperBoxes3D.length; i++) {
    for (let j = i + 1; j < res.sleeperBoxes3D.length; j++) {
      if (res.sleeperBoxes3D[i].trackId === res.sleeperBoxes3D[j].trackId) continue;
      if (doSleeperBoxesOverlap2D(res.sleeperBoxes3D[i], res.sleeperBoxes3D[j], 0.015)) {
        overlaps++;
      }
    }
  }
  assert.equal(overlaps, 0, 'Expected 0 overlapping sleepers across 5-track competing corridor');

  res.dispose();
});

test('M2.1 Closely Spaced Tracks Regression 3 & 4: Turnout shared bearers in 3-track throat preserve both shared turnout support, adjacent parallel track support, and overlap prevention', () => {
  const theme = MAP_THEMES.tactical;

  // Mainline 1 at z = 0, Turnout Branch diverging from (0, 0) to (32, 3.8),
  // PLUS a closely spaced Parallel Mainline 2 at z = 4.0m (only 2.0m away from the diverging branch in the throat!)
  const mainline1 = {
    id: 'throat_main_1',
    sourceFeatureId: 'throat_main_1',
    sourceFeatureIds: ['throat_main_1'],
    type: 'railway' as const,
    name: 'Throat Mainline 1',
    points: [
      [-10, 0],
      [40, 0],
    ] as [number, number][],
    railwayType: 'rail' as const,
    cartoLabel: 'Standard Railway',
    primaryTag: 'railway=rail',
    width: 3.5,
    gauge: 1435,
    layer: 0,
    isBridge: false,
    isTunnel: false,
    osmTags: { railway: 'rail', usage: 'main' },
  };

  const turnoutBranch = {
    ...mainline1,
    id: 'throat_turnout_branch',
    sourceFeatureId: 'throat_turnout_branch',
    sourceFeatureIds: ['throat_turnout_branch'],
    name: 'Throat Turnout Branch',
    points: [
      [0, 0],
      [8, 0.75],
      [16, 1.85],
      [24, 2.30],
      [32, 2.30],
      [40, 2.30],
    ] as [number, number][],
    osmTags: { railway: 'rail', usage: 'branch', service: 'siding' },
  };

  const mainline2Close = {
    ...mainline1,
    id: 'throat_main_2_close',
    sourceFeatureId: 'throat_main_2_close',
    sourceFeatureIds: ['throat_main_2_close'],
    name: 'Throat Adjacent Parallel Mainline 2',
    points: [
      [-10, 4.35],
      [40, 4.35],
    ] as [number, number][],
    osmTags: { railway: 'rail', usage: 'branch', service: 'yard' },
  };

  const res = buildRailwayPrototypeGroup(
    {
      roads: [],
      buildings: [],
      parks: [],
      landuse: [],
      railways: [mainline1, turnoutBranch, mainline2Close],
    } as any,
    theme,
    'candidateB',
    8.0
  );

  // 1. Legitimate shared turnout bearers must be generated in the switch throat (0 <= x <= 22)
  const sharedBearers = res.sleeperBoxes3D.filter(
    (b) => b.isTurnoutBearer && b.supportedTrackIds?.includes('throat_turnout_branch')
  );
  assert.ok(
    sharedBearers.length >= 6,
    `Turnout throat must generate >= 6 shared turnout bearers explicitly supporting throat_turnout_branch, got ${sharedBearers.length}`
  );

  // 2. Once the turnout branch levels out into a parallel siding at z = 2.30m (24 <= x <= 40),
  // it must transition smoothly to its own independent sleepers without transition gaps
  const branchOwnSleepers = res.sleeperBoxes3D.filter(
    (b) => b.trackId === 'throat_turnout_branch'
  );
  assert.ok(
    branchOwnSleepers.length >= 18,
    `Turnout branch must place its own sleepers after diverging/leveling out, got ${branchOwnSleepers.length}`
  );

  // 3. Every rail of all 3 tracks (Mainline 1, Turnout Branch, and closely spaced Mainline 2 at z=4.35m)
  // must have continuous structural sleeper support across the entire throat and transition zone
  for (const t of [mainline1, turnoutBranch, mainline2Close]) {
    const sup = evaluateStructuralSupportPerRail(t, res.sleeperBoxes3D, false);
    assert.ok(
      sup.leftMaxGapMeters <= 1.25 && sup.rightMaxGapMeters <= 1.25,
      `Rail on ${t.id} lost sleeper support: L maxGap=${sup.leftMaxGapMeters.toFixed(3)}m, R maxGap=${sup.rightMaxGapMeters.toFixed(3)}m`
    );
  }

  // 4. Mainline 2 (at z = 4.35m, 2.05m from the leveled-out branch at z = 2.30m) must retain its own sleepers
  const main2Own = evaluateStructuralSupportPerRail(mainline2Close, res.sleeperBoxes3D, true);
  assert.ok(
    main2Own.ownSleeperCount >= 65 &&
      main2Own.leftMaxGapMeters <= 0.85 &&
      main2Own.rightMaxGapMeters <= 0.85,
    `Adjacent Mainline 2 must retain its own sleepers along its entire length (count=${main2Own.ownSleeperCount}, L=${main2Own.leftMaxGapMeters.toFixed(3)}m, R=${main2Own.rightMaxGapMeters.toFixed(3)}m)`
  );

  // 5. Overlap prevention: 0 inter-track 2D OBB overlaps across the entire 3-track turnout + parallel throat
  let overlaps = 0;
  for (let i = 0; i < res.sleeperBoxes3D.length; i++) {
    for (let j = i + 1; j < res.sleeperBoxes3D.length; j++) {
      if (res.sleeperBoxes3D[i].trackId === res.sleeperBoxes3D[j].trackId) continue;
      if (doSleeperBoxesOverlap2D(res.sleeperBoxes3D[i], res.sleeperBoxes3D[j], 0.02)) {
        overlaps++;
      }
    }
  }
  assert.equal(overlaps, 0, `Expected 0 inter-track sleeper overlaps, found ${overlaps}`);

  res.dispose();
});




