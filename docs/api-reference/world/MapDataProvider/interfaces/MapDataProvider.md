[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/MapDataProvider](../README.md) / MapDataProvider

# Interface: MapDataProvider

Defined in: world/MapDataProvider.ts:20

Common provider interface for geographic features.
In this version, LocalGeoJsonProvider provides the data.
Future implementations could fetch vector tiles (MVT/PMTiles) or Overpass API queries.

## Properties

### id

> `readonly` **id**: `string`

Defined in: world/MapDataProvider.ts:21

***

### name

> `readonly` **name**: `string`

Defined in: world/MapDataProvider.ts:22

## Methods

### loadRegion()

> **loadRegion**(`query?`): `Promise`\<[`ProcessedMapData`](../../../types/MapFeature/interfaces/ProcessedMapData.md)\>

Defined in: world/MapDataProvider.ts:23

#### Parameters

##### query?

[`MapRegionQuery`](MapRegionQuery.md)

#### Returns

`Promise`\<[`ProcessedMapData`](../../../types/MapFeature/interfaces/ProcessedMapData.md)\>
