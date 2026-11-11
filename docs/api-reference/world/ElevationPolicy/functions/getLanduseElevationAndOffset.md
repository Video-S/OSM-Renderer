[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/ElevationPolicy](../README.md) / getLanduseElevationAndOffset

# Function: getLanduseElevationAndOffset()

> **getLanduseElevationAndOffset**(`subtype`): `object`

Defined in: world/ElevationPolicy.ts:413

Returns the physical Y-elevation, renderOrder, and depth bias config for a landuse subtype.
All ordinary ground-cover fills share the uniform flush GROUND_COVER_SURFACE (+0.025m),
while `parking_space` decals sit at +0.028m.

## Parameters

### subtype

`string`

## Returns

`object`

### depthOffset

> **depthOffset**: `object`

#### depthOffset.polygonOffset?

> `optional` **polygonOffset?**: `boolean`

#### depthOffset.polygonOffsetFactor?

> `optional` **polygonOffsetFactor?**: `number`

#### depthOffset.polygonOffsetUnits?

> `optional` **polygonOffsetUnits?**: `number`

### elevation

> **elevation**: `number`

### renderOrder

> **renderOrder**: `number`
