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
 * Helper to extract original OSM features corresponding to selected feature IDs
 * plus immediate connected context (features sharing an OSM node ID or nearby endpoint).
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

  if (sourceFeatureIds && Array.isArray(sourceFeatureIds)) {
    for (const rawId of sourceFeatureIds) {
      if (!rawId) continue;
      targetIdSet.add(rawId);
      if (rawId.startsWith('way/')) targetIdSet.add(rawId.slice(4));
      else targetIdSet.add(`way/${rawId}`);
      if (rawId.startsWith('node/')) targetIdSet.add(rawId.slice(5));
      else targetIdSet.add(`node/${rawId}`);
    }
  }

  // If no specific feature and no spatial box requested, export all features
  if (targetIdSet.size === 0 && !options?.spatialBoxMeters) {
    return [...allFeatures];
  }

  // 1. Identify primary features matching targetIdSet
  const primaryFeatures: any[] = [];
  const targetNodeIds = new Set<string>();

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

  for (const f of allFeatures) {
    const fid = getFeatureId(f);
    const shortId = fid.replace(/^(way|node|relation)\//, '');
    const longId = fid.includes('/') ? fid : `way/${fid}`;
    if (targetIdSet.has(fid) || targetIdSet.has(shortId) || targetIdSet.has(longId)) {
      primaryFeatures.push(f);
      for (const nid of getNodeIds(f)) {
        targetNodeIds.add(nid);
      }
    }
  }

  // If spatial box is specified, include features intersecting that box
  if (options?.spatialBoxMeters && options.centerLonLat) {
    const [cLon, cLat] = options.centerLonLat;
    const box = options.spatialBoxMeters;
    const [minLon, maxLat] = unprojectToGeo(box.minX, box.minZ, cLon, cLat);
    const [maxLon, minLat] = unprojectToGeo(box.maxX, box.maxZ, cLon, cLat);
    const geoMinLon = Math.min(minLon, maxLon);
    const geoMaxLon = Math.max(minLon, maxLon);
    const geoMinLat = Math.min(minLat, maxLat);
    const geoMaxLat = Math.max(minLat, maxLat);

    for (const f of allFeatures) {
      if (primaryFeatures.includes(f)) continue;
      const coords = f.geometry?.coordinates;
      if (!coords) continue;
      // Check if any point falls within bounding box
      const pts: number[][] = Array.isArray(coords[0])
        ? Array.isArray(coords[0][0])
          ? coords.flat(2)
          : coords
        : [coords];
      const hits = pts.some((p: number[]) =>
        p[0] >= geoMinLon && p[0] <= geoMaxLon && p[1] >= geoMinLat && p[1] <= geoMaxLat
      );
      if (hits) {
        primaryFeatures.push(f);
        for (const nid of getNodeIds(f)) {
          targetNodeIds.add(nid);
        }
      }
    }
  }

  // 2. Context expansion: include connected features sharing verified node IDs
  const resultFeatures = [...primaryFeatures];
  const includedIds = new Set(resultFeatures.map(getFeatureId));

  if (options?.includeConnectedRoads !== false && targetNodeIds.size > 0) {
    for (const f of allFeatures) {
      const fid = getFeatureId(f);
      if (includedIds.has(fid)) continue;
      const fNodeIds = getNodeIds(f);
      const sharesNode = fNodeIds.some((nid) => targetNodeIds.has(nid));
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
        mapData: ProcessedMapData | null;
        fullRawGeoJson: any;
        infrastructureRenderOptions: InfrastructureRenderOptions;
        railwayPrototypeMode: RailwayPrototypeMode;
        cameraPose: SerializedCameraPose;
        spatialBoxMeters?: { minX: number; maxX: number; minZ: number; maxZ: number };
        roadWidthMultiplier?: number;
        heightMultiplier?: number;
        themeId?: string;
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
  maybeCamera?: SerializedCameraPose
): DeveloperReproductionPackage {
  let report: Omit<DefectIssueReportMeta, 'createdAt'> & { createdAt?: string };
  let selectedFeature: InspectableFeatureInfo | null | undefined;
  let mapData: ProcessedMapData | null;
  let fullRawGeoJson: any;
  let infrastructureRenderOptions: InfrastructureRenderOptions;
  let railwayPrototypeMode: RailwayPrototypeMode;
  let cameraPose: SerializedCameraPose;
  let spatialBoxMeters: { minX: number; maxX: number; minZ: number; maxZ: number } | undefined;
  let roadWidthMultiplier: number = 1.0;
  let heightMultiplier: number = 1.0;
  let themeId: string = 'tactical';

  if (paramsOrReport && 'report' in paramsOrReport && typeof paramsOrReport.report === 'object') {
    const p = paramsOrReport as any;
    report = p.report;
    selectedFeature = p.selectedFeature;
    mapData = p.mapData;
    fullRawGeoJson = p.fullRawGeoJson;
    infrastructureRenderOptions = p.infrastructureRenderOptions ?? DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS;
    railwayPrototypeMode = p.railwayPrototypeMode ?? 'production';
    cameraPose = p.cameraPose ?? { target: [0, 0, 0], zoom: 1.0 };
    spatialBoxMeters = p.spatialBoxMeters;
    roadWidthMultiplier = p.roadWidthMultiplier ?? 1.0;
    heightMultiplier = p.heightMultiplier ?? 1.0;
    themeId = p.themeId ?? 'tactical';
  } else {
    report = paramsOrReport as any;
    mapData = maybeMapData ?? null;
    fullRawGeoJson = maybeRawGeoJson;
    selectedFeature = maybeSelectedFeature;
    spatialBoxMeters = maybeSpatialBox ?? undefined;
    infrastructureRenderOptions = maybeConfig?.infrastructureRenderOptions ?? DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS;
    railwayPrototypeMode = maybeConfig?.railwayPrototypeMode ?? 'production';
    cameraPose = maybeCamera ?? { target: [0, 0, 0], zoom: 1.0 };
    roadWidthMultiplier = maybeConfig?.roadWidthMultiplier ?? 1.0;
    heightMultiplier = maybeConfig?.heightMultiplier ?? 1.0;
    themeId = maybeConfig?.themeId ?? 'tactical';
  }

  const targetIds: string[] = [];
  if (selectedFeature) {
    if (selectedFeature.sourceFeatureIds && selectedFeature.sourceFeatureIds.length > 0) {
      targetIds.push(...selectedFeature.sourceFeatureIds);
    } else if (selectedFeature.sourceFeatureId) {
      targetIds.push(selectedFeature.sourceFeatureId);
    } else if (selectedFeature.id) {
      targetIds.push(selectedFeature.id);
    }
  }

  const centerLonLat: [number, number] = mapData?.centerLonLat ?? [4.9003, 52.3791];

  let extractedFeatures = extractConnectedOsmFeatures(targetIds, fullRawGeoJson, {
    includeConnectedRoads: true,
    spatialBoxMeters,
    centerLonLat,
  });

  // Fallback: if raw GeoJSON wasn't available or had no features, synthesize valid OSM GeoJSON
  // features from mapData.roads/railways/buildings so reproduction is never empty
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
      // If no spatial/selected match, export the first 25 features around origin
      extractedFeatures = fullRawGeoJson.features.slice(0, 30);
    }
  }

  // Diagnostics metadata for the selected feature
  let inspection: InspectedGeometryDiagnostics | undefined;
  if (selectedFeature) {
    const rawCoordsMeters: [number, number][] = [];
    if (mapData) {
      const road = mapData.roads.find(
        (r) =>
          r.sourceFeatureId === selectedFeature.sourceFeatureId ||
          r.id === selectedFeature.id
      );
      if (road) {
        rawCoordsMeters.push(...road.points);
      }
    }

    const coordsGeo = rawCoordsMeters.map((pt) =>
      unprojectToGeo(pt[0], pt[1], centerLonLat[0], centerLonLat[1])
    );

    inspection = {
      selectedFeatureId: selectedFeature.id,
      sourceFeatureIds: selectedFeature.sourceFeatureIds ?? [selectedFeature.sourceFeatureId],
      category: selectedFeature.category,
      cartoLabel: selectedFeature.cartoLabel,
      primaryTag: selectedFeature.primaryTag,
      subtype: selectedFeature.subtype,
      inferredWidth: selectedFeature.width,
      elevation: selectedFeature.elevation,
      layer: selectedFeature.layer,
      isBridge: selectedFeature.isBridge,
      isTunnel: selectedFeature.isTunnel,
      osmTags: selectedFeature.osmTags ?? {},
      coordinatesMeters: rawCoordsMeters.length > 0 ? rawCoordsMeters : undefined,
      coordinatesGeo: coordsGeo.length > 0 ? coordsGeo : undefined,
      graphConnectivity: selectedFeature.portalConnections
        ? {
            portalConnections: selectedFeature.portalConnections,
            incidentSourceFeatureIds: selectedFeature.sourceFeatureIds,
          }
        : undefined,
    };
  }

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
    },
    camera: { ...cameraPose },
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
      roadWidthMultiplier: typeof data.configuration?.roadWidthMultiplier === 'number' ? data.configuration.roadWidthMultiplier : 1.0,
      heightMultiplier: typeof data.configuration?.heightMultiplier === 'number' ? data.configuration.heightMultiplier : 1.0,
      themeId: data.configuration?.themeId ?? 'tactical',
    },
    camera: {
      target: Array.isArray(data.camera?.target) && data.camera.target.length === 3 ? data.camera.target : [0, 0, 0],
      zoom: typeof data.camera?.zoom === 'number' ? data.camera.zoom : 8.0,
      azimuthDeg: typeof data.camera?.azimuthDeg === 'number' ? data.camera.azimuthDeg : 45,
    },
    inspection: data.inspection,
    geoJson: data.geoJson,
  };

  return { valid: true, errors: [], package: pkg };
}
