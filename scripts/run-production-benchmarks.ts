import fs from 'node:fs';
import path from 'node:path';
import { createRailwayPrototypeFixtureData } from '../src/world/prototype/RailwayTestFixtures';
import { LocalGeoJsonProvider } from '../src/world/LocalGeoJsonProvider';
import { MAP_THEMES } from '../src/styles/mapThemes';
import { runCpuAndLifecycleBenchmark } from '../src/world/prototype/PerformanceBaselineHarness';

async function main() {
  console.log('=== Running Production Candidate B Benchmarks ===\n');

  // 1. Synthetic Switchyard
  const switchyardData = createRailwayPrototypeFixtureData();
  const switchyardReport = runCpuAndLifecycleBenchmark(switchyardData, MAP_THEMES.tactical, 'production', 3);

  // 2. Real Station Hengelo OSM
  const extractsPath = path.resolve('src/world/prototype/realOsmRailwayExtracts.json');
  const extracts = JSON.parse(fs.readFileSync(extractsPath, 'utf8'));

  const provider = new LocalGeoJsonProvider();
  const hengeloData = provider.parseGeoJson(
    { type: 'FeatureCollection', features: extracts.regions.hengelo.features },
    'Station Hengelo (OSM Extract)'
  );
  const hengeloReport = runCpuAndLifecycleBenchmark(hengeloData, MAP_THEMES.tactical, 'production', 3);

  // 3. Real Amsterdam Centraal OSM
  const amsterdamData = provider.parseGeoJson(
    { type: 'FeatureCollection', features: extracts.regions.amsterdamCentraal.features },
    'Amsterdam Centraal (OSM Extract)'
  );
  const amsterdamReport = runCpuAndLifecycleBenchmark(amsterdamData, MAP_THEMES.tactical, 'production', 3);

  const results = {
    switchyard: {
      totalBuildMs: switchyardReport.buildTimeMs,
      railBuildMs: switchyardReport.railwayBuildTimeMs,
      meshes: switchyardReport.constructedMeshesCount,
      totalVertices: switchyardReport.totalVertices,
      totalTriangles: switchyardReport.totalTriangles,
      railVertices: switchyardReport.railwayGroupStats.vertices,
      railTriangles: switchyardReport.railwayGroupStats.triangles,
      railCpuKB: Number((switchyardReport.railwayGroupStats.cpuBufferBytes / 1024).toFixed(1)),
      sceneCpuMB: switchyardReport.cpuBufferMB,
      leakedGeometries: switchyardReport.lifecycleAudit.netLeakedGeometriesAfterCycles,
      leakedMaterials: switchyardReport.lifecycleAudit.netLeakedMaterialsAfterCycles,
    },
    hengelo: {
      totalBuildMs: hengeloReport.buildTimeMs,
      railBuildMs: hengeloReport.railwayBuildTimeMs,
      meshes: hengeloReport.constructedMeshesCount,
      totalVertices: hengeloReport.totalVertices,
      totalTriangles: hengeloReport.totalTriangles,
      railVertices: hengeloReport.railwayGroupStats.vertices,
      railTriangles: hengeloReport.railwayGroupStats.triangles,
      railCpuKB: Number((hengeloReport.railwayGroupStats.cpuBufferBytes / 1024).toFixed(1)),
      sceneCpuMB: hengeloReport.cpuBufferMB,
      leakedGeometries: hengeloReport.lifecycleAudit.netLeakedGeometriesAfterCycles,
      leakedMaterials: hengeloReport.lifecycleAudit.netLeakedMaterialsAfterCycles,
    },
    amsterdam: {
      totalBuildMs: amsterdamReport.buildTimeMs,
      railBuildMs: amsterdamReport.railwayBuildTimeMs,
      meshes: amsterdamReport.constructedMeshesCount,
      totalVertices: amsterdamReport.totalVertices,
      totalTriangles: amsterdamReport.totalTriangles,
      railVertices: amsterdamReport.railwayGroupStats.vertices,
      railTriangles: amsterdamReport.railwayGroupStats.triangles,
      railCpuKB: Number((amsterdamReport.railwayGroupStats.cpuBufferBytes / 1024).toFixed(1)),
      sceneCpuMB: amsterdamReport.cpuBufferMB,
      leakedGeometries: amsterdamReport.lifecycleAudit.netLeakedGeometriesAfterCycles,
      leakedMaterials: amsterdamReport.lifecycleAudit.netLeakedMaterialsAfterCycles,
    },
  };

  console.table(results);
  fs.writeFileSync('docs/m2-2-production-benchmarks.json', JSON.stringify(results, null, 2));
  console.log('Saved benchmark results to docs/m2-2-production-benchmarks.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
