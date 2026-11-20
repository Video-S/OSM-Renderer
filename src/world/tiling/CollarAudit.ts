import type { ProcessedMapData } from '../../types/MapFeature';
import type { InfrastructureRenderDescriptorBundle } from '../infrastructure/rendering/InfrastructureRenderAdapter';
import type { GraphGradeSeparatedResolutionResult } from '../BridgeAndTunnelBuilder';
import {
  boxesOverlap2D,
  computePointsBBox,
  computeRingBBox,
  type StudyGridSpec,
  type TileDescriptor,
} from './TileGrid';

export type CollarInsufficiencyKind =
  | 'planar_polygon_extends_beyond_collar'
  | 'building_extends_beyond_collar'
  | 'bridge_or_tunnel_component_exceeds_collar'
  | 'railway_phase_or_switch_exceeds_collar'
  | 'road_edge_or_blocker_exceeds_collar'
  | 'barrier_structural_context_exceeds_collar';

export interface CollarInsufficiencyCase {
  kind: CollarInsufficiencyKind;
  tileId: string;
  featureId: string;
  sourceFeatureId: string;
  category: string;
  requiredCollarMeters: number;
  proposedCollarMeters: number;
  overflowMeters: number;
  detail: string;
}

export interface SceneTreeBudgetAudit {
  singleSceneTreeCap: number;
  estimatedGlobalCandidateTrees: number;
  singleSceneTruncatedByCap: boolean;
  tiledCanBypassGlobalCap: boolean;
  note: string;
}

export interface CollarAuditReport {
  proposedCollarMeters: number;
  totalTilesAudited: number;
  tilesWithInsufficiency: number;
  totalInsufficiencyCases: number;
  isProposedCollarSufficientWithoutGlobalContext: boolean;
  maxRequiredCollarMeters: number;
  countsByKind: Record<CollarInsufficiencyKind, number>;
  cases: CollarInsufficiencyCase[];
  sceneTreeBudgetAudit: SceneTreeBudgetAudit;
}

function computeOverflowBeyondTile(
  bbox: { minX: number; maxX: number; minZ: number; maxZ: number },
  tile: TileDescriptor
): { requiredCollarMeters: number; overflowMeters: number } {
  const b = tile.localBounds;
  const reqLeft = Math.max(0, b.minX - bbox.minX);
  const reqRight = Math.max(0, bbox.maxX - b.maxX);
  const reqTop = Math.max(0, b.minZ - bbox.minZ);
  const reqBottom = Math.max(0, bbox.maxZ - b.maxZ);
  const requiredCollarMeters = Math.max(reqLeft, reqRight, reqTop, reqBottom);
  const collarMeters = tile.localBounds.minX - tile.collarLocalBounds.minX;
  const overflowMeters = Math.max(0, requiredCollarMeters - collarMeters);
  return { requiredCollarMeters, overflowMeters };
}

function estimateCandidateTreeCount(data: ProcessedMapData): number {
  let count = 0;
  for (const park of data.parks || []) {
    if (!park.has3DFoliage || !park.polygon || !park.polygon[0]) continue;
    const bb = computeRingBBox(park.polygon);
    if (!bb) continue;
    const areaApprox = (bb.maxX - bb.minX) * (bb.maxZ - bb.minZ);
    const spacing = areaApprox > 60000 ? 15.0 : 11.5;
    const nx = Math.max(0, Math.floor((bb.maxX - bb.minX) / spacing));
    const nz = Math.max(0, Math.floor((bb.maxZ - bb.minZ) / spacing));
    count += Math.round(nx * nz * 0.65);
  }
  for (const bar of data.barriers || []) {
    if (bar.barrierType !== 'tree_row' || !bar.points || bar.points.length < 2) continue;
    for (let i = 0; i < bar.points.length - 1; i++) {
      const len = Math.hypot(
        bar.points[i + 1][0] - bar.points[i][0],
        bar.points[i + 1][1] - bar.points[i][1]
      );
      count += Math.max(1, Math.floor(len / 9.5)) + 1;
    }
  }
  for (const lm of data.landmarks || []) {
    if (lm.landmarkType === 'tree') count++;
  }
  return count;
}

/**
 * Empirically audits the `64 m` (or custom) synthesis collar hypothesis against a study grid
 * and canonical dataset. Explicitly detects and reports every feature or topological component
 * whose geometry, planar context, continuous phase, or grade-separation plan requires > `collarMeters`
 * context outside a tile boundary — never silently truncating or hiding border insufficiency.
 */
export function auditCollarSufficiency(params: {
  data: ProcessedMapData;
  grid: StudyGridSpec;
  descriptors?: InfrastructureRenderDescriptorBundle | null;
  roadGradeSeparatedPlans?: GraphGradeSeparatedResolutionResult | null;
  railwayGradeSeparatedPlans?: GraphGradeSeparatedResolutionResult | null;
  maxSceneTreesCap?: number;
}): CollarAuditReport {
  const {
    data,
    grid,
    descriptors,
    roadGradeSeparatedPlans,
    railwayGradeSeparatedPlans,
    maxSceneTreesCap = 2200,
  } = params;

  const proposedCollarMeters = grid.collarMeters;
  const countsByKind: Record<CollarInsufficiencyKind, number> = {
    planar_polygon_extends_beyond_collar: 0,
    building_extends_beyond_collar: 0,
    bridge_or_tunnel_component_exceeds_collar: 0,
    railway_phase_or_switch_exceeds_collar: 0,
    road_edge_or_blocker_exceeds_collar: 0,
    barrier_structural_context_exceeds_collar: 0,
  };

  const cases: CollarInsufficiencyCase[] = [];
  const tilesWithIssues = new Set<string>();
  let maxRequiredCollarMeters = 0;

  const pushCase = (entry: CollarInsufficiencyCase) => {
    cases.push(entry);
    countsByKind[entry.kind]++;
    tilesWithIssues.add(entry.tileId);
    if (entry.requiredCollarMeters > maxRequiredCollarMeters) {
      maxRequiredCollarMeters = entry.requiredCollarMeters;
    }
  };

  // Precompute connected railway component bounding boxes if descriptors are available,
  // because continuous sleeper phase propagates across entire connected track components.
  const railComponentBBoxByEdgeId = new Map<
    string,
    { minX: number; maxX: number; minZ: number; maxZ: number }
  >();
  if (descriptors && descriptors.railwayEdges.length > 0) {
    const adj = new Map<string, string[]>();
    for (const e of descriptors.railwayEdges) {
      if (!adj.has(e.fromNodeId)) adj.set(e.fromNodeId, []);
      if (!adj.has(e.toNodeId)) adj.set(e.toNodeId, []);
      adj.get(e.fromNodeId)!.push(e.id);
      adj.get(e.toNodeId)!.push(e.id);
    }
    const visitedEdges = new Set<string>();
    for (const seed of descriptors.railwayEdges) {
      if (visitedEdges.has(seed.id)) continue;
      const compEdgeIds: string[] = [];
      const stack = [seed.id];
      visitedEdges.add(seed.id);
      let minX = Infinity,
        maxX = -Infinity,
        minZ = Infinity,
        maxZ = -Infinity;
      while (stack.length > 0) {
        const eid = stack.pop()!;
        const edge = descriptors.railwayEdgesById.get(eid);
        if (!edge) continue;
        compEdgeIds.push(eid);
        for (const [x, z] of edge.points) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
        for (const nid of [edge.fromNodeId, edge.toNodeId]) {
          for (const nextEid of adj.get(nid) || []) {
            if (!visitedEdges.has(nextEid)) {
              visitedEdges.add(nextEid);
              stack.push(nextEid);
            }
          }
        }
      }
      if (Number.isFinite(minX)) {
        const compBox = { minX, maxX, minZ, maxZ };
        for (const eid of compEdgeIds) {
          railComponentBBoxByEdgeId.set(eid, compBox);
        }
      }
    }
  }

  for (const tile of grid.tiles) {
    // 1. Planar polygons (landuse, parks, waterBodies)
    const inspectPlanarList = (
      items: Array<{
        id: string;
        sourceFeatureId?: string;
        polygon: [number, number][][];
      }>,
      category: string
    ) => {
      for (const item of items) {
        if (!item.polygon || item.polygon.length === 0) continue;
        const bb = computeRingBBox(item.polygon);
        if (!bb || !boxesOverlap2D(bb, tile.localBounds, 0.05)) continue;
        const { requiredCollarMeters, overflowMeters } = computeOverflowBeyondTile(bb, tile);
        if (overflowMeters > 0.01) {
          pushCase({
            kind: 'planar_polygon_extends_beyond_collar',
            tileId: tile.id,
            featureId: item.id,
            sourceFeatureId: item.sourceFeatureId || item.id,
            category,
            requiredCollarMeters: Number(requiredCollarMeters.toFixed(2)),
            proposedCollarMeters,
            overflowMeters: Number(overflowMeters.toFixed(2)),
            detail: `${category} polygon overlaps tile ${tile.id} and extends ${overflowMeters.toFixed(1)} m beyond the ${proposedCollarMeters} m collar`,
          });
        }
      }
    };

    inspectPlanarList(data.landuse || [], 'landuse');
    inspectPlanarList(data.parks || [], 'parks');
    inspectPlanarList(data.waterBodies || [], 'waterBodies');

    // 2. Buildings extending beyond collar
    for (const bldg of data.buildings || []) {
      const bb = computeRingBBox(bldg.footprint);
      if (!bb || !boxesOverlap2D(bb, tile.localBounds, 0.05)) continue;
      const { requiredCollarMeters, overflowMeters } = computeOverflowBeyondTile(bb, tile);
      if (overflowMeters > 0.01) {
        pushCase({
          kind: 'building_extends_beyond_collar',
          tileId: tile.id,
          featureId: bldg.id,
          sourceFeatureId: bldg.sourceFeatureId || bldg.id,
          category: 'building',
          requiredCollarMeters: Number(requiredCollarMeters.toFixed(2)),
          proposedCollarMeters,
          overflowMeters: Number(overflowMeters.toFixed(2)),
          detail: `Building footprint extends ${overflowMeters.toFixed(1)} m beyond ${proposedCollarMeters} m collar around ${tile.id}`,
        });
      }
    }

    // 3. Roads (at-grade long edges / priority blockers + grade-separated bridge/tunnel components)
    if (descriptors) {
      for (const edge of descriptors.roadEdges) {
        const pts: [number, number][] = edge.points.map((p) => [p[0], p[1]]);
        const bb = computePointsBBox(pts);
        if (!bb || !boxesOverlap2D(bb, tile.localBounds, edge.width + 1)) continue;

        const isGradeSep = !edge.isAtGradeBuildable && !edge.isCulvert;
        const plan = roadGradeSeparatedPlans?.plansByEdgeId.get(edge.id);
        const { requiredCollarMeters, overflowMeters } = computeOverflowBeyondTile(bb, tile);
        const planRequiredMeters = plan
          ? Math.max(
              requiredCollarMeters,
              plan.startPortalDistanceMeters ?? 0,
              plan.endPortalDistanceMeters ?? 0,
              plan.componentRampLengthMeters ?? 0
            )
          : requiredCollarMeters;
        const effectiveOverflow = Math.max(
          overflowMeters,
          planRequiredMeters - proposedCollarMeters
        );

        if (isGradeSep && effectiveOverflow > 0.01) {
          pushCase({
            kind: 'bridge_or_tunnel_component_exceeds_collar',
            tileId: tile.id,
            featureId: edge.id,
            sourceFeatureId: edge.sourceFeatureId || edge.id,
            category: 'road_grade_separated',
            requiredCollarMeters: Number(planRequiredMeters.toFixed(2)),
            proposedCollarMeters,
            overflowMeters: Number(effectiveOverflow.toFixed(2)),
            detail: `Road bridge/tunnel edge/component requires ${planRequiredMeters.toFixed(1)} m context outside ${tile.id}`,
          });
        } else if (!isGradeSep && overflowMeters > 0.01) {
          pushCase({
            kind: 'road_edge_or_blocker_exceeds_collar',
            tileId: tile.id,
            featureId: edge.id,
            sourceFeatureId: edge.sourceFeatureId || edge.id,
            category: 'road_at_grade',
            requiredCollarMeters: Number(requiredCollarMeters.toFixed(2)),
            proposedCollarMeters,
            overflowMeters: Number(overflowMeters.toFixed(2)),
            detail: `At-grade road edge extends ${overflowMeters.toFixed(1)} m beyond ${proposedCollarMeters} m collar`,
          });
        }
      }

      // 4. Railways (grade-separated + continuous track phase / switch topology)
      for (const edge of descriptors.railwayEdges) {
        const pts: [number, number][] = edge.points.map((p) => [p[0], p[1]]);
        const bb = computePointsBBox(pts);
        if (!bb || !boxesOverlap2D(bb, tile.localBounds, 5)) continue;

        const isGradeSep = edge.isBridge || edge.isTunnel || edge.layer !== 0;
        const plan = railwayGradeSeparatedPlans?.plansByEdgeId.get(edge.id);
        const compBox = railComponentBBoxByEdgeId.get(edge.id) ?? bb;
        const edgeOverflow = computeOverflowBeyondTile(bb, tile);
        const compOverflow = computeOverflowBeyondTile(compBox, tile);

        if (isGradeSep) {
          const req = Math.max(
            edgeOverflow.requiredCollarMeters,
            plan?.startPortalDistanceMeters ?? 0,
            plan?.endPortalDistanceMeters ?? 0
          );
          const ov = Math.max(0, req - proposedCollarMeters);
          if (ov > 0.01) {
            pushCase({
              kind: 'bridge_or_tunnel_component_exceeds_collar',
              tileId: tile.id,
              featureId: edge.id,
              sourceFeatureId: edge.sourceFeatureId || edge.id,
              category: 'railway_grade_separated',
              requiredCollarMeters: Number(req.toFixed(2)),
              proposedCollarMeters,
              overflowMeters: Number(ov.toFixed(2)),
              detail: `Railway bridge/tunnel edge requires ${req.toFixed(1)} m context outside ${tile.id}`,
            });
          }
        }

        if (compOverflow.overflowMeters > 0.01) {
          pushCase({
            kind: 'railway_phase_or_switch_exceeds_collar',
            tileId: tile.id,
            featureId: edge.id,
            sourceFeatureId: edge.sourceFeatureId || edge.id,
            category: 'railway_phase_continuity',
            requiredCollarMeters: Number(compOverflow.requiredCollarMeters.toFixed(2)),
            proposedCollarMeters,
            overflowMeters: Number(compOverflow.overflowMeters.toFixed(2)),
            detail: `Connected railway track phase/switch component extends ${compOverflow.overflowMeters.toFixed(1)} m beyond ${proposedCollarMeters} m collar`,
          });
        }
      }
    }

    // 5. Barriers
    for (const bar of data.barriers || []) {
      const bb = computePointsBBox(bar.points);
      if (!bb || !boxesOverlap2D(bb, tile.localBounds, 2)) continue;
      const { requiredCollarMeters, overflowMeters } = computeOverflowBeyondTile(bb, tile);
      if (overflowMeters > 0.01) {
        pushCase({
          kind: 'barrier_structural_context_exceeds_collar',
          tileId: tile.id,
          featureId: bar.id,
          sourceFeatureId: bar.sourceFeatureId || bar.id,
          category: 'barrier',
          requiredCollarMeters: Number(requiredCollarMeters.toFixed(2)),
          proposedCollarMeters,
          overflowMeters: Number(overflowMeters.toFixed(2)),
          detail: `Barrier (${bar.barrierType}) extends ${overflowMeters.toFixed(1)} m beyond ${proposedCollarMeters} m collar`,
        });
      }
    }
  }

  const estimatedGlobalCandidateTrees = estimateCandidateTreeCount(data);
  const singleSceneTruncatedByCap = estimatedGlobalCandidateTrees > maxSceneTreesCap;

  return {
    proposedCollarMeters,
    totalTilesAudited: grid.tiles.length,
    tilesWithInsufficiency: tilesWithIssues.size,
    totalInsufficiencyCases: cases.length,
    isProposedCollarSufficientWithoutGlobalContext:
      cases.length === 0 && !singleSceneTruncatedByCap,
    maxRequiredCollarMeters: Number(maxRequiredCollarMeters.toFixed(2)),
    countsByKind,
    cases,
    sceneTreeBudgetAudit: {
      singleSceneTreeCap: maxSceneTreesCap,
      estimatedGlobalCandidateTrees,
      singleSceneTruncatedByCap,
      tiledCanBypassGlobalCap: singleSceneTruncatedByCap && grid.tiles.length > 1,
      note: singleSceneTruncatedByCap
        ? `Estimated ${estimatedGlobalCandidateTrees} candidate trees exceed GeometryBuilder MAX_SCENE_TREES=${maxSceneTreesCap}; single-scene truncates at ${maxSceneTreesCap} while per-tile scenes do not unless maxSceneTreesCap is lifted for parity verification.`
        : `Estimated ${estimatedGlobalCandidateTrees} candidate trees within MAX_SCENE_TREES=${maxSceneTreesCap}.`,
    },
  };
}
