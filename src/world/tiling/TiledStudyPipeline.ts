import type {
  BarrierFeature,
  BuildingFeature,
  LanduseFeature,
  LinearWaterwayFeature,
  MapStyleTheme,
  ParkFeature,
  PointLandmarkFeature,
  ProcessedMapData,
  RailwayFeature,
  RoadFeature,
  WaterBodyFeature,
} from '../../types/MapFeature';
import {
  applyTunnelPortalGroundCutoutsToPlanarLayers,
  GeometryBuilder,
  type BuiltSceneGeometry,
  type GeometryBuilderOptions,
} from '../GeometryBuilder';
import { resolveAndValidatePlanarPolygons } from '../PlanarLayerValidator';
import { LocalGeoJsonProvider } from '../LocalGeoJsonProvider';
import {
  DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS,
  normalizeInfrastructureRenderOptions,
  prepareInfrastructureRenderPreview,
  type InfrastructureRenderDescriptorBundle,
  type InfrastructureRenderOptions,
  type InfrastructureRenderPreviewResult,
  type RailwayEdgeRenderDescriptor,
  type RoadEdgeRenderDescriptor,
} from '../infrastructure/rendering/InfrastructureRenderAdapter';
import {
  resolveGraphGradeSeparatedPlans,
  type GraphGradeSeparatedResolutionResult,
} from '../BridgeAndTunnelBuilder';
import { getRailwayElevations, getRoadElevation } from '../ElevationPolicy';
import {
  computeContinuousTrackPhases,
  sortRailwaysMainlineFirst,
} from '../infrastructure/railways/RailwayTopology';
import { VerifiedTunnelEntrances } from '../SurfaceVisibilityPolicy';
import { auditCollarSufficiency, type CollarAuditReport } from './CollarAudit';
import {
  boxesOverlap2D,
  computePointsBBox,
  computeRingBBox,
  type StudyGridSpec,
  type TileDescriptor,
} from './TileGrid';

export interface ProcessMemorySnapshot {
  rssMB: number;
  heapTotalMB: number;
  heapUsedMB: number;
  externalMB: number;
}

export function captureProcessMemorySnapshot(): ProcessMemorySnapshot {
  const mem = process.memoryUsage();
  const toMB = (bytes: number) => Number((bytes / (1024 * 1024)).toFixed(2));
  return {
    rssMB: toMB(mem.rss),
    heapTotalMB: toMB(mem.heapTotal),
    heapUsedMB: toMB(mem.heapUsed),
    externalMB: toMB(mem.external),
  };
}

export interface IngestedStudyRegion {
  grid: StudyGridSpec;
  data: ProcessedMapData;
  descriptors: InfrastructureRenderDescriptorBundle | null;
  previewMeta: Pick<InfrastructureRenderPreviewResult, 'graph' | 'validation' | 'timing'>;
  infrastructureRenderOptions: InfrastructureRenderOptions;
  precomputedGlobalPlans: NonNullable<GeometryBuilderOptions['precomputedGlobalPlans']>;
  ingestTimeMs: number;
  memoryAfterIngest: ProcessMemorySnapshot;
}

export interface SingleSceneReferenceResult {
  scene: BuiltSceneGeometry;
  buildTimeMs: number;
  memoryAfterBuild: ProcessMemorySnapshot;
  dispose: () => void;
}

export interface BuiltTileEntry {
  tile: TileDescriptor;
  scene: BuiltSceneGeometry;
  buildTimeMs: number;
  inputCounts: {
    buildings: number;
    roads: number;
    railways: number;
    landuse: number;
    parks: number;
    waterBodies: number;
    linearWaterways: number;
    barriers: number;
    landmarks: number;
  };
}

export interface TiledStudyBuildResult {
  grid: StudyGridSpec;
  tiles: BuiltTileEntry[];
  collarAudit: CollarAuditReport;
  totalBuildTimeMs: number;
  maxTileBuildTimeMs: number;
  avgTileBuildTimeMs: number;
  peakMemory: ProcessMemorySnapshot;
  memoryAfterAllTiles: ProcessMemorySnapshot;
  dispose: () => void;
}

function cloneDiagnostics(src: ProcessedMapData['diagnostics']): ProcessedMapData['diagnostics'] {
  if (!src) return undefined;
  return JSON.parse(JSON.stringify(src));
}

function cloneProcessedDataForBuild(data: ProcessedMapData): ProcessedMapData {
  return {
    ...data,
    bounds: { ...data.bounds },
    buildings: data.buildings.map((b) => ({ ...b })),
    roads: data.roads.map((r) => ({
      ...r,
      points: r.points.map((p) => [p[0], p[1]] as [number, number]),
    })),
    railways: data.railways.map((r) => ({
      ...r,
      points: r.points.map((p) => [p[0], p[1]] as [number, number]),
    })),
    waterBodies: data.waterBodies.map((w) => ({ ...w })),
    linearWaterways: data.linearWaterways.map((w) => ({ ...w })),
    water: data.water.map((w) => ({ ...w })),
    parks: data.parks.map((p) => ({ ...p })),
    landuse: data.landuse.map((l) => ({ ...l })),
    barriers: data.barriers.map((b) => ({ ...b })),
    landmarks: data.landmarks.map((l) => ({ ...l })),
    diagnostics: cloneDiagnostics(data.diagnostics),
  };
}

function clonePreviewForBuild(
  preview: InfrastructureRenderPreviewResult | null
): InfrastructureRenderPreviewResult | null {
  if (!preview || !preview.descriptors) return preview;
  const d = preview.descriptors;
  const roadNodes = d.roadNodes.map((n) => ({
    ...n,
    incidentEdgeIds: [...n.incidentEdgeIds],
    gradeTransitionIds: [...n.gradeTransitionIds],
    levelCrossingIds: [...n.levelCrossingIds],
  }));
  const roadEdges = d.roadEdges.map((e) => ({
    ...e,
    points: e.points.map((p) => [p[0], p[1]] as [number, number]),
  }));
  const railwayNodes = d.railwayNodes.map((n) => ({
    ...n,
    incidentEdgeIds: [...n.incidentEdgeIds],
    gradeTransitionIds: [...n.gradeTransitionIds],
    levelCrossingIds: [...n.levelCrossingIds],
    flatCrossingIds: [...n.flatCrossingIds],
  }));
  const railwayEdges = d.railwayEdges.map((e) => ({
    ...e,
    points: e.points.map((p) => [p[0], p[1]] as [number, number]),
  }));

  return {
    ...preview,
    descriptors: {
      ...d,
      roadNodes,
      roadEdges,
      railwayNodes,
      railwayEdges,
      roadNodesById: new Map(roadNodes.map((n) => [n.id, n])),
      roadEdgesById: new Map(roadEdges.map((e) => [e.id, e])),
      railwayNodesById: new Map(railwayNodes.map((n) => [n.id, n])),
      railwayEdgesById: new Map(railwayEdges.map((e) => [e.id, e])),
    },
  };
}

/**
 * Ingests a canonical OSM GeoJSON study collection into the fixed ETRS89 / UTM Zone 32N
 * shifted local frame ONCE, builds the study-level InfrastructureGraph + render descriptors
 * ONCE, and precomputes shared global bridge/tunnel plans and railway sleeper phases.
 */
export function ingestCanonicalStudyGeoJson(
  geojson: any,
  grid: StudyGridSpec,
  options?: {
    infrastructureRenderOptions?: Partial<InfrastructureRenderOptions>;
  }
): IngestedStudyRegion {
  const t0 = performance.now();
  const provider = new LocalGeoJsonProvider();
  const data = provider.parseGeoJson(geojson, grid.name, undefined, undefined, {
    coordinateTransformer: grid.projection,
    disableRegionClipping: true,
  });

  const infraOpts = normalizeInfrastructureRenderOptions({
    ...DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS,
    ...options?.infrastructureRenderOptions,
  });
  const preview = prepareInfrastructureRenderPreview(data, infraOpts);
  const descriptors = preview.descriptors;

  const roadGradeSeparatedPlans: GraphGradeSeparatedResolutionResult | null = descriptors
    ? resolveGraphGradeSeparatedPlans(descriptors, 'road', (edge) => {
        const roadEdge = descriptors.roadEdgesById.get(edge.id);
        const roadClass = roadEdge?.roadClass ?? 'residential';
        const isBridge = edge.placementClassification
          ? edge.placementClassification.isElevatedBridge
          : edge.isBridge;
        const isTunnel = edge.placementClassification
          ? edge.placementClassification.isSubterraneanTunnel
          : edge.isTunnel;
        return getRoadElevation(
          roadClass,
          edge.layer,
          isBridge,
          isTunnel,
          edge.sourceFeatureIds[0] || edge.id,
          edge.placementClassification?.supportingEvidence.maxheightMeters
        );
      })
    : null;

  const railwayGradeSeparatedPlans: GraphGradeSeparatedResolutionResult | null = descriptors
    ? resolveGraphGradeSeparatedPlans(descriptors, 'railway', (e) => {
        const railEdge = descriptors.railwayEdgesById.get(e.id);
        return getRailwayElevations(
          e.layer,
          e.placementClassification ? e.placementClassification.isElevatedBridge : e.isBridge,
          e.placementClassification ? e.placementClassification.isSubterraneanTunnel : e.isTunnel,
          {
            railwayType: railEdge?.railwayType,
            electrified: railEdge?.electrified,
            maxheightMeters: e.placementClassification?.supportingEvidence.maxheightMeters,
          }
        ).ballast;
      })
    : null;

  // Compute canonical global railway track phases (matching RailwayGeometryBuilder exactly)
  let railwayTrackPhases = new Map<string, number>();
  if (descriptors && descriptors.railwayEdges.length > 0) {
    const divergingEdgeIds = new Set<string>();
    for (const node of descriptors.railwayNodes) {
      if (
        node.isConfirmedSwitch &&
        node.turnoutTopology?.status === 'confirmed' &&
        node.turnoutTopology.divergingBranchEdgeId
      ) {
        divergingEdgeIds.add(node.turnoutTopology.divergingBranchEdgeId);
      }
    }
    const pseudoRailways: RailwayFeature[] = descriptors.railwayEdges.map((e) => {
      const plan = railwayGradeSeparatedPlans?.plansByEdgeId.get(e.id);
      const snap = railwayGradeSeparatedPlans?.atGradePortalSnapsByEdgeId.get(e.id);
      const pts: [number, number][] = (plan?.points ?? e.points).map(
        (p) => [p[0], p[1]] as [number, number]
      );
      if (snap?.start && pts.length > 0) pts[0] = [snap.start[0], snap.start[1]];
      if (snap?.end && pts.length > 0) pts[pts.length - 1] = [snap.end[0], snap.end[1]];
      return {
        id: e.id,
        sourceFeatureId: e.sourceFeatureId,
        sourceFeatureIds: [...e.sourceFeatureIds],
        type: 'railway' as const,
        points: pts,
        railwayType: e.railwayType,
        width: e.width,
        layer: e.layer,
        isBridge: e.isBridge,
        isTunnel: e.isTunnel,
        placementClassification: e.placementClassification,
        osmTags: e.primaryOsmTags as Record<string, string | number | boolean>,
      };
    });
    const sorted = sortRailwaysMainlineFirst(pseudoRailways, divergingEdgeIds);
    railwayTrackPhases = computeContinuousTrackPhases(sorted);
  } else if (data.railways.length > 0) {
    railwayTrackPhases = computeContinuousTrackPhases(sortRailwaysMainlineFirst(data.railways));
  }

  const tunnelEntrances = new VerifiedTunnelEntrances(data.roads || [], data.railways || []);

  const existingParkingSpaceBoxes: Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> = [];
  for (const item of data.landuse) {
    if (item.landuseType === 'parking_space' && item.polygon && item.polygon[0]?.length >= 3) {
      const bb = computeRingBBox(item.polygon);
      if (bb) existingParkingSpaceBoxes.push(bb);
    }
  }

  const { resolvedById: planarResolvedById, report: planarReport } = resolveAndValidatePlanarPolygons(
    data.landuse || [],
    data.parks || [],
    data.waterBodies || [],
    data.linearWaterways || []
  );
  const polygonRingsById = new Map<string, [number, number][][]>();
  for (const lu of data.landuse) {
    if (lu.polygon) polygonRingsById.set(lu.id, lu.polygon);
  }
  for (const pk of data.parks) {
    if (pk.polygon) polygonRingsById.set(pk.id, pk.polygon);
  }
  applyTunnelPortalGroundCutoutsToPlanarLayers(data, planarResolvedById, tunnelEntrances, 1.0);

  const ingestTimeMs = Number((performance.now() - t0).toFixed(2));
  return {
    grid,
    data,
    descriptors,
    previewMeta: {
      graph: preview.graph,
      validation: preview.validation,
      timing: preview.timing,
    },
    infrastructureRenderOptions: infraOpts,
    precomputedGlobalPlans: {
      roadGradeSeparatedPlans,
      railwayGradeSeparatedPlans,
      railwayTrackPhases,
      tunnelEntrances,
      existingParkingSpaceBoxes,
      planarResolution: {
        resolvedById: planarResolvedById,
        report: planarReport,
        polygonRingsById,
        portalCutoutsApplied: true,
      },
    },
    ingestTimeMs,
    memoryAfterIngest: captureProcessMemorySnapshot(),
  };
}

/**
 * Builds the exact same-source single-scene reference clipped to `grid.studyLocalBounds`
 * using the canonical projection and global infrastructure plans.
 */
export function buildSingleSceneReference(
  ingested: IngestedStudyRegion,
  theme: MapStyleTheme,
  options?: {
    maxSceneTrees?: number;
    initialCameraZoom?: number;
  }
): SingleSceneReferenceResult {
  const t0 = performance.now();
  const buildData = cloneProcessedDataForBuild(ingested.data);
  const preview = clonePreviewForBuild(
    ingested.descriptors
      ? {
          options: ingested.infrastructureRenderOptions,
          graph: ingested.previewMeta.graph,
          descriptors: ingested.descriptors,
          validation: ingested.previewMeta.validation,
          timing: ingested.previewMeta.timing,
        }
      : null
  );

  const builder = new GeometryBuilder({
    initialCameraZoom: options?.initialCameraZoom ?? 1.0,
    infrastructureRenderOptions: ingested.infrastructureRenderOptions,
    infrastructureRenderPreview: preview,
    tileClipBounds: ingested.grid.studyLocalBounds,
    maxSceneTrees: options?.maxSceneTrees ?? 100000,
    precomputedGlobalPlans: ingested.precomputedGlobalPlans,
  });

  const scene = builder.buildScene(buildData, theme);
  const buildTimeMs = Number((performance.now() - t0).toFixed(2));
  return {
    scene,
    buildTimeMs,
    memoryAfterBuild: captureProcessMemorySnapshot(),
    dispose: () => scene.dispose(),
  };
}

/**
 * Filters global ProcessedMapData and InfrastructureRenderDescriptorBundle down to features
 * overlapping `tile.collarLocalBounds` (including incident node arms so border junctions and
 * turnouts retain full neighborhood topology), while preserving unclipped feature geometries.
 */
export function sliceStudyInputsForTile(
  ingested: IngestedStudyRegion,
  tile: TileDescriptor
): {
  tileData: ProcessedMapData;
  tileDescriptors: InfrastructureRenderDescriptorBundle | null;
} {
  const { data, descriptors } = ingested;
  const collar = tile.collarLocalBounds;

  const buildings: BuildingFeature[] = data.buildings.filter((b) => {
    const bb = computeRingBBox(b.footprint);
    return bb ? boxesOverlap2D(bb, collar, 2) : false;
  });

  const landuse: LanduseFeature[] = data.landuse.filter((l) => {
    const bb = computeRingBBox(l.polygon);
    return bb ? boxesOverlap2D(bb, collar, 2) : false;
  });

  const parks: ParkFeature[] = data.parks.filter((p) => {
    const bb = computeRingBBox(p.polygon);
    return bb ? boxesOverlap2D(bb, collar, 2) : false;
  });

  const waterBodies: WaterBodyFeature[] = data.waterBodies.filter((w) => {
    const bb = computeRingBBox(w.polygon);
    return bb ? boxesOverlap2D(bb, collar, 2) : false;
  });

  const linearWaterways: LinearWaterwayFeature[] = data.linearWaterways.filter((w) => {
    const bb = computePointsBBox(w.points);
    return bb ? boxesOverlap2D(bb, collar, (w.width || 10) + 4) : false;
  });

  const barriers: BarrierFeature[] = data.barriers.filter((bar) => {
    const bb = computePointsBBox(bar.points);
    return bb ? boxesOverlap2D(bb, collar, 8) : false;
  });

  const landmarks: PointLandmarkFeature[] = data.landmarks.filter((lm) => {
    const [x, z] = lm.position;
    return (
      x >= collar.minX - 4 &&
      x <= collar.maxX + 4 &&
      z >= collar.minZ - 4 &&
      z <= collar.maxZ + 4
    );
  });

  const roads: RoadFeature[] = data.roads
    .filter((r) => {
      const bb = computePointsBBox(r.points);
      return bb ? boxesOverlap2D(bb, collar, r.width + 8) : false;
    })
    .map((r) => ({ ...r, points: r.points.map((p) => [p[0], p[1]] as [number, number]) }));

  const railways: RailwayFeature[] = data.railways
    .filter((r) => {
      const bb = computePointsBBox(r.points);
      return bb ? boxesOverlap2D(bb, collar, 16) : false;
    })
    .map((r) => ({ ...r, points: r.points.map((p) => [p[0], p[1]] as [number, number]) }));

  let tileDescriptors: InfrastructureRenderDescriptorBundle | null = null;
  if (descriptors) {
    // Select road edges overlapping tile collar + pull in incident edges for junction completeness
    const selectedRoadEdgeIds = new Set<string>();
    const activeRoadNodeIds = new Set<string>();
    for (const edge of descriptors.roadEdges) {
      const bb = computePointsBBox(edge.points as [number, number][]);
      if (bb && boxesOverlap2D(bb, collar, edge.width + 12)) {
        selectedRoadEdgeIds.add(edge.id);
        activeRoadNodeIds.add(edge.fromNodeId);
        activeRoadNodeIds.add(edge.toNodeId);
      }
    }
    for (const nid of activeRoadNodeIds) {
      const node = descriptors.roadNodesById.get(nid);
      if (!node) continue;
      for (const eid of node.incidentEdgeIds) {
        selectedRoadEdgeIds.add(eid);
      }
    }
    const finalRoadNodeIds = new Set<string>();
    const roadEdges: RoadEdgeRenderDescriptor[] = [];
    for (const eid of selectedRoadEdgeIds) {
      const e = descriptors.roadEdgesById.get(eid);
      if (!e) continue;
      roadEdges.push({
        ...e,
        points: e.points.map((p) => [p[0], p[1]] as [number, number]),
      });
      finalRoadNodeIds.add(e.fromNodeId);
      finalRoadNodeIds.add(e.toNodeId);
    }
    const roadNodes = [];
    for (const nid of finalRoadNodeIds) {
      const n = descriptors.roadNodesById.get(nid);
      if (n) {
        roadNodes.push({
          ...n,
          incidentEdgeIds: [...n.incidentEdgeIds],
          gradeTransitionIds: [...n.gradeTransitionIds],
          levelCrossingIds: [...n.levelCrossingIds],
        });
      }
    }

    // Select railway edges overlapping tile collar + pull in incident edges for turnout/sleeper continuity
    const selectedRailEdgeIds = new Set<string>();
    const activeRailNodeIds = new Set<string>();
    for (const edge of descriptors.railwayEdges) {
      const bb = computePointsBBox(edge.points as [number, number][]);
      if (bb && boxesOverlap2D(bb, collar, 16)) {
        selectedRailEdgeIds.add(edge.id);
        activeRailNodeIds.add(edge.fromNodeId);
        activeRailNodeIds.add(edge.toNodeId);
      }
    }
    for (const nid of activeRailNodeIds) {
      const node = descriptors.railwayNodesById.get(nid);
      if (!node) continue;
      for (const eid of node.incidentEdgeIds) {
        selectedRailEdgeIds.add(eid);
      }
    }
    const finalRailNodeIds = new Set<string>();
    const railwayEdges: RailwayEdgeRenderDescriptor[] = [];
    for (const eid of selectedRailEdgeIds) {
      const e = descriptors.railwayEdgesById.get(eid);
      if (!e) continue;
      railwayEdges.push({
        ...e,
        points: e.points.map((p) => [p[0], p[1]] as [number, number]),
      });
      finalRailNodeIds.add(e.fromNodeId);
      finalRailNodeIds.add(e.toNodeId);
    }
    const railwayNodes = [];
    for (const nid of finalRailNodeIds) {
      const n = descriptors.railwayNodesById.get(nid);
      if (n) {
        railwayNodes.push({
          ...n,
          incidentEdgeIds: [...n.incidentEdgeIds],
          gradeTransitionIds: [...n.gradeTransitionIds],
          levelCrossingIds: [...n.levelCrossingIds],
          flatCrossingIds: [...n.flatCrossingIds],
        });
      }
    }

    // Also include roads/railways matching selected edges so barriers / tunnel portals / diagnostics match
    const roadIdsSet = new Set(roads.map((r) => r.id));
    for (const re of roadEdges) {
      if (!roadIdsSet.has(re.id)) {
        const match = data.roads.find((r) => r.id === re.id);
        if (match) {
          roads.push({ ...match, points: match.points.map((p) => [p[0], p[1]] as [number, number]) });
          roadIdsSet.add(re.id);
        }
      }
    }
    const railIdsSet = new Set(railways.map((r) => r.id));
    for (const re of railwayEdges) {
      if (!railIdsSet.has(re.id)) {
        const match = data.railways.find((r) => r.id === re.id);
        if (match) {
          railways.push({ ...match, points: match.points.map((p) => [p[0], p[1]] as [number, number]) });
          railIdsSet.add(re.id);
        }
      }
    }

    tileDescriptors = {
      ...descriptors,
      roadNodes,
      roadEdges,
      railwayNodes,
      railwayEdges,
      roadNodesById: new Map(roadNodes.map((n) => [n.id, n])),
      roadEdgesById: new Map(roadEdges.map((e) => [e.id, e])),
      railwayNodesById: new Map(railwayNodes.map((n) => [n.id, n])),
      railwayEdgesById: new Map(railwayEdges.map((e) => [e.id, e])),
    };
  }

  const tileData: ProcessedMapData = {
    ...data,
    regionName: `${data.regionName}_${tile.id}`,
    bounds: {
      minX: tile.localBounds.minX,
      maxX: tile.localBounds.maxX,
      minZ: tile.localBounds.minZ,
      maxZ: tile.localBounds.maxZ,
      widthMeters: tile.localBounds.maxX - tile.localBounds.minX,
      depthMeters: tile.localBounds.maxZ - tile.localBounds.minZ,
    },
    buildings,
    roads,
    railways,
    waterBodies,
    linearWaterways,
    water: waterBodies,
    parks,
    landuse,
    barriers,
    landmarks,
    diagnostics: cloneDiagnostics(data.diagnostics),
  };

  return { tileData, tileDescriptors };
}

/**
 * Builds all tiles in `ingested.grid` using GeometryBuilder with exact tile clip bounds,
 * global precomputed plans/phases, and explicit 64m collar insufficiency auditing.
 */
export function buildTiledStudyScenes(
  ingested: IngestedStudyRegion,
  theme: MapStyleTheme,
  options?: {
    maxSceneTreesPerTile?: number;
    initialCameraZoom?: number;
    tileFilter?: (tile: TileDescriptor) => boolean;
  }
): TiledStudyBuildResult {
  const tAll0 = performance.now();
  const collarAudit = auditCollarSufficiency({
    data: ingested.data,
    grid: ingested.grid,
    descriptors: ingested.descriptors,
    roadGradeSeparatedPlans: ingested.precomputedGlobalPlans.roadGradeSeparatedPlans,
    railwayGradeSeparatedPlans: ingested.precomputedGlobalPlans.railwayGradeSeparatedPlans,
  });

  const builtTiles: BuiltTileEntry[] = [];
  let maxTileBuildTimeMs = 0;
  let peakMemory = captureProcessMemorySnapshot();
  const mergePeakMemory = (
    peak: ProcessMemorySnapshot,
    sample: ProcessMemorySnapshot
  ): ProcessMemorySnapshot => ({
    rssMB: Math.max(peak.rssMB, sample.rssMB),
    heapTotalMB: Math.max(peak.heapTotalMB, sample.heapTotalMB),
    heapUsedMB: Math.max(peak.heapUsedMB, sample.heapUsedMB),
    externalMB: Math.max(peak.externalMB, sample.externalMB),
  });

  const targetTiles = options?.tileFilter
    ? ingested.grid.tiles.filter(options.tileFilter)
    : ingested.grid.tiles;

  for (const tile of targetTiles) {
    const tTile0 = performance.now();
    const { tileData, tileDescriptors } = sliceStudyInputsForTile(ingested, tile);
    const preview: InfrastructureRenderPreviewResult | null = tileDescriptors
      ? {
          options: ingested.infrastructureRenderOptions,
          graph: ingested.previewMeta.graph,
          descriptors: tileDescriptors,
          validation: ingested.previewMeta.validation,
          timing: ingested.previewMeta.timing,
        }
      : null;

    const builder = new GeometryBuilder({
      initialCameraZoom: options?.initialCameraZoom ?? 1.0,
      infrastructureRenderOptions: ingested.infrastructureRenderOptions,
      infrastructureRenderPreview: preview,
      tileClipBounds: tile.localBounds,
      maxSceneTrees: options?.maxSceneTreesPerTile ?? 50000,
      precomputedGlobalPlans: ingested.precomputedGlobalPlans,
    });

    const scene = builder.buildScene(tileData, theme);
    const buildTimeMs = Number((performance.now() - tTile0).toFixed(2));
    if (buildTimeMs > maxTileBuildTimeMs) maxTileBuildTimeMs = buildTimeMs;

    const memNow = captureProcessMemorySnapshot();
    peakMemory = mergePeakMemory(peakMemory, memNow);

    builtTiles.push({
      tile,
      scene,
      buildTimeMs,
      inputCounts: {
        buildings: tileData.buildings.length,
        roads: tileData.roads.length,
        railways: tileData.railways.length,
        landuse: tileData.landuse.length,
        parks: tileData.parks.length,
        waterBodies: tileData.waterBodies.length,
        linearWaterways: tileData.linearWaterways.length,
        barriers: tileData.barriers.length,
        landmarks: tileData.landmarks.length,
      },
    });
  }

  const totalBuildTimeMs = Number((performance.now() - tAll0).toFixed(2));
  const avgTileBuildTimeMs =
    builtTiles.length > 0
      ? Number(
          (
            builtTiles.reduce((sum, t) => sum + t.buildTimeMs, 0) / builtTiles.length
          ).toFixed(2)
        )
      : 0;

  const memoryAfterAllTiles = captureProcessMemorySnapshot();
  peakMemory = mergePeakMemory(peakMemory, memoryAfterAllTiles);

  return {
    grid: ingested.grid,
    tiles: builtTiles,
    collarAudit,
    totalBuildTimeMs,
    maxTileBuildTimeMs,
    avgTileBuildTimeMs,
    peakMemory,
    memoryAfterAllTiles,
    dispose: () => {
      for (const entry of builtTiles) {
        entry.scene.dispose();
      }
    },
  };
}
