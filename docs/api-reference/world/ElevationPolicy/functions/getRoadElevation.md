[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/ElevationPolicy](../README.md) / getRoadElevation

# Function: getRoadElevation()

> **getRoadElevation**(`roadClass`, `layer?`, `isBridge?`, `isTunnel?`, `_featureId?`): `number`

Defined in: world/ElevationPolicy.ts:151

Determines the physical Y-elevation for a road feature.
- All ordinary at-grade roads and paths share the uniform physical baseline ELEVATION_POLICY.ROAD_SURFACE (0.050m).
- Bridges: relational grade-separation clearance (>= 2.8m above grade).
- Tunnels: subterranean depth (<= -2.0m).

## Parameters

### roadClass

[`RoadClass`](../../../types/MapFeature/type-aliases/RoadClass.md)

### layer?

`number` = `0`

### isBridge?

`boolean` = `false`

### isTunnel?

`boolean` = `false`

### \_featureId?

`string`

## Returns

`number`
