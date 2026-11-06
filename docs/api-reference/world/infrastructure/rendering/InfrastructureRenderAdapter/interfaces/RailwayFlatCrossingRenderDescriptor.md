[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / RailwayFlatCrossingRenderDescriptor

# Interface: RailwayFlatCrossingRenderDescriptor

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:440

Render-ready descriptor for a confirmed rail-over-rail flat diamond crossing (`railway=railway_crossing`, Stage E3 handoff).

Enforces `allowsBranchInterchange: false` so E3 never confuses a flat diamond crossing
with a turnout switch or slip switch.

## Properties

### allowsBranchInterchange

> **allowsBranchInterchange**: `false`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:453

Always `false`: flat diamond crossings do not permit branch switching between `trackA` and `trackB`.

***

### confidence

> **confidence**: `"explicit_railway_crossing_tag"` \| `"shared_osm_node_flat_crossing"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:451

***

### crossingAngleRad

> **crossingAngleRad**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:450

***

### id

> **id**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:441

***

### pointOsmTags?

> `optional` **pointOsmTags?**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:454

***

### position

> **position**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:442

***

### rawOsmNodeId?

> `optional` **rawOsmNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:443

***

### trackAArcLengthMeters

> **trackAArcLengthMeters**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:445

***

### trackAEdgeId

> **trackAEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:444

***

### trackASourceFeatureIds

> **trackASourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:446

***

### trackBArcLengthMeters

> **trackBArcLengthMeters**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:448

***

### trackBEdgeId

> **trackBEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:447

***

### trackBSourceFeatureIds

> **trackBSourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:449
