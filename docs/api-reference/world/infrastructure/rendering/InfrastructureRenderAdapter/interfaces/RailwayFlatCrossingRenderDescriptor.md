[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / RailwayFlatCrossingRenderDescriptor

# Interface: RailwayFlatCrossingRenderDescriptor

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:489

Render-ready descriptor for a confirmed rail-over-rail flat diamond crossing (`railway=railway_crossing`, Stage E3 handoff).

Enforces `allowsBranchInterchange: false` so E3 never confuses a flat diamond crossing
with a turnout switch or slip switch.

## Properties

### allowsBranchInterchange

> **allowsBranchInterchange**: `false`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:502

Always `false`: flat diamond crossings do not permit branch switching between `trackA` and `trackB`.

***

### confidence

> **confidence**: `"explicit_railway_crossing_tag"` \| `"shared_osm_node_flat_crossing"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:500

***

### crossingAngleRad

> **crossingAngleRad**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:499

***

### id

> **id**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:490

***

### pointOsmTags?

> `optional` **pointOsmTags?**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:503

***

### position

> **position**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:491

***

### rawOsmNodeId?

> `optional` **rawOsmNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:492

***

### trackAArcLengthMeters

> **trackAArcLengthMeters**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:494

***

### trackAEdgeId

> **trackAEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:493

***

### trackASourceFeatureIds

> **trackASourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:495

***

### trackBArcLengthMeters

> **trackBArcLengthMeters**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:497

***

### trackBEdgeId

> **trackBEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:496

***

### trackBSourceFeatureIds

> **trackBSourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:498
