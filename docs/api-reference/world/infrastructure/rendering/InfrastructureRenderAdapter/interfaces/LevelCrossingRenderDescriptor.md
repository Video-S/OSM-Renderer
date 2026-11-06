[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / LevelCrossingRenderDescriptor

# Interface: LevelCrossingRenderDescriptor

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:508

Render-ready descriptor for a confirmed road/rail or pedestrian/rail level crossing (Stage E4 handoff).

## Properties

### confidence

> **confidence**: `"explicit_osm_crossing_tag"` \| `"shared_explicit_osm_node"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:525

***

### crossingAngleRad

> **crossingAngleRad**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:524

***

### crossingKind

> **crossingKind**: `"road_rail_level_crossing"` \| `"pedestrian_rail_crossing"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:510

***

### id

> **id**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:509

***

### pointOsmTags?

> `optional` **pointOsmTags?**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:526

***

### position

> **position**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:511

***

### railwayArcLengthMeters

> **railwayArcLengthMeters**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:521

***

### railwayEdgeId

> **railwayEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:519

***

### railwayNodeId?

> `optional` **railwayNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:520

***

### railwaySourceFeatureIds

> **railwaySourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:523

***

### railwayType

> **railwayType**: [`RailwayType`](../../../../../types/MapFeature/type-aliases/RailwayType.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:522

***

### rawOsmNodeId?

> `optional` **rawOsmNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:512

***

### roadArcLengthMeters

> **roadArcLengthMeters**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:515

***

### roadClass

> **roadClass**: [`RoadClass`](../../../../../types/MapFeature/type-aliases/RoadClass.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:516

***

### roadEdgeId

> **roadEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:513

***

### roadNodeId?

> `optional` **roadNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:514

***

### roadSourceFeatureIds

> **roadSourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:518

***

### roadTier

> **roadTier**: [`RoadTier`](../../../topology/types/type-aliases/RoadTier.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:517
