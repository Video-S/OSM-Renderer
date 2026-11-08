[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/OsmRoadCrossSection](../README.md) / resolveOsmRoadWidth

# Function: resolveOsmRoadWidth()

> **resolveOsmRoadWidth**(`roadClass`, `osmTags`, `catalogueDefaultWidth?`, `options?`): `number`

Defined in: world/OsmRoadCrossSection.ts:360

Resolves the canonical unscaled physical carriageway width (in meters) for an OSM way
following the Stage E2 evidence hierarchy:
1. Explicit `width:carriageway` (on vehicular roads)
2. Explicit `width`
3. Subtype-specific `catalogueDefaultWidth` (runway, taxiway, pier, platform, etc.)
4. Subordinated service (`parking_aisle`, `driveway`) and non-vehicular path defaults
5. Explicit lane counts (`lanes`, `lanes:forward`/`lanes:backward`, `turn:lanes`) +
   painted on-carriageway cycle lanes (`cycleway*=lane`)
6. Conservative class & one-way default width (`ROAD_CLASS_WIDTHS`).

## Parameters

### roadClass

[`RoadClass`](../../../types/MapFeature/type-aliases/RoadClass.md)

### osmTags

[`RawGeoJsonProperties`](../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

### catalogueDefaultWidth?

`number`

### options?

#### suppressInferredLaneWidening?

`boolean`

## Returns

`number`
