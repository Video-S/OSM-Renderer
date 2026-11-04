import { ProcessedMapData } from '../types/MapFeature';

export interface MapRegionQuery {
  centerLat?: number;
  centerLon?: number;
  radiusMeters?: number;
  locationName?: string;
  sourceUrl?: string;
  minLon?: number;
  maxLon?: number;
  minLat?: number;
  maxLat?: number;
}

/**
 * Common provider interface for geographic features.
 * In this version, LocalGeoJsonProvider provides the data.
 * Future implementations could fetch vector tiles (MVT/PMTiles) or Overpass API queries.
 */
export interface MapDataProvider {
  readonly id: string;
  readonly name: string;
  loadRegion(query?: MapRegionQuery): Promise<ProcessedMapData>;
}
