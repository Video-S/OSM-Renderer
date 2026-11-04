import { MapStyleTheme, ProcessedMapData } from '../../types/MapFeature';
import {
  buildRailwayGroupInternal,
  type BuildRailwayPrototypeOptions,
  type RailwayBuildProfile,
  type RailwayPrototypeMode,
  type RailwayPrototypeResult,
  type RailwayPrototypeStats,
} from '../infrastructure/railways/RailwayGeometryBuilder';
import {
  computeContinuousTrackPhases,
  HostTrackSpatialIndex,
  isTurnoutThroatPair,
  queryInteriorPerpDistanceToPolyline,
  RAILWAY_DIMENSION_SPEC,
  type SleeperBearerBox3D,
  sortRailwaysMainlineFirst,
  subtractIntervalFromList,
  subtractLateralInterval,
} from '../infrastructure/railways/RailwayTopology';

export {
  RAILWAY_DIMENSION_SPEC,
  type SleeperBearerBox3D,
  HostTrackSpatialIndex,
  subtractLateralInterval,
  subtractIntervalFromList,
  queryInteriorPerpDistanceToPolyline,
  isTurnoutThroatPair,
  sortRailwaysMainlineFirst,
  computeContinuousTrackPhases,
  type RailwayPrototypeMode,
  type BuildRailwayPrototypeOptions,
  type RailwayBuildProfile,
  type RailwayPrototypeStats,
  type RailwayPrototypeResult,
};

export type BuiltRailwayPrototypeResult = RailwayPrototypeResult;

/**
 * Prototype entry point preserved for M2.1 benchmark and regression test compatibility.
 * Delegates directly to the extracted `RailwayGeometryBuilder` without duplicating Candidate B logic.
 */
export function buildRailwayPrototypeGroup(
  data: ProcessedMapData,
  theme: MapStyleTheme,
  mode: 'candidateA' | 'candidateB' = 'candidateB',
  initialZoom: number = 1.0,
  options?: BuildRailwayPrototypeOptions
): RailwayPrototypeResult {
  return buildRailwayGroupInternal(data, theme, mode, initialZoom, options);
}
