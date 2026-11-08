[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/OsmRoadCrossSection](../README.md) / resolveSegmentCrossSectionProfile

# Function: resolveSegmentCrossSectionProfile()

> **resolveSegmentCrossSectionProfile**(`baseWidth`, `roadClass`, `osmTags`, `options?`): [`RoadCrossSectionProfile`](../interfaces/RoadCrossSectionProfile.md)

Defined in: world/OsmRoadCrossSection.ts:480

Resolves the start and end left/right lateral offsets (in meters) for a road segment
from its base width, `roadClass`, and `osmTags`, honoring `placement`, `placement:start`,
`placement:end`, `placement:forward`, `placement:backward`, `oneway=-1`, and graph
segment reversal (`reversedRelativeToSource`).

## Parameters

### baseWidth

`number`

### roadClass

[`RoadClass`](../../../types/MapFeature/type-aliases/RoadClass.md)

### osmTags

[`RawGeoJsonProperties`](../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

### options?

#### reversedRelativeToSource?

`boolean`

#### roadWidthMultiplier?

`number`

#### suppressAsymmetricPlacement?

`boolean`

## Returns

[`RoadCrossSectionProfile`](../interfaces/RoadCrossSectionProfile.md)
