import { RawGeoJsonProperties } from '../types/MapFeature';

/**
 * Primary semantic placement category for road, path, railway, and waterway infrastructure (`M2.3-E4-T`).
 * Kept strictly separate from 3D geometry construction so it can be reused during ingestion,
 * graph topology analysis, runtime rendering, and future offline tile/mesh baking.
 */
export type InfrastructurePlacementKind =
  | 'surface_open'
  | 'elevated'
  | 'open_cutting'
  | 'covered_passage'
  | 'underground_tunnel'
  | 'unknown_or_conflicting';

/**
 * Vertical relationship relative to local ground level, kept distinct from physical enclosure.
 */
export type InfrastructureVerticalRelation =
  | 'at_grade'
  | 'above_grade'
  | 'below_grade_open'
  | 'below_grade_enclosed'
  | 'relative_layer_only'
  | 'conflicting';

/**
 * Physical enclosure category of the infrastructure way.
 */
export type InfrastructureEnclosureKind =
  | 'open_air'
  | 'covered_surface'
  | 'building_passage'
  | 'subterranean_tunnel'
  | 'culvert_conduit'
  | 'unknown_enclosure';

/**
 * Specific tunnel or covered-structure construction subtype derived from OSM tags.
 */
export type TunnelConstructionSubtype =
  | 'bored_or_mined_tunnel'
  | 'cut_and_cover_or_underpass'
  | 'building_passage'
  | 'covered_arcade_or_colonnade'
  | 'culvert'
  | 'unknown_tunnel'
  | 'none';

/**
 * Provenance confidence for the resolved placement classification.
 */
export type InfrastructurePlacementConfidence =
  | 'explicit_tag'
  | 'inferred_from_location'
  | 'fallback_default'
  | 'conflicting_or_unknown';

/**
 * Optional supporting vertical/structural metadata parsed from OSM tags (`incline=*`, `ele=*`, `level=*`, `maxheight=*`).
 */
export interface InfrastructureSupportingVerticalEvidence {
  incline?: string;
  eleMeters?: number;
  level?: number;
  maxheightMeters?: number;
}

/**
 * Complete semantic placement classification record for an infrastructure way or edge (`M2.3-E4-T`).
 */
export interface InfrastructurePlacementClassification {
  /** Primary placement category. */
  placement: InfrastructurePlacementKind;
  /** Vertical relation relative to ground level (separating physical depth from relative OSM `layer`). */
  verticalRelation: InfrastructureVerticalRelation;
  /** Physical overhead enclosure category. */
  enclosure: InfrastructureEnclosureKind;
  /** Specific tunnel or covered construction subtype. */
  tunnelSubtype: TunnelConstructionSubtype;
  /** Confidence and provenance of the classification decision. */
  confidence: InfrastructurePlacementConfidence;
  /** Effective relative OSM `layer` integer (default `0`). */
  layer: number;
  /** True ONLY when the way is a confirmed non-conflicting subterranean tunnel (`placement === 'underground_tunnel'`). */
  isSubterraneanTunnel: boolean;
  /** True when the way is a confirmed non-conflicting elevated bridge/viaduct (`placement === 'elevated'`). */
  isElevatedBridge: boolean;
  /** True when the way is tagged as a culvert (`tunnel=culvert`, `culvert=yes`, `bridge=culvert`, `man_made=culvert`). */
  isCulvert: boolean;
  /** True when the way is covered at or above ground (`covered=*` or `tunnel=building_passage|avalanche_protector|covered|gallery`). */
  isCoveredPassage: boolean;
  /** True when the way runs in an open excavation (`cutting=*`). */
  isOpenCutting: boolean;
  /** True when vertical/enclosure tags are contradictory or use an unrecognized `tunnel=*` value. */
  hasConflict: boolean;
  /** Machine-readable reason when `hasConflict === true`. */
  conflictReason?:
    | 'bridge_and_tunnel_both_tagged'
    | 'bridge_and_underground_location'
    | 'bridge_with_negative_layer'
    | 'tunnel_with_positive_layer'
    | 'tunnel_no_with_underground_location'
    | 'unrecognized_tunnel_value';
  /** True when continuous 3D underground road/railway geometry should be generated (`placement === 'underground_tunnel' && !hasConflict && !isCulvert`). */
  canGenerateUndergroundGeometry: boolean;
  /** True when the way should be rendered on the surface as at-grade/open/covered infrastructure rather than grade-separated. */
  rendersOnSurface: boolean;
  /** Canonical list of OSM tag key=value pairs that contributed to this classification. */
  evidenceTags: readonly string[];
  /** Optional supporting vertical tags (`incline=*`, `ele=*`, `level=*`, `maxheight=*`). */
  supportingEvidence: InfrastructureSupportingVerticalEvidence;
}

/**
 * Optional pre-parsed hints for synthetic test fixtures that construct `RoadFeature` / `RailwayFeature`
 * directly in memory without populating `osmTags.tunnel` or `osmTags.bridge`.
 */
export interface ExplicitPlacementHints {
  isBridge?: boolean;
  isTunnel?: boolean;
  isCulvert?: boolean;
  layer?: number;
  featureDomain?: 'road' | 'railway' | 'waterway' | 'other';
}

/**
 * Aggregate diagnostic counters for infrastructure placement classification across a dataset or scene.
 */
export interface InfrastructurePlacementDiagnostics {
  surfaceOpenCount: number;
  elevatedCount: number;
  openCuttingCount: number;
  coveredPassageCount: number;
  undergroundTunnelCount: number;
  unknownOrConflictingCount: number;
  culvertCount: number;
  relativeNegativeLayerNonTunnelCount: number;
  classificationTimeMs: number;
}

export function createEmptyPlacementDiagnostics(): InfrastructurePlacementDiagnostics {
  return {
    surfaceOpenCount: 0,
    elevatedCount: 0,
    openCuttingCount: 0,
    coveredPassageCount: 0,
    undergroundTunnelCount: 0,
    unknownOrConflictingCount: 0,
    culvertCount: 0,
    relativeNegativeLayerNonTunnelCount: 0,
    classificationTimeMs: 0,
  };
}

export function recordPlacementInDiagnostics(
  diag: InfrastructurePlacementDiagnostics,
  classification: InfrastructurePlacementClassification
): void {
  if (classification.isCulvert) {
    diag.culvertCount++;
  }
  if (
    classification.layer < 0 &&
    classification.placement !== 'underground_tunnel' &&
    !classification.isCulvert
  ) {
    diag.relativeNegativeLayerNonTunnelCount++;
  }
  switch (classification.placement) {
    case 'surface_open':
      diag.surfaceOpenCount++;
      break;
    case 'elevated':
      diag.elevatedCount++;
      break;
    case 'open_cutting':
      diag.openCuttingCount++;
      break;
    case 'covered_passage':
      diag.coveredPassageCount++;
      break;
    case 'underground_tunnel':
      diag.undergroundTunnelCount++;
      break;
    case 'unknown_or_conflicting':
      diag.unknownOrConflictingCount++;
      break;
  }
}

const NEGATIVE_TAG_VALUES = new Set<string>(['no', 'false', '0', 'none']);

const SUBTERRANEAN_TUNNEL_VALUES = new Set<string>([
  'yes',
  'true',
  '1',
  'railway',
  'subway',
  'flooded',
  'mineral_extract',
  'pipeline',
]);

const UNDERPASS_TUNNEL_VALUES = new Set<string>(['underpass', 'cut_and_cover']);

const BUILDING_PASSAGE_TUNNEL_VALUES = new Set<string>([
  'building_passage',
  'passage',
  'corridor',
  'hall',
]);

const COVERED_GALLERY_TUNNEL_VALUES = new Set<string>([
  'avalanche_protector',
  'covered',
  'arcade',
  'colonnade',
  'gallery',
  'noise_protection_gallery',
  'rock_shelter',
]);

const CULVERT_TUNNEL_VALUES = new Set<string>(['culvert', 'low_water_crossing']);

const VALID_BRIDGE_VALUES = new Set<string>([
  'yes',
  'true',
  '1',
  'viaduct',
  'aqueduct',
  'boardwalk',
  'cantilever',
  'covered',
  'movable',
  'trestle',
  'suspension',
  'swing',
  'lift',
  'bascule',
  'drawbridge',
  'pontoon',
  'beam',
  'arch',
  'footbridge',
]);

const COVERED_SURFACE_VALUES = new Set<string>([
  'yes',
  'true',
  '1',
  'arcade',
  'colonnade',
  'booth',
  'roof',
  'canopy',
  'building_passage',
  'avalanche_protector',
  'gallery',
]);

const OPEN_CUTTING_VALUES = new Set<string>([
  'yes',
  'true',
  '1',
  'left',
  'right',
  'both',
  'hollow_way',
]);

function normalizeTagString(val: unknown): string | undefined {
  if (val === undefined || val === null) return undefined;
  const trimmed = String(val).trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalMeters(val: unknown): number | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : undefined;
  }
  const str = String(val).trim().toLowerCase();
  if (!str || str === 'default' || str === 'none' || str === 'below_default') return undefined;
  const match = str.match(/^([+-]?\d+(?:\.\d+)?)\s*(?:m|meter|meters|metres)?$/);
  if (!match) return undefined;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : undefined;
}

function parseOptionalNumber(val: unknown): number | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : undefined;
  }
  const str = String(val).trim();
  if (!str) return undefined;
  const firstToken = str.split(';')[0].trim();
  const num = Number(firstToken);
  return Number.isFinite(num) ? num : undefined;
}

function parseLayerTag(rawLayer: unknown, fallbackLayer?: number): { layer: number; hasExplicitLayer: boolean } {
  if (typeof rawLayer === 'number' && Number.isFinite(rawLayer)) {
    return { layer: Math.trunc(rawLayer), hasExplicitLayer: true };
  }
  if (rawLayer !== undefined && rawLayer !== null) {
    const str = String(rawLayer).trim();
    if (str.length > 0) {
      const parsed = parseInt(str, 10);
      if (Number.isFinite(parsed)) {
        return { layer: parsed, hasExplicitLayer: true };
      }
    }
  }
  if (typeof fallbackLayer === 'number' && Number.isFinite(fallbackLayer)) {
    return { layer: Math.trunc(fallbackLayer), hasExplicitLayer: fallbackLayer !== 0 };
  }
  return { layer: 0, hasExplicitLayer: false };
}

/**
 * Classifies the physical placement, vertical relation, and enclosure of an OSM feature
 * from its raw tags (`props`) and optional synthetic hints (`hints`).
 *
 * Strictly separates relative OSM `layer` ordering (`layer < 0`) and surface coverings
 * (`covered=*`, `tunnel=building_passage`, `cutting=*`) from genuine subterranean tunnels (`underground_tunnel`).
 */
export function classifyInfrastructurePlacement(
  props?: RawGeoJsonProperties | null,
  hints?: ExplicitPlacementHints
): InfrastructurePlacementClassification {
  const p: RawGeoJsonProperties = props || {};
  const evidenceTags: string[] = [];

  const rawBridge = normalizeTagString(p.bridge);
  const rawTunnel = normalizeTagString(p.tunnel);
  const rawCovered = normalizeTagString(p.covered);
  const rawCutting = normalizeTagString(p.cutting);
  const rawEmbankment = normalizeTagString(p.embankment);
  const rawLocation = normalizeTagString(p.location);
  const rawCulvert = normalizeTagString(p.culvert);
  const rawManMade = normalizeTagString(p.man_made);
  const rawWaterway = normalizeTagString(p.waterway);
  const rawRailway = normalizeTagString(p.railway);
  const rawHighway = normalizeTagString(p.highway);

  const { layer, hasExplicitLayer } = parseLayerTag(p.layer, hints?.layer);

  if (rawHighway) evidenceTags.push(`highway=${rawHighway}`);
  if (rawRailway) evidenceTags.push(`railway=${rawRailway}`);
  if (rawWaterway) evidenceTags.push(`waterway=${rawWaterway}`);
  if (rawBridge) evidenceTags.push(`bridge=${rawBridge}`);
  if (rawTunnel) evidenceTags.push(`tunnel=${rawTunnel}`);
  if (rawCovered) evidenceTags.push(`covered=${rawCovered}`);
  if (rawCutting) evidenceTags.push(`cutting=${rawCutting}`);
  if (rawLocation) evidenceTags.push(`location=${rawLocation}`);
  if (rawCulvert) evidenceTags.push(`culvert=${rawCulvert}`);
  if (hasExplicitLayer) evidenceTags.push(`layer=${layer}`);

  const supportingEvidence: InfrastructureSupportingVerticalEvidence = {};
  const rawIncline = normalizeTagString(p.incline);
  if (rawIncline) {
    supportingEvidence.incline = rawIncline;
    evidenceTags.push(`incline=${rawIncline}`);
  }
  const eleMeters = parseOptionalMeters(p.ele);
  if (eleMeters !== undefined) {
    supportingEvidence.eleMeters = eleMeters;
    evidenceTags.push(`ele=${eleMeters}`);
  }
  const levelVal = parseOptionalNumber(p.level);
  if (levelVal !== undefined) {
    supportingEvidence.level = levelVal;
    evidenceTags.push(`level=${levelVal}`);
  }
  const maxheightMeters = parseOptionalMeters(p.maxheight ?? p['maxheight:physical']);
  if (maxheightMeters !== undefined && maxheightMeters > 0) {
    supportingEvidence.maxheightMeters = maxheightMeters;
    evidenceTags.push(`maxheight=${maxheightMeters}`);
  }

  const domain: 'road' | 'railway' | 'waterway' | 'other' =
    hints?.featureDomain ??
    (rawHighway
      ? 'road'
      : rawRailway
        ? 'railway'
        : rawWaterway
          ? 'waterway'
          : 'other');

  // 1. Check for culvert / low-water crossing first (handled separately from ordinary road/railway tunnels)
  const isExplicitCulvertTag =
    (rawTunnel !== undefined && CULVERT_TUNNEL_VALUES.has(rawTunnel)) ||
    (rawBridge !== undefined && CULVERT_TUNNEL_VALUES.has(rawBridge)) ||
    rawCulvert === 'yes' ||
    rawCulvert === 'true' ||
    rawCulvert === '1' ||
    rawManMade === 'culvert' ||
    rawWaterway === 'culvert' ||
    Boolean(hints?.isCulvert);

  if (isExplicitCulvertTag) {
    const isWaterwayCulvert = domain === 'waterway' && rawBridge === undefined;
    return {
      placement: isWaterwayCulvert ? 'underground_tunnel' : 'surface_open',
      verticalRelation: isWaterwayCulvert ? 'below_grade_enclosed' : 'at_grade',
      enclosure: 'culvert_conduit',
      tunnelSubtype: 'culvert',
      confidence: 'explicit_tag',
      layer,
      isSubterraneanTunnel: isWaterwayCulvert,
      isElevatedBridge: false,
      isCulvert: true,
      isCoveredPassage: false,
      isOpenCutting: false,
      hasConflict: false,
      canGenerateUndergroundGeometry: false,
      rendersOnSurface: !isWaterwayCulvert,
      evidenceTags,
      supportingEvidence,
    };
  }

  // 2. Evaluate explicit bridge evidence
  const hasExplicitBridgeNo = rawBridge !== undefined && NEGATIVE_TAG_VALUES.has(rawBridge);
  const hasExplicitBridgePositive =
    rawBridge !== undefined && !hasExplicitBridgeNo && (VALID_BRIDGE_VALUES.has(rawBridge) || rawBridge.length > 0);
  const hasSyntheticBridgeHint =
    rawBridge === undefined && Boolean(hints?.isBridge);
  const isBridgeCandidate = hasExplicitBridgePositive || hasSyntheticBridgeHint;

  // 3. Evaluate explicit tunnel evidence and check for unrecognized `tunnel=*` values
  const hasExplicitTunnelNo = rawTunnel !== undefined && NEGATIVE_TAG_VALUES.has(rawTunnel);
  const isSubterraneanTunnelTag =
    rawTunnel !== undefined && SUBTERRANEAN_TUNNEL_VALUES.has(rawTunnel);
  const isUnderpassTunnelTag =
    rawTunnel !== undefined && UNDERPASS_TUNNEL_VALUES.has(rawTunnel);
  const isBuildingPassageTunnelTag =
    rawTunnel !== undefined && BUILDING_PASSAGE_TUNNEL_VALUES.has(rawTunnel);
  const isCoveredGalleryTunnelTag =
    rawTunnel !== undefined && COVERED_GALLERY_TUNNEL_VALUES.has(rawTunnel);
  const isKnownTunnelTag =
    rawTunnel === undefined ||
    hasExplicitTunnelNo ||
    isSubterraneanTunnelTag ||
    isUnderpassTunnelTag ||
    isBuildingPassageTunnelTag ||
    isCoveredGalleryTunnelTag ||
    CULVERT_TUNNEL_VALUES.has(rawTunnel);

  const isUndergroundLocation =
    rawLocation === 'underground' || rawLocation === 'underwater';
  const isOvergroundLocation =
    rawLocation === 'overground' || rawLocation === 'elevated' || rawLocation === 'surface';

  // Synthetic `hints.isTunnel` applies only when no explicit `tunnel`, `covered`, `cutting`, or `location` tag overrides it
  const hasAnyExplicitPlacementTag =
    rawTunnel !== undefined ||
    rawCovered !== undefined ||
    rawCutting !== undefined ||
    rawLocation !== undefined;
  const hasSyntheticTunnelHint =
    !hasAnyExplicitPlacementTag && Boolean(hints?.isTunnel);

  const isSubterraneanCandidate =
    isSubterraneanTunnelTag ||
    isUnderpassTunnelTag ||
    (isUndergroundLocation && !hasExplicitTunnelNo) ||
    hasSyntheticTunnelHint;

  // 4. Detect contradictory vertical/enclosure tags (`unknown_or_conflicting`)
  if (!isKnownTunnelTag) {
    return {
      placement: 'unknown_or_conflicting',
      verticalRelation: 'conflicting',
      enclosure: 'unknown_enclosure',
      tunnelSubtype: 'unknown_tunnel',
      confidence: 'conflicting_or_unknown',
      layer,
      isSubterraneanTunnel: false,
      isElevatedBridge: false,
      isCulvert: false,
      isCoveredPassage: false,
      isOpenCutting: false,
      hasConflict: true,
      conflictReason: 'unrecognized_tunnel_value',
      canGenerateUndergroundGeometry: false,
      rendersOnSurface: false,
      evidenceTags,
      supportingEvidence,
    };
  }

  if (isBridgeCandidate && (isSubterraneanCandidate || isBuildingPassageTunnelTag || isCoveredGalleryTunnelTag)) {
    return {
      placement: 'unknown_or_conflicting',
      verticalRelation: 'conflicting',
      enclosure: 'unknown_enclosure',
      tunnelSubtype: isSubterraneanCandidate ? 'bored_or_mined_tunnel' : 'unknown_tunnel',
      confidence: 'conflicting_or_unknown',
      layer,
      isSubterraneanTunnel: false,
      isElevatedBridge: false,
      isCulvert: false,
      isCoveredPassage: false,
      isOpenCutting: false,
      hasConflict: true,
      conflictReason: isUndergroundLocation
        ? 'bridge_and_underground_location'
        : 'bridge_and_tunnel_both_tagged',
      canGenerateUndergroundGeometry: false,
      rendersOnSurface: false,
      evidenceTags,
      supportingEvidence,
    };
  }

  if (hasExplicitTunnelNo && isUndergroundLocation) {
    return {
      placement: 'unknown_or_conflicting',
      verticalRelation: 'conflicting',
      enclosure: 'unknown_enclosure',
      tunnelSubtype: 'none',
      confidence: 'conflicting_or_unknown',
      layer,
      isSubterraneanTunnel: false,
      isElevatedBridge: false,
      isCulvert: false,
      isCoveredPassage: false,
      isOpenCutting: false,
      hasConflict: true,
      conflictReason: 'tunnel_no_with_underground_location',
      canGenerateUndergroundGeometry: false,
      rendersOnSurface: false,
      evidenceTags,
      supportingEvidence,
    };
  }

  if (isSubterraneanCandidate && layer > 0) {
    return {
      placement: 'unknown_or_conflicting',
      verticalRelation: 'conflicting',
      enclosure: 'unknown_enclosure',
      tunnelSubtype: isUnderpassTunnelTag ? 'cut_and_cover_or_underpass' : 'bored_or_mined_tunnel',
      confidence: 'conflicting_or_unknown',
      layer,
      isSubterraneanTunnel: false,
      isElevatedBridge: false,
      isCulvert: false,
      isCoveredPassage: false,
      isOpenCutting: false,
      hasConflict: true,
      conflictReason: 'tunnel_with_positive_layer',
      canGenerateUndergroundGeometry: false,
      rendersOnSurface: false,
      evidenceTags,
      supportingEvidence,
    };
  }

  if (isBridgeCandidate && layer < 0) {
    return {
      placement: 'unknown_or_conflicting',
      verticalRelation: 'conflicting',
      enclosure: 'unknown_enclosure',
      tunnelSubtype: 'none',
      confidence: 'conflicting_or_unknown',
      layer,
      isSubterraneanTunnel: false,
      isElevatedBridge: false,
      isCulvert: false,
      isCoveredPassage: false,
      isOpenCutting: false,
      hasConflict: true,
      conflictReason: 'bridge_with_negative_layer',
      canGenerateUndergroundGeometry: false,
      rendersOnSurface: false,
      evidenceTags,
      supportingEvidence,
    };
  }

  // 5. Confirmed subterranean tunnel (`underground_tunnel`)
  if (isSubterraneanCandidate) {
    const tunnelSubtype: TunnelConstructionSubtype = isUnderpassTunnelTag
      ? 'cut_and_cover_or_underpass'
      : 'bored_or_mined_tunnel';
    const confidence: InfrastructurePlacementConfidence =
      isSubterraneanTunnelTag || isUnderpassTunnelTag || hasSyntheticTunnelHint
        ? 'explicit_tag'
        : 'inferred_from_location';
    return {
      placement: 'underground_tunnel',
      verticalRelation: 'below_grade_enclosed',
      enclosure: 'subterranean_tunnel',
      tunnelSubtype,
      confidence,
      layer,
      isSubterraneanTunnel: true,
      isElevatedBridge: false,
      isCulvert: false,
      isCoveredPassage: false,
      isOpenCutting: false,
      hasConflict: false,
      canGenerateUndergroundGeometry: true,
      rendersOnSurface: false,
      evidenceTags,
      supportingEvidence,
    };
  }

  // 6. Confirmed elevated bridge (`elevated`)
  const isPositiveLayerElevated =
    layer > 0 &&
    !hasExplicitBridgeNo &&
    !isBuildingPassageTunnelTag &&
    !isCoveredGalleryTunnelTag &&
    (isBridgeCandidate || isOvergroundLocation || rawCovered === undefined);

  if (isBridgeCandidate || isPositiveLayerElevated) {
    const isCoveredBridge =
      rawBridge === 'covered' ||
      (rawCovered !== undefined && COVERED_SURFACE_VALUES.has(rawCovered));
    return {
      placement: 'elevated',
      verticalRelation: 'above_grade',
      enclosure: isCoveredBridge ? 'covered_surface' : 'open_air',
      tunnelSubtype: 'none',
      confidence: isBridgeCandidate ? 'explicit_tag' : 'fallback_default',
      layer,
      isSubterraneanTunnel: false,
      isElevatedBridge: true,
      isCulvert: false,
      isCoveredPassage: isCoveredBridge,
      isOpenCutting: false,
      hasConflict: false,
      canGenerateUndergroundGeometry: false,
      rendersOnSurface: false,
      evidenceTags,
      supportingEvidence,
    };
  }

  // 7. Building passage (`tunnel=building_passage|passage|corridor`)
  if (isBuildingPassageTunnelTag) {
    return {
      placement: 'covered_passage',
      verticalRelation: layer < 0 ? 'relative_layer_only' : 'at_grade',
      enclosure: 'building_passage',
      tunnelSubtype: 'building_passage',
      confidence: 'explicit_tag',
      layer,
      isSubterraneanTunnel: false,
      isElevatedBridge: false,
      isCulvert: false,
      isCoveredPassage: true,
      isOpenCutting: false,
      hasConflict: false,
      canGenerateUndergroundGeometry: false,
      rendersOnSurface: true,
      evidenceTags,
      supportingEvidence,
    };
  }

  // 8. Covered surface infrastructure (`covered=yes|arcade|colonnade|booth` or `tunnel=avalanche_protector|covered|gallery`)
  const isCoveredSurfaceTag =
    (rawCovered !== undefined &&
      !NEGATIVE_TAG_VALUES.has(rawCovered) &&
      COVERED_SURFACE_VALUES.has(rawCovered)) ||
    isCoveredGalleryTunnelTag;

  if (isCoveredSurfaceTag) {
    return {
      placement: 'covered_passage',
      verticalRelation: layer < 0 ? 'relative_layer_only' : 'at_grade',
      enclosure: rawCovered === 'building_passage' ? 'building_passage' : 'covered_surface',
      tunnelSubtype:
        rawCovered === 'building_passage'
          ? 'building_passage'
          : 'covered_arcade_or_colonnade',
      confidence: 'explicit_tag',
      layer,
      isSubterraneanTunnel: false,
      isElevatedBridge: false,
      isCulvert: false,
      isCoveredPassage: true,
      isOpenCutting: false,
      hasConflict: false,
      canGenerateUndergroundGeometry: false,
      rendersOnSurface: true,
      evidenceTags,
      supportingEvidence,
    };
  }

  // 9. Open cutting (`cutting=yes|left|right|both` or `embankment=cutting`)
  const isOpenCuttingTag =
    (rawCutting !== undefined &&
      !NEGATIVE_TAG_VALUES.has(rawCutting) &&
      OPEN_CUTTING_VALUES.has(rawCutting)) ||
    rawEmbankment === 'cutting';

  if (isOpenCuttingTag) {
    return {
      placement: 'open_cutting',
      verticalRelation: 'below_grade_open',
      enclosure: 'open_air',
      tunnelSubtype: 'none',
      confidence: 'explicit_tag',
      layer,
      isSubterraneanTunnel: false,
      isElevatedBridge: false,
      isCulvert: false,
      isCoveredPassage: false,
      isOpenCutting: true,
      hasConflict: false,
      canGenerateUndergroundGeometry: false,
      rendersOnSurface: true,
      evidenceTags,
      supportingEvidence,
    };
  }

  // 10. Default open-air surface placement (`surface_open`), including:
  // - Ordinary at-grade roads, footpaths, and railways (`layer = 0`)
  // - Surface or elevated metro lines (`railway=subway` without `tunnel=*` or `location=underground`)
  // - Explicit `tunnel=no`
  // - Negative OSM `layer < 0` without physical tunnel or underground tags (`verticalRelation: 'relative_layer_only'`)
  return {
    placement: 'surface_open',
    verticalRelation: layer < 0 ? 'relative_layer_only' : 'at_grade',
    enclosure: 'open_air',
    tunnelSubtype: 'none',
    confidence:
      hasExplicitTunnelNo || hasExplicitBridgeNo || isOvergroundLocation
        ? 'explicit_tag'
        : 'fallback_default',
    layer,
    isSubterraneanTunnel: false,
    isElevatedBridge: false,
    isCulvert: false,
    isCoveredPassage: false,
    isOpenCutting: false,
    hasConflict: false,
    canGenerateUndergroundGeometry: false,
    rendersOnSurface: true,
    evidenceTags,
    supportingEvidence,
  };
}
