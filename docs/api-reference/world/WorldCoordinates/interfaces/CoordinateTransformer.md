[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/WorldCoordinates](../README.md) / CoordinateTransformer

# Interface: CoordinateTransformer

Defined in: world/WorldCoordinates.ts:11

## Properties

### originLat

> **originLat**: `number`

Defined in: world/WorldCoordinates.ts:13

***

### originLon

> **originLon**: `number`

Defined in: world/WorldCoordinates.ts:12

## Methods

### toGeo()

> **toGeo**(`x`, `z`): \[`number`, `number`\]

Defined in: world/WorldCoordinates.ts:15

#### Parameters

##### x

`number`

##### z

`number`

#### Returns

\[`number`, `number`\]

***

### toLocal()

> **toLocal**(`lon`, `lat`): \[`number`, `number`\]

Defined in: world/WorldCoordinates.ts:14

#### Parameters

##### lon

`number`

##### lat

`number`

#### Returns

\[`number`, `number`\]
