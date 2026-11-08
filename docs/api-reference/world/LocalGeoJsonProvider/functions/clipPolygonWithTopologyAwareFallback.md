[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/LocalGeoJsonProvider](../README.md) / clipPolygonWithTopologyAwareFallback

# Function: clipPolygonWithTopologyAwareFallback()

> **clipPolygonWithTopologyAwareFallback**(`rings`, `minX`, `minZ`, `maxX`, `maxZ`): \[`number`, `number`\][][][]

Defined in: world/LocalGeoJsonProvider.ts:687

Topology-aware fallback for polygon-to-box clipping.
Decomposes concave and holed polygons into convex planar triangles via THREE.ShapeUtils.triangulateShape,
clips each triangle against the axis-aligned box with exact convex Sutherland-Hodgman clipping,
and reconstructs disjoint connected components into clean MultiPolygon parts via Boolean union.

Safe for direct callers: accepts either open or closed rings.
If an interior hole is a sliver (< 0.05 m²), degenerate, or self-intersecting, the offending hole is
dropped rather than discarding the entire polygon. If the outer boundary itself cannot produce valid
geometry, returns an empty array ([]).

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

## Returns

\[`number`, `number`\][][][]
