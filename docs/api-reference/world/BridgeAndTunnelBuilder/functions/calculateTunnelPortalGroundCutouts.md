[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/BridgeAndTunnelBuilder](../README.md) / calculateTunnelPortalGroundCutouts

# Function: calculateTunnelPortalGroundCutouts()

> **calculateTunnelPortalGroundCutouts**(`points`, `width`, `isPedestrianOrCycle?`, `options?`): \[`number`, `number`\][][][]

Defined in: world/BridgeAndTunnelBuilder.ts:261

Pure portal cutout geometry for pre-render ground-cover clipping.
Only explicitly authorized endpoints get holes; no portal mesh is allocated.

## Parameters

### points

readonly \[`number`, `number`\][]

### width

`number`

### isPedestrianOrCycle?

`boolean` = `false`

### options?

`Pick`\<[`TunnelPortalGenerationOptions`](../interfaces/TunnelPortalGenerationOptions.md), `"emitStartPortal"` \| `"emitEndPortal"` \| `"railwayType"`\>

## Returns

\[`number`, `number`\][][][]
