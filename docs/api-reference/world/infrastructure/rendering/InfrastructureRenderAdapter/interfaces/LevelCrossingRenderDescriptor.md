[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / LevelCrossingRenderDescriptor

# Interface: LevelCrossingRenderDescriptor

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:612

Render-ready descriptor for a confirmed road/rail or pedestrian/rail level crossing (Stage E4 handoff).

## Properties

### confidence

> **confidence**: `"explicit_osm_crossing_tag"` \| `"shared_explicit_osm_node"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:629

***

### crossingAngleRad

> **crossingAngleRad**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:628

***

### crossingKind

> **crossingKind**: `"road_rail_level_crossing"` \| `"pedestrian_rail_crossing"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:614

***

### id

> **id**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:613

***

### pointOsmTags?

> `optional` **pointOsmTags?**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:630

***

### position

> **position**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:615

***

### railwayArcLengthMeters

> **railwayArcLengthMeters**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:625

***

### railwayEdgeId

> **railwayEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:623

***

### railwayNodeId?

> `optional` **railwayNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:624

***

### railwaySourceFeatureIds

> **railwaySourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:627

***

### railwayType

> **railwayType**: [`RailwayType`](../../../../../types/MapFeature/type-aliases/RailwayType.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:626

***

### rawOsmNodeId?

> `optional` **rawOsmNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:616

***

### roadArcLengthMeters

> **roadArcLengthMeters**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:619

***

### roadClass

> **roadClass**: [`RoadClass`](../../../../../types/MapFeature/type-aliases/RoadClass.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:620

***

### roadEdgeId

> **roadEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:617

***

### roadNodeId?

> `optional` **roadNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:618

***

### roadSourceFeatureIds

> **roadSourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:622

***

### roadTier

> **roadTier**: [`RoadTier`](../../../topology/types/type-aliases/RoadTier.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:621
