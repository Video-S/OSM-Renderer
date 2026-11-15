import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { ProcessedMapData } from '../src/types/MapFeature';
import { LocalGeoJsonProvider } from '../src/world/LocalGeoJsonProvider';
import type {
  ScalingDatasetManifest,
  ScalingDatasetManifestEntry,
} from './prepareHengeloScalingDatasets';
import type { HengeloScalingLevel, ScalingDatasetDescriptor } from './types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_HENGELO_SCALING_MANIFEST_PATH = path.join(
  REPO_ROOT,
  'benchmarks',
  'datasets',
  'hengelo-scaling',
  'manifest.json'
);

export interface LoadedScalingDataset {
  descriptor: ScalingDatasetDescriptor;
  manifestEntry: ScalingDatasetManifestEntry;
  manifest: ScalingDatasetManifest;
  filePath: string;
  loadGeoJson: () => any;
  parseInput: () => ProcessedMapData;
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function loadScalingDatasetManifest(
  manifestPath: string = DEFAULT_HENGELO_SCALING_MANIFEST_PATH
): ScalingDatasetManifest {
  const resolved = path.resolve(manifestPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Hengelo scaling dataset manifest not found at ${resolved}. Run "npx tsx benchmarks/prepareHengeloScalingDatasets.ts --pbf=<path>" to regenerate.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf8')) as ScalingDatasetManifest;
  if (!raw || !Array.isArray(raw.datasets) || raw.datasets.length === 0) {
    throw new Error(`Invalid scaling dataset manifest at ${resolved}: missing datasets array.`);
  }
  return raw;
}

export function toScalingDatasetDescriptor(
  entry: ScalingDatasetManifestEntry,
  manifest: ScalingDatasetManifest
): ScalingDatasetDescriptor {
  return {
    level: entry.level,
    id: entry.id,
    name: entry.name,
    areaKm2: entry.areaKm2,
    widthMeters: entry.widthMeters,
    depthMeters: entry.depthMeters,
    halfExtentMeters: entry.halfExtentMeters,
    centerLonLat: [entry.centerLonLat[0], entry.centerLonLat[1]],
    bbox: { ...entry.bbox },
    osmElementCounts: { ...entry.osmElementCounts },
    geoJsonFeatureCount: entry.geoJsonFeatureCount,
    geoJsonSha256: entry.geoJsonSha256,
    gzipFileSha256: entry.gzipFileSha256,
    gzipBytes: entry.gzipBytes,
    uncompressedBytes: entry.uncompressedBytes,
    osmTimestampIso: manifest.osmTimestampIso,
    attribution: manifest.attribution,
  };
}

export function loadScalingDatasetEntry(
  entry: ScalingDatasetManifestEntry,
  manifest: ScalingDatasetManifest,
  baseDir: string,
  options: { verifyHashes?: boolean } = {}
): LoadedScalingDataset {
  const verifyHashes = options.verifyHashes ?? true;
  const filePath = path.resolve(baseDir, entry.file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Scaling dataset file missing: ${filePath}`);
  }

  const descriptor = toScalingDatasetDescriptor(entry, manifest);

  const loadGeoJson = (): any => {
    const gzBuffer = fs.readFileSync(filePath);
    if (verifyHashes) {
      const actualGzHash = sha256Hex(gzBuffer);
      if (actualGzHash !== entry.gzipFileSha256) {
        throw new Error(
          `SHA-256 mismatch for ${entry.file} (gzip): expected ${entry.gzipFileSha256}, got ${actualGzHash}`
        );
      }
    }
    const jsonBuffer = zlib.gunzipSync(gzBuffer);
    if (verifyHashes) {
      const actualJsonHash = sha256Hex(jsonBuffer);
      if (actualJsonHash !== entry.geoJsonSha256) {
        throw new Error(
          `SHA-256 mismatch for ${entry.file} (decompressed GeoJSON): expected ${entry.geoJsonSha256}, got ${actualJsonHash}`
        );
      }
    }
    return JSON.parse(jsonBuffer.toString('utf8'));
  };

  let cachedGeoJson: any = null;
  const getCachedGeoJson = () => {
    if (!cachedGeoJson) {
      cachedGeoJson = loadGeoJson();
    }
    return cachedGeoJson;
  };

  const parseInput = (): ProcessedMapData => {
    const rawGeoJson = getCachedGeoJson();
    const provider = new LocalGeoJsonProvider();
    return provider.parseGeoJson(
      rawGeoJson,
      entry.name,
      [entry.centerLonLat[0], entry.centerLonLat[1]],
      entry.halfExtentMeters
    );
  };

  return {
    descriptor,
    manifestEntry: entry,
    manifest,
    filePath,
    loadGeoJson,
    parseInput,
  };
}

export function loadHengeloScalingDatasets(options: {
  manifestPath?: string;
  levelsOrIds?: readonly string[];
  maxScale?: HengeloScalingLevel;
  verifyHashes?: boolean;
} = {}): {
  manifest: ScalingDatasetManifest;
  datasets: LoadedScalingDataset[];
} {
  const manifestPath = path.resolve(options.manifestPath ?? DEFAULT_HENGELO_SCALING_MANIFEST_PATH);
  const manifest = loadScalingDatasetManifest(manifestPath);
  const baseDir = path.dirname(manifestPath);

  const LEVEL_ORDER: Record<HengeloScalingLevel, number> = {
    S1: 1,
    S2: 2,
    S3: 3,
    S4: 4,
    S5: 5,
  };
  const maxOrder = options.maxScale ? LEVEL_ORDER[options.maxScale] : 5;

  let entries = manifest.datasets.filter((d) => LEVEL_ORDER[d.level] <= maxOrder);
  if (options.levelsOrIds && options.levelsOrIds.length > 0) {
    const wanted = new Set(options.levelsOrIds.map((v) => v.trim().toUpperCase()));
    const wantedRaw = new Set(options.levelsOrIds.map((v) => v.trim()));
    entries = entries.filter(
      (d) => wanted.has(d.level.toUpperCase()) || wantedRaw.has(d.id)
    );
    if (entries.length === 0) {
      const available = manifest.datasets.map((d) => `${d.level} (${d.id})`).join(', ');
      throw new Error(
        `No scaling datasets matched filter [${options.levelsOrIds.join(', ')}]. Available: ${available}`
      );
    }
  }

  const datasets = entries.map((entry) =>
    loadScalingDatasetEntry(entry, manifest, baseDir, {
      verifyHashes: options.verifyHashes ?? true,
    })
  );

  return { manifest, datasets };
}
