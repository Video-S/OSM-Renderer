[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / LevelCrossingRenderDescriptor

# Interface: LevelCrossingRenderDescriptor

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:663

Render-ready descriptor for a confirmed road/rail or pedestrian/rail level crossing (Stage E4 handoff).

## Properties

### confidence

> **confidence**: `"explicit_osm_crossing_tag"` \| `"shared_explicit_osm_node"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:680

***

### crossingAngleRad

> **crossingAngleRad**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:679

***

### crossingKind

> **crossingKind**: `"road_rail_level_crossing"` \| `"pedestrian_rail_crossing"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:665

***

### id

> **id**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:664

***

### pointOsmTags?

> `optional` **pointOsmTags?**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:681

***

### position

> **position**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:666

***

### railwayArcLengthMeters

> **railwayArcLengthMeters**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:676

***

### railwayEdgeId

> **railwayEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:674

***

### railwayNodeId?

> `optional` **railwayNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:675

***

### railwaySourceFeatureIds

> **railwaySourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:678

***

### railwayType

> **railwayType**: [`RailwayType`](../../../../../types/MapFeature/type-aliases/RailwayType.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:677

***

### rawOsmNodeId?

> `optional` **rawOsmNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:667

***

### roadArcLengthMeters

> **roadArcLengthMeters**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:670

***

### roadClass

> **roadClass**: [`RoadClass`](../../../../../types/MapFeature/type-aliases/RoadClass.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:671

***

### roadEdgeId

> **roadEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:668

***

### roadNodeId?

> `optional` **roadNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:669

***

### roadSourceFeatureIds

> **roadSourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:673

***

### roadTier

> **roadTier**: [`RoadTier`](../../../topology/types/type-aliases/RoadTier.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:672
