[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / resolveBarrierStructuralContexts

# Function: resolveBarrierStructuralContexts()

> **resolveBarrierStructuralContexts**(`barriers`, `roads`, `railways`): `object`

Defined in: world/StructuralContextResolver.ts:158

Evaluates all linear barriers (`barrier=retaining_wall`, `wall`, `fence`, `embankment`, etc.)
in relation to surrounding subterranean tunnels, underpasses, open cuttings, and connected
retaining wall chains (M2.3-E4-T2).

Uses a bounded 2D spatial grid (`16 m` cells) and explicit OSM node / topological node sharing
rather than global $O(N^2)$ proximity searches or blind negative-layer sinking.

## Parameters

### barriers

readonly [`BarrierFeature`](../../../types/MapFeature/interfaces/BarrierFeature.md)[]

### roads

readonly [`RoadFeature`](../../../types/MapFeature/interfaces/RoadFeature.md)[]

### railways

readonly [`RailwayFeature`](../../../types/MapFeature/interfaces/RailwayFeature.md)[]

## Returns

`object`

### contextsById

> **contextsById**: `ReadonlyMap`\<`string`, [`BarrierStructuralContext`](../../../types/MapFeature/interfaces/BarrierStructuralContext.md)\>

### diagnostics

> **diagnostics**: [`StructuralContextDiagnostics`](../../../types/MapFeature/interfaces/StructuralContextDiagnostics.md)
