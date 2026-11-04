/**
 * Coordinate projection module for converting geographic WGS84 coordinates (lon, lat)
 * to local Euclidean 3D space in meters (X = East, Y = Up, Z = South).
 *
 * Designed with a clean interface so the underlying local Equirectangular / Transverse Mercator
 * projection can be swapped or augmented with web mercator / vector tile coordinates in the future.
 */

export const WGS84_EQUATORIAL_RADIUS = 6378137.0; // WGS84 semi-major axis in meters

export interface CoordinateTransformer {
  originLon: number;
  originLat: number;
  toLocal(lon: number, lat: number): [number, number]; // [x, z] meters
  toGeo(x: number, z: number): [number, number]; // [lon, lat]
}

/**
 * Projects (lon, lat) in degrees into local Cartesian (x, z) coordinates in meters
 * relative to an origin (originLon, originLat).
 * - X axis points East (+X)
 * - Z axis points South (+Z), so North is (-Z)
 * - Y axis represents vertical elevation
 */
export function projectToLocalMeters(
  lon: number,
  lat: number,
  originLon: number,
  originLat: number
): [number, number] {
  const rad = Math.PI / 180;
  const latRad = originLat * rad;
  const cosLat = Math.cos(latRad);

  const x = WGS84_EQUATORIAL_RADIUS * (lon - originLon) * rad * cosLat;
  const z = -WGS84_EQUATORIAL_RADIUS * (lat - originLat) * rad;

  return [x === 0 ? 0 : x, z === 0 ? 0 : z];
}

/**
 * Inverse projection: converts local (x, z) meters back to (lon, lat) degrees.
 */
export function unprojectToGeo(
  x: number,
  z: number,
  originLon: number,
  originLat: number
): [number, number] {
  const rad = Math.PI / 180;
  const latRad = originLat * rad;
  const cosLat = Math.cos(latRad);

  const lon = originLon + (x / (WGS84_EQUATORIAL_RADIUS * cosLat)) * (180 / Math.PI);
  const lat = originLat - (z / WGS84_EQUATORIAL_RADIUS) * (180 / Math.PI);

  return [lon, lat];
}

/**
 * Haversine formula for calculating ground distance between two (lon, lat) coordinates in meters.
 */
export function haversineDistanceMeters(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number
): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const lat1Rad = lat1 * rad;
  const lat2Rad = lat2 * rad;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return WGS84_EQUATORIAL_RADIUS * c;
}

/**
 * WorldCoordinates helper class to store origin and convert batch coordinates efficiently.
 */
export class WorldCoordinates implements CoordinateTransformer {
  readonly originLon: number;
  readonly originLat: number;
  private readonly cosLat: number;
  private readonly rad: number = Math.PI / 180;
  private readonly deg: number = 180 / Math.PI;

  constructor(originLon: number, originLat: number) {
    this.originLon = originLon;
    this.originLat = originLat;
    this.cosLat = Math.cos(originLat * this.rad);
  }

  toLocal(lon: number, lat: number): [number, number] {
    const x = WGS84_EQUATORIAL_RADIUS * (lon - this.originLon) * this.rad * this.cosLat;
    const z = -WGS84_EQUATORIAL_RADIUS * (lat - this.originLat) * this.rad;
    return [x === 0 ? 0 : x, z === 0 ? 0 : z];
  }

  toGeo(x: number, z: number): [number, number] {
    const lon = this.originLon + (x / (WGS84_EQUATORIAL_RADIUS * this.cosLat)) * this.deg;
    const lat = this.originLat - (z / WGS84_EQUATORIAL_RADIUS) * this.deg;
    return [lon, lat];
  }

  /**
   * Transforms an array of [lon, lat] coordinates into [x, z] meters.
   */
  transformRing(coordinates: [number, number][]): [number, number][] {
    return coordinates.map(([lon, lat]) => this.toLocal(lon, lat));
  }

  /**
   * Transforms an array of [lon, lat] polyline vertices into [x, z] meters.
   */
  transformLine(coordinates: [number, number][]): [number, number][] {
    return coordinates.map(([lon, lat]) => this.toLocal(lon, lat));
  }
}
