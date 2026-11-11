[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/BridgeAndTunnelBuilder](../README.md) / GradeTransitionRenderDiagnostics

# Interface: GradeTransitionRenderDiagnostics

Defined in: world/BridgeAndTunnelBuilder.ts:76

## Properties

### boundaryClippedEndpointsCount

> **boundaryClippedEndpointsCount**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:81

***

### bridgeAndTunnelBuildTimeMs

> **bridgeAndTunnelBuildTimeMs**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:85

***

### confirmedElevatedContinuations

> **confirmedElevatedContinuations**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:79

***

### confirmedTransitionsConsumed

> **confirmedTransitionsConsumed**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:78

***

### conflictingPlacementFallbackCount?

> `optional` **conflictingPlacementFallbackCount?**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:95

Number of features with conflicting vertical tags routed to a conservative surface fallback (M2.3-E4-T2).

***

### conflictingPlacementSkippedCount?

> `optional` **conflictingPlacementSkippedCount?**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:93

Number of features skipped from grade-separated/surface rendering due to contradictory vertical/enclosure tags (M2.3-E4-T).

***

### correctedPortalDiscontinuitiesCount

> **correctedPortalDiscontinuitiesCount**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:84

***

### hiddenUndergroundMeshCount?

> `optional` **hiddenUndergroundMeshCount?**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:99

Number of subterranean meshes hidden from normal surface draw calls (M2.3-E4-T2).

***

### intentionallyStandaloneEndpointsCount

> **intentionallyStandaloneEndpointsCount**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:82

***

### legacyFallbacksCount

> **legacyFallbacksCount**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:83

***

### mode

> **mode**: `"legacy"` \| `"graph"`

Defined in: world/BridgeAndTunnelBuilder.ts:77

***

### portalGroundCutoutsCount?

> `optional` **portalGroundCutoutsCount?**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:97

Number of localized portal ground-cover cutouts applied at confirmed tunnel entrances (M2.3-E4-T2).

***

### tunnelPortalsEmittedCount?

> `optional` **tunnelPortalsEmittedCount?**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:87

Number of individual tunnel portal structures emitted at confirmed/standalone entrances (M2.3-E4-T).

***

### undergroundRailwayGeometryCount?

> `optional` **undergroundRailwayGeometryCount?**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:91

Number of subterranean tunnel railway features rendered with continuous 3D underground track geometry (M2.3-E4-T).

***

### undergroundRoadGeometryCount?

> `optional` **undergroundRoadGeometryCount?**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:89

Number of subterranean tunnel road features rendered with continuous 3D underground road geometry (M2.3-E4-T).

***

### undergroundTracesVisible?

> `optional` **undergroundTracesVisible?**: `boolean`

Defined in: world/BridgeAndTunnelBuilder.ts:101

True when diagnostic dashed underground traces are enabled in visible presentation (M2.3-E4-T2).

***

### unresolvedTransitionsCount

> **unresolvedTransitionsCount**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:80
