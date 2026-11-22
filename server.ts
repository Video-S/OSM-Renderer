import http from 'http';
import fs from 'fs';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { BoundedCache, createOsmDataHandler } from './src/server/osm/osmDataHandler';
import {
  isOverijsselAutoBootstrapDisabled,
  resolveOverijsselIndexPath,
} from './src/server/osm/overijsselConfig';
import { OverijsselOsmStore } from './src/server/osm/OverijsselOsmStore';
import { fetchOverijsselPbf } from './scripts/fetch-overijssel-pbf';
import { runBuildOverijsselIndex } from './scripts/build-overijssel-index';
import { createTilePackHttpHandler } from './src/server/tiles/tilePackHttpHandler';
import { resolveTilePackPathForTileSize } from './src/server/tiles/TilePackSqliteStore';
import {
  createRegionalMosaicHttpHandler,
  resolveRegionalMosaicIndexPath,
} from './src/server/tiles/RegionalMosaicHttpHandler';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

let overijsselBootstrapPromise: Promise<void> | null = null;

export interface EnsureOverijsselReadyOptions {
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  indexPath?: string;
  fetchPbf?: () => Promise<{ pbfPath: string }>;
  buildIndex?: (options: {
    pbfPath: string;
    outIndexPath: string;
    force?: boolean;
  }) => Promise<unknown>;
}

export function ensureOverijsselReady(options?: EnsureOverijsselReadyOptions): Promise<void> {
  if (isOverijsselAutoBootstrapDisabled(options?.env, options?.argv)) {
    return Promise.resolve();
  }
  const indexPath = options?.indexPath ?? resolveOverijsselIndexPath();
  let forceRebuild = false;
  if (fs.existsSync(indexPath)) {
    try {
      const store = new OverijsselOsmStore(indexPath);
      store.close();
      return Promise.resolve();
    } catch {
      forceRebuild = true;
    }
  }
  if (!overijsselBootstrapPromise) {
    const fetchPbf = options?.fetchPbf ?? fetchOverijsselPbf;
    const buildIndex = options?.buildIndex ?? runBuildOverijsselIndex;
    overijsselBootstrapPromise = (async () => {
      console.log('Bootstrapping offline Overijssel OSM spatial index...');
      const fetched = await fetchPbf();
      await buildIndex({
        pbfPath: fetched.pbfPath,
        outIndexPath: indexPath,
        ...(forceRebuild ? { force: true } : {}),
      });
      console.log(`Offline Overijssel OSM spatial index ready at ${indexPath}`);
    })().finally(() => {
      overijsselBootstrapPromise = null;
    });
  }
  return overijsselBootstrapPromise;
}

const geocodeCache = new BoundedCache<string, any>(200, 30 * 60 * 1000);
const osmDataController = createOsmDataHandler({
  ensureOverijsselReady: isOverijsselAutoBootstrapDisabled() ? undefined : ensureOverijsselReady,
});
const tilePackController = createTilePackHttpHandler();
const tilePack1024Controller = createTilePackHttpHandler({
  packPath: resolveTilePackPathForTileSize(1024),
});
// Lazily opened, isolated 16km pilot; missing mosaic index returns a clear 503.
const regionalMosaicController = createRegionalMosaicHttpHandler({
  indexPath: resolveRegionalMosaicIndexPath(),
});

// 1. Geocoding endpoint using Photon (Komoot OpenStreetMap geocoder)
app.get('/api/geocode', async (req, res) => {
  const query = req.query.q as string;
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  const trimmed = query.trim();
  const cached = geocodeCache.get(trimmed.toLowerCase());
  if (cached) {
    return res.json(cached);
  }

  try {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(trimmed)}&limit=5`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'RealWorld3DMapViewer/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`Photon API responded with status ${response.status}`);
    }

    const data = await response.json();
    const results = (data.features || []).map((f: any) => {
      const [lon, lat] = f.geometry?.coordinates || [0, 0];
      const p = f.properties || {};
      const parts = [
        p.name,
        p.street ? `${p.housenumber ? p.housenumber + ' ' : ''}${p.street}` : null,
        p.city || p.town || p.district,
        p.state,
        p.country,
      ].filter(Boolean);

      return {
        name: p.name || parts[0] || 'Unknown location',
        displayName: parts.join(', '),
        lat,
        lon,
        type: p.type || p.osm_value || 'place',
      };
    });

    geocodeCache.set(trimmed.toLowerCase(), results);
    return res.json(results);
  } catch (err: any) {
    console.error('Geocoding error:', err);
    return res.status(500).json({ error: `Geocoding failed: ${err.message}` });
  }
});

// 2. Fetch and convert real OpenStreetMap data around (lat, lon) to GeoJSON
app.get('/api/osm-data', osmDataController.handler);

// 3. M2-A Offline Baked Tile Pack API (OSMTILE1)
app.get('/api/tiles/manifest', tilePackController.manifestHandler);
app.get('/api/tiles/:lod/:tx/:ty', tilePackController.tilePayloadHandler);
app.get(
  '/api/tiles/:snapshotId/:schemaVersion/:lod/:tx/:ty',
  tilePackController.tilePayloadHandler
);

// 3b. Reversible 1,024 m Tile-Size Experiment Baked Pack API (lazy-opened on request)
app.get('/api/tiles-1024m/manifest', tilePack1024Controller.manifestHandler);
// TKT-029 bounded regional pilot: same OSMTILE1 codec, same streaming client.
app.get('/api/tiles-region/manifest', regionalMosaicController.manifestHandler);
app.get('/api/tiles-region/:lod/:tx/:ty', regionalMosaicController.tilePayloadHandler);
app.get('/api/tiles-region/:snapshotId/:schemaVersion/:lod/:tx/:ty', regionalMosaicController.tilePayloadHandler);
app.get('/api/tiles-1024m/:lod/:tx/:ty', tilePack1024Controller.tilePayloadHandler);
app.get(
  '/api/tiles-1024m/:snapshotId/:schemaVersion/:lod/:tx/:ty',
  tilePack1024Controller.tilePayloadHandler
);

// Vite middleware in development or static hosting in production
async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';
  const httpServer = http.createServer(app);

  if (!isProduction) {
    const isHmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: isHmrDisabled ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist/index.html'));
    });
  }

  const overijsselStatus = osmDataController.getStoreStatus();
  if (overijsselStatus.available) {
    console.log(
      `Overijssel offline spatial store ready (${overijsselStatus.snapshotId}) at ${overijsselStatus.indexPath}`
    );
  } else if (isOverijsselAutoBootstrapDisabled()) {
    console.info(
      `Overijssel offline spatial store not ready (${overijsselStatus.error}) at ${overijsselStatus.indexPath}. ` +
        `Automatic background setup disabled via opt-out.`
    );
  } else {
    console.warn(
      `Overijssel offline spatial store not ready (${overijsselStatus.error}) at ${overijsselStatus.indexPath}. ` +
        `Starting automatic background setup...`
    );
    ensureOverijsselReady().catch((err) => {
      console.error('Automatic Overijssel spatial index bootstrap failed:', err?.message ?? err);
    });
  }

  const shutdown = () => {
    osmDataController.close();
    tilePackController.close();
    tilePack1024Controller.close();
    regionalMosaicController.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT} in ${isProduction ? 'production' : 'development'} mode`);
  });
}

const isMainModule = (() => {
  if (typeof process.argv[1] !== 'string' || process.argv[1].length === 0) {
    return false;
  }
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(__filename);
  }
})();

if (isMainModule) {
  startServer();
}

