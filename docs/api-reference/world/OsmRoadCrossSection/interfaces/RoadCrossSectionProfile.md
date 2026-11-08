[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/OsmRoadCrossSection](../README.md) / RoadCrossSectionProfile

# Interface: RoadCrossSectionProfile

Defined in: world/OsmRoadCrossSection.ts:14

Resolved physical cross-section profile for a road way or graph sub-segment.

Represents independently determined left and right lateral offsets (`leftOffset`, `rightOffset`)
from the OSM reference polyline at the start and end of the segment so that asymmetric
`placement` tags (`left_of:k`, `middle_of:k`, `right_of:k`), `placement:start` / `placement:end`
transitions, and on-carriageway painted cycle lanes (`cycleway*=lane`) are modeled consistently
across ribbons, junction portals, degree-2 joins, and 2D Boolean clipping footprints.

## Properties

### endLeftOffset

> **endLeftOffset**: `number`

Defined in: world/OsmRoadCrossSection.ts:26

Scaled lateral offset (meters) to the physical left curb at the end of the segment.

***

### endRightOffset

> **endRightOffset**: `number`

Defined in: world/OsmRoadCrossSection.ts:28

Scaled lateral offset (meters) to the physical right curb at the end of the segment.

***

### endWidth

> **endWidth**: `number`

Defined in: world/OsmRoadCrossSection.ts:20

Total scaled physical width at the end of the segment (`endLeftOffset + endRightOffset`).

***

### isAsymmetricOrTapered

> **isAsymmetricOrTapered**: `boolean`

Defined in: world/OsmRoadCrossSection.ts:39

True if left and right offsets are asymmetric or vary from start to end.

***

### resolvedLanes?

> `optional` **resolvedLanes?**: `number`

Defined in: world/OsmRoadCrossSection.ts:30

Resolved motor-vehicle lane count if inferred or explicitly tagged.

***

### startLeftOffset

> **startLeftOffset**: `number`

Defined in: world/OsmRoadCrossSection.ts:22

Scaled lateral offset (meters) to the physical left curb at the start of the segment.

***

### startRightOffset

> **startRightOffset**: `number`

Defined in: world/OsmRoadCrossSection.ts:24

Scaled lateral offset (meters) to the physical right curb at the start of the segment.

***

### startWidth

> **startWidth**: `number`

Defined in: world/OsmRoadCrossSection.ts:18

Total scaled physical width at the start of the segment (`startLeftOffset + startRightOffset`).

***

### width

> **width**: `number`

Defined in: world/OsmRoadCrossSection.ts:16

Base unscaled road width in meters.

***

### widthSource

> **widthSource**: `"explicit_width_carriageway"` \| `"explicit_width"` \| `"catalogue_default"` \| `"lanes_and_cycleway"` \| `"class_default"`

Defined in: world/OsmRoadCrossSection.ts:32

Provenance tier of the resolved carriageway width.
