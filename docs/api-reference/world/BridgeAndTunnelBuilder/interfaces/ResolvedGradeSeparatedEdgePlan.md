[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/BridgeAndTunnelBuilder](../README.md) / ResolvedGradeSeparatedEdgePlan

# Interface: ResolvedGradeSeparatedEdgePlan

Defined in: world/BridgeAndTunnelBuilder.ts:50

## Properties

### componentRampLengthMeters

> **componentRampLengthMeters**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:65

Effective ramp length (meters) for the connected bridge component containing this edge.

***

### componentSpanMeters

> **componentSpanMeters**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:67

Effective total span (meters) of the connected bridge component containing this edge.

***

### correctedPortalDiscontinuities

> **correctedPortalDiscontinuities**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:73

Number of portal horizontal discontinuities (> 0.0001 m) snapped to authoritative transition node on this edge.

***

### edgeId

> **edgeId**: `string`

Defined in: world/BridgeAndTunnelBuilder.ts:51

***

### endClassification

> **endClassification**: [`GradeSeparatedEndpointClassification`](../type-aliases/GradeSeparatedEndpointClassification.md)

Defined in: world/BridgeAndTunnelBuilder.ts:57

***

### endPortalDistanceMeters

> **endPortalDistanceMeters**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:63

Shortest path distance (meters) along connected bridge component from end node to nearest confirmed transition portal (`Infinity` if none).

***

### endTargetDeckElevation

> **endTargetDeckElevation**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:71

Authoritative target deck elevation at end node (supports smooth cross-layer bridge continuations).

***

### endTransition?

> `optional` **endTransition?**: [`GradeTransitionRenderDescriptor`](../../infrastructure/rendering/InfrastructureRenderAdapter/interfaces/GradeTransitionRenderDescriptor.md)

Defined in: world/BridgeAndTunnelBuilder.ts:59

***

### isBridge

> **isBridge**: `boolean`

Defined in: world/BridgeAndTunnelBuilder.ts:53

***

### isTunnel

> **isTunnel**: `boolean`

Defined in: world/BridgeAndTunnelBuilder.ts:54

***

### network

> **network**: `"road"` \| `"railway"`

Defined in: world/BridgeAndTunnelBuilder.ts:52

***

### points

> **points**: \[`number`, `number`\][]

Defined in: world/BridgeAndTunnelBuilder.ts:55

***

### startClassification

> **startClassification**: [`GradeSeparatedEndpointClassification`](../type-aliases/GradeSeparatedEndpointClassification.md)

Defined in: world/BridgeAndTunnelBuilder.ts:56

***

### startPortalDistanceMeters

> **startPortalDistanceMeters**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:61

Shortest path distance (meters) along connected bridge component from start node to nearest confirmed transition portal (`Infinity` if none).

***

### startTargetDeckElevation

> **startTargetDeckElevation**: `number`

Defined in: world/BridgeAndTunnelBuilder.ts:69

Authoritative target deck elevation at start node (supports smooth cross-layer bridge continuations).

***

### startTransition?

> `optional` **startTransition?**: [`GradeTransitionRenderDescriptor`](../../infrastructure/rendering/InfrastructureRenderAdapter/interfaces/GradeTransitionRenderDescriptor.md)

Defined in: world/BridgeAndTunnelBuilder.ts:58
