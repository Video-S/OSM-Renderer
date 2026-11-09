[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/ElevationPolicy](../README.md) / getRailwayElevations

# Function: getRailwayElevations()

> **getRailwayElevations**(`layer?`, `isBridge?`, `isTunnel?`): `object`

Defined in: world/ElevationPolicy.ts:178

Determines the physical Y-elevation for a railway feature (ballast bed, cross-tie sleepers, and steel rails).

## Parameters

### layer?

`number` = `0`

### isBridge?

`boolean` = `false`

### isTunnel?

`boolean` = `false`

## Returns

`object`

### ballast

> **ballast**: `number`

### rails

> **rails**: `number`

### sleepers

> **sleepers**: `number`
