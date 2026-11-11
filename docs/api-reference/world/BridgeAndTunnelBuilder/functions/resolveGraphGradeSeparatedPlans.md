[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/BridgeAndTunnelBuilder](../README.md) / resolveGraphGradeSeparatedPlans

# Function: resolveGraphGradeSeparatedPlans()

> **resolveGraphGradeSeparatedPlans**(`descriptors`, `network`, `getTargetDeckElevation`): [`GraphGradeSeparatedResolutionResult`](../interfaces/GraphGradeSeparatedResolutionResult.md)

Defined in: world/BridgeAndTunnelBuilder.ts:1528

Authoritative Stage E4-A graph-driven grade-transition and continuation resolver for road and railway
bridges and tunnels.

Classifies every grade-separated endpoint into one of:
1. `'confirmed_transition'`
2. `'confirmed_elevated_continuation'`
3. `'boundary_clipped_continuation'`
4. `'unresolved_connection'`
5. `'intentionally_standalone'`

Also computes connected bridge component path spans and shortest portal distances so multi-segment bridges,
bridges with switches/turnouts near portals, and cross-layer bridge continuations share exact 3D elevations
at every interior node and every confirmed ground portal without vertical cliffs.

## Parameters

### descriptors

[`InfrastructureRenderDescriptorBundle`](../../infrastructure/rendering/InfrastructureRenderAdapter/interfaces/InfrastructureRenderDescriptorBundle.md)

### network

`"road"` \| `"railway"`

### getTargetDeckElevation

(`edge`) => `number`

## Returns

[`GraphGradeSeparatedResolutionResult`](../interfaces/GraphGradeSeparatedResolutionResult.md)
