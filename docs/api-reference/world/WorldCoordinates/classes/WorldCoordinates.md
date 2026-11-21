[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/WorldCoordinates](../README.md) / WorldCoordinates

# Class: WorldCoordinates

Defined in: world/WorldCoordinates.ts:88

WorldCoordinates helper class to store origin and convert batch coordinates efficiently.

## Implements

- [`CoordinateTransformer`](../interfaces/CoordinateTransformer.md)

## Constructors

### Constructor

> **new WorldCoordinates**(`originLon`, `originLat`): `WorldCoordinates`

Defined in: world/WorldCoordinates.ts:95

#### Parameters

##### originLon

`number`

##### originLat

`number`

#### Returns

`WorldCoordinates`

## Properties

### originLat

> `readonly` **originLat**: `number`

Defined in: world/WorldCoordinates.ts:90

#### Implementation of

[`CoordinateTransformer`](../interfaces/CoordinateTransformer.md).[`originLat`](../interfaces/CoordinateTransformer.md#originlat)

***

### originLon

> `readonly` **originLon**: `number`

Defined in: world/WorldCoordinates.ts:89

#### Implementation of

[`CoordinateTransformer`](../interfaces/CoordinateTransformer.md).[`originLon`](../interfaces/CoordinateTransformer.md#originlon)

## Methods

### toGeo()

> **toGeo**(`x`, `z`): \[`number`, `number`\]

Defined in: world/WorldCoordinates.ts:107

#### Parameters

##### x

`number`

##### z

`number`

#### Returns

\[`number`, `number`\]

#### Implementation of

[`CoordinateTransformer`](../interfaces/CoordinateTransformer.md).[`toGeo`](../interfaces/CoordinateTransformer.md#togeo)

***

### toLocal()

> **toLocal**(`lon`, `lat`): \[`number`, `number`\]

Defined in: world/WorldCoordinates.ts:101

#### Parameters

##### lon

`number`

##### lat

`number`

#### Returns

\[`number`, `number`\]

#### Implementation of

[`CoordinateTransformer`](../interfaces/CoordinateTransformer.md).[`toLocal`](../interfaces/CoordinateTransformer.md#tolocal)

***

### transformLine()

> **transformLine**(`coordinates`): \[`number`, `number`\][]

Defined in: world/WorldCoordinates.ts:123

Transforms an array of [lon, lat] polyline vertices into [x, z] meters.

#### Parameters

##### coordinates

\[`number`, `number`\][]

#### Returns

\[`number`, `number`\][]

#### Implementation of

[`CoordinateTransformer`](../interfaces/CoordinateTransformer.md).[`transformLine`](../interfaces/CoordinateTransformer.md#transformline)

***

### transformRing()

> **transformRing**(`coordinates`): \[`number`, `number`\][]

Defined in: world/WorldCoordinates.ts:116

Transforms an array of [lon, lat] coordinates into [x, z] meters.

#### Parameters

##### coordinates

\[`number`, `number`\][]

#### Returns

\[`number`, `number`\][]

#### Implementation of

[`CoordinateTransformer`](../interfaces/CoordinateTransformer.md).[`transformRing`](../interfaces/CoordinateTransformer.md#transformring)
