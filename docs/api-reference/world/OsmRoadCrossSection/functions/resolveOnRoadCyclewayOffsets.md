[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/OsmRoadCrossSection](../README.md) / resolveOnRoadCyclewayOffsets

# Function: resolveOnRoadCyclewayOffsets()

> **resolveOnRoadCyclewayOffsets**(`osmTags`, `roadClass`, `isOneWay`, `isReverseOneWay`): `object`

Defined in: world/OsmRoadCrossSection.ts:268

Resolves on-carriageway painted cycleway lane widths (`leftCycleWidth`, `rightCycleWidth`)
in the digitized OSM way direction.

Physical surface semantics:
- Only painted on-carriageway cycle lanes (`cycleway*=lane | opposite_lane | shared_lane`)
  share the physical asphalt carriageway between curbs.
- Separated cycle tracks (`cycleway*=track | opposite_track | separate`), `share_busway`,
  or `bicycle=use_sidepath` are physically separated or share an existing motor lane and
  NEVER widen the motor-vehicle carriageway.

## Parameters

### osmTags

[`RawGeoJsonProperties`](../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

### roadClass

[`RoadClass`](../../../types/MapFeature/type-aliases/RoadClass.md)

### isOneWay

`boolean`

### isReverseOneWay

`boolean`

## Returns

`object`

### leftCycleWidth

> **leftCycleWidth**: `number`

### rightCycleWidth

> **rightCycleWidth**: `number`
