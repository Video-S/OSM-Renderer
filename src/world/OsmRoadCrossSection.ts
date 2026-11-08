import { RawGeoJsonProperties, RoadClass } from '../types/MapFeature';
import { ROAD_CLASS_WIDTHS } from './FeatureCatalogue';
import { isNonVehicularRoadClass } from './ElevationPolicy';

/**
 * Resolved physical cross-section profile for a road way or graph sub-segment.
 *
 * Represents independently determined left and right lateral offsets (`leftOffset`, `rightOffset`)
 * from the OSM reference polyline at the start and end of the segment so that asymmetric
 * `placement` tags (`left_of:k`, `middle_of:k`, `right_of:k`), `placement:start` / `placement:end`
 * transitions, and on-carriageway painted cycle lanes (`cycleway*=lane`) are modeled consistently
 * across ribbons, junction portals, degree-2 joins, and 2D Boolean clipping footprints.
 */
export interface RoadCrossSectionProfile {
  /** Base unscaled road width in meters. */
  width: number;
  /** Total scaled physical width at the start of the segment (`startLeftOffset + startRightOffset`). */
  startWidth: number;
  /** Total scaled physical width at the end of the segment (`endLeftOffset + endRightOffset`). */
  endWidth: number;
  /** Scaled lateral offset (meters) to the physical left curb at the start of the segment. */
  startLeftOffset: number;
  /** Scaled lateral offset (meters) to the physical right curb at the start of the segment. */
  startRightOffset: number;
  /** Scaled lateral offset (meters) to the physical left curb at the end of the segment. */
  endLeftOffset: number;
  /** Scaled lateral offset (meters) to the physical right curb at the end of the segment. */
  endRightOffset: number;
  /** Resolved motor-vehicle lane count if inferred or explicitly tagged. */
  resolvedLanes?: number;
  /** Provenance tier of the resolved carriageway width. */
  widthSource:
    | 'explicit_width_carriageway'
    | 'explicit_width'
    | 'catalogue_default'
    | 'lanes_and_cycleway'
    | 'class_default';
  /** True if left and right offsets are asymmetric or vary from start to end. */
  isAsymmetricOrTapered: boolean;
}

/**
 * Parsed OSM lane count metadata across total, directional, and turn-lane tags.
 */
export interface OsmLaneCountResolution {
  /** Effective motor-vehicle lane count in `[1, 12]`. */
  totalLanes?: number;
  /** Explicit forward lane count if tagged via `lanes:forward` or `turn:lanes:forward`. */
  forwardLanes?: number;
  /** Explicit backward lane count if tagged via `lanes:backward` or `turn:lanes:backward`. */
  backwardLanes?: number;
  /** Explicit bi-directional center lane count if tagged via `lanes:both_ways`. */
  bothWaysLanes?: number;
  /** Lane count derived from pipe-delimited `turn:lanes*` tags. */
  turnLanesCount?: number;
  /** True if an explicit `lanes` or `lanes:*` numeric tag was present and valid. */
  hasExplicitLaneTag: boolean;
}

const VALID_TURN_LANE_TOKENS = new Set<string>([
  'left',
  'right',
  'through',
  'none',
  'slight_left',
  'slight_right',
  'sharp_left',
  'sharp_right',
  'merge_to_left',
  'merge_to_right',
  'reverse',
]);

const ON_ROAD_CYCLEWAY_VALUES = new Set<string>([
  'lane',
  'opposite_lane',
  'shared_lane',
]);

/**
 * Parses an explicit metric width string or number (e.g. `"7.2"`, `"7.2 m"`, `"7,2m"`).
 * Rejects non-positive, non-finite, malformed, compound (`"3.5;4.0"`), or out-of-range values.
 */
export function parseExplicitMetricWidth(
  raw: unknown,
  maxAllowedMeters = 120
): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0.4 && raw <= maxAllowedMeters ? raw : undefined;
  }
  const str = String(raw).trim().replace(',', '.');
  if (str.length === 0) return undefined;
  const match = /^([+-]?\d+(?:\.\d+)?)\s*(?:m|meter|meters|metres)?$/i.exec(str);
  if (!match) return undefined;
  const val = Number(match[1]);
  if (!Number.isFinite(val) || val < 0.4 || val > maxAllowedMeters) {
    return undefined;
  }
  return val;
}

/**
 * Parses a positive lane count tag in `[1, maxLanes]` (supports integer or `.5` values).
 */
export function parseValidLaneCount(raw: unknown, maxLanes = 12): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const str = String(raw).trim();
  if (!/^\d+(?:\.5)?$/.test(str)) return undefined;
  const val = Number(str);
  if (!Number.isFinite(val) || val < 1 || val > maxLanes) return undefined;
  return val;
}

/**
 * Parses a pipe-delimited `turn:lanes*` tag (e.g. `"left|through|right"` or `"left|"`),
 * validating that each non-empty compartment contains recognized turn tokens.
 */
export function parseTurnLanesCompartmentCount(raw: unknown, maxLanes = 12): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const str = String(raw).trim().toLowerCase();
  if (str.length === 0) return undefined;

  const parts = str.split('|');
  // A single token with no pipe must be an explicit recognized turn value
  if (parts.length === 1) {
    const tokens = parts[0]
      .split(';')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (tokens.length === 0 || !tokens.every((t) => VALID_TURN_LANE_TOKENS.has(t))) {
      return undefined;
    }
    return 1;
  }

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue; // empty compartment in e.g. "left|" is valid in OSM
    const tokens = trimmed
      .split(';')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (tokens.length === 0 || !tokens.every((t) => VALID_TURN_LANE_TOKENS.has(t))) {
      return undefined;
    }
  }

  return parts.length >= 1 && parts.length <= maxLanes ? parts.length : undefined;
}

/**
 * Determines whether OSM tags represent a one-way road and whether its traffic flow is
 * reversed (`oneway=-1` or `oneway=reverse`) relative to the digitized way direction.
 */
export function resolveOnewayOrientation(osmTags?: RawGeoJsonProperties): {
  isOneWay: boolean;
  isReverseOneWay: boolean;
} {
  const onewayVal = String(osmTags?.oneway ?? '').trim().toLowerCase();
  const isReverseOneWay = onewayVal === '-1' || onewayVal === 'reverse';
  const isOneWay =
    onewayVal === 'yes' ||
    onewayVal === '1' ||
    onewayVal === 'true' ||
    isReverseOneWay ||
    String(osmTags?.junction ?? '').trim().toLowerCase() === 'roundabout';
  return { isOneWay, isReverseOneWay };
}

/**
 * Resolves effective motor-vehicle lane counts from `lanes`, `lanes:forward`, `lanes:backward`,
 * `lanes:both_ways`, and `turn:lanes*` tags with deterministic precedence and sanity bounds.
 */
export function resolveOsmLaneCounts(
  osmTags: RawGeoJsonProperties | undefined,
  isOneWay: boolean,
  isReverseOneWay: boolean
): OsmLaneCountResolution {
  if (!osmTags) {
    return { hasExplicitLaneTag: false };
  }

  const taggedLanes = parseValidLaneCount(osmTags.lanes, 12);
  const fwdLanes = parseValidLaneCount(osmTags['lanes:forward'], 8);
  const bwdLanes = parseValidLaneCount(osmTags['lanes:backward'], 8);
  const bothLanes = parseValidLaneCount(osmTags['lanes:both_ways'], 4);

  const turnAll = parseTurnLanesCompartmentCount(osmTags['turn:lanes'], 12);
  const turnFwd = parseTurnLanesCompartmentCount(osmTags['turn:lanes:forward'], 8);
  const turnBwd = parseTurnLanesCompartmentCount(osmTags['turn:lanes:backward'], 8);
  const turnBoth = parseTurnLanesCompartmentCount(osmTags['turn:lanes:both_ways'], 4);

  const hasExplicitLaneTag =
    taggedLanes !== undefined ||
    fwdLanes !== undefined ||
    bwdLanes !== undefined ||
    bothLanes !== undefined;

  let dirTotal: number | undefined;
  if (isOneWay) {
    if (isReverseOneWay) {
      dirTotal = bwdLanes ?? fwdLanes;
    } else {
      dirTotal = fwdLanes ?? bwdLanes;
    }
  } else {
    if (fwdLanes !== undefined && bwdLanes !== undefined) {
      dirTotal = Math.min(12, fwdLanes + bwdLanes + (bothLanes ?? 0));
    } else if (taggedLanes === undefined && (fwdLanes !== undefined || bwdLanes !== undefined)) {
      dirTotal = Math.min(12, (fwdLanes ?? 1) + (bwdLanes ?? 1) + (bothLanes ?? 0));
    }
  }

  let turnLanesCount: number | undefined;
  if (isOneWay) {
    turnLanesCount = isReverseOneWay ? (turnBwd ?? turnAll ?? turnFwd) : (turnFwd ?? turnAll ?? turnBwd);
  } else {
    if (turnFwd !== undefined && turnBwd !== undefined) {
      turnLanesCount = Math.min(12, turnFwd + turnBwd + (turnBoth ?? bothLanes ?? 0));
    } else if (turnFwd !== undefined) {
      turnLanesCount = Math.min(12, turnFwd + (bwdLanes ?? 1) + (turnBoth ?? bothLanes ?? 0));
    } else if (turnBwd !== undefined) {
      turnLanesCount = Math.min(12, (fwdLanes ?? 1) + turnBwd + (turnBoth ?? bothLanes ?? 0));
    } else if (turnAll !== undefined) {
      turnLanesCount = turnAll;
    }
  }

  // Precedence:
  // 1. When both `lanes:forward` and `lanes:backward` are explicitly given on a two-way road,
  //    their sum (`dirTotal`) is authoritative over a potentially stale `lanes` tag.
  // 2. Otherwise use `taggedLanes ?? dirTotal`.
  // 3. If `turn:lanes*` indicates a wider turn-pocket lane count at an approach, take `Math.max`.
  let baseLanes: number | undefined;
  if (!isOneWay && fwdLanes !== undefined && bwdLanes !== undefined) {
    baseLanes = dirTotal;
  } else {
    baseLanes = taggedLanes ?? dirTotal;
  }

  let totalLanes = baseLanes;
  if (turnLanesCount !== undefined) {
    totalLanes = totalLanes !== undefined ? Math.max(totalLanes, turnLanesCount) : turnLanesCount;
  }

  return {
    totalLanes,
    forwardLanes: fwdLanes ?? turnFwd,
    backwardLanes: bwdLanes ?? turnBwd,
    bothWaysLanes: bothLanes ?? turnBoth,
    turnLanesCount,
    hasExplicitLaneTag,
  };
}

/**
 * Resolves on-carriageway painted cycleway lane widths (`leftCycleWidth`, `rightCycleWidth`)
 * in the digitized OSM way direction.
 *
 * Physical surface semantics:
 * - Only painted on-carriageway cycle lanes (`cycleway*=lane | opposite_lane | shared_lane`)
 *   share the physical asphalt carriageway between curbs.
 * - Separated cycle tracks (`cycleway*=track | opposite_track | separate`), `share_busway`,
 *   or `bicycle=use_sidepath` are physically separated or share an existing motor lane and
 *   NEVER widen the motor-vehicle carriageway.
 */
export function resolveOnRoadCyclewayOffsets(
  osmTags: RawGeoJsonProperties | undefined,
  roadClass: RoadClass,
  isOneWay: boolean,
  isReverseOneWay: boolean
): { leftCycleWidth: number; rightCycleWidth: number } {
  if (!osmTags || isNonVehicularRoadClass(roadClass)) {
    return { leftCycleWidth: 0, rightCycleWidth: 0 };
  }

  const rawCycleway = String(osmTags.cycleway ?? '').trim().toLowerCase();
  const rawBoth = String(osmTags['cycleway:both'] ?? '').trim().toLowerCase();
  const rawLeft = String(osmTags['cycleway:left'] ?? '').trim().toLowerCase();
  const rawRight = String(osmTags['cycleway:right'] ?? '').trim().toLowerCase();

  let leftKind = rawLeft || rawBoth;
  let rightKind = rawRight || rawBoth;

  if (!leftKind && !rightKind && ON_ROAD_CYCLEWAY_VALUES.has(rawCycleway)) {
    if (!isOneWay) {
      leftKind = rawCycleway;
      rightKind = rawCycleway;
    } else if (rawCycleway === 'opposite_lane') {
      // Contraflow cycle lane on the opposing side (driver's left)
      if (isReverseOneWay) {
        rightKind = rawCycleway;
      } else {
        leftKind = rawCycleway;
      }
    } else {
      // Standard one-way on-road cycle lane on driver's right
      if (isReverseOneWay) {
        leftKind = rawCycleway;
      } else {
        rightKind = rawCycleway;
      }
    }
  }

  const resolveSideWidth = (kind: string, side: 'left' | 'right'): number => {
    if (!ON_ROAD_CYCLEWAY_VALUES.has(kind)) return 0;
    const explicitSideW =
      parseExplicitMetricWidth(osmTags[`cycleway:${side}:width`], 3.5) ??
      parseExplicitMetricWidth(osmTags['cycleway:both:width'], 3.5) ??
      parseExplicitMetricWidth(osmTags['cycleway:width'], 3.5);
    if (explicitSideW !== undefined && explicitSideW >= 0.5) {
      return explicitSideW;
    }
    return kind === 'shared_lane' ? 1.25 : 1.5;
  };

  return {
    leftCycleWidth: resolveSideWidth(leftKind, 'left'),
    rightCycleWidth: resolveSideWidth(rightKind, 'right'),
  };
}

function getPerLaneWidthForClass(roadClass: RoadClass, baseWidth: number, totalLanes: number): number {
  switch (roadClass) {
    case 'motorway':
      return 3.6;
    case 'trunk':
    case 'primary':
      return 3.5;
    case 'secondary':
      return baseWidth * 0.5; // 3.6m (2 lanes = 7.2m)
    case 'tertiary':
      return baseWidth * 0.5; // 3.3m (2 lanes = 6.6m)
    case 'unclassified':
      return totalLanes === 1 ? 3.6 : 2.75;
    case 'residential':
      return totalLanes === 1 ? 3.6 : 2.7;
    case 'living_street':
      return totalLanes === 1 ? 3.25 : 2.5;
    case 'service':
      return totalLanes === 1 ? 3.5 : 2.75;
    default:
      return Math.max(2.5, baseWidth * 0.5);
  }
}

/**
 * Resolves the canonical unscaled physical carriageway width (in meters) for an OSM way
 * following the Stage E2 evidence hierarchy:
 * 1. Explicit `width:carriageway` (on vehicular roads)
 * 2. Explicit `width`
 * 3. Subtype-specific `catalogueDefaultWidth` (runway, taxiway, pier, platform, etc.)
 * 4. Subordinated service (`parking_aisle`, `driveway`) and non-vehicular path defaults
 * 5. Explicit lane counts (`lanes`, `lanes:forward`/`lanes:backward`, `turn:lanes`) +
 *    painted on-carriageway cycle lanes (`cycleway*=lane`)
 * 6. Conservative class & one-way default width (`ROAD_CLASS_WIDTHS`).
 */
export function resolveOsmRoadWidth(
  roadClass: RoadClass,
  osmTags: RawGeoJsonProperties | undefined,
  catalogueDefaultWidth?: number,
  options?: { suppressInferredLaneWidening?: boolean }
): number {
  const maxExplicit = roadClass === 'runway' || roadClass === 'taxiway' ? 120 : 60;

  if (!isNonVehicularRoadClass(roadClass)) {
    const cw = parseExplicitMetricWidth(osmTags?.['width:carriageway'], maxExplicit);
    if (cw !== undefined) {
      return cw;
    }
  }

  const explicitWidth = parseExplicitMetricWidth(osmTags?.width, maxExplicit);
  if (explicitWidth !== undefined) {
    return explicitWidth;
  }

  if (
    typeof catalogueDefaultWidth === 'number' &&
    Number.isFinite(catalogueDefaultWidth) &&
    catalogueDefaultWidth > 0
  ) {
    return catalogueDefaultWidth;
  }

  const hw = String(osmTags?.highway || '').trim().toLowerCase();
  const isLink = hw.endsWith('_link');
  const base = ROAD_CLASS_WIDTHS[roadClass] || 5.4;

  // Subordinated service ways (driveways, parking aisles)
  const serviceType = String(osmTags?.service || '').trim().toLowerCase();
  if (roadClass === 'service' && (serviceType === 'parking_aisle' || serviceType === 'driveway')) {
    return 3.0;
  }

  if (isNonVehicularRoadClass(roadClass)) {
    return base;
  }

  const { isOneWay, isReverseOneWay } = resolveOnewayOrientation(osmTags);

  if (isLink) {
    const linkDefault = Math.min(Math.max(base * 0.55, 3.6), 5.0);
    if (!options?.suppressInferredLaneWidening && osmTags) {
      const laneInfo = resolveOsmLaneCounts(osmTags, isOneWay, isReverseOneWay);
      const cycleInfo = resolveOnRoadCyclewayOffsets(osmTags, roadClass, isOneWay, isReverseOneWay);
      const cycleW = cycleInfo.leftCycleWidth + cycleInfo.rightCycleWidth;
      if (laneInfo.totalLanes !== undefined && laneInfo.totalLanes >= 2) {
        return Number(Math.min(28.0, laneInfo.totalLanes * 3.5 + cycleW).toFixed(4));
      }
      if (cycleW > 0) {
        return Number((linkDefault + cycleW).toFixed(4));
      }
    }
    return linkDefault;
  }

  const defaultWidth = isOneWay ? Math.max(base * 0.62, 3.6) : base;
  if (options?.suppressInferredLaneWidening || !osmTags) {
    return defaultWidth;
  }

  const laneInfo = resolveOsmLaneCounts(osmTags, isOneWay, isReverseOneWay);
  const cycleInfo = resolveOnRoadCyclewayOffsets(osmTags, roadClass, isOneWay, isReverseOneWay);
  const cycleW = cycleInfo.leftCycleWidth + cycleInfo.rightCycleWidth;
  const baselineLanes = isOneWay ? 1 : 2;

  let motorWidth = defaultWidth;
  if (laneInfo.totalLanes !== undefined && laneInfo.totalLanes !== baselineLanes) {
    const laneWidth = getPerLaneWidthForClass(roadClass, base, laneInfo.totalLanes);
    motorWidth = Math.min(36.0, Math.max(3.0, laneInfo.totalLanes * laneWidth));
  }

  return Number((motorWidth + cycleW).toFixed(4));
}

interface ParsedPlacementSpec {
  kind: 'spec' | 'transition';
  mode?: 'left_of' | 'middle_of' | 'right_of';
  laneIndex?: number;
}

function parsePlacementValue(raw: unknown): ParsedPlacementSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  const str = String(raw).trim().toLowerCase();
  if (str.length === 0) return undefined;
  if (str === 'transition') {
    return { kind: 'transition' };
  }
  const match = /^(left_of|middle_of|right_of):(\d+)$/.exec(str);
  if (!match) return undefined;
  const laneIndex = parseInt(match[2], 10);
  if (!Number.isFinite(laneIndex) || laneIndex < 1 || laneIndex > 12) {
    return undefined;
  }
  return {
    kind: 'spec',
    mode: match[1] as 'left_of' | 'middle_of' | 'right_of',
    laneIndex,
  };
}

function getLaneRelativePosition(
  mode: 'left_of' | 'middle_of' | 'right_of',
  laneIndex: number
): number {
  if (mode === 'left_of') return laneIndex - 1;
  if (mode === 'middle_of') return laneIndex - 0.5;
  return laneIndex;
}

/**
 * Resolves the start and end left/right lateral offsets (in meters) for a road segment
 * from its base width, `roadClass`, and `osmTags`, honoring `placement`, `placement:start`,
 * `placement:end`, `placement:forward`, `placement:backward`, `oneway=-1`, and graph
 * segment reversal (`reversedRelativeToSource`).
 */
export function resolveSegmentCrossSectionProfile(
  baseWidth: number,
  roadClass: RoadClass,
  osmTags: RawGeoJsonProperties | undefined,
  options?: {
    reversedRelativeToSource?: boolean;
    roadWidthMultiplier?: number;
    suppressAsymmetricPlacement?: boolean;
  }
): RoadCrossSectionProfile {
  const mult = options?.roadWidthMultiplier ?? 1;
  const reversed = Boolean(options?.reversedRelativeToSource);
  const scaledBase = baseWidth * mult;

  const maxExplicit = roadClass === 'runway' || roadClass === 'taxiway' ? 120 : 60;
  const hasExplicitCarriageway =
    !isNonVehicularRoadClass(roadClass) &&
    parseExplicitMetricWidth(osmTags?.['width:carriageway'], maxExplicit) !== undefined;
  const hasExplicitWidth = parseExplicitMetricWidth(osmTags?.width, maxExplicit) !== undefined;

  const rawStartW =
    (!isNonVehicularRoadClass(roadClass)
      ? parseExplicitMetricWidth(osmTags?.['width:carriageway:start'], maxExplicit)
      : undefined) ?? parseExplicitMetricWidth(osmTags?.['width:start'], maxExplicit);
  const rawEndW =
    (!isNonVehicularRoadClass(roadClass)
      ? parseExplicitMetricWidth(osmTags?.['width:carriageway:end'], maxExplicit)
      : undefined) ?? parseExplicitMetricWidth(osmTags?.['width:end'], maxExplicit);

  const startWidth = rawStartW !== undefined ? rawStartW * mult : scaledBase;
  const endWidth = rawEndW !== undefined ? rawEndW * mult : scaledBase;

  const widthSource: RoadCrossSectionProfile['widthSource'] = hasExplicitCarriageway
    ? 'explicit_width_carriageway'
    : hasExplicitWidth
      ? 'explicit_width'
      : 'class_default';

  if (
    !osmTags ||
    isNonVehicularRoadClass(roadClass) ||
    options?.suppressAsymmetricPlacement
  ) {
    const sHalf = startWidth * 0.5;
    const eHalf = endWidth * 0.5;
    return reversed
      ? {
          width: baseWidth,
          startWidth: endWidth,
          endWidth: startWidth,
          startLeftOffset: eHalf,
          startRightOffset: eHalf,
          endLeftOffset: sHalf,
          endRightOffset: sHalf,
          widthSource,
          isAsymmetricOrTapered: Math.abs(startWidth - endWidth) > 1e-4,
        }
      : {
          width: baseWidth,
          startWidth,
          endWidth,
          startLeftOffset: sHalf,
          startRightOffset: sHalf,
          endLeftOffset: eHalf,
          endRightOffset: eHalf,
          widthSource,
          isAsymmetricOrTapered: Math.abs(startWidth - endWidth) > 1e-4,
        };
  }

  const { isOneWay, isReverseOneWay } = resolveOnewayOrientation(osmTags);
  const laneInfo = resolveOsmLaneCounts(osmTags, isOneWay, isReverseOneWay);
  const cycleInfo = resolveOnRoadCyclewayOffsets(osmTags, roadClass, isOneWay, isReverseOneWay);

  const baseClassWidth = ROAD_CLASS_WIDTHS[roadClass] || 5.4;
  const oneWayDefaultWidth = Math.max(baseClassWidth * 0.62, 3.6);

  // Detect if an acute V-split branch without explicit width was clamped to the 1-lane one-way default
  const wasClampedToSingleLaneSplit =
    isOneWay &&
    !hasExplicitCarriageway &&
    !hasExplicitWidth &&
    laneInfo.totalLanes !== undefined &&
    laneInfo.totalLanes >= 2 &&
    Math.abs(baseWidth - oneWayDefaultWidth) < 1e-3 &&
    baseWidth < baseClassWidth - 0.5;

  const baselineLanes = isOneWay ? 1 : 2;
  let effectiveLanes = wasClampedToSingleLaneSplit
    ? 1
    : (laneInfo.totalLanes ?? baselineLanes);

  // If no explicit lane count was tagged on a wide road, allow a conservative placement=*:2 to imply 2 lanes
  if (
    !wasClampedToSingleLaneSplit &&
    laneInfo.totalLanes === undefined &&
    !laneInfo.hasExplicitLaneTag &&
    baseWidth >= 6.0
  ) {
    const pGen = parsePlacementValue(osmTags.placement);
    const pStart = parsePlacementValue(osmTags['placement:start']);
    const pEnd = parsePlacementValue(osmTags['placement:end']);
    const maxTaggedIdx = Math.max(
      pGen?.laneIndex ?? 0,
      pStart?.laneIndex ?? 0,
      pEnd?.laneIndex ?? 0
    );
    if (maxTaggedIdx >= 2 && maxTaggedIdx <= 4) {
      effectiveLanes = Math.max(effectiveLanes, maxTaggedIdx);
    }
  }

  const maxCycleBudget = Math.min(startWidth, endWidth) * 0.45;
  const rawCLeft = cycleInfo.leftCycleWidth * mult;
  const rawCRight = cycleInfo.rightCycleWidth * mult;
  const rawCSum = rawCLeft + rawCRight;
  const cycleScale = rawCSum > maxCycleBudget && rawCSum > 0 ? maxCycleBudget / rawCSum : 1;
  const cLeft = rawCLeft * cycleScale;
  const cRight = rawCRight * cycleScale;

  const resolveEndpointOffsets = (
    which: 'start' | 'end',
    totalW: number
  ): { left: number; right: number } => {
    const motorW = Math.max(0, totalW - cLeft - cRight);
    const laneW = motorW / Math.max(1, effectiveLanes);

    if (wasClampedToSingleLaneSplit) {
      return { left: totalW * 0.5, right: totalW * 0.5 };
    }

    const specificRaw =
      which === 'start' ? osmTags['placement:start'] : osmTags['placement:end'];
    const specificSpec = parsePlacementValue(specificRaw);
    const generalSpec = parsePlacementValue(osmTags.placement);

    const activeSpec = specificSpec ?? generalSpec;
    if (activeSpec) {
      if (activeSpec.kind === 'transition') {
        return {
          left: motorW * 0.5 + cLeft,
          right: motorW * 0.5 + cRight,
        };
      }
      if (
        activeSpec.mode &&
        activeSpec.laneIndex !== undefined &&
        activeSpec.laneIndex >= 1 &&
        activeSpec.laneIndex <= effectiveLanes
      ) {
        const rel = getLaneRelativePosition(activeSpec.mode, activeSpec.laneIndex);
        const uFromDriverLeft = Math.max(0, Math.min(motorW, rel * laneW));
        // When oneway=-1 / reverse, lanes 1..N are indexed from left to right in the reverse (driving) direction
        const uFromDigitizedLeft = isReverseOneWay
          ? motorW - uFromDriverLeft
          : uFromDriverLeft;
        return {
          left: uFromDigitizedLeft + cLeft,
          right: motorW - uFromDigitizedLeft + cRight,
        };
      }
      // Conflicting lane index (e.g. placement=middle_of:4 on a 2-lane road) -> safe symmetric fallback
      return {
        left: motorW * 0.5 + cLeft,
        right: motorW * 0.5 + cRight,
      };
    }

    // Check directional placement tags on two-way roads (placement:forward / placement:backward)
    if (!isOneWay) {
      const fwdRaw =
        (which === 'start' ? osmTags['placement:forward:start'] : osmTags['placement:forward:end']) ??
        osmTags['placement:forward'];
      const bwdRaw =
        (which === 'start'
          ? osmTags['placement:backward:start']
          : osmTags['placement:backward:end']) ?? osmTags['placement:backward'];
      const fwdSpec = parsePlacementValue(fwdRaw);
      const bwdSpec = parsePlacementValue(bwdRaw);

      const nBwd = laneInfo.backwardLanes ?? Math.max(1, Math.floor(effectiveLanes / 2));
      const nBoth = laneInfo.bothWaysLanes ?? 0;
      const nFwd = Math.max(1, effectiveLanes - nBwd - nBoth);

      if (
        fwdSpec?.kind === 'spec' &&
        fwdSpec.mode &&
        fwdSpec.laneIndex !== undefined &&
        fwdSpec.laneIndex <= nFwd
      ) {
        const rel = getLaneRelativePosition(fwdSpec.mode, fwdSpec.laneIndex);
        const uFromDigitizedLeft = Math.max(
          0,
          Math.min(motorW, (nBwd + nBoth + rel) * laneW)
        );
        return {
          left: uFromDigitizedLeft + cLeft,
          right: motorW - uFromDigitizedLeft + cRight,
        };
      }

      if (
        bwdSpec?.kind === 'spec' &&
        bwdSpec.mode &&
        bwdSpec.laneIndex !== undefined &&
        bwdSpec.laneIndex <= nBwd
      ) {
        const rel = getLaneRelativePosition(bwdSpec.mode, bwdSpec.laneIndex);
        const uFromDigitizedLeft = Math.max(0, Math.min(motorW, (nBwd - rel) * laneW));
        return {
          left: uFromDigitizedLeft + cLeft,
          right: motorW - uFromDigitizedLeft + cRight,
        };
      }
    }

    return {
      left: motorW * 0.5 + cLeft,
      right: motorW * 0.5 + cRight,
    };
  };

  const startOff = resolveEndpointOffsets('start', startWidth);
  const endOff = resolveEndpointOffsets('end', endWidth);

  const effectiveSource: RoadCrossSectionProfile['widthSource'] =
    widthSource !== 'class_default'
      ? widthSource
      : laneInfo.totalLanes !== undefined || cLeft + cRight > 0
        ? 'lanes_and_cycleway'
        : 'class_default';

  const sL = reversed ? endOff.right : startOff.left;
  const sR = reversed ? endOff.left : startOff.right;
  const eL = reversed ? startOff.right : endOff.left;
  const eR = reversed ? startOff.left : endOff.right;
  const sW = sL + sR;
  const eW = eL + eR;

  const isAsymmetricOrTapered =
    Math.abs(sL - sR) > 1e-4 ||
    Math.abs(eL - eR) > 1e-4 ||
    Math.abs(sL - eL) > 1e-4 ||
    Math.abs(sR - eR) > 1e-4;

  return {
    width: baseWidth,
    startWidth: sW,
    endWidth: eW,
    startLeftOffset: sL,
    startRightOffset: sR,
    endLeftOffset: eL,
    endRightOffset: eR,
    resolvedLanes: effectiveLanes,
    widthSource: effectiveSource,
    isAsymmetricOrTapered,
  };
}

/**
 * Linearly interpolates a `RoadCrossSectionProfile` onto the sub-span `[spanStart, spanEnd]`
 * within `[segStartArcLength, segEndArcLength]` (or normalized `[t0, t1]` when 3 arguments are passed).
 */
export function interpolateCrossSectionSpan(
  profile: RoadCrossSectionProfile,
  segStartOrT0: number,
  segEndOrT1: number,
  spanStart?: number,
  spanEnd?: number
): RoadCrossSectionProfile {
  let t0: number;
  let t1: number;
  if (spanStart !== undefined && spanEnd !== undefined) {
    const segLen = segEndOrT1 - segStartOrT0;
    if (segLen <= 1e-6) {
      t0 = 0;
      t1 = 1;
    } else {
      t0 = (spanStart - segStartOrT0) / segLen;
      t1 = (spanEnd - segStartOrT0) / segLen;
    }
  } else {
    t0 = segStartOrT0;
    t1 = segEndOrT1;
  }
  const u0 = Math.max(0, Math.min(1, t0));
  const u1 = Math.max(u0, Math.min(1, t1));
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  const sL = lerp(profile.startLeftOffset, profile.endLeftOffset, u0);
  const sR = lerp(profile.startRightOffset, profile.endRightOffset, u0);
  const eL = lerp(profile.startLeftOffset, profile.endLeftOffset, u1);
  const eR = lerp(profile.startRightOffset, profile.endRightOffset, u1);

  return {
    ...profile,
    startWidth: sL + sR,
    endWidth: eL + eR,
    startLeftOffset: sL,
    startRightOffset: sR,
    endLeftOffset: eL,
    endRightOffset: eR,
  };
}
