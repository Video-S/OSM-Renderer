[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / RoadEdgeRenderDescriptor

# Interface: RoadEdgeRenderDescriptor

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:207

Render-ready descriptor for a topological road edge (Stage E2 & M2.4 handoff contract).

Preserves canonical edge/node IDs, ordered metric polyline geometry, road class/tier,
width, lanes, one-way orientation, surface, culvert/bridge/tunnel flags, boundary clipping,
endpoint tangents/roles, complete per-segment provenance, and crossing/portal relations.

## Properties

### clippedAtEnd

> **clippedAtEnd**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:253

True if `points[points.length - 1]` was synthesized by region bounding-box clipping.

***

### clippedAtStart

> **clippedAtStart**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:251

True if `points[0]` was synthesized by region bounding-box clipping.

***

### deduplicatedFeatureIds

> **deduplicatedFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:271

Canonically sorted list of exact-duplicate feature IDs merged into this edge's segments.

***

### endGradeTransitionId?

> `optional` **endGradeTransitionId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:279

Confirmed `GradeTransitionRelation.id` at the `'end'` (`toNodeId`) endpoint, if any.

***

### endInwardTangent

> **endInwardTangent**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:257

Unit tangent `[dx, dz]` at `points[N-1]` pointing inward along the edge (`toNodeId -> points[N-2]`).

***

### endNodeIsCrossTier

> **endNodeIsCrossTier**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:265

True if `toNodeId` is a cross-tier node (`vehicular` + `path`).

***

### endNodeRoles

> **endNodeRoles**: readonly [`RoadNodeRole`](../../../topology/types/type-aliases/RoadNodeRole.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:261

Topological roles held by `toNodeId`.

***

### fromNodeId

> **fromNodeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:211

Start road node ID (`points[0]`).

***

### gradeSeparatedCrossingIds

> **gradeSeparatedCrossingIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:285

All `GradeSeparatedCrossingRelation.id`s where this road edge is the upper or lower way.

***

### gradeTransitionIds

> **gradeTransitionIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:281

All confirmed `GradeTransitionRelation.id`s attached to this road edge.

***

### id

> **id**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:209

Canonical road edge ID.

***

### isAtGradeBuildable

> **isAtGradeBuildable**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:247

True if rendered in the at-grade road surface pass (`(layer === 0 && !isBridge && !isTunnel) || isCulvert`).

***

### isBridge

> **isBridge**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:241

True if road edge is a bridge structure.

***

### isClosedLoop

> **isClosedLoop**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:249

True if `fromNodeId === toNodeId`.

***

### isCulvert

> **isCulvert**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:245

True if road edge is an at-grade culvert crossing.

***

### isTunnel

> **isTunnel**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:243

True if road edge is a tunnel structure.

***

### lanes?

> `optional` **lanes?**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:229

Parsed lane count if present in OSM tags.

***

### layer

> **layer**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:239

Effective vertical OSM layer.

***

### lengthMeters

> **lengthMeters**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:221

Cumulative Euclidean arc-length in meters.

***

### levelCrossingIds

> **levelCrossingIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:283

All confirmed `LevelCrossingRelation.id`s along this road edge, ordered by `roadArcLengthMeters`.

***

### name?

> `optional` **name?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:237

Road name if present.

***

### normalizedOneway

> **normalizedOneway**: [`NormalizedOneWay`](../../../topology/types/type-aliases/NormalizedOneWay.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:231

Normalized one-way direction relative to `fromNodeId -> toNodeId`.

***

### parallelIndex

> **parallelIndex**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:215

Zero-based parallel multi-edge index between `{fromNodeId, toNodeId}`.

***

### points

> **points**: readonly \[`number`, `number`\][]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:217

Ordered 2D metric polyline vertices `[x, z][]` in `fromNodeId -> toNodeId` order.

***

### primaryOsmTags

> **primaryOsmTags**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:273

Cloned OSM tags from the primary constituent segment for `InspectableFeatureInfo` construction.

***

### provenance

> **provenance**: [`EdgeProvenance`](../../../topology/types/interfaces/EdgeProvenance.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:275

Complete per-segment OSMnx-style provenance covering `[0, lengthMeters]`.

***

### rawOnewayTag?

> `optional` **rawOnewayTag?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:233

Verbatim raw `oneway` tag value from OSM if present.

***

### roadClass

> **roadClass**: [`RoadClass`](../../../../../types/MapFeature/type-aliases/RoadClass.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:223

Classified OSM road class.

***

### sourceFeatureId

> **sourceFeatureId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:267

Primary original OSM source feature ID (`provenance.segments[0].sourceFeatureId`).

***

### sourceFeatureIds

> **sourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:269

Canonically sorted list of all original OSM source feature IDs contributing to this edge.

***

### startGradeTransitionId?

> `optional` **startGradeTransitionId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:277

Confirmed `GradeTransitionRelation.id` at the `'start'` (`fromNodeId`) endpoint, if any.

***

### startInwardTangent

> **startInwardTangent**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:255

Unit tangent `[dx, dz]` at `points[0]` pointing inward along the edge (`fromNodeId -> points[1]`).

***

### startNodeIsCrossTier

> **startNodeIsCrossTier**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:263

True if `fromNodeId` is a cross-tier node (`vehicular` + `path`).

***

### startNodeRoles

> **startNodeRoles**: readonly [`RoadNodeRole`](../../../topology/types/type-aliases/RoadNodeRole.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:259

Topological roles held by `fromNodeId`.

***

### surface?

> `optional` **surface?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:235

Normalized surface material tag if present (e.g. `'asphalt'`, `'paving_stones'`).

***

### tier

> **tier**: [`RoadTier`](../../../topology/types/type-aliases/RoadTier.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:225

Road tier (`'vehicular' | 'path'`).

***

### toNodeId

> **toNodeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:213

End road node ID (`points[points.length - 1]`).

***

### vertexRawOsmNodeIds

> **vertexRawOsmNodeIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:219

Verified raw OSM node IDs aligned 1:1 with `points` (`undefined` where untagged or clipped).

***

### width

> **width**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:227

Unscaled road width in meters.
