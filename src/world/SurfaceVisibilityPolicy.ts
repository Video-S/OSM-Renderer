import type { RawGeoJsonProperties, RoadFeature, RailwayFeature } from '../types/MapFeature';
import { classifyInfrastructurePlacement, type InfrastructurePlacementClassification } from './InfrastructurePlacementClassifier';

/**
 * Surface presentation is deliberately separate from OSM vertical ordering and graph connectivity.
 * OSM layer is relative stacking, level is a floor within a building/complex, and ele is an elevation.
 * Neither a negative layer nor a negative level alone proves that a way is buried.
 */
export type SurfaceVisibility = 'surface' | 'elevated' | 'underground' | 'concealed_indoor' | 'conflict';

export interface VisibilitySource {
  osmTags?: RawGeoJsonProperties;
  placementClassification?: InfrastructurePlacementClassification;
  layer?: number;
  isBridge?: boolean;
  isTunnel?: boolean;
}

/** Pure, feature-type-independent visibility classification for normal outdoor presentation. */
export function resolveSurfaceVisibility(source: VisibilitySource): SurfaceVisibility {
  const tags = source.osmTags;
  const placement = source.placementClassification ?? classifyInfrastructurePlacement(tags, {
    layer: source.layer,
    isBridge: source.isBridge,
    isTunnel: source.isTunnel,
  });
  if (placement.hasConflict) return 'conflict';
  if (placement.isSubterraneanTunnel) return 'underground';

  const level = placement.supportingEvidence.level;
  const indoorTag = String(tags?.indoor ?? '').trim().toLowerCase();
  const location = String(tags?.location ?? '').trim().toLowerCase();
  const indoorContext =
    indoorTag === 'yes' || indoorTag === 'room' || indoorTag === 'corridor' ||
    location === 'indoor' || placement.enclosure === 'building_passage';
  if (level !== undefined && level < 0 && indoorContext) return 'concealed_indoor';

  if (placement.isElevatedBridge) return 'elevated';
  return 'surface';
}

export interface TunnelEntranceDecision {
  start: boolean;
  end: boolean;
}

/**
 * A verified tunnel opening requires an end-to-end connection to exposed infrastructure
 * of the same network. Underground-to-underground and isolated ends never open terrain.
 * Coordinate-only evidence is accepted only for tightly coincident, aligned endpoints;
 * when both explicit OSM node IDs exist they must agree.
 */
type LinearFeature = RoadFeature | RailwayFeature;
type End = 'start' | 'end';
interface IndexedEndpoint {
  feature: LinearFeature;
  point: readonly [number, number];
  tangent: readonly [number, number];
  rawNodeId?: string;
}
interface FeatureDecision {
  // Immutable source terminal positions: downstream graph renderers may mutate
  // their working points for snapped transitions after this index is built.
  startPoint: readonly [number, number];
  endPoint: readonly [number, number];
  start: boolean;
  end: boolean;
}

const MAX_ENDPOINT_GAP_METERS = 0.15;
const GRID_METERS = 0.25;
const COS_30 = Math.cos(Math.PI / 6);

function endpoint(feature: LinearFeature, end: End): IndexedEndpoint | undefined {
  const pts = feature.points;
  if (pts.length < 2) return undefined;
  const idx = end === 'start' ? 0 : pts.length - 1;
  const next = end === 'start' ? 1 : pts.length - 2;
  const dx = pts[next][0] - pts[idx][0];
  const dz = pts[next][1] - pts[idx][1];
  const length = Math.hypot(dx, dz);
  if (length <= 1e-4) return undefined;
  // Only use *original* OSM node provenance; grade-scoped synthetic nodeIds
  // are not reliable identifiers across surface/underground transitions.
  const raw = feature.osmTags;
  const ids = raw?.nodes ?? raw?.nodeIds ?? raw?._nodeIds;
  const rawId = Array.isArray(ids) ? ids[idx] : undefined;
  return {
    feature,
    point: pts[idx],
    tangent: [dx / length, dz / length],
    rawNodeId: rawId !== undefined && rawId !== null ? String(rawId).replace(/^node\//, '') : undefined,
  };
}

function compatible(a: LinearFeature, b: LinearFeature): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'railway' && b.type === 'railway') {
    return a.railwayType === b.railwayType;
  }
  if (a.type === 'road' && b.type === 'road') {
    const aPath = ['path', 'footway', 'cycleway', 'steps', 'bridleway', 'pedestrian'].includes(a.roadClass);
    const bPath = ['path', 'footway', 'cycleway', 'steps', 'bridleway', 'pedestrian'].includes(b.roadClass);
    return aPath === bPath;
  }
  return false;
}

function gridKey(cx: number, cz: number): string {
  return cx + ',' + cz;
}

function cell(point: readonly [number, number]): readonly [number, number] {
  return [Math.floor(point[0] / GRID_METERS), Math.floor(point[1] / GRID_METERS)];
}

/**
 * One per-scene decision index, consumed by portal builders and by ground-cover clipping.
 * It is keyed by original source identity AND terminal coordinates so an internally split
 * graph edge cannot accidentally inherit a portal from the source way's other end.
 */
export class VerifiedTunnelEntrances {
  private readonly byId = new Map<string, FeatureDecision[]>();

  constructor(roads: readonly RoadFeature[], railways: readonly RailwayFeature[]) {
    this.addNetwork(roads);
    this.addNetwork(railways);
  }

  private addNetwork(features: readonly LinearFeature[]): void {
    const exposed = new Map<string, IndexedEndpoint[]>();
    const insert = (ep: IndexedEndpoint): void => {
      const [cx, cz] = cell(ep.point);
      const key = gridKey(cx, cz);
      const bucket = exposed.get(key) ?? [];
      bucket.push(ep);
      exposed.set(key, bucket);
    };

    for (const f of features) {
      if (resolveSurfaceVisibility(f) !== 'surface') continue;
      const s = endpoint(f, 'start');
      const e = endpoint(f, 'end');
      if (s) insert(s);
      if (e) insert(e);
    }

    const verified = (candidate: IndexedEndpoint | undefined): boolean => {
      if (!candidate) return false;
      const [cx, cz] = cell(candidate.point);
      for (let x = cx - 1; x <= cx + 1; x++) {
        for (let z = cz - 1; z <= cz + 1; z++) {
          for (const surface of exposed.get(gridKey(x, z)) ?? []) {
            if (!compatible(candidate.feature, surface.feature)) continue;
            if (Math.hypot(
              candidate.point[0] - surface.point[0],
              candidate.point[1] - surface.point[1]
            ) > MAX_ENDPOINT_GAP_METERS) continue;
            if (candidate.rawNodeId && surface.rawNodeId &&
                candidate.rawNodeId !== surface.rawNodeId) continue;
            const dot = -(candidate.tangent[0] * surface.tangent[0] +
                          candidate.tangent[1] * surface.tangent[1]);
            if (dot >= (candidate.rawNodeId && surface.rawNodeId ? 0.5 : COS_30)) return true;
          }
        }
      }
      return false;
    };

    for (const feature of features) {
      if (resolveSurfaceVisibility(feature) !== 'underground') continue;
      const first = feature.points[0];
      const last = feature.points[feature.points.length - 1];
      const decision: FeatureDecision = {
        startPoint: [first[0], first[1]],
        endPoint: [last[0], last[1]],
        start: verified(endpoint(feature, 'start')),
        end: verified(endpoint(feature, 'end')),
      };
      for (const id of new Set([feature.id, feature.sourceFeatureId, ...(feature.sourceFeatureIds ?? [])])) {
        if (!id) continue;
        const bucket = this.byId.get(id) ?? [];
        bucket.push(decision);
        this.byId.set(id, bucket);
      }
    }
  }

  /** Unmatched and interior graph endpoints default to closed, never to speculative portals. */
  forEndpoint(
    ids: readonly (string | undefined)[],
    point: readonly [number, number],
    end: End
  ): boolean {
    for (const id of ids) {
      if (!id) continue;
      for (const candidate of this.byId.get(id) ?? []) {
        const originalPoint = end === 'start' ? candidate.startPoint : candidate.endPoint;
        if (Math.hypot(point[0] - originalPoint[0], point[1] - originalPoint[1]) <= MAX_ENDPOINT_GAP_METERS) {
          return end === 'start' ? candidate.start : candidate.end;
        }
        // Graph edges can reverse their source way orientation. Match the actual
        // endpoint in either direction, but never a non-terminal vertex.
        const opposite = end === 'start' ? candidate.endPoint : candidate.startPoint;
        if (Math.hypot(point[0] - opposite[0], point[1] - opposite[1]) <= MAX_ENDPOINT_GAP_METERS) {
          return end === 'start' ? candidate.end : candidate.start;
        }
      }
    }
    return false;
  }

  forFeature(feature: LinearFeature): TunnelEntranceDecision {
    const ids = [feature.id, feature.sourceFeatureId, ...(feature.sourceFeatureIds ?? [])];
    if (feature.points.length < 2) return { start: false, end: false };
    return {
      start: this.forEndpoint(ids, feature.points[0], 'start'),
      end: this.forEndpoint(ids, feature.points[feature.points.length - 1], 'end'),
    };
  }
}
