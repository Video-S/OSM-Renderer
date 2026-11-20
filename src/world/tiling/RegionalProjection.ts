import type { CoordinateTransformer } from '../WorldCoordinates';

/**
 * ETRS89 / UTM Zone 32N (EPSG:25832) ellipsoid & Transverse Mercator parameters.
 * Uses GRS80 ellipsoid parameters (identical semi-major axis to WGS84; 1/f = 298.257222101).
 */
export const EPSG_25832_CODE = 'EPSG:25832';
export const GRS80_SEMI_MAJOR_AXIS = 6378137.0;
export const GRS80_INV_FLATTENING = 298.257222101;
export const UTM32N_CENTRAL_MERIDIAN_DEG = 9.0;
export const UTM32N_SCALE_FACTOR = 0.9996;
export const UTM32N_FALSE_EASTING = 500000.0;
export const UTM32N_FALSE_NORTHING = 0.0;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

// Ellipsoid derived constants (GRS80)
const F = 1.0 / GRS80_INV_FLATTENING;
const N = F / (2.0 - F);
const N2 = N * N;
const N3 = N2 * N;
const N4 = N3 * N;

// Rectifying radius A (Karney / Krüger 4th-order)
const A_RECT =
  (GRS80_SEMI_MAJOR_AXIS / (1.0 + N)) * (1.0 + N2 / 4.0 + N4 / 64.0);

// Forward Krüger series coefficients alpha_1..4
const ALPHA1 =
  (1.0 / 2.0) * N -
  (2.0 / 3.0) * N2 +
  (5.0 / 16.0) * N3 +
  (41.0 / 180.0) * N4;
const ALPHA2 =
  (13.0 / 48.0) * N2 - (3.0 / 5.0) * N3 + (557.0 / 1440.0) * N4;
const ALPHA3 = (61.0 / 240.0) * N3 - (103.0 / 140.0) * N4;
const ALPHA4 = (49561.0 / 161280.0) * N4;

// Inverse Krüger series coefficients beta_1..4
const BETA1 =
  (1.0 / 2.0) * N -
  (2.0 / 3.0) * N2 +
  (37.0 / 96.0) * N3 -
  (1.0 / 360.0) * N4;
const BETA2 =
  (1.0 / 48.0) * N2 + (1.0 / 15.0) * N3 - (437.0 / 1440.0) * N4;
const BETA3 = (17.0 / 480.0) * N3 - (37.0 / 840.0) * N4;
const BETA4 = (4397.0 / 161280.0) * N4;

// Conformal to geodetic latitude inverse coefficients delta_1..4
const DELTA1 =
  2.0 * N -
  (2.0 / 3.0) * N2 -
  2.0 * N3 +
  (116.0 / 45.0) * N4;
const DELTA2 =
  (7.0 / 3.0) * N2 - (8.0 / 5.0) * N3 - (227.0 / 45.0) * N4;
const DELTA3 = (56.0 / 15.0) * N3 - (136.0 / 35.0) * N4;
const DELTA4 = (4279.0 / 630.0) * N4;

const E_ELLIPSOID = Math.sqrt(F * (2.0 - F));

function atanh(x: number): number {
  return 0.5 * Math.log((1.0 + x) / (1.0 - x));
}

/**
 * Forward projection from geographic (lon, lat) in degrees to ETRS89 / UTM Zone 32N
 * (easting, northing) in meters using 4th-order Krüger/Karney series (< 1e-6 m precision).
 */
export function geoToUtm32N(lon: number, lat: number): [number, number] {
  const phi = lat * DEG_TO_RAD;
  const lambda = (lon - UTM32N_CENTRAL_MERIDIAN_DEG) * DEG_TO_RAD;

  const sinPhi = Math.sin(phi);
  const Q =
    Math.asinh(Math.tan(phi)) - E_ELLIPSOID * atanh(E_ELLIPSOID * sinPhi);

  const xiPrime = Math.atan(Math.sinh(Q) / Math.cos(lambda));
  const etaPrime = Math.atanh(Math.sin(lambda) / Math.cosh(Q));

  const xi =
    xiPrime +
    ALPHA1 * Math.sin(2 * xiPrime) * Math.cosh(2 * etaPrime) +
    ALPHA2 * Math.sin(4 * xiPrime) * Math.cosh(4 * etaPrime) +
    ALPHA3 * Math.sin(6 * xiPrime) * Math.cosh(6 * etaPrime) +
    ALPHA4 * Math.sin(8 * xiPrime) * Math.cosh(8 * etaPrime);

  const eta =
    etaPrime +
    ALPHA1 * Math.cos(2 * xiPrime) * Math.sinh(2 * etaPrime) +
    ALPHA2 * Math.cos(4 * xiPrime) * Math.sinh(4 * etaPrime) +
    ALPHA3 * Math.cos(6 * xiPrime) * Math.sinh(6 * etaPrime) +
    ALPHA4 * Math.cos(8 * xiPrime) * Math.sinh(8 * etaPrime);

  const easting = UTM32N_FALSE_EASTING + UTM32N_SCALE_FACTOR * A_RECT * eta;
  const northing = UTM32N_FALSE_NORTHING + UTM32N_SCALE_FACTOR * A_RECT * xi;

  return [easting, northing];
}

/**
 * Inverse projection from ETRS89 / UTM Zone 32N (easting, northing) in meters
 * back to geographic (lon, lat) in degrees.
 */
export function utm32NToGeo(easting: number, northing: number): [number, number] {
  const eta = (easting - UTM32N_FALSE_EASTING) / (UTM32N_SCALE_FACTOR * A_RECT);
  const xi = (northing - UTM32N_FALSE_NORTHING) / (UTM32N_SCALE_FACTOR * A_RECT);

  const xiPrime =
    xi -
    (BETA1 * Math.sin(2 * xi) * Math.cosh(2 * eta) +
      BETA2 * Math.sin(4 * xi) * Math.cosh(4 * eta) +
      BETA3 * Math.sin(6 * xi) * Math.cosh(6 * eta) +
      BETA4 * Math.sin(8 * xi) * Math.cosh(8 * eta));

  const etaPrime =
    eta -
    (BETA1 * Math.cos(2 * xi) * Math.sinh(2 * eta) +
      BETA2 * Math.cos(4 * xi) * Math.sinh(4 * eta) +
      BETA3 * Math.cos(6 * xi) * Math.sinh(6 * eta) +
      BETA4 * Math.cos(8 * xi) * Math.sinh(8 * eta));

  const chi = Math.asin(Math.sin(xiPrime) / Math.cosh(etaPrime));
  const phi =
    chi +
    DELTA1 * Math.sin(2 * chi) +
    DELTA2 * Math.sin(4 * chi) +
    DELTA3 * Math.sin(6 * chi) +
    DELTA4 * Math.sin(8 * chi);

  const lambda = Math.atan2(Math.sinh(etaPrime), Math.cos(xiPrime));

  return [
    UTM32N_CENTRAL_MERIDIAN_DEG + lambda * RAD_TO_DEG,
    phi * RAD_TO_DEG,
  ];
}

/**
 * Deterministic regional CoordinateTransformer fixed to ETRS89 / UTM Zone 32N (EPSG:25832),
 * shifted to a local Float64 reference origin `(originEasting, originNorthing)` so local world
 * coordinates remain small meters while preserving the renderer convention:
 *   +X = East, +Y = Up, +Z = South (so z = originNorthing - northing).
 */
export class RegionalProjection implements CoordinateTransformer {
  readonly crs = EPSG_25832_CODE;
  readonly originLon: number;
  readonly originLat: number;
  readonly originEasting: number;
  readonly originNorthing: number;

  constructor(originEasting: number, originNorthing: number) {
    this.originEasting = originEasting;
    this.originNorthing = originNorthing;
    const [lon, lat] = utm32NToGeo(originEasting, originNorthing);
    this.originLon = lon;
    this.originLat = lat;
  }

  static fromLonLatOrigin(originLon: number, originLat: number): RegionalProjection {
    const [easting, northing] = geoToUtm32N(originLon, originLat);
    return new RegionalProjection(easting, northing);
  }

  toUtm(lon: number, lat: number): [number, number] {
    return geoToUtm32N(lon, lat);
  }

  utmToGeo(easting: number, northing: number): [number, number] {
    return utm32NToGeo(easting, northing);
  }

  utmToLocal(easting: number, northing: number): [number, number] {
    const x = easting - this.originEasting;
    const z = this.originNorthing - northing;
    return [x === 0 ? 0 : x, z === 0 ? 0 : z];
  }

  localToUtm(x: number, z: number): [number, number] {
    return [this.originEasting + x, this.originNorthing - z];
  }

  toLocal(lon: number, lat: number): [number, number] {
    const [easting, northing] = geoToUtm32N(lon, lat);
    return this.utmToLocal(easting, northing);
  }

  toGeo(x: number, z: number): [number, number] {
    const [easting, northing] = this.localToUtm(x, z);
    return utm32NToGeo(easting, northing);
  }

  transformRing(coordinates: [number, number][]): [number, number][] {
    return coordinates.map(([lon, lat]) => this.toLocal(lon, lat));
  }

  transformLine(coordinates: [number, number][]): [number, number][] {
    return coordinates.map(([lon, lat]) => this.toLocal(lon, lat));
  }
}
