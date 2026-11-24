import http from 'http';
import fs from 'fs';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { createOsmDataHandler } from './src/server/osm/osmDataHandler';
import { createSearchDataHandler } from './src/server/osm/searchDataHandler';
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

const osmDataController = createOsmDataHandler({
  ensureOverijsselReady: isOverijsselAutoBootstrapDisabled() ? undefined : ensureOverijsselReady,
});
const tilePackController = createTilePackHttpHandler();
const tilePack1024Controller = createTilePackHttpHandler({
  packPath: resolveTilePackPathForTileSize(1024),
});
// Lazily opened, isolated regional mosaic; missing mosaic index returns a clear 503.
const regionalMosaicController = createRegionalMosaicHttpHandler({
  indexPath: resolveRegionalMosaicIndexPath(),
});
// Local offline SQLite FTS5 search over Overijssel spatial store with mosaic coverage evaluation.
const searchController = createSearchDataHandler({
  getMosaicCoverage: regionalMosaicController.getCoverageSnapshot,
});

// 1. Offline local SQLite FTS5 search endpoints (zero external network fallback)
app.get('/api/search', searchController.searchHandler);
app.get('/api/search/status', searchController.statusHandler);
app.post('/api/search/build', searchController.buildHandler);

// 2. Local Overijssel GeoJSON API (used by benchmarks and explicit developer study fixtures)
app.get('/api/osm-data', osmDataController.handler);

// 3. M2-A Offline Baked Tile Pack API (OSMTILE1)
app.get('/api/tiles/manifest', tilePackController.manifestHandler);
app.get('/api/tiles/:lod/:tx/:ty', tilePackController.tilePayloadHandler);
app.get(
  '/api/tiles/:snapshotId/:schemaVersion/:lod/:tx/:ty',
  tilePackController.tilePayloadHandler
);

// 3b. Reversible 1,024 m Tile-Size Experiment & Regional Mosaic API (lazy-opened on request)
app.get('/api/tiles-1024m/manifest', tilePack1024Controller.manifestHandler);
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
    if (!isOverijsselAutoBootstrapDisabled()) {
      const searchStatus = searchController.getStatus();
      if (!searchStatus.available) {
        searchController.ensureReady().catch((err) => {
          console.error('Automatic Overijssel search index bootstrap failed:', err?.message ?? err);
        });
      }
    }
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
    ensureOverijsselReady()
      .then(() => searchController.ensureReady())
      .catch((err) => {
        console.error('Automatic Overijssel spatial index bootstrap failed:', err?.message ?? err);
      });
  }

  const shutdown = () => {
    osmDataController.close();
    searchController.close();
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

