import fs from 'node:fs';
import type { Request, Response } from 'express';
import osmtogeojson from 'osmtogeojson';
import { DOMParser } from 'xmldom';
import {
  enrichGeoJsonWithOsmXmlNodeIds,
  enrichGeoJsonWithOverpassNodeIds,
} from '../../world/infrastructure/topology/OsmNodeIdEnricher';
import { isPointInOverijssel } from './overijsselBoundary';
import { resolveOverijsselIndexPath } from './overijsselConfig';
import {
  computeRegionBBox,
  OverijsselIndexMissingError,
  OverijsselOsmStore,
} from './OverijsselOsmStore';
import { createHengeloStudyGrid } from '../../world/tiling/TileGrid';

export class BoundedCache<K, V> {
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

export interface OsmDataHandlerController {
  handler: (req: Request, res: Response) => Promise<any>;
  close: () => void;
  getStoreStatus: () => {
    indexPath: string;
    available: boolean;
    snapshotId: string | null;
    error: string | null;
  };
}

export function createOsmDataHandler(options?: {
  overijsselIndexPath?: string;
  cacheMaxEntries?: number;
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  ensureOverijsselReady?: () => Promise<void>;
}): OsmDataHandlerController {
  const osmCache = new BoundedCache<string, any>(
    options?.cacheMaxEntries ?? 40,
    options?.cacheTtlMs ?? 30 * 60 * 1000
  );
  const fetchFn = options?.fetchImpl ?? globalThis.fetch;

  let cachedStore: OverijsselOsmStore | null = null;
  let cachedStorePath: string | null = null;

  const getIndexPath = () => options?.overijsselIndexPath ?? resolveOverijsselIndexPath();

  const getOverijsselStore = (): OverijsselOsmStore => {
    const targetPath = getIndexPath();
    if (cachedStore && cachedStore.isOpen() && cachedStorePath === targetPath) {
      return cachedStore;
    }
    if (cachedStore) {
      cachedStore.close();
      cachedStore = null;
      cachedStorePath = null;
    }
    const store = new OverijsselOsmStore(targetPath);
    cachedStore = store;
    cachedStorePath = targetPath;
    return store;
  };

  const close = () => {
    if (cachedStore) {
      cachedStore.close();
      cachedStore = null;
      cachedStorePath = null;
    }
  };

  const getStoreStatus = () => {
    const targetPath = getIndexPath();
    if (!fs.existsSync(targetPath)) {
      return {
        indexPath: targetPath,
        available: false,
        snapshotId: null,
        error: 'Index file not present',
      };
    }
    try {
      const store = getOverijsselStore();
      return {
        indexPath: targetPath,
        available: true,
        snapshotId: store.getSnapshotMetadata().snapshotId,
        error: null,
      };
    } catch (err: any) {
      return {
        indexPath: targetPath,
        available: false,
        snapshotId: null,
        error: err?.message ?? String(err),
      };
    }
  };

  const handler = async (req: Request, res: Response) => {
    const tReq0 = performance.now();
    const presetParam = typeof req.query.preset === 'string' ? req.query.preset.trim() : '';
    if (presetParam === 'hengelo-m1a') {
      const tileSizeMeters = Math.max(
        64,
        Math.min(2048, parseFloat(String(req.query.tileSize ?? '512')) || 512)
      );
      const collarMeters = Math.max(
        0,
        Math.min(512, parseFloat(String(req.query.collar ?? '64')) || 64)
      );
      const cacheKey = `preset:hengelo-m1a:${tileSizeMeters}:${collarMeters}`;
      const tCache0 = performance.now();
      const cachedOsm = osmCache.get(cacheKey);
      const cacheLookupMs = performance.now() - tCache0;
      if (cachedOsm) {
        const totalServerMs = performance.now() - tReq0;
        res.setHeader(
          'Access-Control-Expose-Headers',
          'Server-Timing, X-OSM-Cache, X-OSM-Source, X-OSM-Snapshot, X-OSM-Feature-Count'
        );
        res.setHeader('X-OSM-Cache', 'HIT');
        res.setHeader('X-OSM-Source', 'cache');
        if (cachedOsm?.metadata?.snapshotId) {
          res.setHeader('X-OSM-Snapshot', String(cachedOsm.metadata.snapshotId));
        }
        res.setHeader('X-OSM-Feature-Count', String(cachedOsm.features?.length ?? 0));
        res.setHeader(
          'Server-Timing',
          `cache;dur=${cacheLookupMs.toFixed(3)}, total;dur=${totalServerMs.toFixed(3)}`
        );
        return res.json(cachedOsm);
      }

      try {
        if (!fs.existsSync(getIndexPath()) && options?.ensureOverijsselReady) {
          await options.ensureOverijsselReady();
        }
        const store = getOverijsselStore();
        const grid = createHengeloStudyGrid(tileSizeMeters, collarMeters);
        const result = store.queryBBox({
          ...grid.studyExpandedGeoBounds,
          locationName: grid.name,
        });

        osmCache.set(cacheKey, result.geojson);
        const totalServerMs = performance.now() - tReq0;
        res.setHeader(
          'Access-Control-Expose-Headers',
          'Server-Timing, X-OSM-Cache, X-OSM-Source, X-OSM-Snapshot, X-OSM-Feature-Count'
        );
        res.setHeader('X-OSM-Cache', 'MISS');
        res.setHeader('X-OSM-Source', 'overijssel-offline-m1a');
        res.setHeader('X-OSM-Snapshot', result.snapshotMetadata.snapshotId);
        res.setHeader('X-OSM-Feature-Count', String(result.counts.features));
        res.setHeader(
          'Server-Timing',
          `cache;dur=${cacheLookupMs.toFixed(3)}, upstream;dur=${result.timings.spatialQueryMs.toFixed(
            3
          )}, osmtogeojson;dur=${result.timings.osmtogeojsonMs.toFixed(
            3
          )}, enrich;dur=${result.timings.nodeIdEnrichMs.toFixed(
            3
          )}, total;dur=${totalServerMs.toFixed(3)}`
        );
        return res.json(result.geojson);
      } catch (err: any) {
        const isMissing = err instanceof OverijsselIndexMissingError;
        const status = isMissing ? 503 : 500;
        console.error('Offline Overijssel M1a study BBox query error:', err);
        return res.status(status).json({
          error:
            err?.message ??
            'Failed to query canonical Hengelo M1a study BBox from local Overijssel OSM spatial store.',
        });
      }
    }

    const lat = parseFloat(req.query.lat as string);
    const lon = parseFloat(req.query.lon as string);
    const radiusMeters = Math.min(Math.max(parseFloat(req.query.radius as string) || 350, 200), 5000);
    const locationName = (req.query.name as string) || 'Location';

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'Valid "lat" and "lon" coordinates are required' });
    }

    const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)},${radiusMeters}`;
    const tCache0 = performance.now();
    const cachedOsm = osmCache.get(cacheKey);
    const cacheLookupMs = performance.now() - tCache0;
    if (cachedOsm) {
      const totalServerMs = performance.now() - tReq0;
      res.setHeader(
        'Access-Control-Expose-Headers',
        'Server-Timing, X-OSM-Cache, X-OSM-Source, X-OSM-Snapshot, X-OSM-Feature-Count'
      );
      res.setHeader('X-OSM-Cache', 'HIT');
      res.setHeader('X-OSM-Source', 'cache');
      if (cachedOsm?.metadata?.snapshotId) {
        res.setHeader('X-OSM-Snapshot', String(cachedOsm.metadata.snapshotId));
      }
      res.setHeader('X-OSM-Feature-Count', String(cachedOsm.features?.length ?? 0));
      res.setHeader(
        'Server-Timing',
        `cache;dur=${cacheLookupMs.toFixed(3)}, total;dur=${totalServerMs.toFixed(3)}`
      );
      return res.json(cachedOsm);
    }

    // Locations covered by the Overijssel snapshot MUST be served exclusively from local storage.
    // Never silently fall back to live Overpass for covered coordinates.
    if (isPointInOverijssel(lat, lon)) {
      try {
        if (!fs.existsSync(getIndexPath()) && options?.ensureOverijsselReady) {
          await options.ensureOverijsselReady();
        }
        const store = getOverijsselStore();
        const result = store.queryRegion({
          centerLat: lat,
          centerLon: lon,
          radiusMeters,
          locationName,
        });

        osmCache.set(cacheKey, result.geojson);
        const totalServerMs = performance.now() - tReq0;

        res.setHeader(
          'Access-Control-Expose-Headers',
          'Server-Timing, X-OSM-Cache, X-OSM-Source, X-OSM-Snapshot, X-OSM-Feature-Count'
        );
        res.setHeader('X-OSM-Cache', 'MISS');
        res.setHeader('X-OSM-Source', 'overijssel-offline');
        res.setHeader('X-OSM-Snapshot', result.snapshotMetadata.snapshotId);
        res.setHeader('X-OSM-Feature-Count', String(result.counts.features));
        res.setHeader(
          'Server-Timing',
          `cache;dur=${cacheLookupMs.toFixed(3)}, upstream;dur=${result.timings.spatialQueryMs.toFixed(
            3
          )}, osmtogeojson;dur=${result.timings.osmtogeojsonMs.toFixed(
            3
          )}, enrich;dur=${result.timings.nodeIdEnrichMs.toFixed(
            3
          )}, total;dur=${totalServerMs.toFixed(3)}`
        );
        return res.json(result.geojson);
      } catch (err: any) {
        const isMissing = err instanceof OverijsselIndexMissingError;
        const status = isMissing ? 503 : 500;
        console.error('Offline Overijssel OSM query error (Overpass fallback disabled):', err);
        return res.status(status).json({
          error:
            err?.message ??
            'Failed to query local Overijssel OSM spatial store. Live Overpass fallback is disabled for locations within Overijssel.',
        });
      }
    }

    try {
      const { minLon, minLat, maxLon, maxLat } = computeRegionBBox(lat, lon, radiusMeters);
      const bbox = `${minLon.toFixed(5)},${minLat.toFixed(5)},${maxLon.toFixed(5)},${maxLat.toFixed(5)}`;
      console.log(`Fetching real OSM data for "${locationName}" [${bbox}]...`);

      let geojson: any = null;
      let upstreamSource: 'overpass' | 'osm-xml' = 'overpass';
      let upstreamFetchMs = 0;
      let osmtogeojsonMs = 0;
      let nodeIdEnrichMs = 0;

      const isLargeRadius = radiusMeters > 600;
      const overpassQuery = isLargeRadius
        ? `[out:json][timeout:60];(way["highway"](${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)});way["railway"](${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)});way["building"](${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)});way["waterway"](${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)});way["natural"](${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)});way["landuse"](${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)});way["leisure"](${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)});relation["highway"](${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)});relation["railway"](${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)}););out body;>;out skel qt;`
        : `[out:json][timeout:30];(node(${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)});way(${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)});relation(${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)}););out body;>;out skel qt;`;

      try {
        const tOverpass0 = performance.now();
        const overpassRes = await fetchFn('https://overpass-api.de/api/interpreter', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'User-Agent': 'RealWorld3DMapViewer/1.0',
          },
          body: `data=${encodeURIComponent(overpassQuery)}`,
        });
        if (overpassRes.ok) {
          const overpassJson = await overpassRes.json();
          upstreamFetchMs = performance.now() - tOverpass0;

          const tConvert0 = performance.now();
          geojson = osmtogeojson(overpassJson);
          osmtogeojsonMs = performance.now() - tConvert0;

          const tEnrich0 = performance.now();
          enrichGeoJsonWithOverpassNodeIds(geojson, overpassJson);
          nodeIdEnrichMs = performance.now() - tEnrich0;
        } else {
          upstreamFetchMs = performance.now() - tOverpass0;
        }
      } catch (err) {
        console.warn('Overpass fetch exception:', err);
      }

      if (!geojson && radiusMeters <= 600) {
        upstreamSource = 'osm-xml';
        const osmUrl = `https://api.openstreetmap.org/api/0.6/map?bbox=${bbox}`;
        const tXml0 = performance.now();
        const osmRes = await fetchFn(osmUrl, {
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
        upstreamFetchMs += performance.now() - tXml0;

        const tConvert0 = performance.now();
        const xmlDoc = new DOMParser().parseFromString(xmlText, 'text/xml');
        geojson = osmtogeojson(xmlDoc);
        osmtogeojsonMs = performance.now() - tConvert0;

        const tEnrich0 = performance.now();
        enrichGeoJsonWithOsmXmlNodeIds(geojson, xmlDoc);
        nodeIdEnrichMs = performance.now() - tEnrich0;
      }

      if (!geojson || !geojson.features || geojson.features.length === 0) {
        throw new Error(
          'Requested area returned no features or Overpass API is busy. Please try a slightly smaller radius.'
        );
      }

      geojson.name = locationName;
      geojson.crs = {
        type: 'name',
        properties: {
          name: 'urn:ogc:def:crs:OGC:1.3:CRS84',
        },
      };

      osmCache.set(cacheKey, geojson);
      const totalServerMs = performance.now() - tReq0;
      res.setHeader(
        'Access-Control-Expose-Headers',
        'Server-Timing, X-OSM-Cache, X-OSM-Source, X-OSM-Snapshot, X-OSM-Feature-Count'
      );
      res.setHeader('X-OSM-Cache', 'MISS');
      res.setHeader('X-OSM-Source', upstreamSource);
      res.setHeader('X-OSM-Feature-Count', String(geojson.features?.length ?? 0));
      res.setHeader(
        'Server-Timing',
        `cache;dur=${cacheLookupMs.toFixed(3)}, upstream;dur=${upstreamFetchMs.toFixed(
          3
        )}, osmtogeojson;dur=${osmtogeojsonMs.toFixed(
          3
        )}, enrich;dur=${nodeIdEnrichMs.toFixed(3)}, total;dur=${totalServerMs.toFixed(3)}`
      );
      return res.json(geojson);
    } catch (err: any) {
      console.error('OSM Data fetch error:', err);
      return res.status(500).json({ error: `Failed to retrieve OSM data: ${err.message}` });
    }
  };

  return { handler, close, getStoreStatus };
}
