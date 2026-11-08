[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/LocalGeoJsonProvider](../README.md) / LocalGeoJsonProvider

# Class: LocalGeoJsonProvider

Defined in: world/LocalGeoJsonProvider.ts:898

Common provider interface for geographic features.
In this version, LocalGeoJsonProvider provides the data.
Future implementations could fetch vector tiles (MVT/PMTiles) or Overpass API queries.

## Implements

- [`MapDataProvider`](../../MapDataProvider/interfaces/MapDataProvider.md)

## Constructors

### Constructor

> **new LocalGeoJsonProvider**(`options?`): `LocalGeoJsonProvider`

Defined in: world/LocalGeoJsonProvider.ts:906

#### Parameters

##### options?

[`LocalGeoJsonProviderOptions`](../interfaces/LocalGeoJsonProviderOptions.md) = `{}`

#### Returns

`LocalGeoJsonProvider`

## Properties

### id

> `readonly` **id**: `"local-geojson"` = `'local-geojson'`

Defined in: world/LocalGeoJsonProvider.ts:899

#### Implementation of

[`MapDataProvider`](../../MapDataProvider/interfaces/MapDataProvider.md).[`id`](../../MapDataProvider/interfaces/MapDataProvider.md#id)

***

### name

> `readonly` **name**: `"Local GeoJSON Provider"` = `'Local GeoJSON Provider'`

Defined in: world/LocalGeoJsonProvider.ts:900

#### Implementation of

[`MapDataProvider`](../../MapDataProvider/interfaces/MapDataProvider.md).[`name`](../../MapDataProvider/interfaces/MapDataProvider.md#name)

## Methods

### loadRegion()

> **loadRegion**(`query?`): `Promise`\<[`ProcessedMapData`](../../../types/MapFeature/interfaces/ProcessedMapData.md)\>

Defined in: world/LocalGeoJsonProvider.ts:912

#### Parameters

##### query?

[`MapRegionQuery`](../../MapDataProvider/interfaces/MapRegionQuery.md)

#### Returns

`Promise`\<[`ProcessedMapData`](../../../types/MapFeature/interfaces/ProcessedMapData.md)\>

#### Implementation of

[`MapDataProvider`](../../MapDataProvider/interfaces/MapDataProvider.md).[`loadRegion`](../../MapDataProvider/interfaces/MapDataProvider.md#loadregion)

***

### parseGeoJson()

> **parseGeoJson**(`geojson`, `explicitRegionName?`, `explicitCenter?`, `clipRadiusMeters?`): [`ProcessedMapData`](../../../types/MapFeature/interfaces/ProcessedMapData.md)

Defined in: world/LocalGeoJsonProvider.ts:935

Parses a GeoJSON object into ProcessedMapData with strict, unambiguous diagnostic accounting.

#### Parameters

##### geojson

`any`

##### explicitRegionName?

`string`

##### explicitCenter?

\[`number`, `number`\]

##### clipRadiusMeters?

`number`

#### Returns

[`ProcessedMapData`](../../../types/MapFeature/interfaces/ProcessedMapData.md)
