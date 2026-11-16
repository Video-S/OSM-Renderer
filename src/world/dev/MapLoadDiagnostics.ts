import type {
  RailwayInfrastructureRenderSource,
  RoadInfrastructureRenderSource,
} from '../infrastructure/rendering/InfrastructureRenderAdapter';

export type MapLoadSourceType =
  | 'live_osm'
  | 'preset_live_osm'
  | 'address_search'
  | 'geojson_upload'
  | 'fixture'
  | 'repro_import'
  | 'offline_benchmark';

export type MapLoadStatus =
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'superseded'
  | 'cancelled';

export type MapLoadCacheStatus =
  | 'cold_miss'
  | 'warm_hit'
  | 'unknown'
  | 'not_applicable';

export interface MapLoadServerTimingsMs {
  cacheLookupMs: number | null;
  upstreamFetchMs: number | null;
  upstreamSource: 'cache' | 'overpass' | 'osm-xml' | 'unknown' | null;
  osmtogeojsonMs: number | null;
  nodeIdEnrichMs: number | null;
  totalServerMs: number | null;
}

export interface GeoJsonParseSubTimingsMs {
  boundsAndPreScanMs: number;
  featureClipAndExtractMs: number;
  roadChainingAndStatsMs: number;
}

export interface MapLoadStageTimingsMs {
  /** Monotonic request-to-headers HTTP wait for /api/osm-data (null for local/fixture loads). */
  osmRequestMs: number | null;
  /** Client response download + JSON decode or FileReader read + JSON parse. */
  dataTransferAndDecodeMs: number | null;
  /** Response stream/file text transfer sub-stage where separately measurable. */
  responseTransferMs: number | null;
  /** Synchronous JSON.parse duration where separately measurable. */
  jsonDecodeMs: number | null;
  /** LocalGeoJsonProvider.parseGeoJson execution time. */
  geoJsonProcessingMs: number | null;
  /** Optional internal parseGeoJson stage breakdown. */
  geoJsonSubTimingsMs: GeoJsonParseSubTimingsMs | null;
  /** Synchronous console.table diagnostics logging duration (when executed). */
  consoleDiagnosticsMs: number | null;
  /** prepareInfrastructureRenderPreview duration (0ms in default legacy mode). */
  infrastructurePreparationMs: number | null;
  /** GeometryBuilder.buildScene + optional prototype railway build time. */
  sceneGeometryMs: number | null;
  /** React commit + Three.js resource upload + shader compile + first gl.render() for revision. */
  scenePresentationMs: number | null;
  /** Subset of unaccounted gap between mapData commit and buildScene effect start (minus infra memo). */
  reactSchedulingGapMs: number | null;
  /** Unaccounted delta: totalLoadingMs - accountedCoreStagesMs (includes React render/effect scheduling, disposal, GC). */
  unaccountedOverheadMs: number;
  /** End-to-end duration from user/mount request initiation to first rendered WebGL frame. */
  totalLoadingMs: number | null;
}

export interface MapLoadSpinnerDiagnostics {
  /** Milliseconds from request initiation until loading state flipped false. */
  spinnerHiddenAtMs: number | null;
  /** How many milliseconds BEFORE first WebGL frame the loading spinner disappeared. */
  prematureSpinnerHideMs: number | null;
}

export interface MapLoadNetworkDetails {
  url: string | null;
  httpStatus: number | null;
  payloadBytes: number | null;
  transferSizeBytes: number | null;
  encodedBodySizeBytes: number | null;
  featureCount: number | null;
  cacheStatus: MapLoadCacheStatus;
  serverTimings: MapLoadServerTimingsMs | null;
}

export interface MapLoadRendererConfigSnapshot {
  roadsMode: RoadInfrastructureRenderSource;
  railwaysMode: RailwayInfrastructureRenderSource;
  railwayPrototypeMode: string;
  themeId: string;
}

export interface MapLoadSceneCountsSnapshot {
  buildings: number;
  roads: number;
  railways: number;
  totalFeaturesParsed: number;
  triangles: number | null;
  drawCalls: number | null;
}

export interface MapLoadAccountingSummary {
  accountedMs: number;
  unaccountedMs: number;
  totalMs: number | null;
  instrumentationOverheadMs: number;
}

export interface MapLoadDiagnosticsRecord {
  requestId: number;
  locationId: string;
  locationName: string;
  radiusMeters: number | null;
  sourceType: MapLoadSourceType;
  status: MapLoadStatus;
  errorMessage: string | null;
  supersededByRequestId: number | null;
  sceneRevision: number | null;
  initiatedAtIso: string;
  completedAtIso: string | null;
  isInitialStartupLoad: boolean;
  rendererConfig: MapLoadRendererConfigSnapshot;
  counts: MapLoadSceneCountsSnapshot | null;
  network: MapLoadNetworkDetails;
  timings: MapLoadStageTimingsMs;
  spinner: MapLoadSpinnerDiagnostics;
  accounting: MapLoadAccountingSummary;
}

export interface OsmProviderLoadMetrics {
  url: string;
  httpStatus: number;
  osmRequestMs: number;
  dataTransferAndDecodeMs: number;
  responseTransferMs: number | null;
  jsonDecodeMs: number | null;
  geoJsonProcessingMs: number;
  geoJsonSubTimingsMs: GeoJsonParseSubTimingsMs | null;
  payloadBytes: number | null;
  transferSizeBytes: number | null;
  encodedBodySizeBytes: number | null;
  featureCount: number | null;
  cacheStatus: MapLoadCacheStatus;
  serverTimings: MapLoadServerTimingsMs | null;
}

function roundMs(value: number): number {
  return Number(Math.max(0, value).toFixed(3));
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Parses an HTTP Server-Timing header (e.g. `cache;dur=0.2, upstream;dur=1250.4, total;dur=1310.0`)
 * into structured millisecond numbers without inventing absent values.
 */
export function parseServerTimingHeader(
  headerValue: string | null | undefined,
  upstreamSourceHeader?: string | null
): MapLoadServerTimingsMs | null {
  if (!headerValue || typeof headerValue !== 'string' || headerValue.trim().length === 0) {
    return null;
  }

  const durations = new Map<string, number>();
  const entries = headerValue.split(',');
  for (const rawEntry of entries) {
    const parts = rawEntry.split(';').map((s) => s.trim());
    const metricName = parts[0]?.toLowerCase();
    if (!metricName) continue;
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      if (part.toLowerCase().startsWith('dur=')) {
        const val = parseFloat(part.slice(4));
        if (Number.isFinite(val) && val >= 0) {
          durations.set(metricName, roundMs(val));
        }
      }
    }
  }

  if (durations.size === 0) {
    return null;
  }

  const normalizedSource = upstreamSourceHeader?.trim().toLowerCase();
  const upstreamSource: MapLoadServerTimingsMs['upstreamSource'] =
    normalizedSource === 'cache'
      ? 'cache'
      : normalizedSource === 'overpass'
        ? 'overpass'
        : normalizedSource === 'osm-xml'
          ? 'osm-xml'
          : normalizedSource
            ? 'unknown'
            : null;

  return {
    cacheLookupMs: durations.get('cache') ?? null,
    upstreamFetchMs: durations.get('upstream') ?? null,
    upstreamSource,
    osmtogeojsonMs: durations.get('osmtogeojson') ?? null,
    nodeIdEnrichMs: durations.get('enrich') ?? null,
    totalServerMs: durations.get('total') ?? null,
  };
}

export function resolveCacheStatusFromHeaders(
  cacheHeader: string | null | undefined
): MapLoadCacheStatus {
  if (!cacheHeader || typeof cacheHeader !== 'string') return 'unknown';
  const normalized = cacheHeader.trim().toUpperCase();
  if (normalized === 'HIT') return 'warm_hit';
  if (normalized === 'MISS') return 'cold_miss';
  return 'unknown';
}

export function readResourceTimingSizes(
  requestUrl: string
): { transferSizeBytes: number | null; encodedBodySizeBytes: number | null } {
  if (
    typeof performance === 'undefined' ||
    typeof performance.getEntriesByType !== 'function'
  ) {
    return { transferSizeBytes: null, encodedBodySizeBytes: null };
  }
  try {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.name && entry.name.includes(requestUrl)) {
        const transfer =
          typeof entry.transferSize === 'number' && entry.transferSize > 0
            ? entry.transferSize
            : null;
        const encoded =
          typeof entry.encodedBodySize === 'number' && entry.encodedBodySize > 0
            ? entry.encodedBodySize
            : null;
        return { transferSizeBytes: transfer, encodedBodySizeBytes: encoded };
      }
    }
  } catch {
    // Ignore ResourceTiming access errors in restricted environments
  }
  return { transferSizeBytes: null, encodedBodySizeBytes: null };
}

interface InternalMutableLoad {
  requestId: number;
  locationId: string;
  locationName: string;
  radiusMeters: number | null;
  sourceType: MapLoadSourceType;
  status: MapLoadStatus;
  errorMessage: string | null;
  supersededByRequestId: number | null;
  sceneRevision: number | null;
  initiatedAtMs: number;
  initiatedAtIso: string;
  completedAtIso: string | null;
  isInitialStartupLoad: boolean;
  rendererConfig: MapLoadRendererConfigSnapshot;
  counts: MapLoadSceneCountsSnapshot | null;
  network: MapLoadNetworkDetails;

  osmRequestMs: number | null;
  dataTransferAndDecodeMs: number | null;
  responseTransferMs: number | null;
  jsonDecodeMs: number | null;
  geoJsonProcessingMs: number | null;
  geoJsonSubTimingsMs: GeoJsonParseSubTimingsMs | null;
  consoleDiagnosticsMs: number | null;
  infrastructurePreparationMs: number | null;
  sceneGeometryMs: number | null;
  scenePresentationMs: number | null;

  mapDataCommittedAtMs: number | null;
  infraPrepStartedAtMs: number | null;
  geometryEffectStartedAtMs: number | null;
  geometryCommittedAtMs: number | null;
  spinnerHiddenAtMs: number | null;
  totalLoadingMs: number | null;
  instrumentationOverheadMs: number;
  finalizedForPresentation: boolean;
}

export interface StartMapLoadParams {
  locationId: string;
  locationName: string;
  radiusMeters?: number | null;
  sourceType: MapLoadSourceType;
  isInitialStartupLoad?: boolean;
  rendererConfig: MapLoadRendererConfigSnapshot;
}

export const MAX_MAP_LOAD_HISTORY = 10;

/**
 * Bounded request-scoped timeline tracker that correlates asynchronous fetch/parse work,
 * React state updates, geometry construction, and first WebGL frame presentation without
 * double-counting stages or accumulating unbounded history.
 */
export class MapLoadTimelineTracker {
  private nextRequestId = 1;
  private activeLoad: InternalMutableLoad | null = null;
  private loadsById = new Map<number, InternalMutableLoad>();
  private revisionToRequestId = new Map<number, number>();
  private finalizedRequestIds = new Set<number>();
  private latestSnapshot: MapLoadDiagnosticsRecord | null = null;
  private history: MapLoadDiagnosticsRecord[] = [];
  private maxHistory: number;

  constructor(maxHistory: number = MAX_MAP_LOAD_HISTORY) {
    this.maxHistory = Math.max(1, maxHistory);
  }

  startLoad(params: StartMapLoadParams): number {
    const tOverhead0 = nowMs();
    const requestId = this.nextRequestId++;

    if (this.activeLoad && this.activeLoad.status === 'in_progress') {
      const prev = this.activeLoad;
      prev.status = 'superseded';
      prev.supersededByRequestId = requestId;
      prev.completedAtIso = new Date().toISOString();
      prev.totalLoadingMs = roundMs(tOverhead0 - prev.initiatedAtMs);
      this.finalizedRequestIds.add(prev.requestId);
      const prevRecord = this.toRecord(prev);
      this.pushHistory(prevRecord);
      this.loadsById.delete(prev.requestId);
    }

    const load: InternalMutableLoad = {
      requestId,
      locationId: params.locationId,
      locationName: params.locationName,
      radiusMeters: params.radiusMeters ?? null,
      sourceType: params.sourceType,
      status: 'in_progress',
      errorMessage: null,
      supersededByRequestId: null,
      sceneRevision: null,
      initiatedAtMs: tOverhead0,
      initiatedAtIso: new Date().toISOString(),
      completedAtIso: null,
      isInitialStartupLoad: Boolean(params.isInitialStartupLoad),
      rendererConfig: { ...params.rendererConfig },
      counts: null,
      network: {
        url: null,
        httpStatus: null,
        payloadBytes: null,
        transferSizeBytes: null,
        encodedBodySizeBytes: null,
        featureCount: null,
        cacheStatus:
          params.sourceType === 'live_osm' ||
          params.sourceType === 'preset_live_osm' ||
          params.sourceType === 'address_search'
            ? 'unknown'
            : 'not_applicable',
        serverTimings: null,
      },
      osmRequestMs: null,
      dataTransferAndDecodeMs: null,
      responseTransferMs: null,
      jsonDecodeMs: null,
      geoJsonProcessingMs: null,
      geoJsonSubTimingsMs: null,
      consoleDiagnosticsMs: null,
      infrastructurePreparationMs: null,
      sceneGeometryMs: null,
      scenePresentationMs: null,
      mapDataCommittedAtMs: null,
      infraPrepStartedAtMs: null,
      geometryEffectStartedAtMs: null,
      geometryCommittedAtMs: null,
      spinnerHiddenAtMs: null,
      totalLoadingMs: null,
      instrumentationOverheadMs: 0,
      finalizedForPresentation: false,
    };

    load.instrumentationOverheadMs += Math.max(0, nowMs() - tOverhead0);
    this.activeLoad = load;
    this.loadsById.set(requestId, load);
    this.pruneOldTrackingMaps();
    return requestId;
  }

  isRequestCurrent(requestId: number): boolean {
    return (
      this.activeLoad !== null &&
      this.activeLoad.requestId === requestId &&
      this.activeLoad.status === 'in_progress'
    );
  }

  hasFinalizedPresentation(requestId: number): boolean {
    return this.finalizedRequestIds.has(requestId);
  }

  recordOsmProviderMetrics(requestId: number, metrics: OsmProviderLoadMetrics): void {
    const t0 = nowMs();
    const load = this.loadsById.get(requestId);
    if (!load) return;

    load.osmRequestMs = roundMs(metrics.osmRequestMs);
    load.dataTransferAndDecodeMs = roundMs(metrics.dataTransferAndDecodeMs);
    load.responseTransferMs =
      metrics.responseTransferMs !== null ? roundMs(metrics.responseTransferMs) : null;
    load.jsonDecodeMs = metrics.jsonDecodeMs !== null ? roundMs(metrics.jsonDecodeMs) : null;
    load.geoJsonProcessingMs = roundMs(metrics.geoJsonProcessingMs);
    load.geoJsonSubTimingsMs = metrics.geoJsonSubTimingsMs
      ? {
          boundsAndPreScanMs: roundMs(metrics.geoJsonSubTimingsMs.boundsAndPreScanMs),
          featureClipAndExtractMs: roundMs(metrics.geoJsonSubTimingsMs.featureClipAndExtractMs),
          roadChainingAndStatsMs: roundMs(metrics.geoJsonSubTimingsMs.roadChainingAndStatsMs),
        }
      : null;

    load.network = {
      url: metrics.url,
      httpStatus: metrics.httpStatus,
      payloadBytes: metrics.payloadBytes,
      transferSizeBytes: metrics.transferSizeBytes,
      encodedBodySizeBytes: metrics.encodedBodySizeBytes,
      featureCount: metrics.featureCount,
      cacheStatus: metrics.cacheStatus,
      serverTimings: metrics.serverTimings,
    };

    load.instrumentationOverheadMs += Math.max(0, nowMs() - t0);
  }

  recordLocalTransferAndParse(
    requestId: number,
    params: {
      responseTransferMs?: number | null;
      jsonDecodeMs?: number | null;
      dataTransferAndDecodeMs?: number | null;
      geoJsonProcessingMs?: number | null;
      geoJsonSubTimingsMs?: GeoJsonParseSubTimingsMs | null;
      payloadBytes?: number | null;
      featureCount?: number | null;
    }
  ): void {
    const t0 = nowMs();
    const load = this.loadsById.get(requestId);
    if (!load) return;

    if (params.responseTransferMs !== undefined) {
      load.responseTransferMs =
        params.responseTransferMs !== null ? roundMs(params.responseTransferMs) : null;
    }
    if (params.jsonDecodeMs !== undefined) {
      load.jsonDecodeMs = params.jsonDecodeMs !== null ? roundMs(params.jsonDecodeMs) : null;
    }
    if (params.dataTransferAndDecodeMs !== undefined) {
      load.dataTransferAndDecodeMs =
        params.dataTransferAndDecodeMs !== null ? roundMs(params.dataTransferAndDecodeMs) : null;
    }
    if (params.geoJsonProcessingMs !== undefined) {
      load.geoJsonProcessingMs =
        params.geoJsonProcessingMs !== null ? roundMs(params.geoJsonProcessingMs) : null;
    }
    if (params.geoJsonSubTimingsMs !== undefined) {
      load.geoJsonSubTimingsMs = params.geoJsonSubTimingsMs
        ? {
            boundsAndPreScanMs: roundMs(params.geoJsonSubTimingsMs.boundsAndPreScanMs),
            featureClipAndExtractMs: roundMs(params.geoJsonSubTimingsMs.featureClipAndExtractMs),
            roadChainingAndStatsMs: roundMs(params.geoJsonSubTimingsMs.roadChainingAndStatsMs),
          }
        : null;
    }
    if (params.payloadBytes !== undefined) {
      load.network.payloadBytes = params.payloadBytes;
    }
    if (params.featureCount !== undefined) {
      load.network.featureCount = params.featureCount;
    }

    load.instrumentationOverheadMs += Math.max(0, nowMs() - t0);
  }

  recordConsoleDiagnosticsMs(requestId: number, durationMs: number): void {
    const load = this.loadsById.get(requestId);
    if (!load) return;
    load.consoleDiagnosticsMs = roundMs(durationMs);
  }

  markMapDataCommitted(
    requestId: number,
    counts?: Partial<MapLoadSceneCountsSnapshot>
  ): void {
    const t0 = nowMs();
    const load = this.loadsById.get(requestId);
    if (!load || load.finalizedForPresentation) return;
    load.mapDataCommittedAtMs = t0;
    if (counts) {
      load.counts = {
        buildings: counts.buildings ?? load.counts?.buildings ?? 0,
        roads: counts.roads ?? load.counts?.roads ?? 0,
        railways: counts.railways ?? load.counts?.railways ?? 0,
        totalFeaturesParsed: counts.totalFeaturesParsed ?? load.counts?.totalFeaturesParsed ?? 0,
        triangles: counts.triangles ?? load.counts?.triangles ?? null,
        drawCalls: counts.drawCalls ?? load.counts?.drawCalls ?? null,
      };
    }
    load.instrumentationOverheadMs += Math.max(0, nowMs() - t0);
  }

  markLoadingIndicatorHidden(requestId: number): void {
    const t0 = nowMs();
    const load = this.loadsById.get(requestId);
    if (!load) return;
    if (load.spinnerHiddenAtMs === null) {
      load.spinnerHiddenAtMs = roundMs(t0 - load.initiatedAtMs);
    }
    load.instrumentationOverheadMs += Math.max(0, nowMs() - t0);
  }

  recordInfrastructurePrep(
    requestId: number,
    startedAtMs: number,
    durationMs: number
  ): void {
    const t0 = nowMs();
    const load = this.loadsById.get(requestId);
    if (!load || load.finalizedForPresentation) return;
    if (load.infraPrepStartedAtMs === null) {
      load.infraPrepStartedAtMs = startedAtMs;
    }
    load.infrastructurePreparationMs = roundMs(durationMs);
    load.instrumentationOverheadMs += Math.max(0, nowMs() - t0);
  }

  recordSceneGeometryBuild(
    requestId: number,
    params: {
      effectStartedAtMs: number;
      buildDurationMs: number;
      sceneRevision: number;
      rendererConfig?: Partial<MapLoadRendererConfigSnapshot>;
      triangles?: number | null;
      drawCalls?: number | null;
    }
  ): void {
    const t0 = nowMs();
    const load = this.loadsById.get(requestId);
    if (!load || load.finalizedForPresentation) return;

    if (load.geometryEffectStartedAtMs === null) {
      load.geometryEffectStartedAtMs = params.effectStartedAtMs;
    }
    load.sceneGeometryMs = roundMs(params.buildDurationMs);
    load.sceneRevision = params.sceneRevision;
    load.geometryCommittedAtMs = t0;
    if (params.rendererConfig) {
      load.rendererConfig = { ...load.rendererConfig, ...params.rendererConfig };
    }
    if (load.counts) {
      load.counts.triangles = params.triangles ?? load.counts.triangles;
      load.counts.drawCalls = params.drawCalls ?? load.counts.drawCalls;
    }

    this.revisionToRequestId.set(params.sceneRevision, requestId);
    load.instrumentationOverheadMs += Math.max(0, nowMs() - t0);
  }

  addPrototypeRailwayBuildMs(requestId: number, durationMs: number, endedAtMs?: number): void {
    const load = this.loadsById.get(requestId);
    if (!load || load.finalizedForPresentation) return;
    load.sceneGeometryMs = roundMs((load.sceneGeometryMs ?? 0) + durationMs);
    if (endedAtMs !== undefined) {
      load.geometryCommittedAtMs = Math.max(load.geometryCommittedAtMs ?? endedAtMs, endedAtMs);
    } else {
      load.geometryCommittedAtMs = nowMs();
    }
  }

  markScenePresented(sceneRevision: number, renderedAtMs?: number): MapLoadDiagnosticsRecord | null {
    const t0 = renderedAtMs ?? nowMs();
    const requestId = this.revisionToRequestId.get(sceneRevision);
    if (requestId === undefined) return null;

    const load = this.loadsById.get(requestId);
    if (!load || load.finalizedForPresentation || load.status !== 'in_progress') {
      return null;
    }

    load.finalizedForPresentation = true;
    this.finalizedRequestIds.add(requestId);
    load.status = 'completed';
    load.completedAtIso = new Date().toISOString();

    const commitAnchor = load.geometryCommittedAtMs ?? t0;
    load.scenePresentationMs = roundMs(Math.max(0, t0 - commitAnchor));
    load.totalLoadingMs = roundMs(Math.max(0, t0 - load.initiatedAtMs));
    load.instrumentationOverheadMs += Math.max(0, nowMs() - t0);

    const record = this.toRecord(load);
    this.latestSnapshot = record;
    this.pushHistory(record);

    if (this.activeLoad?.requestId === requestId) {
      this.activeLoad = null;
    }
    this.loadsById.delete(requestId);
    this.revisionToRequestId.delete(sceneRevision);

    return record;
  }

  markLoadFailed(
    requestId: number,
    errorMessage: string,
    status: 'failed' | 'cancelled' = 'failed'
  ): MapLoadDiagnosticsRecord | null {
    const t0 = nowMs();
    const load = this.loadsById.get(requestId);
    if (!load) return null;
    if (load.status !== 'in_progress') return null;

    load.finalizedForPresentation = true;
    this.finalizedRequestIds.add(requestId);
    load.status = status;
    load.errorMessage = errorMessage;
    load.completedAtIso = new Date().toISOString();
    load.totalLoadingMs = roundMs(Math.max(0, t0 - load.initiatedAtMs));
    load.instrumentationOverheadMs += Math.max(0, nowMs() - t0);

    const record = this.toRecord(load);
    this.latestSnapshot = record;
    this.pushHistory(record);

    if (this.activeLoad?.requestId === requestId) {
      this.activeLoad = null;
    }
    this.loadsById.delete(requestId);
    return record;
  }

  getLatestRecord(): MapLoadDiagnosticsRecord | null {
    return this.latestSnapshot;
  }

  getInProgressSnapshot(): MapLoadDiagnosticsRecord | null {
    if (!this.activeLoad || this.activeLoad.status !== 'in_progress') return null;
    return this.toRecord(this.activeLoad);
  }

  getHistory(): MapLoadDiagnosticsRecord[] {
    return [...this.history];
  }

  private pushHistory(record: MapLoadDiagnosticsRecord): void {
    this.history.unshift(record);
    if (this.history.length > this.maxHistory) {
      this.history.length = this.maxHistory;
    }
  }

  private pruneOldTrackingMaps(): void {
    if (this.revisionToRequestId.size > this.maxHistory * 4) {
      const oldestKey = this.revisionToRequestId.keys().next().value;
      if (oldestKey !== undefined) this.revisionToRequestId.delete(oldestKey);
    }
    if (this.finalizedRequestIds.size > this.maxHistory * 4) {
      const oldestKey = this.finalizedRequestIds.values().next().value;
      if (oldestKey !== undefined) this.finalizedRequestIds.delete(oldestKey);
    }
    if (this.loadsById.size > this.maxHistory * 4) {
      const oldestKey = this.loadsById.keys().next().value;
      if (oldestKey !== undefined && oldestKey !== this.activeLoad?.requestId) {
        this.loadsById.delete(oldestKey);
      }
    }
  }

  private toRecord(load: InternalMutableLoad): MapLoadDiagnosticsRecord {
    const accountedMs = roundMs(
      (load.osmRequestMs ?? 0) +
        (load.dataTransferAndDecodeMs ?? 0) +
        (load.geoJsonProcessingMs ?? 0) +
        (load.consoleDiagnosticsMs ?? 0) +
        (load.infrastructurePreparationMs ?? 0) +
        (load.sceneGeometryMs ?? 0) +
        (load.scenePresentationMs ?? 0)
    );

    const totalMs = load.totalLoadingMs;
    const unaccountedOverheadMs =
      totalMs !== null ? Number(Math.max(0, totalMs - accountedMs).toFixed(3)) : 0;

    let reactSchedulingGapMs: number | null = null;
    if (load.mapDataCommittedAtMs !== null && load.geometryEffectStartedAtMs !== null) {
      const rawGap =
        load.geometryEffectStartedAtMs -
        load.mapDataCommittedAtMs -
        (load.infrastructurePreparationMs ?? 0);
      reactSchedulingGapMs = roundMs(Math.max(0, rawGap));
    }

    const prematureSpinnerHideMs =
      load.spinnerHiddenAtMs !== null && totalMs !== null && load.spinnerHiddenAtMs < totalMs
        ? roundMs(totalMs - load.spinnerHiddenAtMs)
        : null;

    return {
      requestId: load.requestId,
      locationId: load.locationId,
      locationName: load.locationName,
      radiusMeters: load.radiusMeters,
      sourceType: load.sourceType,
      status: load.status,
      errorMessage: load.errorMessage,
      supersededByRequestId: load.supersededByRequestId,
      sceneRevision: load.sceneRevision,
      initiatedAtIso: load.initiatedAtIso,
      completedAtIso: load.completedAtIso,
      isInitialStartupLoad: load.isInitialStartupLoad,
      rendererConfig: { ...load.rendererConfig },
      counts: load.counts ? { ...load.counts } : null,
      network: {
        ...load.network,
        serverTimings: load.network.serverTimings ? { ...load.network.serverTimings } : null,
      },
      timings: {
        osmRequestMs: load.osmRequestMs,
        dataTransferAndDecodeMs: load.dataTransferAndDecodeMs,
        responseTransferMs: load.responseTransferMs,
        jsonDecodeMs: load.jsonDecodeMs,
        geoJsonProcessingMs: load.geoJsonProcessingMs,
        geoJsonSubTimingsMs: load.geoJsonSubTimingsMs
          ? { ...load.geoJsonSubTimingsMs }
          : null,
        consoleDiagnosticsMs: load.consoleDiagnosticsMs,
        infrastructurePreparationMs: load.infrastructurePreparationMs,
        sceneGeometryMs: load.sceneGeometryMs,
        scenePresentationMs: load.scenePresentationMs,
        reactSchedulingGapMs,
        unaccountedOverheadMs,
        totalLoadingMs: totalMs,
      },
      spinner: {
        spinnerHiddenAtMs: load.spinnerHiddenAtMs,
        prematureSpinnerHideMs,
      },
      accounting: {
        accountedMs,
        unaccountedMs: unaccountedOverheadMs,
        totalMs,
        instrumentationOverheadMs: roundMs(load.instrumentationOverheadMs),
      },
    };
  }
}
