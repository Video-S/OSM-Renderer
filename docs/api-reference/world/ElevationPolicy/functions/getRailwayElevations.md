[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/ElevationPolicy](../README.md) / getRailwayElevations

# Function: getRailwayElevations()

> **getRailwayElevations**(`layer?`, `isBridge?`, `isTunnel?`, `clearanceOptions?`): `object`

Defined in: world/ElevationPolicy.ts:288

Determines the physical Y-elevation for a railway feature (ballast bed, cross-tie sleepers, and steel rails).

## Parameters

### layer?

`number` = `0`

### isBridge?

`boolean` = `false`

### isTunnel?

`boolean` = `false`

### clearanceOptions?

#### electrified?

`string` \| `boolean`

#### maxheightMeters?

`number`

#### railwayType?

`string`

## Returns

`object`

### ballast

> **ballast**: `number`

### rails

> **rails**: `number`

### sleepers

> **sleepers**: `number`
