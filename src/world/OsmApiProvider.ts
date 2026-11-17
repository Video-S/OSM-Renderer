import { ProcessedMapData } from '../types/MapFeature';
import { MapDataProvider, MapRegionQuery } from './MapDataProvider';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import {
  type OsmProviderLoadMetrics,
  parseServerTimingHeader,
  readResourceTimingSizes,
  resolveCacheStatusFromHeaders,
} from './dev/MapLoadDiagnostics';

/**
 * MapDataProvider implementation that queries the server-side OpenStreetMap API proxy
 * (/api/osm-data) and parses the returned GeoJSON into high-fidelity 3D map data.
 */
export class OsmApiProvider implements MapDataProvider {
  readonly id = 'osm-live-api';
  readonly name = 'OpenStreetMap Live API';

  private parser: LocalGeoJsonProvider;
  private lastRawGeoJson: any = null;
  private lastLoadMetrics: OsmProviderLoadMetrics | null = null;

  constructor() {
    this.parser = new LocalGeoJsonProvider();
  }

  getLastRawGeoJson(): any {
    return this.lastRawGeoJson;
  }

  getLastLoadMetrics(): OsmProviderLoadMetrics | null {
    return this.lastLoadMetrics;
  }

  async loadRegion(query?: MapRegionQuery): Promise<ProcessedMapData> {
    const lat = query?.centerLat ?? 52.378;
    const lon = query?.centerLon ?? 4.900;
    const radius = query?.radiusMeters ?? 350;
    const name = query?.locationName ?? 'Location';

    const baseUrl = typeof window !== 'undefined' ? '' : 'http://localhost:3000';
    const url = `${baseUrl}/api/osm-data?lat=${lat}&lon=${lon}&radius=${radius}&name=${encodeURIComponent(name)}`;

    const tFetchStart = performance.now();
    const res = await fetch(url);
    const tHeadersAt = performance.now();

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to fetch OSM data from server (${res.status}): ${errText || res.statusText}`);
    }

    let geojson: any;
    let responseTransferMs: number | null = null;
    let jsonDecodeMs: number | null = null;
    let payloadBytes: number | null = null;

    if (typeof res.text === 'function') {
      const tTransferStart = performance.now();
      const rawText = await res.text();
      const tTransferEnd = performance.now();
      responseTransferMs = tTransferEnd - tTransferStart;
      payloadBytes =
        typeof TextEncoder !== 'undefined'
          ? new TextEncoder().encode(rawText).byteLength
          : rawText.length;

      const trimmedText = rawText.trimStart();
      if (trimmedText.startsWith('<')) {
        throw new Error(
          'OSM data endpoint returned an HTML page instead of GeoJSON (the server or local Overijssel index may still be warming up). Please retry in a moment.'
        );
      }

      const tDecodeStart = performance.now();
      geojson = JSON.parse(rawText);
      const tDecodeEnd = performance.now();
      jsonDecodeMs = tDecodeEnd - tDecodeStart;
    } else {
      geojson = await res.json();
    }
    const tDecodeDone = performance.now();

    this.lastRawGeoJson = geojson;

    const tParseStart = performance.now();
    const parsed = this.parser.parseGeoJson(geojson, name, [lon, lat], radius);
    const tParseEnd = performance.now();

    const serverTimingHeader = res.headers?.get?.('server-timing') ?? null;
    const cacheHeader = res.headers?.get?.('x-osm-cache') ?? null;
    const sourceHeader = res.headers?.get?.('x-osm-source') ?? null;
    const contentLengthHeader = res.headers?.get?.('content-length') ?? null;
    if (payloadBytes === null && contentLengthHeader) {
      const parsedLen = parseInt(contentLengthHeader, 10);
      if (Number.isFinite(parsedLen) && parsedLen >= 0) {
        payloadBytes = parsedLen;
      }
    }

    const resourceSizes = readResourceTimingSizes(url);

    this.lastLoadMetrics = {
      url,
      httpStatus: res.status,
      osmRequestMs: Math.max(0, tHeadersAt - tFetchStart),
      dataTransferAndDecodeMs: Math.max(0, tDecodeDone - tHeadersAt),
      responseTransferMs,
      jsonDecodeMs,
      geoJsonProcessingMs: Math.max(0, tParseEnd - tParseStart),
      geoJsonSubTimingsMs: this.parser.getLastParseSubTimings(),
      payloadBytes,
      transferSizeBytes: resourceSizes.transferSizeBytes,
      encodedBodySizeBytes: resourceSizes.encodedBodySizeBytes,
      featureCount: Array.isArray(geojson?.features) ? geojson.features.length : null,
      cacheStatus: resolveCacheStatusFromHeaders(cacheHeader),
      serverTimings: parseServerTimingHeader(serverTimingHeader, sourceHeader),
    };

    return parsed;
  }
}
