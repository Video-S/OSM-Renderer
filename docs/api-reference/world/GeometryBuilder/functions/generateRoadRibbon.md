[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / generateRoadRibbon

# Function: generateRoadRibbon()

> **generateRoadRibbon**(`points`, `width`, `yElevation?`, `options?`): `object`

Defined in: world/GeometryBuilder.ts:275

Pure math helper to compute 2D ribbon strip vertices from a centerline polyline.
Exported for unit testing and reusable for roads, railways, and linear waterways.
Supports independent start and end caps for clean junction trimming and cul-de-sacs.

## Parameters

### points

\[`number`, `number`\][]

### width

`number`

### yElevation?

`number` = `0.050`

### options?

[`RoadRibbonOptions`](../interfaces/RoadRibbonOptions.md)

## Returns

`object`

### indices

> **indices**: `Uint32Array`

### normals

> **normals**: `Float32Array`

### positions

> **positions**: `Float32Array`
