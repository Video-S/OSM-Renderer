[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / buildRoadRibbonOutlineRing

# Function: buildRoadRibbonOutlineRing()

> **buildRoadRibbonOutlineRing**(`points`, `width`, `options?`): \[`number`, `number`\][][]

Defined in: world/GeometryBuilder.ts:727

Extracts a closed 2D outer polygon ring `[x, z][]` around a centerline polyline of width `width`
so at-grade road ribbons and footpaths can participate in exact 2D Boolean clipping.

## Parameters

### points

\[`number`, `number`\][]

### width

`number`

### options?

`Pick`\<[`RoadRibbonOptions`](../interfaces/RoadRibbonOptions.md), `"startPortal"` \| `"endPortal"`\>

## Returns

\[`number`, `number`\][][]
