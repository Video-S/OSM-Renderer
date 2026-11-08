[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/OsmRoadCrossSection](../README.md) / resolveOnewayOrientation

# Function: resolveOnewayOrientation()

> **resolveOnewayOrientation**(`osmTags?`): `object`

Defined in: world/OsmRoadCrossSection.ts:156

Determines whether OSM tags represent a one-way road and whether its traffic flow is
reversed (`oneway=-1` or `oneway=reverse`) relative to the digitized way direction.

## Parameters

### osmTags?

[`RawGeoJsonProperties`](../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

## Returns

`object`

### isOneWay

> **isOneWay**: `boolean`

### isReverseOneWay

> **isReverseOneWay**: `boolean`
