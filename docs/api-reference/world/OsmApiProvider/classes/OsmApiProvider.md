[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/OsmApiProvider](../README.md) / OsmApiProvider

# Class: OsmApiProvider

Defined in: world/OsmApiProvider.ts:9

MapDataProvider implementation that queries the server-side OpenStreetMap API proxy
(/api/osm-data) and parses the returned GeoJSON into high-fidelity 3D map data.

## Implements

- [`MapDataProvider`](../../MapDataProvider/interfaces/MapDataProvider.md)

## Constructors

### Constructor

> **new OsmApiProvider**(): `OsmApiProvider`

Defined in: world/OsmApiProvider.ts:16

#### Returns

`OsmApiProvider`

## Properties

### id

> `readonly` **id**: `"osm-live-api"` = `'osm-live-api'`

Defined in: world/OsmApiProvider.ts:10

#### Implementation of

[`MapDataProvider`](../../MapDataProvider/interfaces/MapDataProvider.md).[`id`](../../MapDataProvider/interfaces/MapDataProvider.md#id)

***

### name

> `readonly` **name**: `"OpenStreetMap Live API"` = `'OpenStreetMap Live API'`

Defined in: world/OsmApiProvider.ts:11

#### Implementation of

[`MapDataProvider`](../../MapDataProvider/interfaces/MapDataProvider.md).[`name`](../../MapDataProvider/interfaces/MapDataProvider.md#name)

## Methods

### getLastRawGeoJson()

> **getLastRawGeoJson**(): `any`

Defined in: world/OsmApiProvider.ts:20

#### Returns

`any`

***

### loadRegion()

> **loadRegion**(`query?`): `Promise`\<[`ProcessedMapData`](../../../types/MapFeature/interfaces/ProcessedMapData.md)\>

Defined in: world/OsmApiProvider.ts:24

#### Parameters

##### query?

[`MapRegionQuery`](../../MapDataProvider/interfaces/MapRegionQuery.md)

#### Returns

`Promise`\<[`ProcessedMapData`](../../../types/MapFeature/interfaces/ProcessedMapData.md)\>

#### Implementation of

[`MapDataProvider`](../../MapDataProvider/interfaces/MapDataProvider.md).[`loadRegion`](../../MapDataProvider/interfaces/MapDataProvider.md#loadregion)
