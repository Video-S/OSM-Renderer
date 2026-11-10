[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / RailwayEdgeRenderDescriptor

# Interface: RailwayEdgeRenderDescriptor

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:503

Render-ready descriptor for a topological railway edge (Stage E3 handoff contract).

## Properties

### clippedAtEnd

> **clippedAtEnd**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:545

True if `points[points.length - 1]` was synthesized by region bounding-box clipping.

***

### clippedAtStart

> **clippedAtStart**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:543

True if `points[0]` was synthesized by region bounding-box clipping.

***

### deduplicatedFeatureIds

> **deduplicatedFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:567

Canonically sorted list of exact-duplicate feature IDs merged into this edge's segments.

***

### electrified?

> `optional` **electrified?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:525

Raw electrification tag from OSM if present (e.g. `'contact_line'`, `'no'`).

***

### endGradeTransitionId?

> `optional` **endGradeTransitionId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:577

Confirmed `GradeTransitionRelation.id` at the `'end'` (`toNodeId`) endpoint, if any.

***

### endInwardTangent

> **endInwardTangent**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:549

Unit tangent `[dx, dz]` at `points[N-1]` pointing inward along the edge (`toNodeId -> points[N-2]`).

***

### endNodeRoles

> **endNodeRoles**: readonly [`RailwayNodeRole`](../../../topology/types/type-aliases/RailwayNodeRole.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:553

Topological roles held by `toNodeId`.

***

### endTurnoutStatus

> **endTurnoutStatus**: [`TurnoutClassificationStatus`](../../../topology/types/type-aliases/TurnoutClassificationStatus.md) \| `"none"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:557

Turnout classification status at `toNodeId`.

***

### flatCrossingIds

> **flatCrossingIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:573

Confirmed `RailwayFlatCrossingRelation.id`s crossing this railway edge, ordered by arc-length.

***

### fromNodeId

> **fromNodeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:507

Start railway node ID (`points[0]`).

***

### gauge?

> `optional` **gauge?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:523

Raw gauge string from OSM tags if present (e.g. `'1435'`).

***

### gradeSeparatedCrossingIds

> **gradeSeparatedCrossingIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:583

All `GradeSeparatedCrossingRelation.id`s where this railway edge is the upper or lower way.

***

### gradeTransitionIds

> **gradeTransitionIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:579

All confirmed `GradeTransitionRelation.id`s attached to this railway edge.

***

### hasConfirmedSwitchAtEnd

> **hasConfirmedSwitchAtEnd**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:561

True iff `toNodeId` has a confirmed turnout switch (`endTurnoutStatus === 'confirmed'`).

***

### hasConfirmedSwitchAtStart

> **hasConfirmedSwitchAtStart**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:559

True iff `fromNodeId` has a confirmed turnout switch (`startTurnoutStatus === 'confirmed'`).

***

### id

> **id**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:505

Canonical railway edge ID.

***

### isBridge

> **isBridge**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:537

True if railway edge is a bridge structure.

***

### isClosedLoop

> **isClosedLoop**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:541

True if `fromNodeId === toNodeId`.

***

### isSecondaryBranch

> **isSecondaryBranch**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:533

True if classified as a secondary branch (`service=siding|yard|spur|crossover` or `usage=industrial|military`).

***

### isTunnel

> **isTunnel**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:539

True if railway edge is a tunnel structure.

***

### layer

> **layer**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:535

Effective vertical OSM layer.

***

### lengthMeters

> **lengthMeters**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:517

Cumulative Euclidean arc-length in meters.

***

### levelCrossingIds

> **levelCrossingIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:581

All confirmed `LevelCrossingRelation.id`s along this railway edge, ordered by `railwayArcLengthMeters`.

***

### name?

> `optional` **name?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:531

Railway line/track name if present.

***

### parallelIndex

> **parallelIndex**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:511

Zero-based parallel multi-edge index between `{fromNodeId, toNodeId}`.

***

### points

> **points**: readonly \[`number`, `number`\][]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:513

Ordered 2D metric polyline vertices `[x, z][]` in `fromNodeId -> toNodeId` order.

***

### primaryOsmTags

> **primaryOsmTags**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:569

Cloned OSM tags from the primary constituent segment for `InspectableFeatureInfo` construction.

***

### provenance

> **provenance**: [`EdgeProvenance`](../../../topology/types/interfaces/EdgeProvenance.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:571

Complete per-segment OSMnx-style provenance covering `[0, lengthMeters]`.

***

### railwayType

> **railwayType**: [`RailwayType`](../../../../../types/MapFeature/type-aliases/RailwayType.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:519

Classified OSM railway type (`'rail'`, `'tram'`, `'light_rail'`, `'subway'`, etc.).

***

### service?

> `optional` **service?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:527

Raw railway service tag if present (e.g. `'siding'`, `'yard'`, `'spur'`, `'crossover'`).

***

### sourceFeatureId

> **sourceFeatureId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:563

Primary original OSM source feature ID (`provenance.segments[0].sourceFeatureId`).

***

### sourceFeatureIds

> **sourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:565

Canonically sorted list of all original OSM source feature IDs contributing to this edge.

***

### startGradeTransitionId?

> `optional` **startGradeTransitionId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:575

Confirmed `GradeTransitionRelation.id` at the `'start'` (`fromNodeId`) endpoint, if any.

***

### startInwardTangent

> **startInwardTangent**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:547

Unit tangent `[dx, dz]` at `points[0]` pointing inward along the edge (`fromNodeId -> points[1]`).

***

### startNodeRoles

> **startNodeRoles**: readonly [`RailwayNodeRole`](../../../topology/types/type-aliases/RailwayNodeRole.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:551

Topological roles held by `fromNodeId`.

***

### startTurnoutStatus

> **startTurnoutStatus**: [`TurnoutClassificationStatus`](../../../topology/types/type-aliases/TurnoutClassificationStatus.md) \| `"none"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:555

Turnout classification status at `fromNodeId`.

***

### toNodeId

> **toNodeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:509

End railway node ID (`points[points.length - 1]`).

***

### usage?

> `optional` **usage?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:529

Raw railway usage tag if present (e.g. `'main'`, `'branch'`).

***

### vertexRawOsmNodeIds

> **vertexRawOsmNodeIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:515

Verified raw OSM node IDs aligned 1:1 with `points` (`undefined` where untagged or clipped).

***

### width

> **width**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:521

Track bed width in meters.
