import * as fs from 'node:fs';
import * as path from 'node:path';
import { LocalGeoJsonProvider } from '../src/world/LocalGeoJsonProvider';
import { MAP_THEMES } from '../src/styles/mapThemes';
import {
  GeometryBuilder,
  GraphRoadGenerationTiming,
  GraphRoadRenderStats,
  prepareInfrastructureRenderPreview,
  RoadInfrastructureRenderSource,
  validateSurfaceFirstRoadGeometry,
} from '../src/world/GeometryBuilder';
import { ProcessedMapData, RoadClass, RoadFeature } from '../src/types/MapFeature';

const ROOT_DIR = process.cwd();

interface BenchmarkDatasetSpec {
  id: string;
  name: string;
  category: 'repro-fixture' | 'real-world-extract' | 'stress-grid';
  data: ProcessedMapData;
}

const NIEUWSTRAAT_PEDESTRIAN_REPRO = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'way/26735174',
      properties: {
        '@id': 'way/26735174',
        highway: 'pedestrian',
        name: 'Nieuwstraat',
        surface: 'paving_stones',
        _nodeIds: ['1391936373', '1635870960', '275382745'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7932592, 52.2636319],
          [6.7934505, 52.2635675],
          [6.7939619, 52.2633902],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'way/475447189',
      properties: {
        '@id': 'way/475447189',
        highway: 'pedestrian',
        name: 'Stationsplein',
        surface: 'paving_stones',
        _nodeIds: [
          '275382745',
          '4691916888',
          '1635870939',
          '4691916890',
          '4691916891',
          '5126458735',
        ],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7939619, 52.2633902],
          [6.7939441, 52.2633661],
          [6.7939278, 52.2633441],
          [6.7938847, 52.2632888],
          [6.7938605, 52.2632591],
          [6.7937146, 52.2630512],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'way/527651153',
      properties: {
        '@id': 'way/527651153',
        highway: 'pedestrian',
        lit: 'yes',
        name: 'Nieuwstraat',
        surface: 'paving_stones',
        _nodeIds: ['275382745', '275382625'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7939619, 52.2633902],
          [6.7940798, 52.2633491],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'way/26735179',
      properties: {
        '@id': 'way/26735179',
        highway: 'cycleway',
        _nodeIds: ['292954791', '5126458735'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7937878, 52.2629393],
          [6.7937146, 52.2630512],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'way/527651149',
      properties: {
        '@id': 'way/527651149',
        highway: 'cycleway',
        _nodeIds: ['5126458735', '4691916889', '275382625'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7937146, 52.2630512],
          [6.7939543, 52.2632609],
          [6.7940798, 52.2633491],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'way/527651154',
      properties: {
        '@id': 'way/527651154',
        highway: 'pedestrian',
        _nodeIds: ['275382625', '275382464'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7940798, 52.2633491],
          [6.7944019, 52.2632319],
        ],
      },
    },
  ],
};

const HENGELO_PIZZA_SLICE_CORNERS_REPRO = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'way/352527579',
      properties: {
        '@id': 'way/352527579',
        highway: 'footway',
        footway: 'sidewalk',
        _nodeIds: ['3582509666', '3582509657', '5126458731', '3582509648'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7935568, 52.2630339],
          [6.7935675, 52.2630222],
          [6.7936163, 52.2629699],
          [6.7936226, 52.2629632],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'way/527651145',
      properties: {
        '@id': 'way/527651145',
        highway: 'footway',
        footway: 'crossing',
        _nodeIds: ['5126458733', '5126458732', '5126458731'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7937005, 52.2629972],
          [6.7936624, 52.2629848],
          [6.7936163, 52.2629699],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'way/1184231072',
      properties: {
        '@id': 'way/1184231072',
        highway: 'footway',
        _nodeIds: ['5126458731', '10996873170'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7936163, 52.2629699],
          [6.7935304, 52.2629437],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'way/527651146',
      properties: {
        '@id': 'way/527651146',
        highway: 'cycleway',
        _nodeIds: ['5126458730', '5126458732', '5126458734'],
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.7936818, 52.2629584],
          [6.7936624, 52.2629848],
          [6.7936402, 52.2630148],
        ],
      },
    },
  ],
};

interface ResearchSiteMetadata {
  site: string;
  city: string;
  label: string;
  center_lonlat: [number, number];
  osm_context_ids: string[];
}

function filterGeoJsonByOsmContextIds(geoJson: any, osmContextIds: string[]) {
  const idSet = new Set(osmContextIds);
  const features = (geoJson.features || []).filter((f: any) => {
    const id = f.id ?? f.properties?.['@id'];
    return typeof id === 'string' && idSet.has(id);
  });
  return {
    type: 'FeatureCollection',
    features,
  };
}

function countRoadsGroupTriangles(roadsGroup: any): number {
  let triangles = 0;
  roadsGroup.traverse((obj: any) => {
    if (!obj.isMesh || !obj.geometry) return;
    const geom = obj.geometry;
    if (geom.index) {
      triangles += Math.floor(geom.index.count / 3);
    } else if (geom.attributes?.position) {
      triangles += Math.floor(geom.attributes.position.count / 3);
    }
  });
  return triangles;
}

function buildDenseUrbanGrid270Dataset(): ProcessedMapData {
  const roads: RoadFeature[] = [];
  const cols = 10;
  const rows = 9;
  const spacing = 28;

  // Horizontal vehicular ways
  for (let r = 0; r < rows; r++) {
    const z = (r - 4) * spacing;
    const roadClass: RoadClass =
      r % 4 === 0 ? 'primary' : r % 2 === 0 ? 'secondary' : 'residential';
    const width = roadClass === 'primary' ? 10.5 : roadClass === 'secondary' ? 8.0 : 6.5;
    for (let c = 0; c < cols - 1; c++) {
      const x0 = (c - 4.5) * spacing;
      const x1 = (c - 3.5) * spacing;
      roads.push({
        id: `way/h-${r}-${c}`,
        sourceFeatureId: `way/h-${r}-${c}`,
        type: 'road',
        roadClass,
        width,
        points: [
          [x0, z],
          [x1, z],
        ],
        nodeIds: [`gn-${r}-${c}`, `gn-${r}-${c + 1}`],
        name: `Row ${r} Street ${c}`,
        layer: 0,
        isBridge: false,
        isTunnel: false,
        osmTags: { highway: roadClass, name: `Row ${r} Street ${c}` },
      });
    }
  }

  // Vertical vehicular ways
  for (let c = 0; c < cols; c++) {
    const x = (c - 4.5) * spacing;
    const roadClass: RoadClass =
      c % 4 === 0 ? 'secondary' : c % 2 === 0 ? 'tertiary' : 'residential';
    const width = roadClass === 'secondary' ? 8.5 : roadClass === 'tertiary' ? 7.0 : 6.0;
    for (let r = 0; r < rows - 1; r++) {
      const z0 = (r - 4) * spacing;
      const z1 = (r - 3) * spacing;
      roads.push({
        id: `way/v-${c}-${r}`,
        sourceFeatureId: `way/v-${c}-${r}`,
        type: 'road',
        roadClass,
        width,
        points: [
          [x, z0],
          [x, z1],
        ],
        nodeIds: [`gn-${r}-${c}`, `gn-${r + 1}-${c}`],
        name: `Col ${c} Ave ${r}`,
        layer: 0,
        isBridge: false,
        isTunnel: false,
        osmTags: { highway: roadClass, name: `Col ${c} Ave ${r}` },
      });
    }
  }

  // Diagonal cycleways and footways
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      if ((r + c) % 2 !== 0) continue;
      const x0 = (c - 4.5) * spacing;
      const z0 = (r - 4) * spacing;
      const x1 = (c - 3.5) * spacing;
      const z1 = (r - 3) * spacing;
      const isCycle = (r + c) % 4 === 0;
      const roadClass: RoadClass = isCycle ? 'cycleway' : 'footway';
      roads.push({
        id: `way/diag-${r}-${c}`,
        sourceFeatureId: `way/diag-${r}-${c}`,
        type: 'road',
        roadClass,
        width: isCycle ? 2.5 : 1.8,
        points: [
          [x0, z0],
          [x1, z1],
        ],
        nodeIds: [`gn-${r}-${c}`, `gn-${r + 1}-${c + 1}`],
        name: `Diag Path ${r}-${c}`,
        layer: 0,
        isBridge: false,
        isTunnel: false,
        osmTags: { highway: roadClass },
      });
    }
  }

  const roadParts = roads.map((r) => ({
    id: `${r.id}-0`,
    sourceFeatureId: r.sourceFeatureId ?? r.id,
    hasExplicitSourceId: true,
    partIndex: 0,
    roadClass: r.roadClass,
    points: r.points.map((pt) => [pt[0], pt[1]] as [number, number]),
    rawOsmNodeIds: (r.nodeIds ?? []).map((nid) => String(nid)),
    width: r.width,
    layer: r.layer ?? 0,
    isBridge: r.isBridge ?? false,
    isTunnel: r.isTunnel ?? false,
    isCulvert: false,
    name: r.name,
    clippedAtStart: false,
    clippedAtEnd: false,
    osmTags: r.osmTags ?? { highway: r.roadClass },
  }));

  return {
    buildings: [],
    roads,
    waterBodies: [],
    water: [],
    linearWaterways: [],
    parks: [],
    railways: [],
    landuse: [],
    barriers: [],
    landmarks: [],
    bounds: {
      minX: -200,
      maxX: 200,
      minZ: -200,
      maxZ: 200,
      widthMeters: 400,
      depthMeters: 400,
    },
    centerLonLat: [6.795, 52.26],
    regionName: 'Dense-Urban-Grid-270-Ways',
    topologySource: {
      roadParts,
      railwayParts: [],
      infrastructurePoints: [],
    },
    diagnostics: {
      sourceFeaturesReceived: roads.length,
      sourceFeaturesClassified: roads.length,
      totalFeaturesParsed: roads.length,
      sourceFeaturesRendered: 0,
      constructedMeshesCount: 0,
      totalFeaturesReceived: roads.length,
      totalFeaturesRendered: 0,
      parsedByCategory: {
        buildings: 0,
        roads: roads.length,
        waterBodies: 0,
        linearWaterways: 0,
        parks: 0,
        railways: 0,
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
        LineString: roads.length,
        MultiLineString: 0,
        Polygon: 0,
        MultiPolygon: 0,
        GeometryCollection: 0,
        Unknown: 0,
      },
      cartoSubtypesCount: {},
      featuresFullySubtracted: { count: 0, sampleIds: [] },
      clippingFailures: { count: 0, sampleIds: [] },
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
  };
}

function loadBenchmarkDatasets(): BenchmarkDatasetSpec[] {
  const provider = new LocalGeoJsonProvider();
  const datasets: BenchmarkDatasetSpec[] = [];

  const prinsForkRaw = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'src/world/prototype/PrinsHendrikkadeForkFixture.json'), 'utf8')
  );
  const prinsForkJson = prinsForkRaw.geoJson ?? prinsForkRaw;
  const veloursSplitRaw = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'src/world/prototype/VeloursstraatSplitFixture.json'), 'utf8')
  );
  const veloursSplitJson = veloursSplitRaw.geoJson ?? veloursSplitRaw;
  const parallelwegSplitRaw = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'src/world/prototype/ParallelwegSplitFixture.json'), 'utf8')
  );
  const parallelwegSplitJson = parallelwegSplitRaw.geoJson ?? parallelwegSplitRaw;

  datasets.push({
    id: 'repro-nieuwstraat',
    name: 'Hengelo Nieuwstraat–Stationsplein (Pedestrian/Cycleway)',
    category: 'repro-fixture',
    data: provider.parseGeoJson(NIEUWSTRAAT_PEDESTRIAN_REPRO, 'repro-nieuwstraat'),
  });
  datasets.push({
    id: 'repro-hengelo-corners',
    name: 'Hengelo Closely Spaced Path Corners',
    category: 'repro-fixture',
    data: provider.parseGeoJson(HENGELO_PIZZA_SLICE_CORNERS_REPRO, 'repro-hengelo-corners'),
  });
  datasets.push({
    id: 'repro-prins-hendrikkade-fork',
    name: 'Amsterdam Prins Hendrikkade Acute Fork',
    category: 'repro-fixture',
    data: provider.parseGeoJson(prinsForkJson, 'repro-prins-hendrikkade-fork'),
  });
  datasets.push({
    id: 'repro-veloursstraat-split',
    name: 'Hengelo Veloursstraat Carriageway Split',
    category: 'repro-fixture',
    data: provider.parseGeoJson(veloursSplitJson, 'repro-veloursstraat-split'),
  });
  datasets.push({
    id: 'repro-parallelweg-4arm',
    name: 'Parallelweg 4-Arm Junction Split',
    category: 'repro-fixture',
    data: provider.parseGeoJson(parallelwegSplitJson, 'repro-parallelweg-4arm'),
  });

  // Load real-world OSM extracts from research archives
  const pilotGeoJson = JSON.parse(
    fs.readFileSync(
      path.join(ROOT_DIR, 'research/road-surface-reconstruction/baseline_archive/pilot_osm.geojson'),
      'utf8'
    )
  );
  const pilotSitesRaw = JSON.parse(
    fs.readFileSync(
      path.join(ROOT_DIR, 'research/road-surface-reconstruction/baseline_archive/pilot_sites.json'),
      'utf8'
    )
  );
  const pilotSites = (Array.isArray(pilotSitesRaw) ? pilotSitesRaw : pilotSitesRaw.sites) as ResearchSiteMetadata[];

  const holdoutGeoJson = JSON.parse(
    fs.readFileSync(
      path.join(ROOT_DIR, 'research/road-surface-reconstruction/holdout_data/holdout_osm.geojson'),
      'utf8'
    )
  );
  const holdoutSitesRaw = JSON.parse(
    fs.readFileSync(
      path.join(ROOT_DIR, 'research/road-surface-reconstruction/holdout_data/holdout_sites.json'),
      'utf8'
    )
  );
  const holdoutSites = (Array.isArray(holdoutSitesRaw) ? holdoutSitesRaw : holdoutSitesRaw.sites) as ResearchSiteMetadata[];

  const selectedRealSites = [
    { source: holdoutGeoJson, site: holdoutSites.find((s) => s.site === 'H06')! }, // Hengelo
    { source: pilotGeoJson, site: pilotSites.find((s) => s.site === 'A02')! }, // Amsterdam Centraal
    { source: pilotGeoJson, site: pilotSites.find((s) => s.site === 'A01')! }, // Amsterdam Rozengracht
    { source: pilotGeoJson, site: pilotSites.find((s) => s.site === 'A05')! }, // Amsterdam Overtoom
    { source: holdoutGeoJson, site: holdoutSites.find((s) => s.site === 'H01')! }, // Utrecht Vredenburg
    { source: holdoutGeoJson, site: holdoutSites.find((s) => s.site === 'H02')! }, // Rotterdam Coolsingel
  ];

  for (const { source, site } of selectedRealSites) {
    if (!site) continue;
    const subset = filterGeoJsonByOsmContextIds(source, site.osm_context_ids);
    if (subset.features.length > 0) {
      datasets.push({
        id: site.site,
        name: site.label,
        category: 'real-world-extract',
        data: provider.parseGeoJson(subset, site.label, site.center_lonlat, 160),
      });
    }
  }

  datasets.push({
    id: 'stress-urban-grid-270',
    name: 'Dense Urban Mixed Grid (209 Vehicular/Path Ways)',
    category: 'stress-grid',
    data: buildDenseUrbanGrid270Dataset(),
  });

  return datasets;
}

function summarizeSamples(samples: number[]) {
  if (samples.length === 0) {
    return { median: 0, min: 0, max: 0, p95: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
  const p95Idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95));
  return {
    median: Number(median.toFixed(3)),
    min: Number(sorted[0].toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
    p95: Number(sorted[p95Idx].toFixed(3)),
  };
}

function runBaseline() {
  const datasets = loadBenchmarkDatasets();
  const modes: RoadInfrastructureRenderSource[] = ['legacy', 'graph', 'graph-surface'];
  const warmupRuns = 2;
  const measuredRuns = 7;

  const results: any[] = [];

  for (const ds of datasets) {
    for (const mode of modes) {
      const renderOptions = {
        roads: mode,
        railways: 'legacy' as const,
      };

      // Warm-up runs
      for (let w = 0; w < warmupRuns; w++) {
        const clonedData: ProcessedMapData = JSON.parse(JSON.stringify(ds.data));
        const preview = prepareInfrastructureRenderPreview(clonedData, renderOptions);
        const builder = new GeometryBuilder({
          roadWidthMultiplier: 1.0,
          infrastructureRenderOptions: renderOptions,
          infrastructureRenderPreview: preview,
        });
        const warmScene = builder.buildScene(clonedData, MAP_THEMES.tactical);
        warmScene.dispose();
      }

      const sceneBuildSamples: number[] = [];
      const graphBuildSamples: number[] = [];
      const adapterBuildSamples: number[] = [];
      const roadTotalSamples: number[] = [];
      const footprintSamples: number[] = [];
      const unionSamples: number[] = [];
      const clipSamples: number[] = [];
      const triSamples: number[] = [];

      let finalStats: GraphRoadRenderStats | null = null;
      let finalRoadGroupTriangles = 0;
      let finalSceneTriangles = 0;
      let finalSceneVertices = 0;
      let finalValidation: any = null;

      for (let i = 0; i < measuredRuns; i++) {
        const clonedData: ProcessedMapData = JSON.parse(JSON.stringify(ds.data));
        const preview = prepareInfrastructureRenderPreview(clonedData, renderOptions);
        const builder = new GeometryBuilder({
          roadWidthMultiplier: 1.0,
          infrastructureRenderOptions: renderOptions,
          infrastructureRenderPreview: preview,
        });
        const t0 = performance.now();
        const scene = builder.buildScene(clonedData, MAP_THEMES.tactical);
        const sceneElapsed = performance.now() - t0;
        sceneBuildSamples.push(sceneElapsed);

        const previewTiming = scene.infrastructureRenderPreview?.timing;
        if (previewTiming) {
          graphBuildSamples.push(previewTiming.graphBuildTimeMs);
          adapterBuildSamples.push(previewTiming.adapterBuildTimeMs);
        }

        const rTiming = scene.roadsGroup.userData?.graphRoadTiming as
          | GraphRoadGenerationTiming
          | undefined;
        if (rTiming) {
          roadTotalSamples.push(rTiming.totalRoadGenerationTimeMs);
          footprintSamples.push(rTiming.footprintConstructionTimeMs);
          unionSamples.push(rTiming.polygonUnionTimeMs);
          clipSamples.push(rTiming.ownershipClippingTimeMs);
          triSamples.push(rTiming.triangulationAndValidationTimeMs);
        }

        if (i === measuredRuns - 1) {
          finalStats = (scene.roadsGroup.userData?.graphRoadStats as GraphRoadRenderStats) ?? null;
          finalRoadGroupTriangles = countRoadsGroupTriangles(scene.roadsGroup);
          finalSceneTriangles = scene.stats.totalTriangles;
          finalSceneVertices = scene.stats.totalVertices;
          finalValidation = validateSurfaceFirstRoadGeometry(scene, clonedData);
        }

        scene.dispose();
      }

      results.push({
        datasetId: ds.id,
        datasetName: ds.name,
        category: ds.category,
        inputRoadFeatures: ds.data.roads.length,
        rendererMode: mode,
        timingMs: {
          sceneBuild: summarizeSamples(sceneBuildSamples),
          graphBuild: summarizeSamples(graphBuildSamples),
          adapterBuild: summarizeSamples(adapterBuildSamples),
          roadGenerationTotal: summarizeSamples(roadTotalSamples),
          footprintConstruction: summarizeSamples(footprintSamples),
          polygonUnion: summarizeSamples(unionSamples),
          ownershipClipping: summarizeSamples(clipSamples),
          triangulationAndValidation: summarizeSamples(triSamples),
        },
        counters: finalStats,
        roadGroupTriangles: finalRoadGroupTriangles,
        sceneStats: {
          vertices: finalSceneVertices,
          triangles: finalSceneTriangles,
        },
        integrity: {
          valid: finalValidation.valid,
          networkCoverageRatio: Number(
            finalValidation.coverage.networkCoverageRatio.toFixed(4)
          ),
          independentExpectedUnionAreaM2: Number(
            finalValidation.coverage.independentExpectedUnionAreaM2.toFixed(2)
          ),
          emittedAtGradeUnionAreaM2: Number(
            finalValidation.coverage.emittedAtGradeUnionAreaM2.toFixed(2)
          ),
          unexplainedMissingAreaM2: Number(
            finalValidation.coverage.unexplainedNetworkMissingAreaM2.toFixed(3)
          ),
          coverageDefectCount: finalValidation.coverage.defects.length,
          coverageDefectsByKind: finalValidation.coverage.defects.reduce(
            (acc: Record<string, number>, d: any) => {
              acc[d.kind] = (acc[d.kind] || 0) + 1;
              return acc;
            },
            {}
          ),
          coverageDefectSamples: finalValidation.coverage.defects.slice(0, 5),
          coplanarOverlapCount: finalValidation.overlaps.totalPositiveAreaOverlapCount,
          coplanarOverlapAreaM2: Number(finalValidation.overlaps.totalOverlapAreaM2.toFixed(4)),
          overlapsByCategory: finalValidation.overlaps.byCategory,
          windingDefectCount:
            finalValidation.meshIntegrity.auditReport.windingDefects.length,
          degenerateTriangleCount:
            finalValidation.meshIntegrity.auditReport.degenerateTriangles.length,
          inconsistentElevationCount:
            finalValidation.meshIntegrity.inconsistentElevationDefectCount,
          tinyFragmentCount: finalValidation.meshIntegrity.tinyDisconnectedFragmentCount,
          provenanceDefectCount: finalValidation.provenance.defects.length,
          provenanceDefectSamples: finalValidation.provenance.defects.slice(0, 5),
        },
      });
    }
  }

  const outputPayload = {
    benchmarkSuite: 'E2+ Surface-First Road Rendering Geometry Integrity & Performance Baseline',
    generatedAt: new Date().toISOString(),
    methodology: {
      warmupRuns,
      measuredRuns,
      rendererModes: modes,
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    results,
  };

  const outPath = path.join(
    ROOT_DIR,
    'research/surface-first-road-rendering/baseline-results.json'
  );
  fs.writeFileSync(outPath, JSON.stringify(outputPayload, null, 2), 'utf8');

  console.log(`\nSaved baseline results to ${outPath}\n`);
  console.log(
    '| Dataset | Mode | Ways | Road Gen Med (ms) | Buffer/Union (ms) | Clip (ms) | Tri (ms) | Unions/Diffs | Road Tris | Overlaps | Winding/Deg | Cov Ratio | Cov Defects |'
  );
  console.log(
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
  );
  for (const r of results) {
    const roadGen =
      r.rendererMode === 'legacy'
        ? `${r.timingMs.sceneBuild.median.toFixed(2)} (scene)`
        : r.timingMs.roadGenerationTotal.median.toFixed(2);
    const bufUnion =
      r.rendererMode === 'graph-surface'
        ? `${r.timingMs.footprintConstruction.median.toFixed(2)} / ${r.timingMs.polygonUnion.median.toFixed(2)}`
        : '—';
    const clip =
      r.rendererMode !== 'legacy' ? r.timingMs.ownershipClipping.median.toFixed(2) : '—';
    const tri =
      r.rendererMode !== 'legacy'
        ? r.timingMs.triangulationAndValidation.median.toFixed(2)
        : '—';
    const ops = r.counters
      ? `${r.counters.polygonUnionOperationCount}/${r.counters.polygonDifferenceOperationCount}`
      : '—';
    const tris = r.counters ? r.counters.outputTriangleCount : r.roadGroupTriangles;
    const ov = `${r.integrity.coplanarOverlapCount} (${r.integrity.coplanarOverlapAreaM2}m²)`;
    const windDeg = `${r.integrity.windingDefectCount}/${r.integrity.degenerateTriangleCount}`;
    const covRatio =
      r.rendererMode !== 'legacy'
        ? `${(r.integrity.networkCoverageRatio * 100).toFixed(1)}%`
        : '—';
    const covDef =
      r.rendererMode !== 'legacy'
        ? `${r.integrity.coverageDefectCount} ${JSON.stringify(r.integrity.coverageDefectsByKind)}`
        : '—';
    console.log(
      `| ${r.datasetId} | \`${r.rendererMode}\` | ${r.inputRoadFeatures} | ${roadGen} | ${bufUnion} | ${clip} | ${tri} | ${ops} | ${tris} | ${ov} | ${windDeg} | ${covRatio} | ${covDef} |`
    );
  }
}

runBaseline();
