[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / RailwayFlatCrossingRenderDescriptor

# Interface: RailwayFlatCrossingRenderDescriptor

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:592

Render-ready descriptor for a confirmed rail-over-rail flat diamond crossing (`railway=railway_crossing`, Stage E3 handoff).

Enforces `allowsBranchInterchange: false` so E3 never confuses a flat diamond crossing
with a turnout switch or slip switch.

## Properties

### allowsBranchInterchange

> **allowsBranchInterchange**: `false`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:605

Always `false`: flat diamond crossings do not permit branch switching between `trackA` and `trackB`.

***

### confidence

> **confidence**: `"explicit_railway_crossing_tag"` \| `"shared_osm_node_flat_crossing"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:603

***

### crossingAngleRad

> **crossingAngleRad**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:602

***

### id

> **id**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:593

***

### pointOsmTags?

> `optional` **pointOsmTags?**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:606

***

### position

> **position**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:594

***

### rawOsmNodeId?

> `optional` **rawOsmNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:595

***

### trackAArcLengthMeters

> **trackAArcLengthMeters**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:597

***

### trackAEdgeId

> **trackAEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:596

***

### trackASourceFeatureIds

> **trackASourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:598

***

### trackBArcLengthMeters

> **trackBArcLengthMeters**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:600

***

### trackBEdgeId

> **trackBEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:599

***

### trackBSourceFeatureIds

> **trackBSourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:601
