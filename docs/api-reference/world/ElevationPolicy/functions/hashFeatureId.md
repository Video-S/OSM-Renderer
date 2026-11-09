[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/ElevationPolicy](../README.md) / hashFeatureId

# Function: hashFeatureId()

> **hashFeatureId**(`id`): `number`

Defined in: world/ElevationPolicy.ts:135

Computes a deterministic integer hash from a string ID (e.g. OSM feature ID).
Used only for deterministic procedural details (such as foliage variation), never for Y-elevation offsets.

## Parameters

### id

`string` \| `number`

## Returns

`number`
