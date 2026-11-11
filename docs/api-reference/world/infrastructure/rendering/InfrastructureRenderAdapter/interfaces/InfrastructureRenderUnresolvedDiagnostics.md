[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / InfrastructureRenderUnresolvedDiagnostics

# Interface: InfrastructureRenderUnresolvedDiagnostics

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:741

Unresolved candidates and diagnostic records preserved strictly separate from confirmed render descriptors.

## Properties

### topologyDiagnostics

> **topologyDiagnostics**: [`TopologyDiagnostics`](../../../topology/types/interfaces/TopologyDiagnostics.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:750

Cloned aggregate topology diagnostics from `InfrastructureGraph.diagnostics`.

***

### unresolvedCrossings

> **unresolvedCrossings**: readonly [`UnresolvedCrossingCandidate`](../../../topology/types/interfaces/UnresolvedCrossingCandidate.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:742

***

### unresolvedGradeTransitions

> **unresolvedGradeTransitions**: readonly [`UnresolvedGradeTransitionCandidate`](../../../topology/types/interfaces/UnresolvedGradeTransitionCandidate.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:743

***

### unresolvedInfrastructurePoints

> **unresolvedInfrastructurePoints**: readonly [`UnresolvedInfrastructurePointCandidate`](../../../topology/types/interfaces/UnresolvedInfrastructurePointCandidate.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:744

***

### unresolvedRailwayJunctionNodeIds

> **unresolvedRailwayJunctionNodeIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:748

Canonical IDs of `RailwayNode`s holding `'junction'` role without confirmed `'switch'` or `'railway_crossing'` classification.

***

### unresolvedRailwaySwitchNodeIds

> **unresolvedRailwaySwitchNodeIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:746

Canonical IDs of `RailwayNode`s whose turnout classification is `'unresolved_main_vs_diverging'` or `'unresolved_throat'`.
