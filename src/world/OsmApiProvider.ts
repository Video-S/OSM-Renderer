import { ProcessedMapData } from '../types/MapFeature';
import { MapDataProvider, MapRegionQuery } from './MapDataProvider';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';

/**
 * MapDataProvider implementation that queries the server-side OpenStreetMap API proxy
 * (/api/osm-data) and parses the returned GeoJSON into high-fidelity 3D map data.
 */
export class OsmApiProvider implements MapDataProvider {
  readonly id = 'osm-live-api';
  readonly name = 'OpenStreetMap Live API';

  private parser: LocalGeoJsonProvider;
  private lastRawGeoJson: any = null;

  constructor() {
    this.parser = new LocalGeoJsonProvider();
  }

  getLastRawGeoJson(): any {
    return this.lastRawGeoJson;
  }

  async loadRegion(query?: MapRegionQuery): Promise<ProcessedMapData> {
    const lat = query?.centerLat ?? 52.378;
    const lon = query?.centerLon ?? 4.900;
    const radius = query?.radiusMeters ?? 350;
    const name = query?.locationName ?? 'Location';

    const baseUrl = typeof window !== 'undefined' ? '' : 'http://localhost:3000';
    const url = `${baseUrl}/api/osm-data?lat=${lat}&lon=${lon}&radius=${radius}&name=${encodeURIComponent(name)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to fetch OSM data from server (${res.status}): ${errText || res.statusText}`);
    }

    const geojson = await res.json();
    this.lastRawGeoJson = geojson;
    return this.parser.parseGeoJson(geojson, name, [lon, lat], radius);
  }
}
