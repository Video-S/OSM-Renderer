[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/ElevationPolicy](../README.md) / getRoadElevation

# Function: getRoadElevation()

> **getRoadElevation**(`roadClass`, `layer?`, `isBridge?`, `isTunnel?`, `_featureId?`, `maxheightMeters?`): `number`

Defined in: world/ElevationPolicy.ts:256

Determines the physical Y-elevation for a road feature.
- All ordinary at-grade roads and paths share the uniform physical baseline ELEVATION_POLICY.ROAD_SURFACE (0.050m).
- Bridges: relational grade-separation clearance (>= 2.8m above grade).
- Tunnels: subterranean depth (<= ELEVATION_POLICY.TUNNEL_DEPTH = -4.2m, deepened further when explicit maxheight requires it).

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

### maxheightMeters?

`number`

## Returns

`number`
