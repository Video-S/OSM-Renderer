/**
 * Pure, deterministic helpers that enrich GeoJSON FeatureCollections produced by `osmtogeojson`
 * with verified per-vertex OSM node IDs (`properties._nodeIds` / `properties._nodeIdsByPart`)
 * from raw Overpass JSON (`way.nodes`) or OSM 0.6 XML (`<nd ref="...">`).
 *
 * Node IDs are attached ONLY when both way identity AND 1:1 per-vertex coordinate alignment
 * against the source OSM node table are verified.
/**
 * Maximum coordinate alignment deviation between source OSM node table coordinates
 * and osmtogeojson LineString coordinates (degrees).
 *
 * 1e-7 degrees corresponds to ~1.11 cm at the equator and ~0.69 cm at mid-latitudes,
 * matching standard OSM 7-decimal-place precision and floating-point IEEE 754 fidelity,
 * and strictly tighter than the 15 cm (0.15 m) topology snap tolerance.
 */
export const COORD_ALIGNMENT_TOLERANCE_DEG = 1e-7;

interface OsmWayData {
  nodes: string[];
  geometry?: Array<{ lon: number; lat: number }>;
}

function extractCandidateWayId(feature: any): string | undefined {
  const props = feature?.properties || {};
  const candidates = [feature?.id, props.id, props['@id']];

  for (const raw of candidates) {
    if (raw === undefined || raw === null) continue;
    const str = String(raw).trim();
    if (!str) continue;
    if (str.startsWith('way/')) {
      const idPart = str.slice(4).trim();
      if (idPart) return idPart;
    }
    if (str.startsWith('node/') || str.startsWith('relation/')) {
      return undefined;
    }
  }

  for (const raw of candidates) {
    if (raw === undefined || raw === null) continue;
    const str = String(raw).trim();
    if (/^\d+$/.test(str) && props.type !== 'node' && props.type !== 'relation') {
      return str;
    }
  }

  return undefined;
}

function coordsMatch(
  coord: any,
  refLon: number,
  refLat: number,
  tol: number = COORD_ALIGNMENT_TOLERANCE_DEG
): boolean {
  if (!Array.isArray(coord) || coord.length < 2) return false;
  const lon = Number(coord[0]);
  const lat = Number(coord[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  return Math.abs(lon - refLon) <= tol && Math.abs(lat - refLat) <= tol;
}

function getExpectedNodeLonLat(
  nodeId: string,
  idxInWay: number,
  wayData: OsmWayData,
  nodesById: ReadonlyMap<string, [number, number]>
): [number, number] | undefined {
  const fromTable = nodesById.get(nodeId);
  if (fromTable) return fromTable;
  if (wayData.geometry && idxInWay < wayData.geometry.length) {
    const g = wayData.geometry[idxInWay];
    if (g && Number.isFinite(g.lon) && Number.isFinite(g.lat)) {
      return [g.lon, g.lat];
    }
  }
  return undefined;
}

function verifyLineStringAlignment(
  coords: any[],
  wayData: OsmWayData,
  nodesById: ReadonlyMap<string, [number, number]>
): string[] | undefined {
  const wayNodes = wayData.nodes;
  if (!Array.isArray(coords) || coords.length < 2 || coords.length !== wayNodes.length) {
    return undefined;
  }

  for (let i = 0; i < wayNodes.length; i++) {
    const ref = getExpectedNodeLonLat(wayNodes[i], i, wayData, nodesById);
    if (!ref || !coordsMatch(coords[i], ref[0], ref[1])) {
      return undefined;
    }
  }

  return [...wayNodes];
}

function verifyMultiLineStringAlignment(
  linesCoords: any[],
  wayData: OsmWayData,
  nodesById: ReadonlyMap<string, [number, number]>
): string[][] | undefined {
  if (!Array.isArray(linesCoords) || linesCoords.length === 0) return undefined;

  if (linesCoords.length === 1) {
    const aligned = verifyLineStringAlignment(linesCoords[0], wayData, nodesById);
    return aligned ? [aligned] : undefined;
  }

  // For multi-part LineStrings, verify whether parts represent contiguous slices of wayData.nodes
  // (either disjoint consecutive slices or slices sharing split endpoints).
  const wayNodes = wayData.nodes;
  const resultDisjoint: string[][] = [];
  let cursor = 0;
  let disjointValid = true;

  for (const part of linesCoords) {
    if (!Array.isArray(part) || part.length < 2 || cursor + part.length > wayNodes.length) {
      disjointValid = false;
      break;
    }
    const partIds: string[] = [];
    for (let i = 0; i < part.length; i++) {
      const wayIdx = cursor + i;
      const ref = getExpectedNodeLonLat(wayNodes[wayIdx], wayIdx, wayData, nodesById);
      if (!ref || !coordsMatch(part[i], ref[0], ref[1])) {
        disjointValid = false;
        break;
      }
      partIds.push(wayNodes[wayIdx]);
    }
    if (!disjointValid) break;
    resultDisjoint.push(partIds);
    cursor += part.length;
  }

  if (disjointValid && cursor === wayNodes.length) {
    return resultDisjoint;
  }

  // Check contiguous slices sharing boundary vertices (cursor advances by part.length - 1)
  const resultShared: string[][] = [];
  cursor = 0;
  let sharedValid = true;
  for (let pIdx = 0; pIdx < linesCoords.length; pIdx++) {
    const part = linesCoords[pIdx];
    if (!Array.isArray(part) || part.length < 2 || cursor + part.length > wayNodes.length) {
      sharedValid = false;
      break;
    }
    const partIds: string[] = [];
    for (let i = 0; i < part.length; i++) {
      const wayIdx = cursor + i;
      const ref = getExpectedNodeLonLat(wayNodes[wayIdx], wayIdx, wayData, nodesById);
      if (!ref || !coordsMatch(part[i], ref[0], ref[1])) {
        sharedValid = false;
        break;
      }
      partIds.push(wayNodes[wayIdx]);
    }
    if (!sharedValid) break;
    resultShared.push(partIds);
    cursor += part.length - 1;
  }

  if (sharedValid && cursor + 1 === wayNodes.length) {
    return resultShared;
  }

  return undefined;
}

function applyVerifiedNodeIdsToGeoJson(
  geojson: any,
  waysById: ReadonlyMap<string, OsmWayData>,
  nodesById: ReadonlyMap<string, [number, number]>
): any {
  if (!geojson || !Array.isArray(geojson.features)) return geojson;

  for (const feature of geojson.features) {
    if (!feature || !feature.geometry) continue;
    const geom = feature.geometry;
    if (geom.type !== 'LineString' && geom.type !== 'MultiLineString') continue;

    const wayId = extractCandidateWayId(feature);
    if (!wayId) continue;

    const wayData = waysById.get(wayId);
    if (!wayData || !Array.isArray(wayData.nodes) || wayData.nodes.length < 2) continue;

    if (!feature.properties || typeof feature.properties !== 'object') {
      feature.properties = {};
    }

    if (geom.type === 'LineString') {
      const aligned = verifyLineStringAlignment(geom.coordinates, wayData, nodesById);
      if (aligned) {
        feature.properties._nodeIds = aligned;
      }
    } else if (geom.type === 'MultiLineString') {
      const alignedParts = verifyMultiLineStringAlignment(geom.coordinates, wayData, nodesById);
      if (alignedParts) {
        feature.properties._nodeIdsByPart = alignedParts;
        if (alignedParts.length === 1) {
          feature.properties._nodeIds = alignedParts[0];
        }
      }
    }
  }

  return geojson;
}

/**
 * Enriches a GeoJSON FeatureCollection converted from Overpass JSON with verified
 * per-vertex OSM node IDs (`_nodeIds` / `_nodeIdsByPart`).
 */
export function enrichGeoJsonWithOverpassNodeIds(geojson: any, overpassJson: any): any {
  if (!geojson || !overpassJson || !Array.isArray(overpassJson.elements)) {
    return geojson;
  }

  const nodesById = new Map<string, [number, number]>();
  const waysById = new Map<string, OsmWayData>();

  for (const el of overpassJson.elements) {
    if (!el) continue;
    if (el.type === 'node' && el.id !== undefined && Number.isFinite(el.lon) && Number.isFinite(el.lat)) {
      nodesById.set(String(el.id).trim(), [Number(el.lon), Number(el.lat)]);
    } else if (el.type === 'way' && el.id !== undefined && Array.isArray(el.nodes)) {
      const nodeIds = el.nodes
        .map((n: any) => (n !== undefined && n !== null ? String(n).trim() : ''))
        .filter((s: string) => s.length > 0);
      if (nodeIds.length >= 2 && nodeIds.length === el.nodes.length) {
        waysById.set(String(el.id).trim(), {
          nodes: nodeIds,
          geometry: Array.isArray(el.geometry) ? el.geometry : undefined,
        });
      }
    }
  }

  return applyVerifiedNodeIdsToGeoJson(geojson, waysById, nodesById);
}

/**
 * Enriches a GeoJSON FeatureCollection converted from OSM 0.6 XML (`xmlDoc`) with verified
 * per-vertex OSM node IDs (`_nodeIds` / `_nodeIdsByPart`).
 */
export function enrichGeoJsonWithOsmXmlNodeIds(geojson: any, xmlDoc: any): any {
  if (!geojson || !xmlDoc || typeof xmlDoc.getElementsByTagName !== 'function') {
    return geojson;
  }

  const nodesById = new Map<string, [number, number]>();
  const waysById = new Map<string, OsmWayData>();

  const nodeEls = xmlDoc.getElementsByTagName('node');
  for (let i = 0; i < nodeEls.length; i++) {
    const nodeEl = nodeEls[i];
    const id = nodeEl.getAttribute?.('id')?.trim();
    const lon = Number(nodeEl.getAttribute?.('lon'));
    const lat = Number(nodeEl.getAttribute?.('lat'));
    if (id && Number.isFinite(lon) && Number.isFinite(lat)) {
      nodesById.set(id, [lon, lat]);
    }
  }

  const wayEls = xmlDoc.getElementsByTagName('way');
  for (let i = 0; i < wayEls.length; i++) {
    const wayEl = wayEls[i];
    const id = wayEl.getAttribute?.('id')?.trim();
    if (!id) continue;
    const ndEls = wayEl.getElementsByTagName?.('nd');
    if (!ndEls || ndEls.length < 2) continue;

    const nodeIds: string[] = [];
    let allValid = true;
    for (let j = 0; j < ndEls.length; j++) {
      const ref = ndEls[j].getAttribute?.('ref')?.trim();
      if (!ref) {
        allValid = false;
        break;
      }
      nodeIds.push(ref);
    }

    if (allValid && nodeIds.length >= 2) {
      waysById.set(id, { nodes: nodeIds });
    }
  }

  return applyVerifiedNodeIdsToGeoJson(geojson, waysById, nodesById);
}
