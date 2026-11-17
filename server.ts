import http from 'http';
import fs from 'fs';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { BoundedCache, createOsmDataHandler } from './src/server/osm/osmDataHandler';
import { resolveOverijsselIndexPath } from './src/server/osm/overijsselConfig';
import { fetchOverijsselPbf } from './scripts/fetch-overijssel-pbf';
import { runBuildOverijsselIndex } from './scripts/build-overijssel-index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

let overijsselBootstrapPromise: Promise<void> | null = null;

function ensureOverijsselReady(): Promise<void> {
  const indexPath = resolveOverijsselIndexPath();
  if (fs.existsSync(indexPath)) {
    return Promise.resolve();
  }
  if (!overijsselBootstrapPromise) {
    overijsselBootstrapPromise = (async () => {
      console.log('Bootstrapping offline Overijssel OSM spatial index...');
      const fetched = await fetchOverijsselPbf();
      await runBuildOverijsselIndex({ pbfPath: fetched.pbfPath, outIndexPath: indexPath });
      console.log(`Offline Overijssel OSM spatial index ready at ${indexPath}`);
    })().finally(() => {
      overijsselBootstrapPromise = null;
    });
  }
  return overijsselBootstrapPromise;
}

const geocodeCache = new BoundedCache<string, any>(200, 30 * 60 * 1000);
const osmDataController = createOsmDataHandler({
  ensureOverijsselReady,
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
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT} in ${isProduction ? 'production' : 'development'} mode`);
  });
}

startServer();
