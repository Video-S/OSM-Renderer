[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/LocalGeoJsonProvider](../README.md) / clipPolygonRingsToBox

# Function: clipPolygonRingsToBox()

> **clipPolygonRingsToBox**(`rings`, `minX`, `minZ`, `maxX`, `maxZ`, `options?`): [`ClippedPolygonResult`](../interfaces/ClippedPolygonResult.md)

Defined in: world/LocalGeoJsonProvider.ts:798

Clips a polygon `[outerRing, ...holes]` to `[minX, minZ, maxX, maxZ]`.
Uses primary Martínez-Rueda polygonClipping, with a topology-aware convex decomposition fallback
that guarantees disconnected components are emitted as distinct MultiPolygon parts, and that
boundary-crossing holes or invalid degenerate geometries are never silently returned as a single
malformed self-intersecting polygon.

## Parameters

### rings

\[`number`, `number`\][][]

### minX

`number`

### minZ

`number`

### maxX

`number`

### maxZ

`number`

### options?

[`ClipBoxOptions`](../interfaces/ClipBoxOptions.md)

## Returns

[`ClippedPolygonResult`](../interfaces/ClippedPolygonResult.md)
