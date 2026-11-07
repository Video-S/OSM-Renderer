import {
  ProcessedMapData,
  InspectableFeatureInfo,
  RoadClass,
  RawGeoJsonProperties,
} from '../../types/MapFeature';
import {
  InfrastructureRenderOptions,
  RoadInfrastructureRenderSource,
  RailwayInfrastructureRenderSource,
  DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS,
} from '../infrastructure/rendering/InfrastructureRenderAdapter';
import { RailwayPrototypeMode } from '../prototype/RailwayPrototypeBuilder';
import { unprojectToGeo } from '../WorldCoordinates';
import { buildRoadNetwork } from '../infrastructure/topology/RoadNetworkBuilder';

/**
 * Serialized representation of camera pose for reproducible bug reports.
 */
export interface SerializedCameraPose {
  target: [number, number, number];
  zoom: number;
  azimuthDeg?: number;
}

/**
 * User-entered defect / issue report metadata.
 */
export interface DefectIssueReportMeta {
  title: string;
  description: string;
  expectedBehavior: string;
  severity?: 'critical' | 'high' | 'medium' | 'low';
  category?: 'junction' | 'width' | 'alignment' | 'railway' | 'elevation' | 'other';
  author?: string;
  createdAt: string;
}

/**
 * Diagnostic metadata regarding the selected feature, its graph connectivity,
 * and renderer provenance.
 */
export interface InspectedGeometryDiagnostics {
  selectedFeatureId: string;
  sourceFeatureIds: string[];
  category: string;
  cartoLabel: string;
  primaryTag: string;
  subtype: string;
  inferredWidth?: number;
  elevation?: number;
  layer?: number;
  isBridge?: boolean;
  isTunnel?: boolean;
  osmTags: Record<string, string | number | boolean>;
  coordinatesMeters?: [number, number][];
  coordinatesGeo?: [number, number][];
  graphConnectivity?: {
    nodeId?: string;
    nodeRole?: string;
    nodeDegree?: number;
    incidentEdgeIds?: string[];
    incidentSourceFeatureIds?: string[];
    isCrossTier?: boolean;
    portalConnections?: Array<{
      roadFeatureId: string;
      sourceFeatureId: string;
      endpoint: 'start' | 'end';
      left: [number, number];
      right: [number, number];
    }>;
  };
}

/**
 * Explicitly selected object metadata captured in the reproduction package.
 */
export interface SelectedObjectRecord {
  id: string;
  osmId?: string;
  category: string;
  subtype?: string;
  cartoLabel?: string;
  primaryTag?: string;
  osmTags: Record<string, string | number | boolean>;
  explicitWidthTag?: string | number | boolean;
  inferredWidth?: number;
  inferredWidthMeters?: number;
  elevation?: number;
  layer?: number;
  isBridge?: boolean;
  isTunnel?: boolean;
  coordinatesMeters?: [number, number][];
  coordinatesGeo?: [number, number][];
  graphNodeId?: string;
  graphRole?: string;
  degree?: number;
  incidentEdgeIds?: string[];
  incidentOsmIds?: string[];
}

/**
 * Geometric bounds for the selected geographic region in both local meters and WGS84.
 */
export interface SelectedAreaRecord {
  spatialBoxMeters: { minX: number; maxX: number; minZ: number; maxZ: number };
  boundsMeters: { minX: number; maxX: number; minZ: number; maxZ: number };
  boundsGeo: { minLon: number; maxLon: number; minLat: number; maxLat: number };
}

/**
 * Concise topological graph context around the reproduction site.
 */
export interface GraphContextSummary {
  nodes: Array<{
    id: string;
    osmNodeId?: string;
    role: string;
    degree: number;
    position: [number, number];
    incidentEdgeIds: string[];
  }>;
  edges: Array<{
    id: string;
    sourceFeatureId?: string;
    roadClass: string;
    inferredWidth: number;
    osmWidthTag?: string;
    fromNodeId: string;
    toNodeId: string;
  }>;
}

/**
 * Complete self-contained developer reproduction package.
 */
export interface DeveloperReproductionPackage {
  formatVersion: '1.0';
  generator: 'OSM-Renderer-DevTools';
  exportedAt: string;
  report: DefectIssueReportMeta;
  configuration: {
    infrastructureRenderOptions: InfrastructureRenderOptions;
    railwayPrototypeMode: RailwayPrototypeMode;
    roadWidthMultiplier?: number;
    heightMultiplier?: number;
    themeId?: string;
    wireframe?: boolean;
  };
  camera: SerializedCameraPose;
  selectedArea?: SelectedAreaRecord;
  selectedObjects?: SelectedObjectRecord[];
  focusedFeatureId?: string | null;
  graphContext?: GraphContextSummary;
  connectedContextFeatureCount?: number;
  /**
   * Backwards-compatible single-inspection field.
   */
  inspection?: InspectedGeometryDiagnostics;
  /**
   * The minimal, self-contained GeoJSON FeatureCollection containing
   * the selected feature(s) and necessary connected context.
   * All original node IDs and properties are preserved verbatim.
   */
  geoJson: {
    type: 'FeatureCollection';
    name?: string;
    features: any[];
    [key: string]: any;
  };
}

/**
 * Checks whether an OSM GeoJSON feature represents physical ground infrastructure
 * rather than a distant transit route, regional network, or administrative boundary.
 */
function isRelevantPhysicalInfrastructure(f: any): boolean {
  if (!f || typeof f !== 'object') return false;
  const p = f.properties || {};

  // Exclude non-physical transit routes (e.g. municipal bus routes, train route relations)
  if (
    p.route === 'bus' ||
    p.route === 'tram' ||
    p.route === 'train' ||
    p.route === 'bicycle' ||
    p.type === 'route' ||
    p.type === 'network'
  ) {
    return false;
  }

  // Exclude administrative, political, or municipal boundary polygons
  if (p.boundary === 'administrative' || p.boundary === 'political') {
    return false;
  }

  return true;
}

/**
 * Helper to extract original OSM features corresponding to selected feature IDs
 * plus immediate connected context (features sharing an OSM node ID or nearby endpoint).
 * Prevents pulling in municipal transit networks or distant long-distance routes.
 */
export function extractConnectedOsmFeatures(
  sourceFeatureIds?: readonly string[] | null,
  fullRawGeoJson?: any,
  options?: {
    includeConnectedRoads?: boolean;
    maxContextHops?: number;
    spatialBoxMeters?: { minX: number; maxX: number; minZ: number; maxZ: number };
    centerLonLat?: [number, number];
  }
): any[] {
  if (!fullRawGeoJson || !Array.isArray(fullRawGeoJson.features)) {
    return [];
  }

  const allFeatures: any[] = fullRawGeoJson.features;
  const targetIdSet = new Set<string>();
  const explicitOsmNodeIds = new Set<string>();

  if (sourceFeatureIds && Array.isArray(sourceFeatureIds)) {
    for (const rawId of sourceFeatureIds) {
      if (!rawId) continue;
      targetIdSet.add(rawId);
      const shortId = rawId.replace(/^(way|node|relation)\//, '');
      targetIdSet.add(shortId);
      targetIdSet.add(`way/${shortId}`);
      targetIdSet.add(`node/${shortId}`);
      if (rawId.startsWith('node/') || rawId.startsWith('osmNode/')) {
        explicitOsmNodeIds.add(shortId);
      }
    }
  }

  // If no specific feature and no spatial box requested, export all features
  if (targetIdSet.size === 0 && !options?.spatialBoxMeters) {
    return allFeatures.filter(isRelevantPhysicalInfrastructure);
  }

  const getFeatureId = (f: any): string => {
    return String(f.id ?? f.properties?.id ?? f.properties?.['@id'] ?? '');
  };

  const getNodeIds = (f: any): string[] => {
    const raw = f.properties?._nodeIds ?? f.properties?.nodes ?? f.properties?.nodeIds;
    if (Array.isArray(raw)) {
      return raw.map((n: any) => String(n));
    }
    return [];
  };

  // 1. Identify primary features matching targetIdSet
  const primaryFeatures: any[] = [];
  const primaryFeatureIds = new Set<string>();
  const junctionNodeIdsForExpansion = new Set<string>(explicitOsmNodeIds);

  for (const f of allFeatures) {
    const fid = getFeatureId(f);
    const shortId = fid.replace(/^(way|node|relation)\//, '');
    if (
      targetIdSet.has(fid) ||
      targetIdSet.has(shortId) ||
      targetIdSet.has(`way/${shortId}`) ||
      targetIdSet.has(`node/${shortId}`)
    ) {
      primaryFeatures.push(f);
      primaryFeatureIds.add(fid);
      for (const nid of getNodeIds(f)) {
        junctionNodeIdsForExpansion.add(nid);
      }
    }
  }

  // If spatial box is specified, include physical infrastructure features intersecting that box
  if (options?.spatialBoxMeters && options.centerLonLat) {
    const [cLon, cLat] = options.centerLonLat;
    const box = options.spatialBoxMeters;
    const [minLon, maxLat] = unprojectToGeo(box.minX, box.minZ, cLon, cLat);
    const [maxLon, minLat] = unprojectToGeo(box.maxX, box.maxZ, cLon, cLat);
    const geoMinLon = Math.min(minLon, maxLon);
    const geoMaxLon = Math.max(minLon, maxLon);
    const geoMinLat = Math.min(minLat, maxLat);
    const geoMaxLat = Math.max(minLat, maxLat);

    // Margin bounds (~40m) for node expansion
    const [mMinLon, mMaxLat] = unprojectToGeo(box.minX - 40, box.minZ - 40, cLon, cLat);
    const [mMaxLon, mMinLat] = unprojectToGeo(box.maxX + 40, box.maxZ + 40, cLon, cLat);
    const marginMinLon = Math.min(mMinLon, mMaxLon);
    const marginMaxLon = Math.max(mMinLon, mMaxLon);
    const marginMinLat = Math.min(mMinLat, mMaxLat);
    const marginMaxLat = Math.max(mMinLat, mMaxLat);

    for (const f of allFeatures) {
      if (!isRelevantPhysicalInfrastructure(f)) continue;
      const fid = getFeatureId(f);
      if (primaryFeatureIds.has(fid)) continue;

      const coords = f.geometry?.coordinates;
      if (!coords) continue;
      const pts: number[][] = Array.isArray(coords[0])
        ? Array.isArray(coords[0][0])
          ? coords.flat(2)
          : coords
        : [coords];

      // Check if feature intersects the spatial box
      const intersectsBox = pts.some(
        (p: number[]) =>
          p[0] >= geoMinLon && p[0] <= geoMaxLon && p[1] >= geoMinLat && p[1] <= geoMaxLat
      );

      if (intersectsBox) {
        primaryFeatures.push(f);
        primaryFeatureIds.add(fid);

        // Crucial: Only add node IDs for vertices located within or near the spatial box.
        // Prevents adding hundreds of distant nodes from a trunk road that spans kilometers.
        const nodeIds = getNodeIds(f);
        if (nodeIds.length === pts.length) {
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            if (
              p[0] >= marginMinLon &&
              p[0] <= marginMaxLon &&
              p[1] >= marginMinLat &&
              p[1] <= marginMaxLat
            ) {
              junctionNodeIdsForExpansion.add(nodeIds[i]);
            }
          }
        } else {
          for (const nid of nodeIds) {
            junctionNodeIdsForExpansion.add(nid);
          }
        }
      }
    }
  }

  // 2. Context expansion: include connected physical roads & railways sharing junction node IDs
  const resultFeatures = [...primaryFeatures];
  const includedIds = new Set(primaryFeatureIds);

  if (options?.includeConnectedRoads !== false && junctionNodeIdsForExpansion.size > 0) {
    for (const f of allFeatures) {
      if (!isRelevantPhysicalInfrastructure(f)) continue;
      const fid = getFeatureId(f);
      if (includedIds.has(fid)) continue;

      // Connected context for junction geometry must be physical road or railway infrastructure
      const p = f.properties || {};
      if (!p.highway && !p.railway) continue;

      const fNodeIds = getNodeIds(f);
      const sharesNode = fNodeIds.some((nid) => junctionNodeIdsForExpansion.has(nid));
      if (sharesNode) {
        resultFeatures.push(f);
        includedIds.add(fid);
      }
    }
  }

  return resultFeatures;
}

/**
 * Creates a developer reproduction package from current scene context.
 */
export function buildReproductionPackage(
  paramsOrReport:
    | {
        report: Omit<DefectIssueReportMeta, 'createdAt'> & { createdAt?: string };
        selectedFeature?: InspectableFeatureInfo | null;
        selectedFeatures?: InspectableFeatureInfo[];
        focusedFeatureId?: string | null;
        mapData: ProcessedMapData | null;
        fullRawGeoJson: any;
        infrastructureRenderOptions: InfrastructureRenderOptions;
        railwayPrototypeMode: RailwayPrototypeMode;
        cameraPose: SerializedCameraPose;
        spatialBoxMeters?: { minX: number; maxX: number; minZ: number; maxZ: number };
        roadWidthMultiplier?: number;
        heightMultiplier?: number;
        themeId?: string;
        wireframe?: boolean;
      }
    | (Omit<DefectIssueReportMeta, 'createdAt'> & { createdAt?: string }),
  maybeMapData?: ProcessedMapData | null,
  maybeRawGeoJson?: any,
  maybeSelectedFeature?: InspectableFeatureInfo | null,
  maybeSpatialBox?: { minX: number; maxX: number; minZ: number; maxZ: number } | null,
  maybeConfig?: {
    infrastructureRenderOptions?: InfrastructureRenderOptions;
    railwayPrototypeMode?: RailwayPrototypeMode;
    themeId?: string;
    roadWidthMultiplier?: number;
    wireframe?: boolean;
    heightMultiplier?: number;
  },
  maybeCamera?: SerializedCameraPose,
  maybeOptions?: {
    selectedFeatures?: InspectableFeatureInfo[];
    focusedFeatureId?: string | null;
  }
): DeveloperReproductionPackage {
  let report: Omit<DefectIssueReportMeta, 'createdAt'> & { createdAt?: string };
  let selectedFeature: InspectableFeatureInfo | null | undefined;
  let selectedFeatures: InspectableFeatureInfo[] | undefined;
  let focusedFeatureId: string | null | undefined;
  let mapData: ProcessedMapData | null;
  let fullRawGeoJson: any;
  let infrastructureRenderOptions: InfrastructureRenderOptions;
  let railwayPrototypeMode: RailwayPrototypeMode;
  let cameraPose: SerializedCameraPose;
  let spatialBoxMeters: { minX: number; maxX: number; minZ: number; maxZ: number } | undefined;
  let roadWidthMultiplier: number = 1.0;
  let heightMultiplier: number = 1.0;
  let themeId: string = 'tactical';
  let wireframe: boolean = false;

  if (paramsOrReport && 'report' in paramsOrReport && typeof paramsOrReport.report === 'object') {
    const p = paramsOrReport as any;
    report = p.report;
    selectedFeature = p.selectedFeature;
    selectedFeatures = p.selectedFeatures;
    focusedFeatureId = p.focusedFeatureId;
    mapData = p.mapData;
    fullRawGeoJson = p.fullRawGeoJson;
    infrastructureRenderOptions =
      p.infrastructureRenderOptions ?? DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS;
    railwayPrototypeMode = p.railwayPrototypeMode ?? 'production';
    cameraPose = p.cameraPose ?? { target: [0, 0, 0], zoom: 1.0 };
    spatialBoxMeters = p.spatialBoxMeters;
    roadWidthMultiplier = p.roadWidthMultiplier ?? 1.0;
    heightMultiplier = p.heightMultiplier ?? 1.0;
    themeId = p.themeId ?? 'tactical';
    wireframe = p.wireframe ?? false;
  } else {
    report = paramsOrReport as any;
    mapData = maybeMapData ?? null;
    fullRawGeoJson = maybeRawGeoJson;
    selectedFeature = maybeSelectedFeature;
    selectedFeatures = maybeOptions?.selectedFeatures;
    focusedFeatureId = maybeOptions?.focusedFeatureId;
    spatialBoxMeters = maybeSpatialBox ?? undefined;
    infrastructureRenderOptions =
      maybeConfig?.infrastructureRenderOptions ?? DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS;
    railwayPrototypeMode = maybeConfig?.railwayPrototypeMode ?? 'production';
    cameraPose = maybeCamera ?? { target: [0, 0, 0], zoom: 1.0 };
    roadWidthMultiplier = maybeConfig?.roadWidthMultiplier ?? 1.0;
    heightMultiplier = maybeConfig?.heightMultiplier ?? 1.0;
    themeId = maybeConfig?.themeId ?? 'tactical';
    wireframe = maybeConfig?.wireframe ?? false;
  }

  // Consolidate target selection IDs from both selectedFeatures and single selectedFeature
  const effectiveSelectedList: InspectableFeatureInfo[] = [];
  if (Array.isArray(selectedFeatures) && selectedFeatures.length > 0) {
    effectiveSelectedList.push(...selectedFeatures);
  } else if (selectedFeature) {
    effectiveSelectedList.push(selectedFeature);
  }

  const targetIds: string[] = [];
  for (const feat of effectiveSelectedList) {
    if (feat.sourceFeatureIds && feat.sourceFeatureIds.length > 0) {
      targetIds.push(...feat.sourceFeatureIds);
    } else if (feat.sourceFeatureId) {
      targetIds.push(feat.sourceFeatureId);
    } else if (feat.id) {
      targetIds.push(feat.id);
    }
  }

  const centerLonLat: [number, number] = mapData?.centerLonLat ?? [4.9003, 52.3791];

  let extractedFeatures = extractConnectedOsmFeatures(targetIds, fullRawGeoJson, {
    includeConnectedRoads: true,
    spatialBoxMeters,
    centerLonLat,
  });

  // Fallback: if raw GeoJSON wasn't available or had no features, synthesize valid OSM GeoJSON
  if (extractedFeatures.length === 0 && mapData) {
    const synthFeatures: any[] = [];
    const sourceIdsSet = new Set(targetIds);

    const relevantRoads = mapData.roads.filter(
      (r) =>
        sourceIdsSet.has(r.sourceFeatureId || '') ||
        sourceIdsSet.has(r.id) ||
        (spatialBoxMeters &&
          r.points.some(
            (p) =>
              p[0] >= spatialBoxMeters.minX &&
              p[0] <= spatialBoxMeters.maxX &&
              p[1] >= spatialBoxMeters.minZ &&
              p[1] <= spatialBoxMeters.maxZ
          ))
    );

    for (const r of relevantRoads) {
      const coords = r.points.map((pt) =>
        unprojectToGeo(pt[0], pt[1], centerLonLat[0], centerLonLat[1])
      );
      synthFeatures.push({
        type: 'Feature',
        id: r.sourceFeatureId || r.id,
        properties: {
          id: r.sourceFeatureId || r.id,
          highway: r.roadClass,
          name: r.name,
          width: r.width,
          ...(r.osmTags ?? {}),
          _nodeIds: r.nodeIds,
        },
        geometry: {
          type: 'LineString',
          coordinates: coords,
        },
      });
    }

    if (synthFeatures.length > 0) {
      extractedFeatures = synthFeatures;
    } else if (fullRawGeoJson && Array.isArray(fullRawGeoJson.features)) {
      extractedFeatures = fullRawGeoJson.features.filter(isRelevantPhysicalInfrastructure).slice(0, 30);
    }
  }

  // Construct selectedObjects record list
  const selectedObjects: SelectedObjectRecord[] = effectiveSelectedList.map((feat) => {
    let explicitWidthTag: string | number | boolean | undefined;
    if (feat.osmTags) {
      explicitWidthTag = feat.osmTags.width ?? feat.osmTags.est_width;
    }
    const osmId = feat.sourceFeatureId || feat.id;

    let coordsMeters: [number, number][] | undefined;
    let coordsGeo: [number, number][] | undefined;

    if (mapData) {
      const road = mapData.roads.find(
        (r) => r.sourceFeatureId === feat.sourceFeatureId || r.id === feat.id
      );
      if (road) {
        coordsMeters = road.points;
        coordsGeo = road.points.map((pt) =>
          unprojectToGeo(pt[0], pt[1], centerLonLat[0], centerLonLat[1])
        );
        if (!explicitWidthTag && road.osmTags) {
          explicitWidthTag = (road.osmTags as any).width ?? (road.osmTags as any).est_width;
        }
      }
    }

    const resolvedInferredWidth =
      feat.width ?? (feat as any).inferredWidthMeters ?? (feat as any).widthMeters;

    return {
      id: feat.id,
      osmId,
      category: feat.category,
      subtype: feat.subtype,
      cartoLabel: feat.cartoLabel,
      primaryTag: feat.primaryTag,
      osmTags: feat.osmTags ?? {},
      explicitWidthTag,
      inferredWidth: resolvedInferredWidth,
      inferredWidthMeters: resolvedInferredWidth,
      elevation: feat.elevation,
      layer: feat.layer,
      isBridge: feat.isBridge,
      isTunnel: feat.isTunnel,
      coordinatesMeters: coordsMeters,
      coordinatesGeo: coordsGeo,
      graphNodeId: (feat as any).osmNodeId ? String((feat as any).osmNodeId) : undefined,
      graphRole: (feat as any).role || (feat as any).subtype,
      degree: (feat as any).degree,
      incidentEdgeIds: (feat as any).incidentEdgeIds,
      incidentOsmIds: feat.sourceFeatureIds,
    };
  });

  // Construct selectedArea record if spatial box is active
  let selectedArea: SelectedAreaRecord | undefined;
  if (spatialBoxMeters) {
    const [minLon, maxLat] = unprojectToGeo(
      spatialBoxMeters.minX,
      spatialBoxMeters.minZ,
      centerLonLat[0],
      centerLonLat[1]
    );
    const [maxLon, minLat] = unprojectToGeo(
      spatialBoxMeters.maxX,
      spatialBoxMeters.maxZ,
      centerLonLat[0],
      centerLonLat[1]
    );
    selectedArea = {
      spatialBoxMeters: { ...spatialBoxMeters },
      boundsMeters: { ...spatialBoxMeters },
      boundsGeo: {
        minLon: Math.min(minLon, maxLon),
        maxLon: Math.max(minLon, maxLon),
        minLat: Math.min(minLat, maxLat),
        maxLat: Math.max(minLat, maxLat),
      },
    };
  }

  // Construct concise graphContext summary around the defect site
  let graphContext: GraphContextSummary | undefined;
  const descriptors = (mapData as any)?.infrastructureRenderPreview?.descriptors;
  if (descriptors?.roadNodes && descriptors?.roadEdges) {
    const relevantEdgeIds = new Set<string>();
    const relEdges: GraphContextSummary['edges'] = [];

    for (const edge of descriptors.roadEdges) {
      const matchesSelected = targetIds.includes(edge.sourceFeatureId) || targetIds.includes(edge.id);
      const inBox =
        spatialBoxMeters &&
        edge.points.some(
          (p: [number, number]) =>
            p[0] >= spatialBoxMeters.minX &&
            p[0] <= spatialBoxMeters.maxX &&
            p[1] >= spatialBoxMeters.minZ &&
            p[1] <= spatialBoxMeters.maxZ
        );
      if (matchesSelected || inBox) {
        relEdges.push({
          id: edge.id,
          sourceFeatureId: edge.sourceFeatureId,
          roadClass: edge.roadClass,
          inferredWidth: edge.width,
          osmWidthTag: edge.osmTags?.width,
          fromNodeId: edge.fromNodeId,
          toNodeId: edge.toNodeId,
        });
        relevantEdgeIds.add(edge.id);
      }
    }

    const relNodes: GraphContextSummary['nodes'] = descriptors.roadNodes
      .filter((n: any) => {
        const touchesRelEdge = n.incidentEdgeIds?.some((eid: string) => relevantEdgeIds.has(eid));
        const inBox =
          spatialBoxMeters &&
          n.position[0] >= spatialBoxMeters.minX &&
          n.position[0] <= spatialBoxMeters.maxX &&
          n.position[1] >= spatialBoxMeters.minZ &&
          n.position[1] <= spatialBoxMeters.maxZ;
        return touchesRelEdge || inBox;
      })
      .map((n: any) => ({
        id: n.id,
        osmNodeId: n.rawOsmNodeId ?? n.osmNodeId,
        role: n.primaryRole,
        degree: n.degree,
        position: n.position,
        incidentEdgeIds: n.incidentEdgeIds || [],
      }));

    if (relNodes.length > 0 || relEdges.length > 0) {
      graphContext = {
        nodes: relNodes,
        edges: relEdges,
      };
    }
  } else if (mapData) {
    try {
      const roadNet = buildRoadNetwork(mapData).roads;
      const relevantEdgeIds = new Set<string>();
      const relEdges: GraphContextSummary['edges'] = [];

      for (const edge of roadNet.edges.values()) {
        const sourceIds = edge.provenance?.sourceFeatureIds ?? [];
        const primarySourceId = sourceIds[0];
        const firstSegTags = edge.provenance?.segments?.[0]?.osmTags;
        const matchesSelected =
          (primarySourceId && targetIds.includes(primarySourceId)) ||
          sourceIds.some((sid) => targetIds.includes(sid)) ||
          targetIds.includes(edge.id);
        const inBox =
          spatialBoxMeters &&
          edge.points.some(
            (p) =>
              p[0] >= spatialBoxMeters.minX &&
              p[0] <= spatialBoxMeters.maxX &&
              p[1] >= spatialBoxMeters.minZ &&
              p[1] <= spatialBoxMeters.maxZ
          );
        if (matchesSelected || inBox || (targetIds.length === 0 && !spatialBoxMeters)) {
          relEdges.push({
            id: edge.id,
            sourceFeatureId: primarySourceId,
            roadClass: edge.roadClass,
            inferredWidth: edge.width,
            osmWidthTag:
              firstSegTags?.width !== undefined ? String(firstSegTags.width) : undefined,
            fromNodeId: edge.fromNodeId,
            toNodeId: edge.toNodeId,
          });
          relevantEdgeIds.add(edge.id);
        }
      }

      const relNodes: GraphContextSummary['nodes'] = Array.from(roadNet.nodes.values())
        .filter((n) => {
          const touchesRelEdge = n.incidentEdgeIds.some((eid) => relevantEdgeIds.has(eid));
          const inBox =
            spatialBoxMeters &&
            n.x >= spatialBoxMeters.minX &&
            n.x <= spatialBoxMeters.maxX &&
            n.z >= spatialBoxMeters.minZ &&
            n.z <= spatialBoxMeters.maxZ;
          return touchesRelEdge || inBox;
        })
        .map((n) => ({
          id: n.id,
          osmNodeId: n.rawOsmNodeId,
          role: n.primaryRole || n.roles[0] || 'endpoint',
          degree: n.degree,
          position: [n.x, n.z] as [number, number],
          incidentEdgeIds: [...n.incidentEdgeIds],
        }));

      if (relNodes.length > 0 || relEdges.length > 0) {
        graphContext = {
          nodes: relNodes,
          edges: relEdges,
        };
      }
    } catch {
      // Non-fatal fallback if road network cannot be built
    }
  }

  // Backwards-compatible single inspection field (focused or first selected feature)
  const primarySelected =
    effectiveSelectedList.find((f) => f.id === focusedFeatureId) ||
    effectiveSelectedList[0] ||
    selectedFeature;

  let inspection: InspectedGeometryDiagnostics | undefined;
  if (primarySelected) {
    const rawCoordsMeters: [number, number][] = [];
    if (mapData) {
      const road = mapData.roads.find(
        (r) =>
          r.sourceFeatureId === primarySelected.sourceFeatureId ||
          r.id === primarySelected.id
      );
      if (road) {
        rawCoordsMeters.push(...road.points);
      }
    }

    const coordsGeo = rawCoordsMeters.map((pt) =>
      unprojectToGeo(pt[0], pt[1], centerLonLat[0], centerLonLat[1])
    );

    inspection = {
      selectedFeatureId: primarySelected.id,
      sourceFeatureIds: primarySelected.sourceFeatureIds ?? [primarySelected.sourceFeatureId],
      category: primarySelected.category,
      cartoLabel: primarySelected.cartoLabel,
      primaryTag: primarySelected.primaryTag,
      subtype: primarySelected.subtype,
      inferredWidth: primarySelected.width,
      elevation: primarySelected.elevation,
      layer: primarySelected.layer,
      isBridge: primarySelected.isBridge,
      isTunnel: primarySelected.isTunnel,
      osmTags: primarySelected.osmTags ?? {},
      coordinatesMeters: rawCoordsMeters.length > 0 ? rawCoordsMeters : undefined,
      coordinatesGeo: coordsGeo.length > 0 ? coordsGeo : undefined,
      graphConnectivity: primarySelected.portalConnections
        ? {
            portalConnections: primarySelected.portalConnections,
            incidentSourceFeatureIds: primarySelected.sourceFeatureIds,
          }
        : undefined,
    };
  }

  const explicitTargetIdSet = new Set(targetIds);
  const autoContextCount =
    explicitTargetIdSet.size > 0
      ? extractedFeatures.filter(
          (f: any) =>
            !explicitTargetIdSet.has(
              String(f.id ?? f.properties?.id ?? f.properties?.['@id'] ?? '')
            )
        ).length
      : extractedFeatures.length;

  return {
    formatVersion: '1.0',
    generator: 'OSM-Renderer-DevTools',
    exportedAt: new Date().toISOString(),
    report: {
      title: report.title.trim() || 'Untitled Renderer Defect',
      description: report.description.trim(),
      expectedBehavior: report.expectedBehavior.trim(),
      severity: report.severity ?? 'medium',
      category: report.category ?? 'junction',
      author: report.author?.trim(),
      createdAt: report.createdAt ?? new Date().toISOString(),
    },
    configuration: {
      infrastructureRenderOptions: { ...infrastructureRenderOptions },
      railwayPrototypeMode,
      roadWidthMultiplier,
      heightMultiplier,
      themeId,
      wireframe,
    },
    camera: { ...cameraPose },
    selectedArea,
    selectedObjects: selectedObjects.length > 0 ? selectedObjects : undefined,
    focusedFeatureId: focusedFeatureId ?? primarySelected?.id ?? null,
    graphContext,
    connectedContextFeatureCount: autoContextCount,
    inspection,
    geoJson: {
      type: 'FeatureCollection',
      name: `${report.title.trim() || 'OSM Repro'} · Repro Package`,
      features: extractedFeatures,
    },
  };
}

/**
 * Validates whether an imported JSON object conforms to DeveloperReproductionPackage.
 * Provides backwards compatibility for single-feature inspection reports.
 */
export function validateReproductionPackage(data: any): {
  valid: boolean;
  error?: string;
  errors: string[];
  package?: DeveloperReproductionPackage;
} {
  const errors: string[] = [];
  if (!data || typeof data !== 'object') {
    return {
      valid: false,
      error: 'Input must be a valid JSON object',
      errors: ['Input must be a valid JSON object'],
    };
  }
  if (!data.report || typeof data.report !== 'object') {
    errors.push('Package must contain a valid report object');
  }
  if (!data.geoJson || data.geoJson.type !== 'FeatureCollection' || !Array.isArray(data.geoJson.features)) {
    errors.push('Package must contain a GeoJSON FeatureCollection');
  }
  if (errors.length > 0) {
    return { valid: false, error: errors[0], errors };
  }

  // Restore selectedObjects with fallback to legacy inspection
  let restoredObjects: SelectedObjectRecord[] = [];
  if (Array.isArray(data.selectedObjects) && data.selectedObjects.length > 0) {
    restoredObjects = data.selectedObjects;
  } else if (data.inspection) {
    const insp = data.inspection;
    restoredObjects = [
      {
        id: insp.selectedFeatureId || 'selected_feature',
        osmId: insp.sourceFeatureIds?.[0] || insp.selectedFeatureId,
        category: insp.category || 'Feature',
        subtype: insp.subtype,
        cartoLabel: insp.cartoLabel,
        primaryTag: insp.primaryTag,
        osmTags: insp.osmTags || {},
        inferredWidth: insp.inferredWidth,
        inferredWidthMeters: insp.inferredWidth,
        elevation: insp.elevation,
        layer: insp.layer,
        isBridge: insp.isBridge,
        isTunnel: insp.isTunnel,
        coordinatesMeters: insp.coordinatesMeters,
        coordinatesGeo: insp.coordinatesGeo,
      },
    ];
  }

  // Restore selectedArea with fallback to legacy selectedBoxMeters
  let restoredArea: SelectedAreaRecord | undefined = data.selectedArea;
  if (restoredArea && !restoredArea.boundsMeters && restoredArea.spatialBoxMeters) {
    restoredArea = {
      ...restoredArea,
      boundsMeters: restoredArea.spatialBoxMeters,
    };
  } else if (!restoredArea && data.selectedBoxMeters) {
    restoredArea = {
      spatialBoxMeters: data.selectedBoxMeters,
      boundsMeters: data.selectedBoxMeters,
      boundsGeo: data.boundsGeo || { minLon: 0, maxLon: 0, minLat: 0, maxLat: 0 },
    };
  }

  const pkg: DeveloperReproductionPackage = {
    formatVersion: '1.0',
    generator: 'OSM-Renderer-DevTools',
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : new Date().toISOString(),
    report: {
      title: data.report?.title || 'Imported Defect Reproduction',
      description: data.report?.description || '',
      expectedBehavior: data.report?.expectedBehavior || '',
      severity: data.report?.severity || 'medium',
      category: data.report?.category || 'junction',
      author: data.report?.author,
      createdAt: data.report?.createdAt || new Date().toISOString(),
    },
    configuration: {
      infrastructureRenderOptions: {
        roads: data.configuration?.infrastructureRenderOptions?.roads ?? 'graph',
        railways: data.configuration?.infrastructureRenderOptions?.railways ?? 'legacy',
      },
      railwayPrototypeMode: data.configuration?.railwayPrototypeMode ?? 'production',
      roadWidthMultiplier:
        typeof data.configuration?.roadWidthMultiplier === 'number'
          ? data.configuration.roadWidthMultiplier
          : 1.0,
      heightMultiplier:
        typeof data.configuration?.heightMultiplier === 'number'
          ? data.configuration.heightMultiplier
          : 1.0,
      themeId: data.configuration?.themeId ?? 'tactical',
      wireframe: Boolean(data.configuration?.wireframe),
    },
    camera: {
      target:
        Array.isArray(data.camera?.target) && data.camera.target.length === 3
          ? data.camera.target
          : [0, 0, 0],
      zoom: typeof data.camera?.zoom === 'number' ? data.camera.zoom : 8.0,
      azimuthDeg:
        typeof data.camera?.azimuthDeg === 'number' ? data.camera.azimuthDeg : 45,
    },
    selectedArea: restoredArea,
    selectedObjects: restoredObjects.length > 0 ? restoredObjects : undefined,
    focusedFeatureId: data.focusedFeatureId || restoredObjects[0]?.id || null,
    graphContext: data.graphContext,
    connectedContextFeatureCount:
      typeof data.connectedContextFeatureCount === 'number'
        ? data.connectedContextFeatureCount
        : data.geoJson.features.length,
    inspection: data.inspection,
    geoJson: data.geoJson,
  };

  return { valid: true, errors: [], package: pkg };
}
