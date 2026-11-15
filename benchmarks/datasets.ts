import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProcessedMapData } from '../src/types/MapFeature';
import { LocalGeoJsonProvider } from '../src/world/LocalGeoJsonProvider';
import { createRailwayPrototypeFixtureData } from '../src/world/prototype/RailwayTestFixtures';
import { unprojectToGeo } from '../src/world/WorldCoordinates';
import { BenchmarkDatasetMetadata, BenchmarkDatasetScale } from './types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export interface LoadedBenchmarkDataset {
  metadata: BenchmarkDatasetMetadata;
  rawGeoJson: {
    type: 'FeatureCollection';
    name?: string;
    features: any[];
  };
  parseInput: () => ProcessedMapData;
  parsedData: ProcessedMapData;
}

/**
 * Computes a deterministic SHA-256 hex digest of a GeoJSON FeatureCollection payload.
 */
export function computeGeoJsonContentHash(geoJson: unknown): string {
  const canonicalJson = JSON.stringify(geoJson);
  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

/**
 * Extracts structured BenchmarkDatasetMetadata from a raw GeoJSON FeatureCollection and its
 * parsed ProcessedMapData representation.
 */
export function buildDatasetMetadata(params: {
  id: string;
  name: string;
  scale: BenchmarkDatasetScale;
  description: string;
  sourceFiles: string[];
  rawGeoJson: { type: 'FeatureCollection'; features: any[] };
  parsedData: ProcessedMapData;
  originLonLat: [number, number];
  clipRadiusMeters?: number;
}): BenchmarkDatasetMetadata {
  const {
    id,
    name,
    scale,
    description,
    sourceFiles,
    rawGeoJson,
    parsedData,
    originLonLat,
    clipRadiusMeters,
  } = params;

  const contentHashSha256 = computeGeoJsonContentHash(rawGeoJson);
  const buildings = parsedData.buildings?.length ?? 0;
  const roads = parsedData.roads?.length ?? 0;
  const railways = parsedData.railways?.length ?? 0;
  const waterBodies = parsedData.waterBodies?.length ?? 0;
  const linearWaterways = parsedData.linearWaterways?.length ?? 0;
  const parks = parsedData.parks?.length ?? 0;
  const landuse = parsedData.landuse?.length ?? 0;
  const barriers = parsedData.barriers?.length ?? 0;
  const landmarks = parsedData.landmarks?.length ?? 0;
  const total =
    buildings +
    roads +
    railways +
    waterBodies +
    linearWaterways +
    parks +
    landuse +
    barriers +
    landmarks;

  return {
    id,
    name,
    scale,
    description,
    sourceFiles,
    contentHashSha256,
    originLonLat: [originLonLat[0], originLonLat[1]],
    clipRadiusMeters,
    rawFeatureCount: Array.isArray(rawGeoJson.features) ? rawGeoJson.features.length : 0,
    parsedFeatureCounts: {
      total,
      buildings,
      roads,
      railways,
      waterBodies,
      linearWaterways,
      parks,
      landuse,
      barriers,
      landmarks,
    },
    topologySourceCounts: {
      roadParts: parsedData.topologySource?.roadParts.length ?? 0,
      railwayParts: parsedData.topologySource?.railwayParts.length ?? 0,
      infrastructurePoints: parsedData.topologySource?.infrastructurePoints.length ?? 0,
    },
  };
}

/**
 * Deterministically synthesizes a rich, multi-category stress-test GeoJSON FeatureCollection
 * combining:
 * - A 10x9 interconnected urban vehicular & cycleway/footway grid (209 ways with shared OSM node IDs,
 *   bridges, tunnels, and culverts)
 * - The 65-way M2.1 multi-zone railway switchyard (short chained segments, single turnout, scissors
 *   crossover, 4-platform station throat, railway bridges, and tunnels)
 * - 64 urban buildings (including courtyard holes), landuse zones, parks, water bodies, linear
 *   waterways, retaining walls/barriers, and point landmarks/trees.
 */
export function buildSyntheticStressGeoJson(): {
  geoJson: { type: 'FeatureCollection'; name: string; features: any[] };
  originLonLat: [number, number];
  clipRadiusMeters: number;
} {
  const originLonLat: [number, number] = [6.7935, 52.2625];
  const toLonLat = (xMeters: number, zMeters: number): [number, number] => {
    const [lon, lat] = unprojectToGeo(xMeters, zMeters, originLonLat[0], originLonLat[1]);
    return [Number(lon.toFixed(7)), Number(lat.toFixed(7))];
  };

  const features: any[] = [];
  const cols = 10;
  const rows = 9;
  const spacing = 28;

  // 1. Horizontal vehicular road ways
  for (let r = 0; r < rows; r++) {
    const z = (r - 4) * spacing;
    const highway = r % 4 === 0 ? 'primary' : r % 2 === 0 ? 'secondary' : 'residential';
    for (let c = 0; c < cols - 1; c++) {
      const x0 = (c - 4.5) * spacing;
      const x1 = (c - 3.5) * spacing;
      const isBridge = r === 4 && c === 4;
      const isTunnel = r === 2 && c === 3;
      const id = `way/stress-h-${r}-${c}`;
      features.push({
        type: 'Feature',
        id,
        properties: {
          '@id': id,
          highway,
          name: `Grid Row ${r} Street`,
          surface: highway === 'primary' ? 'asphalt' : 'paving_stones',
          ...(isBridge ? { bridge: 'yes', layer: '1' } : {}),
          ...(isTunnel ? { tunnel: 'yes', layer: '-1', maxheight: '4.0' } : {}),
          _nodeIds: [`node/gn-${r}-${c}`, `node/gn-${r}-${c + 1}`],
        },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(x0, z), toLonLat(x1, z)],
        },
      });
    }
  }

  // 2. Vertical vehicular road ways
  for (let c = 0; c < cols; c++) {
    const x = (c - 4.5) * spacing;
    const highway = c % 4 === 0 ? 'secondary' : c % 2 === 0 ? 'tertiary' : 'residential';
    for (let r = 0; r < rows - 1; r++) {
      const z0 = (r - 4) * spacing;
      const z1 = (r - 3) * spacing;
      const id = `way/stress-v-${c}-${r}`;
      features.push({
        type: 'Feature',
        id,
        properties: {
          '@id': id,
          highway,
          name: `Grid Col ${c} Avenue`,
          surface: 'asphalt',
          _nodeIds: [`node/gn-${r}-${c}`, `node/gn-${r + 1}-${c}`],
        },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(x, z0), toLonLat(x, z1)],
        },
      });
    }
  }

  // 3. Diagonal cycleways and footways sharing grid intersection nodes
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      if ((r + c) % 2 !== 0) continue;
      const x0 = (c - 4.5) * spacing;
      const z0 = (r - 4) * spacing;
      const x1 = (c - 3.5) * spacing;
      const z1 = (r - 3) * spacing;
      const isCycle = (r + c) % 4 === 0;
      const highway = isCycle ? 'cycleway' : 'footway';
      const id = `way/stress-diag-${r}-${c}`;
      features.push({
        type: 'Feature',
        id,
        properties: {
          '@id': id,
          highway,
          surface: isCycle ? 'asphalt' : 'paving_stones',
          _nodeIds: [`node/gn-${r}-${c}`, `node/gn-${r + 1}-${c + 1}`],
        },
        geometry: {
          type: 'LineString',
          coordinates: [toLonLat(x0, z0), toLonLat(x1, z1)],
        },
      });
    }
  }

  // 4. Multi-zone railway switchyard ways from M2.1 fixture
  const switchyardData = createRailwayPrototypeFixtureData();
  for (const rail of switchyardData.railways) {
    if (!rail.points || rail.points.length < 2) continue;
    const coords = rail.points.map(([x, z]) => toLonLat(x, z));
    const nodeIds =
      rail.nodeIds && rail.nodeIds.length === rail.points.length
        ? rail.nodeIds
        : rail.points.map(([x, z]) => `node/rail_${Math.round(x * 10)}_${Math.round(z * 10)}`);
    const id = `way/${rail.id}`;
    features.push({
      type: 'Feature',
      id,
      properties: {
        '@id': id,
        railway: rail.railwayType || 'rail',
        name: rail.name || rail.id,
        gauge: String(rail.gauge || 1435),
        electrified: 'contact_line',
        ...(rail.isBridge ? { bridge: 'yes', layer: String(Math.max(1, rail.layer || 1)) } : {}),
        ...(rail.isTunnel ? { tunnel: 'yes', layer: String(Math.min(-1, rail.layer || -1)) } : {}),
        ...(rail.osmTags || {}),
        _nodeIds: nodeIds,
      },
      geometry: {
        type: 'LineString',
        coordinates: coords,
      },
    });
  }

  // 5. Urban buildings inside city blocks (including courtyard buildings)
  let bCount = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      if ((r + c) % 2 === 0) continue;
      bCount++;
      const cx = (c - 4.0) * spacing;
      const cz = (r - 3.5) * spacing;
      const halfW = 7.5;
      const halfD = 6.5;
      const outerRing = [
        toLonLat(cx - halfW, cz - halfD),
        toLonLat(cx + halfW, cz - halfD),
        toLonLat(cx + halfW, cz + halfD),
        toLonLat(cx - halfW, cz + halfD),
        toLonLat(cx - halfW, cz - halfD),
      ];
      const rings: any[] = [outerRing];
      if (bCount % 5 === 0) {
        const holeW = 2.8;
        const holeD = 2.4;
        rings.push([
          toLonLat(cx - holeW, cz - holeD),
          toLonLat(cx - holeW, cz + holeD),
          toLonLat(cx + holeW, cz + holeD),
          toLonLat(cx + holeW, cz - holeD),
          toLonLat(cx - holeW, cz - holeD),
        ]);
      }
      const id = `way/stress-bldg-${bCount}`;
      features.push({
        type: 'Feature',
        id,
        properties: {
          '@id': id,
          building: bCount % 3 === 0 ? 'commercial' : 'apartments',
          'building:levels': String(3 + (bCount % 5)),
          height: String(10 + (bCount % 5) * 3.5),
          name: `Block ${r}-${c} Building`,
        },
        geometry: {
          type: 'Polygon',
          coordinates: rings,
        },
      });
    }
  }

  // 6. Parks, Landuse, Water Bodies, Linear Waterways, Barriers, and Landmarks
  features.push({
    type: 'Feature',
    id: 'way/stress-park-1',
    properties: {
      '@id': 'way/stress-park-1',
      leisure: 'park',
      name: 'Central Benchmark Park',
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          toLonLat(-190, 125),
          toLonLat(-70, 125),
          toLonLat(-70, 195),
          toLonLat(-190, 195),
          toLonLat(-190, 125),
        ],
      ],
    },
  });

  features.push({
    type: 'Feature',
    id: 'way/stress-landuse-parking-1',
    properties: {
      '@id': 'way/stress-landuse-parking-1',
      amenity: 'parking',
      parking: 'surface',
      name: 'Station P+R Lot',
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          toLonLat(60, 125),
          toLonLat(175, 125),
          toLonLat(175, 190),
          toLonLat(60, 190),
          toLonLat(60, 125),
        ],
      ],
    },
  });

  features.push({
    type: 'Feature',
    id: 'way/stress-water-basin-1',
    properties: {
      '@id': 'way/stress-water-basin-1',
      natural: 'water',
      water: 'basin',
      name: 'Harbor Basin',
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          toLonLat(-180, -210),
          toLonLat(180, -210),
          toLonLat(180, -170),
          toLonLat(-180, -170),
          toLonLat(-180, -210),
        ],
      ],
    },
  });

  features.push({
    type: 'Feature',
    id: 'way/stress-canal-1',
    properties: {
      '@id': 'way/stress-canal-1',
      waterway: 'canal',
      width: '14',
      name: 'Benchmark Canal',
    },
    geometry: {
      type: 'LineString',
      coordinates: [toLonLat(-240, -150), toLonLat(0, -145), toLonLat(240, -150)],
    },
  });

  for (let i = 0; i < 6; i++) {
    const bx = -120 + i * 45;
    features.push({
      type: 'Feature',
      id: `way/stress-wall-${i}`,
      properties: {
        '@id': `way/stress-wall-${i}`,
        barrier: i % 2 === 0 ? 'retaining_wall' : 'hedge',
        height: '1.8',
      },
      geometry: {
        type: 'LineString',
        coordinates: [toLonLat(bx, 118), toLonLat(bx + 30, 118)],
      },
    });
  }

  for (let i = 0; i < 16; i++) {
    const tx = -175 + i * 22;
    features.push({
      type: 'Feature',
      id: `node/stress-tree-${i}`,
      properties: {
        '@id': `node/stress-tree-${i}`,
        natural: 'tree',
        height: '9',
      },
      geometry: {
        type: 'Point',
        coordinates: toLonLat(tx, 140 + (i % 3) * 14),
      },
    });
  }

  return {
    geoJson: {
      type: 'FeatureCollection',
      name: 'Synthetic Stress Benchmark (Urban Grid + 65-Way Switchyard)',
      features,
    },
    originLonLat,
    clipRadiusMeters: 480,
  };
}

function loadSmallRealWorldDataset(provider: LocalGeoJsonProvider): LoadedBenchmarkDataset {
  const relPath = 'src/world/prototype/EuropatunnelHengeloFixture.json';
  const fullPath = path.join(REPO_ROOT, relPath);
  const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const rawGeoJson = {
    type: 'FeatureCollection' as const,
    name: 'Hengelo Europatunnel & Spoorstraat (Real OSM Extract)',
    features: raw.features || [],
  };
  const originLonLat: [number, number] = [6.79225, 52.26188];
  const clipRadiusMeters = 180;

  const parseInput = () =>
    provider.parseGeoJson(
      JSON.parse(JSON.stringify(rawGeoJson)),
      rawGeoJson.name,
      originLonLat,
      clipRadiusMeters
    );

  const parsedData = parseInput();
  const metadata = buildDatasetMetadata({
    id: 'small-real-europatunnel',
    name: rawGeoJson.name,
    scale: 'small-real-world',
    description:
      'Frozen real-world OSM extract around Europatunnel / Spoorstraat in Hengelo including buildings, multi-tier roads/cycleways/footways, overhead railway tracks, and subterranean retaining walls.',
    sourceFiles: [relPath],
    rawGeoJson,
    parsedData,
    originLonLat,
    clipRadiusMeters,
  });

  return {
    metadata,
    rawGeoJson,
    parseInput,
    parsedData,
  };
}

function loadMediumRealWorldDataset(provider: LocalGeoJsonProvider): LoadedBenchmarkDataset {
  const railRelPath = 'src/world/prototype/realOsmRailwayExtracts.json';
  const holdoutRelPath = 'research/road-surface-reconstruction/holdout_data/holdout_osm.geojson';
  const holdoutSitesRelPath = 'research/road-surface-reconstruction/holdout_data/holdout_sites.json';

  const railRaw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, railRelPath), 'utf8'));
  const holdoutGeo = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, holdoutRelPath), 'utf8'));
  const holdoutSitesRaw = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, holdoutSitesRelPath), 'utf8')
  );
  const sites = Array.isArray(holdoutSitesRaw) ? holdoutSitesRaw : holdoutSitesRaw.sites;
  const h06 = sites.find((s: any) => s.site === 'H06');
  const h06Ids = new Set<string>(h06?.osm_context_ids || []);

  const roadFeatures = (holdoutGeo.features || []).filter((f: any) => {
    const id = f.id ?? f.properties?.['@id'];
    return typeof id === 'string' && h06Ids.has(id);
  });
  const railFeatures = railRaw.regions?.hengelo?.features || [];

  const seenIds = new Set<string>();
  const combinedFeatures: any[] = [];
  for (const f of [...railFeatures, ...roadFeatures]) {
    const fid = String(f.id ?? f.properties?.['@id'] ?? `feat_${combinedFeatures.length}`);
    if (seenIds.has(fid)) continue;
    seenIds.add(fid);
    combinedFeatures.push(f);
  }

  const rawGeoJson = {
    type: 'FeatureCollection' as const,
    name: 'Station Hengelo Corridor & Throat (Real OSM Extract)',
    features: combinedFeatures,
  };
  const originLonLat: [number, number] = railRaw.regions?.hengelo?.center || [6.7935, 52.2625];
  const clipRadiusMeters = 320;

  const parseInput = () =>
    provider.parseGeoJson(
      JSON.parse(JSON.stringify(rawGeoJson)),
      rawGeoJson.name,
      originLonLat,
      clipRadiusMeters
    );

  const parsedData = parseInput();
  const metadata = buildDatasetMetadata({
    id: 'medium-real-hengelo-station',
    name: rawGeoJson.name,
    scale: 'medium-real-world',
    description:
      'Frozen real-world OSM extract covering Station Hengelo railway switchyard throat (67 railway ways) and adjacent Stationsplein urban roads/cycleways.',
    sourceFiles: [railRelPath, holdoutRelPath],
    rawGeoJson,
    parsedData,
    originLonLat,
    clipRadiusMeters,
  });

  return {
    metadata,
    rawGeoJson,
    parseInput,
    parsedData,
  };
}

function loadLargeRealWorldDataset(provider: LocalGeoJsonProvider): LoadedBenchmarkDataset {
  const railRelPath = 'src/world/prototype/realOsmRailwayExtracts.json';
  const pilotRelPath = 'research/road-surface-reconstruction/baseline_archive/pilot_osm.geojson';
  const pilotSitesRelPath =
    'research/road-surface-reconstruction/baseline_archive/pilot_sites.json';

  const railRaw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, railRelPath), 'utf8'));
  const pilotGeo = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, pilotRelPath), 'utf8'));
  const pilotSitesRaw = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, pilotSitesRelPath), 'utf8')
  );
  const sites = Array.isArray(pilotSitesRaw) ? pilotSitesRaw : pilotSitesRaw.sites;
  const a02 = sites.find((s: any) => s.site === 'A02');
  const a02Ids = new Set<string>(a02?.osm_context_ids || []);

  const roadFeatures = (pilotGeo.features || []).filter((f: any) => {
    const id = f.id ?? f.properties?.['@id'];
    return typeof id === 'string' && a02Ids.has(id);
  });
  const railFeatures = railRaw.regions?.amsterdamCentraal?.features || [];

  const seenIds = new Set<string>();
  const combinedFeatures: any[] = [];
  for (const f of [...railFeatures, ...roadFeatures]) {
    const fid = String(f.id ?? f.properties?.['@id'] ?? `feat_${combinedFeatures.length}`);
    if (seenIds.has(fid)) continue;
    seenIds.add(fid);
    combinedFeatures.push(f);
  }

  const rawGeoJson = {
    type: 'FeatureCollection' as const,
    name: 'Amsterdam Centraal & Prins Hendrikkade (Complex Real OSM Extract)',
    features: combinedFeatures,
  };
  const originLonLat: [number, number] = railRaw.regions?.amsterdamCentraal?.center || [
    4.9003,
    52.3791,
  ];
  const clipRadiusMeters = 280;

  const parseInput = () =>
    provider.parseGeoJson(
      JSON.parse(JSON.stringify(rawGeoJson)),
      rawGeoJson.name,
      originLonLat,
      clipRadiusMeters
    );

  const parsedData = parseInput();
  const metadata = buildDatasetMetadata({
    id: 'large-real-amsterdam-centraal',
    name: rawGeoJson.name,
    scale: 'complex-real-world',
    description:
      'Frozen complex real-world OSM extract covering Amsterdam Centraal multi-track station throat, elevated viaducts, turnouts, diamond crossings, and Prins Hendrikkade multi-modal roads/cycleways.',
    sourceFiles: [railRelPath, pilotRelPath],
    rawGeoJson,
    parsedData,
    originLonLat,
    clipRadiusMeters,
  });

  return {
    metadata,
    rawGeoJson,
    parseInput,
    parsedData,
  };
}

function loadSyntheticStressDataset(provider: LocalGeoJsonProvider): LoadedBenchmarkDataset {
  const { geoJson, originLonLat, clipRadiusMeters } = buildSyntheticStressGeoJson();

  const parseInput = () =>
    provider.parseGeoJson(
      JSON.parse(JSON.stringify(geoJson)),
      geoJson.name,
      originLonLat,
      clipRadiusMeters
    );

  const parsedData = parseInput();
  const metadata = buildDatasetMetadata({
    id: 'synthetic-stress-urban-switchyard',
    name: geoJson.name,
    scale: 'synthetic-stress',
    description:
      'Deterministic synthetic stress-test workload combining a 209-way interconnected urban road/cycleway/footway grid, the 65-way multi-zone railway switchyard, 36 block buildings (with courtyards), parks, parking lots, water bodies, canals, barriers, and trees.',
    sourceFiles: [
      'benchmarks/datasets.ts#buildSyntheticStressGeoJson',
      'src/world/prototype/RailwayTestFixtures.ts',
    ],
    rawGeoJson: geoJson,
    parsedData,
    originLonLat,
    clipRadiusMeters,
  });

  return {
    metadata,
    rawGeoJson: geoJson,
    parseInput,
    parsedData,
  };
}

let cachedDatasets: LoadedBenchmarkDataset[] | null = null;

/**
 * Loads all registered frozen benchmark datasets (or filters by dataset IDs).
 * Guaranteed offline and deterministic.
 */
export function loadBenchmarkDatasets(filterIds?: readonly string[]): LoadedBenchmarkDataset[] {
  if (!cachedDatasets) {
    const provider = new LocalGeoJsonProvider();
    cachedDatasets = [
      loadSmallRealWorldDataset(provider),
      loadMediumRealWorldDataset(provider),
      loadLargeRealWorldDataset(provider),
      loadSyntheticStressDataset(provider),
    ];
  }

  if (!filterIds || filterIds.length === 0) {
    return cachedDatasets;
  }

  const wanted = new Set(filterIds.map((id) => id.trim()));
  const matched = cachedDatasets.filter((ds) => wanted.has(ds.metadata.id));
  if (matched.length === 0) {
    const available = cachedDatasets.map((d) => d.metadata.id).join(', ');
    throw new Error(
      `No benchmark datasets matched filter [${filterIds.join(', ')}]. Available dataset IDs: ${available}`
    );
  }
  return matched;
}
