[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/OsmRoadCrossSection](../README.md) / OsmLaneCountResolution

# Interface: OsmLaneCountResolution

Defined in: world/OsmRoadCrossSection.ts:45

Parsed OSM lane count metadata across total, directional, and turn-lane tags.

## Properties

### backwardLanes?

> `optional` **backwardLanes?**: `number`

Defined in: world/OsmRoadCrossSection.ts:51

Explicit backward lane count if tagged via `lanes:backward` or `turn:lanes:backward`.

***

### bothWaysLanes?

> `optional` **bothWaysLanes?**: `number`

Defined in: world/OsmRoadCrossSection.ts:53

Explicit bi-directional center lane count if tagged via `lanes:both_ways`.

***

### forwardLanes?

> `optional` **forwardLanes?**: `number`

Defined in: world/OsmRoadCrossSection.ts:49

Explicit forward lane count if tagged via `lanes:forward` or `turn:lanes:forward`.

***

### hasExplicitLaneTag

> **hasExplicitLaneTag**: `boolean`

Defined in: world/OsmRoadCrossSection.ts:57

True if an explicit `lanes` or `lanes:*` numeric tag was present and valid.

***

### totalLanes?

> `optional` **totalLanes?**: `number`

Defined in: world/OsmRoadCrossSection.ts:47

Effective motor-vehicle lane count in `[1, 12]`.

***

### turnLanesCount?

> `optional` **turnLanesCount?**: `number`

Defined in: world/OsmRoadCrossSection.ts:55

Lane count derived from pipe-delimited `turn:lanes*` tags.
