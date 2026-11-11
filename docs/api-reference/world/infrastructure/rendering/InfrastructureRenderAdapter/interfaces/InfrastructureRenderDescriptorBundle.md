[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / InfrastructureRenderDescriptorBundle

# Interface: InfrastructureRenderDescriptorBundle

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:766

Complete immutable bundle of render-ready domain descriptors produced from an `InfrastructureGraph`.

## Properties

### gradeSeparatedCrossings

> **gradeSeparatedCrossings**: readonly [`GradeSeparatedCrossingRenderDescriptor`](GradeSeparatedCrossingRenderDescriptor.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:792

Canonically ordered grade-separated overpass/underpass crossings (for E4).

***

### gradeTransitions

> **gradeTransitions**: readonly [`GradeTransitionRenderDescriptor`](GradeTransitionRenderDescriptor.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:790

Canonically ordered confirmed same-domain road and railway grade transitions (for E4).

***

### levelCrossings

> **levelCrossings**: readonly [`LevelCrossingRenderDescriptor`](LevelCrossingRenderDescriptor.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:788

Canonically ordered confirmed road/rail and pedestrian/rail level crossings (for E4).

***

### options

> **options**: [`InfrastructureRenderOptions`](InfrastructureRenderOptions.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:768

Normalized render source options active when this bundle was prepared.

***

### railwayEdges

> **railwayEdges**: readonly [`RailwayEdgeRenderDescriptor`](RailwayEdgeRenderDescriptor.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:778

Canonically ordered railway edge descriptors (for E3).

***

### railwayEdgesById

> **railwayEdgesById**: `ReadonlyMap`\<`string`, [`RailwayEdgeRenderDescriptor`](RailwayEdgeRenderDescriptor.md)\>

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:782

Fast lookup map from canonical `RailwayEdge.id` to `RailwayEdgeRenderDescriptor`.

***

### railwayFeatureLineage

> **railwayFeatureLineage**: [`InfrastructureFeatureLineageSummary`](InfrastructureFeatureLineageSummary.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:806

Pre-computed railway feature lineage summary (`chainingMap` and `deduplicatedMap`).

***

### railwayFlatCrossings

> **railwayFlatCrossings**: readonly [`RailwayFlatCrossingRenderDescriptor`](RailwayFlatCrossingRenderDescriptor.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:786

Canonically ordered confirmed flat railway diamond crossings (for E3).

***

### railwayNodes

> **railwayNodes**: readonly [`RailwayNodeRenderDescriptor`](RailwayNodeRenderDescriptor.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:780

Canonically ordered railway node descriptors (for E3).

***

### railwayNodesById

> **railwayNodesById**: `ReadonlyMap`\<`string`, [`RailwayNodeRenderDescriptor`](RailwayNodeRenderDescriptor.md)\>

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:784

Fast lookup map from canonical `RailwayNode.id` to `RailwayNodeRenderDescriptor`.

***

### roadEdges

> **roadEdges**: readonly [`RoadEdgeRenderDescriptor`](RoadEdgeRenderDescriptor.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:770

Canonically ordered road edge descriptors (for E2).

***

### roadEdgesById

> **roadEdgesById**: `ReadonlyMap`\<`string`, [`RoadEdgeRenderDescriptor`](RoadEdgeRenderDescriptor.md)\>

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:774

Fast lookup map from canonical `RoadEdge.id` to `RoadEdgeRenderDescriptor`.

***

### roadFeatureLineage

> **roadFeatureLineage**: [`InfrastructureFeatureLineageSummary`](InfrastructureFeatureLineageSummary.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:804

Pre-computed road feature lineage summary (`chainingMap` and `deduplicatedMap`).

***

### roadNodes

> **roadNodes**: readonly [`RoadNodeRenderDescriptor`](RoadNodeRenderDescriptor.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:772

Canonically ordered road node descriptors (for E2).

***

### roadNodesById

> **roadNodesById**: `ReadonlyMap`\<`string`, [`RoadNodeRenderDescriptor`](RoadNodeRenderDescriptor.md)\>

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:776

Fast lookup map from canonical `RoadNode.id` to `RoadNodeRenderDescriptor`.

***

### sourceFeatureToRailwayEdgeIds

> **sourceFeatureToRailwayEdgeIds**: `ReadonlyMap`\<`string`, readonly `string`[]\>

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:802

Maps every original OSM railway `sourceFeatureId`, exact-duplicate `deduplicatedFeatureId`,
and unchained `partId` back to the canonically sorted `RailwayEdgeRenderDescriptor.id`s containing it.

***

### sourceFeatureToRoadEdgeIds

> **sourceFeatureToRoadEdgeIds**: `ReadonlyMap`\<`string`, readonly `string`[]\>

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:797

Maps every original OSM road `sourceFeatureId`, exact-duplicate `deduplicatedFeatureId`,
and unchained `partId` back to the canonically sorted `RoadEdgeRenderDescriptor.id`s containing it.

***

### unresolvedDiagnostics

> **unresolvedDiagnostics**: [`InfrastructureRenderUnresolvedDiagnostics`](InfrastructureRenderUnresolvedDiagnostics.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:808

Unresolved candidates and diagnostics kept strictly separate from confirmed descriptors.
