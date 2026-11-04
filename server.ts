import http from 'http';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import osmtogeojson from 'osmtogeojson';
import { DOMParser } from 'xmldom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

/**
 * Bounded LRU + TTL in-memory cache to prevent unbounded memory growth.
 */
class BoundedCache<K, V> {
  private map = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private maxEntries: number,
    private ttlMs: number
  ) {}

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh LRU order
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }
}

const geocodeCache = new BoundedCache<string, any>(200, 30 * 60 * 1000);
const osmCache = new BoundedCache<string, any>(40, 30 * 60 * 1000);

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
app.get('/api/osm-data', async (req, res) => {
  const lat = parseFloat(req.query.lat as string);
  const lon = parseFloat(req.query.lon as string);
  const radiusMeters = Math.min(Math.max(parseFloat(req.query.radius as string) || 350, 200), 600);
  const locationName = (req.query.name as string) || 'Location';

  if (isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ error: 'Valid "lat" and "lon" coordinates are required' });
  }

  const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)},${radiusMeters}`;
  const cachedOsm = osmCache.get(cacheKey);
  if (cachedOsm) {
    return res.json(cachedOsm);
  }

  try {
    // 1 degree latitude ~ 111,320m
    const dLat = radiusMeters / 111320;
    const dLon = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180));

    const minLon = (lon - dLon).toFixed(5);
    const minLat = (lat - dLat).toFixed(5);
    const maxLon = (lon + dLon).toFixed(5);
    const maxLat = (lat + dLat).toFixed(5);

    const bbox = `${minLon},${minLat},${maxLon},${maxLat}`;
    console.log(`Fetching real OSM data for "${locationName}" [${bbox}]...`);

    let geojson: any = null;

    // Primary read-only Overpass API query with fallback to OSM 0.6 map endpoint
    const overpassQuery = `[out:json][timeout:25];(node(${minLat},${minLon},${maxLat},${maxLon});way(${minLat},${minLon},${maxLat},${maxLon});relation(${minLat},${minLon},${maxLat},${maxLon}););out body;>;out skel qt;`;
    try {
      const overpassRes = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': 'RealWorld3DMapViewer/1.0',
        },
        body: `data=${encodeURIComponent(overpassQuery)}`,
      });
      if (overpassRes.ok) {
        const overpassJson = await overpassRes.json();
        geojson = osmtogeojson(overpassJson);
      }
    } catch {
      // Fall back to OSM 0.6 XML map endpoint if Overpass is unreachable
    }

    if (!geojson) {
      const osmUrl = `https://api.openstreetmap.org/api/0.6/map?bbox=${bbox}`;
      const osmRes = await fetch(osmUrl, {
        headers: {
          'User-Agent': 'RealWorld3DMapViewer/1.0 (https://github.com/google-gemini)',
        },
      });

      if (!osmRes.ok) {
        if (osmRes.status === 400 || osmRes.status === 509) {
          throw new Error('Requested area is too dense. Please try a slightly smaller radius.');
        }
        throw new Error(`OpenStreetMap API returned status ${osmRes.status}`);
      }

      const xmlText = await osmRes.text();
      const xmlDoc = new DOMParser().parseFromString(xmlText, 'text/xml');
      geojson = osmtogeojson(xmlDoc);
    }

    // Attach metadata
    geojson.name = locationName;
    geojson.crs = {
      type: 'name',
      properties: {
        name: 'urn:ogc:def:crs:OGC:1.3:CRS84',
      },
    };

    osmCache.set(cacheKey, geojson);
    return res.json(geojson);
  } catch (err: any) {
    console.error('OSM Data fetch error:', err);
    return res.status(500).json({ error: `Failed to retrieve OSM data: ${err.message}` });
  }
});

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

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT} in ${isProduction ? 'production' : 'development'} mode`);
  });
}

startServer();
