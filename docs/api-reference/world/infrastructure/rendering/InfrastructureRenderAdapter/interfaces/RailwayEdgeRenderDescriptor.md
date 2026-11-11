[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / RailwayEdgeRenderDescriptor

# Interface: RailwayEdgeRenderDescriptor

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:591

Render-ready descriptor for a topological railway edge (Stage E3 handoff contract).

## Properties

### clippedAtEnd

> **clippedAtEnd**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:637

True if `points[points.length - 1]` was synthesized by region bounding-box clipping.

***

### clippedAtStart

> **clippedAtStart**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:635

True if `points[0]` was synthesized by region bounding-box clipping.

***

### deduplicatedFeatureIds

> **deduplicatedFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:659

Canonically sorted list of exact-duplicate feature IDs merged into this edge's segments.

***

### electrified?

> `optional` **electrified?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:613

Raw electrification tag from OSM if present (e.g. `'contact_line'`, `'no'`).

***

### endGradeTransitionId?

> `optional` **endGradeTransitionId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:669

Confirmed `GradeTransitionRelation.id` at the `'end'` (`toNodeId`) endpoint, if any.

***

### endInwardTangent

> **endInwardTangent**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:641

Unit tangent `[dx, dz]` at `points[N-1]` pointing inward along the edge (`toNodeId -> points[N-2]`).

***

### endNodeRoles

> **endNodeRoles**: readonly [`RailwayNodeRole`](../../../topology/types/type-aliases/RailwayNodeRole.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:645

Topological roles held by `toNodeId`.

***

### endTurnoutStatus

> **endTurnoutStatus**: [`TurnoutClassificationStatus`](../../../topology/types/type-aliases/TurnoutClassificationStatus.md) \| `"none"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:649

Turnout classification status at `toNodeId`.

***

### flatCrossingIds

> **flatCrossingIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:665

Confirmed `RailwayFlatCrossingRelation.id`s crossing this railway edge, ordered by arc-length.

***

### fromNodeId

> **fromNodeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:595

Start railway node ID (`points[0]`).

***

### gauge?

> `optional` **gauge?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:611

Raw gauge string from OSM tags if present (e.g. `'1435'`).

***

### gradeSeparatedCrossingIds

> **gradeSeparatedCrossingIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:675

All `GradeSeparatedCrossingRelation.id`s where this railway edge is the upper or lower way.

***

### gradeTransitionIds

> **gradeTransitionIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:671

All confirmed `GradeTransitionRelation.id`s attached to this railway edge.

***

### hasConfirmedSwitchAtEnd

> **hasConfirmedSwitchAtEnd**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:653

True iff `toNodeId` has a confirmed turnout switch (`endTurnoutStatus === 'confirmed'`).

***

### hasConfirmedSwitchAtStart

> **hasConfirmedSwitchAtStart**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:651

True iff `fromNodeId` has a confirmed turnout switch (`startTurnoutStatus === 'confirmed'`).

***

### id

> **id**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:593

Canonical railway edge ID.

***

### isAtGradeBuildable?

> `optional` **isAtGradeBuildable?**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:631

True if rendered in the at-grade railway surface pass.

***

### isBridge

> **isBridge**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:625

True if railway edge is a bridge structure.

***

### isClosedLoop

> **isClosedLoop**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:633

True if `fromNodeId === toNodeId`.

***

### isSecondaryBranch

> **isSecondaryBranch**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:621

True if classified as a secondary branch (`service=siding|yard|spur|crossover` or `usage=industrial|military`).

***

### isTunnel

> **isTunnel**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:627

True if railway edge is a tunnel structure.

***

### layer

> **layer**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:623

Effective vertical OSM layer.

***

### lengthMeters

> **lengthMeters**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:605

Cumulative Euclidean arc-length in meters.

***

### levelCrossingIds

> **levelCrossingIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:673

All confirmed `LevelCrossingRelation.id`s along this railway edge, ordered by `railwayArcLengthMeters`.

***

### name?

> `optional` **name?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:619

Railway line/track name if present.

***

### parallelIndex

> **parallelIndex**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:599

Zero-based parallel multi-edge index between `{fromNodeId, toNodeId}`.

***

### placementClassification?

> `optional` **placementClassification?**: [`InfrastructurePlacementClassification`](../../../../../types/MapFeature/interfaces/InfrastructurePlacementClassification.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:629

Semantic vertical/enclosure placement classification (M2.3-E4-T).

***

### points

> **points**: readonly \[`number`, `number`\][]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:601

Ordered 2D metric polyline vertices `[x, z][]` in `fromNodeId -> toNodeId` order.

***

### primaryOsmTags

> **primaryOsmTags**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:661

Cloned OSM tags from the primary constituent segment for `InspectableFeatureInfo` construction.

***

### provenance

> **provenance**: [`EdgeProvenance`](../../../topology/types/interfaces/EdgeProvenance.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:663

Complete per-segment OSMnx-style provenance covering `[0, lengthMeters]`.

***

### railwayType

> **railwayType**: [`RailwayType`](../../../../../types/MapFeature/type-aliases/RailwayType.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:607

Classified OSM railway type (`'rail'`, `'tram'`, `'light_rail'`, `'subway'`, etc.).

***

### service?

> `optional` **service?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:615

Raw railway service tag if present (e.g. `'siding'`, `'yard'`, `'spur'`, `'crossover'`).

***

### sourceFeatureId

> **sourceFeatureId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:655

Primary original OSM source feature ID (`provenance.segments[0].sourceFeatureId`).

***

### sourceFeatureIds

> **sourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:657

Canonically sorted list of all original OSM source feature IDs contributing to this edge.

***

### startGradeTransitionId?

> `optional` **startGradeTransitionId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:667

Confirmed `GradeTransitionRelation.id` at the `'start'` (`fromNodeId`) endpoint, if any.

***

### startInwardTangent

> **startInwardTangent**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:639

Unit tangent `[dx, dz]` at `points[0]` pointing inward along the edge (`fromNodeId -> points[1]`).

***

### startNodeRoles

> **startNodeRoles**: readonly [`RailwayNodeRole`](../../../topology/types/type-aliases/RailwayNodeRole.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:643

Topological roles held by `fromNodeId`.

***

### startTurnoutStatus

> **startTurnoutStatus**: [`TurnoutClassificationStatus`](../../../topology/types/type-aliases/TurnoutClassificationStatus.md) \| `"none"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:647

Turnout classification status at `fromNodeId`.

***

### toNodeId

> **toNodeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:597

End railway node ID (`points[points.length - 1]`).

***

### usage?

> `optional` **usage?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:617

Raw railway usage tag if present (e.g. `'main'`, `'branch'`).

***

### vertexRawOsmNodeIds

> **vertexRawOsmNodeIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:603

Verified raw OSM node IDs aligned 1:1 with `points` (`undefined` where untagged or clipped).

***

### width

> **width**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:609

Track bed width in meters.
