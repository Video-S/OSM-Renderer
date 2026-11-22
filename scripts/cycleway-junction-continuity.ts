/**
 * TKT-033: source-aligned, pointwise physical surface ownership at the
 * way/38892898 -> way/546666718 junction. This module is deliberately pure:
 * the inspector supplies actual source geometry and decoded SQLite evidence.
 */
export type EN = readonly [number, number];
export type OwnershipState =
  | 'residential' | 'cycleway' | 'uncovered' | 'other-road' | 'unattributed';

export interface JunctionCorridorPoint {
  distanceMeters: number;
  easting: number;
  northing: number;
  tx: number;
  ty: number;
}

export type JunctionCorridorPlan =
  | { status: 'inconclusive'; reason: string }
  | {
    status: 'ready';
    sharedNodeId: string;
    junction: EN;
    seamContact: EN;
    seamDistanceMeters: number;
    sampleStepMeters: number;
    sampledUntilMeters: number;
    points: JunctionCorridorPoint[];
  };

export interface OwnershipProbe {
  cycleway: { status: string };
  residential: { status: string };
  anyRoad: { status: string };
  owners: readonly {
    sourceFeatureId: string | null;
    sourceFeatureIds: readonly string[];
  }[];
}

const CYCLEWAY_ID = 'way/38892898';
const RESIDENTIAL_ID = 'way/546666718';
const TILE_SIZE_METERS = 1024;

/** Reject uncertain node/coordinate correspondence rather than guessing a route. */
export function planJunctionCenterlineCorridor(input: {
  cycleway: readonly EN[];
  residential: readonly EN[];
  cyclewayNodeIds: readonly string[];
  residentialNodeIds: readonly string[];
  seamEasting: number;
  seamNorthing: number;
}): JunctionCorridorPlan {
  const fail = (reason: string): JunctionCorridorPlan => ({ status: 'inconclusive', reason });
  const { cycleway, residential, cyclewayNodeIds: cNodes,
    residentialNodeIds: rNodes, seamEasting, seamNorthing } = input;
  if (cycleway.length < 2 || residential.length < 2 ||
      cNodes.length !== cycleway.length || rNodes.length !== residential.length) {
    return fail('OSM geometry and node-ID sequences are missing or do not align');
  }
  const shared = [...new Set(cNodes)].filter(id => rNodes.includes(id));
  if (shared.length !== 1) return fail('Expected exactly one shared OSM node');
  const cycleIndex = cNodes.indexOf(shared[0]);
  if (cycleIndex !== 0 && cycleIndex !== cycleway.length - 1) {
    return fail('The shared node is not a cycleway endpoint');
  }
  const junction = cycleway[cycleIndex];
  const residentialPoint = residential[rNodes.indexOf(shared[0])];
  if (Math.hypot(junction[0] - residentialPoint[0], junction[1] - residentialPoint[1]) > 0.05) {
    return fail('Shared OSM node does not have matching projected coordinates');
  }
  const oriented = cycleIndex === 0 ? [...cycleway] : [...cycleway].reverse();
  let length = 0;
  const seamContacts: { point: EN; distance: number }[] = [];
  for (let i = 1; i < oriented.length; i++) {
    const a = oriented[i - 1], b = oriented[i];
    const segmentLength = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!Number.isFinite(segmentLength) || segmentLength < 1e-8) {
      return fail('Cycleway contains a zero-length or non-finite segment');
    }
    const t = (seamNorthing - a[1]) / (b[1] - a[1]);
    if (Number.isFinite(t) && t > 0 && t < 1) {
      const easting = a[0] + t * (b[0] - a[0]);
      if (Math.abs(easting - seamEasting) < 0.05) {
        seamContacts.push({ point: [easting, seamNorthing], distance: length + segmentLength * t });
      }
    }
    length += segmentLength;
  }
  if (seamContacts.length !== 1) return fail('No unique proper source crossing at the audited seam');
  const seam = seamContacts[0];
  // Probe the entire junction approach and at least 5 m past the seam.
  const sampledUntilMeters = seam.distance + 5.2;
  if (length < sampledUntilMeters) return fail('Source centerline ends before 5 m past the seam');
  const sampleStepMeters = 0.1;
  const points: JunctionCorridorPoint[] = [];
  const centerlineAt = (distance: number): EN => {
    let traversed = 0;
    for (let i = 1; i < oriented.length; i++) {
      const a = oriented[i - 1], b = oriented[i];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (distance <= traversed + len || i === oriented.length - 1) {
        const t = Math.max(0, Math.min(1, (distance - traversed) / len));
        return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      }
      traversed += len;
    }
    return oriented[oriented.length - 1];
  };
  for (let distance = 0.05; distance <= sampledUntilMeters + 1e-9;
    distance += sampleStepMeters) {
    const [easting, northing] = centerlineAt(distance);
    // Never let an exactly-on-tile-boundary point select a single arbitrary tile.
    const nearTileBorder = (v: number) =>
      Math.min(v - Math.floor(v / TILE_SIZE_METERS) * TILE_SIZE_METERS,
        (Math.floor(v / TILE_SIZE_METERS) + 1) * TILE_SIZE_METERS - v) < 0.005;
    if (nearTileBorder(easting) || nearTileBorder(northing)) continue;
    points.push({
      distanceMeters: Number(distance.toFixed(4)), easting, northing,
      tx: Math.floor(easting / TILE_SIZE_METERS),
      ty: Math.floor(northing / TILE_SIZE_METERS),
    });
  }
  if (!points.length || points[points.length - 1].distanceMeters < seam.distance + 5) {
    return fail('Unable to place probes at least 5 m beyond the seam');
  }
  return {
    status: 'ready', sharedNodeId: shared[0], junction,
    seamContact: seam.point, seamDistanceMeters: seam.distance,
    sampleStepMeters, sampledUntilMeters, points,
  };
}

export function classifyJunctionOwner(probe: OwnershipProbe): OwnershipState {
  if (probe.anyRoad.status === 'uncovered') return 'uncovered';
  if (probe.anyRoad.status !== 'covered' ||
      probe.cycleway.status === 'unattributed' ||
      probe.residential.status === 'unattributed') return 'unattributed';
  const ids = new Set(probe.owners.flatMap(owner =>
    [owner.sourceFeatureId, ...owner.sourceFeatureIds].filter((id): id is string => !!id)));
  const cycleway = ids.has(CYCLEWAY_ID);
  const residential = ids.has(RESIDENTIAL_ID);
  if (cycleway !== (probe.cycleway.status === 'covered') ||
      residential !== (probe.residential.status === 'covered')) return 'unattributed';
  if (probe.owners.some(owner => !owner.sourceFeatureId && owner.sourceFeatureIds.length === 0)) {
    return 'unattributed';
  }
  if ([...ids].some(id => id !== CYCLEWAY_ID && id !== RESIDENTIAL_ID) ||
      (cycleway && residential)) return 'other-road';
  if (residential) return 'residential';
  if (cycleway) return 'cycleway';
  return 'other-road';
}

/**
 * A consistent result proves *sampled* centerline ownership, not a theorem
 * about all points between the 10cm samples or the whole regional map.
 */
export function analyzeJunctionCorridor(
  plan: JunctionCorridorPlan,
  probe: (p: JunctionCorridorPoint) => OwnershipProbe
) {
  if (plan.status !== 'ready') return plan;
  const samples = plan.points.map(point => {
    const evidence = probe(point);
    const ownerSourceIds = [...new Set(evidence.owners.flatMap(owner =>
      [owner.sourceFeatureId, ...owner.sourceFeatureIds].filter((id): id is string => !!id)))].sort();
    return {
      ...point,
      state: classifyJunctionOwner(evidence),
      sourceStatuses: {
        cycleway: evidence.cycleway.status,
        residential: evidence.residential.status,
        anyRoad: evidence.anyRoad.status,
      },
      ownerSourceIds,
    };
  });
  const firstCycle = samples.findIndex(s => s.state === 'cycleway');
  const cleanSequence = firstCycle > 0 &&
    samples.every((s, i) => s.state === (i < firstCycle ? 'residential' : 'cycleway'));
  const bothTiles = samples.some(s => s.northing < plan.seamContact[1]) &&
    samples.some(s => s.northing > plan.seamContact[1]);
  const transition = firstCycle > 0 ? {
    residentialLast: samples[firstCycle - 1].distanceMeters,
    cyclewayFirst: samples[firstCycle].distanceMeters,
    bracketMeters: samples[firstCycle].distanceMeters - samples[firstCycle - 1].distanceMeters,
  } : null;
  const transitionNearSeam = transition !== null &&
    transition.residentialLast <= plan.seamDistanceMeters + 0.5 &&
    transition.cyclewayFirst >= plan.seamDistanceMeters - 0.5;
  const hasResidentialSouth = samples.some(s =>
    s.northing < plan.seamContact[1] && s.state === 'residential');
  const hasCyclewayNorth = samples.some(s =>
    s.northing > plan.seamContact[1] && s.state === 'cycleway');
  const consistent = cleanSequence && bothTiles && transitionNearSeam &&
    hasResidentialSouth && hasCyclewayNorth;
  return {
    status: consistent ? 'consistent-sampled-ownership' as const : 'inconclusive' as const,
    reason: consistent
      ? 'Continuous sampled road coverage with one residential-to-cycleway source transition near the seam'
      : 'One or more samples have missing/ambiguous ownership, a reversed or repeated transition, or insufficient seam evidence',
    sharedNodeId: plan.sharedNodeId,
    junction: plan.junction,
    seamContact: plan.seamContact,
    seamDistanceMeters: plan.seamDistanceMeters,
    sampleStepMeters: plan.sampleStepMeters,
    sampledUntilMeters: plan.sampledUntilMeters,
    transition,
    counts: Object.fromEntries(
      (['residential', 'cycleway', 'uncovered', 'other-road', 'unattributed'] as const)
        .map(state => [state, samples.filter(s => s.state === state).length])),
    samples,
    limitations: 'Pointwise centerline samples only; a gap smaller than 0.1m or off-centerline / visual semantics are not excluded.',
  };
}
