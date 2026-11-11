[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/BridgeAndTunnelBuilder](../README.md) / GraphGradeSeparatedResolutionResult

# Interface: GraphGradeSeparatedResolutionResult

Defined in: world/BridgeAndTunnelBuilder.ts:104

## Properties

### atGradePortalSnapsByEdgeId

> **atGradePortalSnapsByEdgeId**: `ReadonlyMap`\<`string`, \{ `end?`: readonly \[`number`, `number`\]; `start?`: readonly \[`number`, `number`\]; \}\>

Defined in: world/BridgeAndTunnelBuilder.ts:107

Map from at-grade edge ID to authoritative portal endpoint coordinates (`start` and/or `end`) snapped to confirmed GradeTransition positions.

***

### diagnostics

> **diagnostics**: [`GradeTransitionRenderDiagnostics`](GradeTransitionRenderDiagnostics.md)

Defined in: world/BridgeAndTunnelBuilder.ts:111

***

### plansByEdgeId

> **plansByEdgeId**: `ReadonlyMap`\<`string`, [`ResolvedGradeSeparatedEdgePlan`](ResolvedGradeSeparatedEdgePlan.md)\>

Defined in: world/BridgeAndTunnelBuilder.ts:105
