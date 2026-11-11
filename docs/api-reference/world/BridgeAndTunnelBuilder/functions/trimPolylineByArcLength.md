[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/BridgeAndTunnelBuilder](../README.md) / trimPolylineByArcLength

# Function: trimPolylineByArcLength()

> **trimPolylineByArcLength**(`points`, `startTrim`, `endTrim`): \[`number`, `number`\][]

Defined in: world/BridgeAndTunnelBuilder.ts:142

Trims a 2D polyline by `startTrim` meters from the start and `endTrim` meters from the end
along its true arc length, removing any short intermediate segments inside the trim zone
so short-segmented OSM approaches at junctions never protrude into the intersection.

## Parameters

### points

\[`number`, `number`\][]

### startTrim

`number`

### endTrim

`number`

## Returns

\[`number`, `number`\][]
