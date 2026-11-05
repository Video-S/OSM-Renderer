[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/LocalGeoJsonProvider](../README.md) / clipPolylineToBox

# Function: clipPolylineToBox()

> **clipPolylineToBox**(`points`, `minX`, `minZ`, `maxX`, `maxZ`, `rawOsmNodes?`): `object`

Defined in: world/LocalGeoJsonProvider.ts:122

Clips a 2D polyline to an axis-aligned bounding box [minX, minZ, maxX, maxZ] using Liang-Barsky.
Preserves per-vertex OSM node IDs for unclipped original vertices and sets `undefined` on
newly interpolated boundary intersection endpoints, recording `clippedAtStart` and `clippedAtEnd`.

## Parameters

### points

\[`number`, `number`\][]

### minX

`number`

### minZ

`number`

### maxX

`number`

### maxZ

`number`

### rawOsmNodes?

(`string` \| `number`)[]

## Returns

`object`

### lines

> **lines**: `object`[]

### wasClipped

> **wasClipped**: `boolean`
