import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadHengeloScalingDatasets } from '../../benchmarks/scalingDatasets';
import { resolveRendererConfigs } from '../../benchmarks/scenarios';
import { MAP_THEMES } from '../styles/mapThemes';
import type { LanduseFeature, ParkFeature, ProcessedMapData, RoadFeature, WaterBodyFeature } from '../types/MapFeature';
import {
  buildGraphAtGradeRoadGeometries,
  GeometryBuilder,
  GraphRoadRenderStats,
  prepareInfrastructureRenderPreview,
} from './GeometryBuilder';
import { SceneResourceManager } from './SceneResourceManager';
import {
  computeBBoxContainmentRatio,
  isGeometricallyContained,
  resolveAndValidatePlanarPolygons,
} from './PlanarLayerValidator';

function makeRectRing(x0: number, z0: number, x1: number, z1: number): [number, number][] {
  return [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
    [x0, z0],
  ];
}

describe('TKT-020 Phase 2: Planar Surface Resolution Spatial Index & Equivalence', () => {
  it('runs Stage 4 audit by default and skips Stage 4 only when runPostResolutionAudit is false without altering resolved layers', () => {
    const { datasets } = loadHengeloScalingDatasets({
      levelsOrIds: ['S2'],
      verifyHashes: true,
    });
    const input = datasets[0].parseInput();

    const withAudit = resolveAndValidatePlanarPolygons(
      input.landuse,
      input.parks,
      input.waterBodies,
      input.linearWaterways
    );
    const withoutAudit = resolveAndValidatePlanarPolygons(
      input.landuse,
      input.parks,
      input.waterBodies,
      input.linearWaterways,
      { runPostResolutionAudit: false }
    );

    assert.equal(withAudit.report.violations.length, 3);
    assert.equal(withAudit.report.maxResidualFillOverlapSqMeters, 0.000343);
    assert.equal(withoutAudit.report.violations.length, 0);
    assert.equal(withoutAudit.report.conflictsResolved, withAudit.report.conflictsResolved);
    assert.equal(withoutAudit.report.booleanSubtractionsCount, withAudit.report.booleanSubtractionsCount);
    assert.equal(withoutAudit.resolvedById.size, withAudit.resolvedById.size);

    for (const [id, layerA] of withAudit.resolvedById.entries()) {
      const layerB = withoutAudit.resolvedById.get(id);
      assert.ok(layerB, `Missing resolved layer ${id} when runPostResolutionAudit=false`);
      assert.equal(layerB.resolvedArea, layerA.resolvedArea);
      assert.equal(layerB.topologicalRank, layerA.topologicalRank);
      assert.deepEqual(layerB.higherOverlappingIds, layerA.higherOverlappingIds);
      const shaA = crypto.createHash('sha256').update(JSON.stringify(layerA.resolvedMultiPolygon)).digest('hex');
      const shaB = crypto.createHash('sha256').update(JSON.stringify(layerB.resolvedMultiPolygon)).digest('hex');
      assert.equal(shaB, shaA);
    }
  });

  it('preserves exact Hengelo S1-S3 planar conflict resolution, topology, and violation invariants', () => {
    const expectedSummary: Record<
      string,
      {
        totalPolygons: number;
        overlappingPairsChecked: number;
        conflictsResolved: number;
        deduplicatedCount: number;
        unionedCount: number;
        booleanSubtractionsCount: number;
        violationsCount: number;
        maxResidualFillOverlapSqMeters: number;
      }
    > = {
      S1: {
        totalPolygons: 60,
        overlappingPairsChecked: 49,
        conflictsResolved: 50,
        deduplicatedCount: 0,
        unionedCount: 1,
        booleanSubtractionsCount: 13,
        violationsCount: 0,
        maxResidualFillOverlapSqMeters: 0.000088,
      },
      S2: {
        totalPolygons: 271,
        overlappingPairsChecked: 226,
        conflictsResolved: 216,
        deduplicatedCount: 0,
        unionedCount: 2,
        booleanSubtractionsCount: 54,
        violationsCount: 3,
        maxResidualFillOverlapSqMeters: 0.000343,
      },
      S3: {
        totalPolygons: 857,
        overlappingPairsChecked: 723,
        conflictsResolved: 713,
        deduplicatedCount: 1,
        unionedCount: 3,
        booleanSubtractionsCount: 134,
        violationsCount: 13,
        maxResidualFillOverlapSqMeters: 0.001259,
      },
    };

    const { datasets } = loadHengeloScalingDatasets({
      maxScale: 'S3',
      verifyHashes: false,
    });
    for (const ds of datasets) {
      const lvl = ds.descriptor.level;
      const exp = expectedSummary[lvl];
      const input = ds.parseInput();
      const res = resolveAndValidatePlanarPolygons(
        input.landuse,
        input.parks,
        input.waterBodies,
        input.linearWaterways
      );

      assert.equal(res.report.totalPolygons, exp.totalPolygons, `${lvl} totalPolygons`);
      assert.equal(res.report.overlappingPairsChecked, exp.overlappingPairsChecked, `${lvl} overlappingPairsChecked`);
      assert.equal(res.report.conflictsResolved, exp.conflictsResolved, `${lvl} conflictsResolved`);
      assert.equal(res.report.deduplicatedCount, exp.deduplicatedCount, `${lvl} deduplicatedCount`);
      assert.equal(res.report.unionedCount, exp.unionedCount, `${lvl} unionedCount`);
      assert.equal(res.report.booleanSubtractionsCount, exp.booleanSubtractionsCount, `${lvl} booleanSubtractionsCount`);
      assert.equal(res.report.violations.length, exp.violationsCount, `${lvl} violationsCount`);
      assert.equal(
        res.report.maxResidualFillOverlapSqMeters,
        exp.maxResidualFillOverlapSqMeters,
        `${lvl} maxResidualFillOverlapSqMeters`
      );
    }
  });

  it('handles Stage 1 bbox expansion chains across 64m grid cell boundaries and oversized (>4km) polygons cleanly', () => {
    // Chain of 3 adjacent unnamed grass fragments:
    // frag-1 intersects frag-2; frag-2 intersects frag-3 which crosses multiple 64m grid cells.
    // Plus a huge >4km residential macro-landuse (>4096 cells -> oversized grid fallback).
    const parks: ParkFeature[] = [
      {
        type: 'park',
        id: 'park-frag-1',
        sourceFeatureId: 'park-frag-1',
        subtype: 'grass',
        polygon: [makeRectRing(0, 0, 40, 20)],
      },
      {
        type: 'park',
        id: 'park-frag-2',
        sourceFeatureId: 'park-frag-2',
        subtype: 'grass',
        polygon: [makeRectRing(35, 0, 140, 20)],
      },
      {
        type: 'park',
        id: 'park-frag-3',
        sourceFeatureId: 'park-frag-3',
        subtype: 'grass',
        polygon: [makeRectRing(135, 0, 210, 20)],
      },
    ];

    const landuse: LanduseFeature[] = [
      {
        type: 'landuse',
        id: 'macro-huge',
        sourceFeatureId: 'macro-huge',
        landuseType: 'residential',
        polygon: [makeRectRing(-2500, -2500, 2500, 2500)],
      },
    ];

    const water: WaterBodyFeature[] = [
      {
        type: 'water',
        id: 'canal-basin',
        sourceFeatureId: 'canal-basin',
        waterType: 'water',
        polygon: [makeRectRing(50, 5, 80, 15)],
      },
    ];

    const res = resolveAndValidatePlanarPolygons(landuse, parks, water, []);
    assert.equal(res.report.isValid, true);
    assert.equal(res.report.unionedCount, 2);

    const merged = res.resolvedById.get('park-frag-1')!;
    assert.equal(merged.sourceFeatureIds.length, 3);
    assert.equal(res.resolvedById.get('park-frag-2')?.isDeduplicatedInto, 'park-frag-1');
    assert.equal(res.resolvedById.get('park-frag-3')?.isDeduplicatedInto, 'park-frag-1');
    assert.ok(merged.higherOverlappingIds.includes('canal-basin'));

    // Macro landuse must subtract the merged park & water without residual overlap
    const macro = res.resolvedById.get('macro-huge')!;
    assert.ok(macro.higherOverlappingIds.includes('park-frag-1'));
    assert.ok(macro.higherOverlappingIds.includes('canal-basin'));

    // Verify containment & bbox ratio helper consistency
    const inner = [ [ makeRectRing(50, 5, 80, 15) ] ];
    const outer = [ [ makeRectRing(0, 0, 210, 20) ] ];
    assert.equal(isGeometricallyContained(inner, outer), true);
    assert.equal(
      computeBBoxContainmentRatio(
        { minX: 50, maxX: 80, minZ: 5, maxZ: 15 },
        { minX: 0, maxX: 210, minZ: 0, maxZ: 20 }
      ),
      1
    );
  });
});

describe('TKT-020 Phase 3: Road Blocker Spatial Grid & Geometry Equivalence', () => {
  it('cuts S3 surface-first candidateBlockerCheckCount by >= 98% while preserving exact blocker/polygon/hole/triangle metrics on S1-S3', () => {
    const { datasets } = loadHengeloScalingDatasets({
      maxScale: 'S3',
      verifyHashes: false,
    });
    const [sfCfg] = resolveRendererConfigs(['surface-first-e2plus-rplus']);

    const expectedSf: Record<
      string,
      {
        maxChecks: number;
        overlappingBlockerCount: number;
        outputPolygonCount: number;
        outputHoleRingCount: number;
        outputTriangleCount: number;
        renderedRoadRibbonCount: number;
      }
    > = {
      S1: {
        maxChecks: 3_000,
        overlappingBlockerCount: 517,
        outputPolygonCount: 183,
        outputHoleRingCount: 0,
        outputTriangleCount: 3589,
        renderedRoadRibbonCount: 174,
      },
      S2: {
        maxChecks: 15_000,
        overlappingBlockerCount: 2017,
        outputPolygonCount: 655,
        outputHoleRingCount: 2,
        outputTriangleCount: 14530,
        renderedRoadRibbonCount: 633,
      },
      S3: {
        maxChecks: 45_000,
        overlappingBlockerCount: 6525,
        outputPolygonCount: 2185,
        outputHoleRingCount: 3,
        outputTriangleCount: 47623,
        renderedRoadRibbonCount: 2112,
      },
    };

    for (const ds of datasets) {
      const lvl = ds.descriptor.level;
      const input = ds.parseInput();

      const sfPreview = prepareInfrastructureRenderPreview(input, sfCfg.infrastructureRenderOptions);
      const sfScene = new GeometryBuilder({
        infrastructureRenderOptions: sfCfg.infrastructureRenderOptions,
        infrastructureRenderPreview: sfPreview,
      }).buildScene(input, MAP_THEMES.tactical);
      const sfStats = sfScene.roadsGroup.userData.graphRoadStats as GraphRoadRenderStats;
      const exp = expectedSf[lvl];
      assert.ok(
        sfStats.candidateBlockerCheckCount <= exp.maxChecks,
        `${lvl} checks (${sfStats.candidateBlockerCheckCount}) exceeded limit (${exp.maxChecks})`
      );
      assert.equal(sfStats.overlappingBlockerCount, exp.overlappingBlockerCount, `${lvl} overlappingBlockerCount`);
      assert.equal(sfStats.outputPolygonCount, exp.outputPolygonCount, `${lvl} outputPolygonCount`);
      assert.equal(sfStats.outputHoleRingCount, exp.outputHoleRingCount, `${lvl} outputHoleRingCount`);
      assert.equal(sfStats.outputTriangleCount, exp.outputTriangleCount, `${lvl} outputTriangleCount`);
      assert.equal(sfStats.renderedRoadRibbonCount, exp.renderedRoadRibbonCount, `${lvl} renderedRoadRibbonCount`);
      sfScene.dispose();
    }
  });

  it('handles 32m grid boundaries, multi-cell spans, and oversized >4km road ribbons deterministically', () => {
    const makeRoad = (
      id: string,
      roadClass: RoadFeature['roadClass'],
      width: number,
      points: [number, number][]
    ): RoadFeature => ({
      type: 'road',
      id,
      sourceFeatureId: id,
      roadClass,
      width,
      layer: 0,
      isBridge: false,
      isTunnel: false,
      points,
    });

    // Long >4km primary arterial (triggers oversized fallback in 32m spatial grid)
    // crossed at 32m cell boundaries by a secondary road and footway.
    const roads: RoadFeature[] = [
      makeRoad('way/long-primary', 'primary', 10, [
        [-2200, 0],
        [2200, 0],
      ]),
      makeRoad('way/cross-secondary', 'secondary', 8, [
        [32, -40],
        [32, 40],
      ]),
      makeRoad('way/cross-footway', 'footway', 3, [
        [64, -40],
        [64, 40],
      ]),
    ];

    const mapData: ProcessedMapData = {
      regionName: 'road-grid-boundary-test',
      centerLonLat: [6.7935, 52.2625],
      bounds: {
        minX: -2500,
        maxX: 2500,
        minZ: -2500,
        maxZ: 2500,
        widthMeters: 5000,
        depthMeters: 5000,
      },
      roads,
      railways: [],
      buildings: [],
      waterBodies: [],
      linearWaterways: [],
      water: [],
      parks: [],
      landuse: [],
      barriers: [],
      landmarks: [],
      topologySource: {
        roadParts: roads.map((r, idx) => ({
          id: r.id,
          sourceFeatureId: r.sourceFeatureId!,
          hasExplicitSourceId: true,
          partIndex: idx,
          clippedAtStart: false,
          clippedAtEnd: false,
          roadClass: r.roadClass,
          width: r.width,
          layer: r.layer ?? 0,
          isBridge: Boolean(r.isBridge),
          isTunnel: Boolean(r.isTunnel),
          isCulvert: false,
          points: r.points,
          rawOsmNodeIds: r.points.map(() => undefined),
          osmTags: {},
        })),
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
        areaKm2: 25,
      },
      diagnostics: {
        sourceFeaturesReceived: roads.length,
        sourceFeaturesClassified: roads.length,
        totalFeaturesParsed: roads.length,
        sourceFeaturesRendered: 0,
        totalFeaturesReceived: roads.length,
        totalFeaturesRendered: 0,
        constructedMeshesCount: 0,
        parsedByCategory: {
          buildings: 0,
          roads: roads.length,
          railways: 0,
          waterBodies: 0,
          linearWaterways: 0,
          parks: 0,
          landuse: 0,
          barriers: 0,
          landmarks: 0,
        },
        geometryPartsGenerated: {
          total: roads.length,
          byCategory: {
            buildings: 0,
            roads: roads.length,
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
          LineString: roads.length,
          MultiLineString: 0,
          Polygon: 0,
          MultiPolygon: 0,
          GeometryCollection: 0,
          Unknown: 0,
        },
      },
    };

    const renderOpts = { roads: 'graph-surface' as const, railways: 'graph-R+' as const };
    const preview = prepareInfrastructureRenderPreview(mapData, renderOpts);
    assert.ok(preview.descriptors);
    const rm = new SceneResourceManager();
    const res = buildGraphAtGradeRoadGeometries({
      descriptors: preview.descriptors,
      roadWidthMultiplier: 1,
      surfaceFirst: true,
      resourceManager: rm,
    });
    assert.ok(res.stats.renderedRoadRibbonCount >= 3);
    assert.ok(res.stats.outputTriangleCount > 0);
    assert.ok(res.stats.overlappingBlockerCount >= 2);
    rm.dispose();
  });
});

