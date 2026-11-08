[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/OsmRoadCrossSection](../README.md) / resolveOsmLaneCounts

# Function: resolveOsmLaneCounts()

> **resolveOsmLaneCounts**(`osmTags`, `isOneWay`, `isReverseOneWay`): [`OsmLaneCountResolution`](../interfaces/OsmLaneCountResolution.md)

Defined in: world/OsmRoadCrossSection.ts:175

Resolves effective motor-vehicle lane counts from `lanes`, `lanes:forward`, `lanes:backward`,
`lanes:both_ways`, and `turn:lanes*` tags with deterministic precedence and sanity bounds.

## Parameters

### osmTags

[`RawGeoJsonProperties`](../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

### isOneWay

`boolean`

### isReverseOneWay

`boolean`

## Returns

[`OsmLaneCountResolution`](../interfaces/OsmLaneCountResolution.md)
