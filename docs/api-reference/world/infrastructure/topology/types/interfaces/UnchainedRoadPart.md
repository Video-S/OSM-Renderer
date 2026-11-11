[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / UnchainedRoadPart

# Interface: UnchainedRoadPart

Defined in: world/infrastructure/topology/types.ts:88

Non-destructive, pre-deduplication and pre-chaining road way part captured immediately
after bounding-box clipping (`clipPolylineToBox`) and culvert/layer classification,
BEFORE `seenRoadSegments` heuristic deduplication and BEFORE `chainContiguousRoads`.

## Properties

### clippedAtEnd

> **clippedAtEnd**: `boolean`

Defined in: world/infrastructure/topology/types.ts:110

True if `points[points.length - 1]` was synthesized by Liang-Barsky bounding-box clipping.

***

### clippedAtStart

> **clippedAtStart**: `boolean`

Defined in: world/infrastructure/topology/types.ts:108

True if `points[0]` was synthesized by Liang-Barsky bounding-box clipping.

***

### hasExplicitSourceId

> **hasExplicitSourceId**: `boolean`

Defined in: world/infrastructure/topology/types.ts:97

True when `sourceFeatureId` came from an explicit ID in the input GeoJSON (`f.id`, `props.id`, or `props['@id']`);
false when synthesized as `feat-${featureIndex}`.

***

### id

> **id**: `string`

Defined in: world/infrastructure/topology/types.ts:90

Unique part ID (e.g. "way/100-0").

***

### isBridge

> **isBridge**: `boolean`

Defined in: world/infrastructure/topology/types.ts:114

***

### isCulvert

> **isCulvert**: `boolean`

Defined in: world/infrastructure/topology/types.ts:116

***

### isTunnel

> **isTunnel**: `boolean`

Defined in: world/infrastructure/topology/types.ts:115

***

### layer

> **layer**: `number`

Defined in: world/infrastructure/topology/types.ts:113

***

### name?

> `optional` **name?**: `string`

Defined in: world/infrastructure/topology/types.ts:117

***

### osmTags

> **osmTags**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/topology/types.ts:119

Original unmodified OSM tags for this specific way.

***

### partIndex

> **partIndex**: `number`

Defined in: world/infrastructure/topology/types.ts:99

Zero-based index of this clipped/multi-line part within `sourceFeatureId`.

***

### placementClassification?

> `optional` **placementClassification?**: [`InfrastructurePlacementClassification`](../../../../../types/MapFeature/interfaces/InfrastructurePlacementClassification.md)

Defined in: world/infrastructure/topology/types.ts:121

Semantic vertical/enclosure placement classification (M2.3-E4-T).

***

### points

> **points**: readonly \[`number`, `number`\][]

Defined in: world/infrastructure/topology/types.ts:101

Ordered 2D metric vertices [x, z][] in original digitized way orientation.

***

### rawOsmNodeIds

> **rawOsmNodeIds**: readonly `string`[]

Defined in: world/infrastructure/topology/types.ts:106

Raw unprefixed OSM node IDs aligned 1:1 with `points` where verified,
or `undefined` at vertices lacking an explicit OSM node ID (including boundary cuts).

***

### roadClass

> **roadClass**: [`RoadClass`](../../../../../types/MapFeature/type-aliases/RoadClass.md)

Defined in: world/infrastructure/topology/types.ts:111

***

### sourceFeatureId

> **sourceFeatureId**: `string`

Defined in: world/infrastructure/topology/types.ts:92

Original unsplit feature ID (e.g. "way/100", or synthetic "feat-1" when the input feature lacked an ID).

***

### width

> **width**: `number`

Defined in: world/infrastructure/topology/types.ts:112
