[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / RoadNodeRenderDescriptor

# Interface: RoadNodeRenderDescriptor

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:186

Render-ready descriptor for a topological road node (Stage E2 handoff contract).

Distinguishes vehicular vs. path incident half-edges so that cross-tier contacts
(e.g. a footpath meeting or crossing a vehicular road at an explicit OSM node)
never trigger false vehicular carriageway asphalt junction trimming (`ADR-0002`, `ADR-0009` Resolution 3).

## Properties

### degree

> **degree**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:204

Total attached half-edge count (`incidentHalfEdges.length`).

***

### gradeTransitionIds

> **gradeTransitionIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:251

Confirmed `GradeTransitionRelation.id`s anchored at this road node.

***

### id

> **id**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:188

Canonical road node ID (e.g. `"road_node:0|0|0:osm_5001"`).

***

### incidentEdgeIds

> **incidentEdgeIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:245

Deduplicated, canonically sorted unique incident road edge IDs.

***

### incidentHalfEdges

> **incidentHalfEdges**: readonly [`IncidentHalfEdge`](../../../topology/types/interfaces/IncidentHalfEdge.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:247

All attached road half-edges (`incidentHalfEdges.length === degree`).

***

### isBoundaryClipped

> **isBoundaryClipped**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:202

True if synthesized at the loaded region clipping boundary.

***

### isBridge

> **isBridge**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:198

True if node belongs to a bridge vertical scope.

***

### isCrossTier

> **isCrossTier**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:210

True if incident to both `'vehicular'` and `'path'` road edges.

***

### isCrossTierOnlyInteraction

> **isCrossTierOnlyInteraction**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:225

True when this node is cross-tier (`isCrossTier === true`) and has at most 2 vehicular half-edges
(i.e. a path contacts a terminating vehicular way [1 vehicular arm] or a continuous through-road
[2 vehicular arms] without a vehicular-to-vehicular branch intersection).
E2 must NOT perform vehicular carriageway junction trimming for path branches.

***

### isTunnel

> **isTunnel**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:200

True if node belongs to a tunnel vertical scope.

***

### layer

> **layer**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:196

Effective vertical OSM layer.

***

### levelCrossingIds

> **levelCrossingIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:253

Confirmed `LevelCrossingRelation.id`s anchored at this road node.

***

### nodeIdOrigin

> **nodeIdOrigin**: [`NodeIdOrigin`](../../../topology/types/type-aliases/NodeIdOrigin.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:192

Provenance of node identity (`'explicit_osm' | 'coordinate_fallback' | 'boundary_clip'`).

***

### pathHalfEdgeCount

> **pathHalfEdgeCount**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:214

Number of attached half-edges belonging to `'path'` road edges.

***

### pathIncidentHalfEdges

> **pathIncidentHalfEdges**: readonly [`IncidentHalfEdge`](../../../topology/types/interfaces/IncidentHalfEdge.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:218

Attached half-edges belonging exclusively to `'path'` road edges.

***

### pointOsmTags?

> `optional` **pointOsmTags?**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:249

Point-level OSM tags if an ingested `InfrastructurePointMetadata` feature matched this node.

***

### position

> **position**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:194

World coordinates `[x, z]` in local meters.

***

### primaryRole

> **primaryRole**: [`RoadNodeRole`](../../../topology/types/type-aliases/RoadNodeRole.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:206

Primary topological role selected by precedence.

***

### rawOsmNodeId?

> `optional` **rawOsmNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:190

Verified raw unprefixed OSM node ID if grounded in explicit OSM data.

***

### requiresPathJunctionTrimming

> **requiresPathJunctionTrimming**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:243

True when at-grade (`layer === 0 && !isBridge && !isTunnel`), `vehicularHalfEdgeCount === 0`,
and `pathHalfEdgeCount >= 2`.

***

### requiresVehicularContinuityMiter

> **requiresVehicularContinuityMiter**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:238

True when at-grade (`layer === 0 && !isBridge && !isTunnel`) and `vehicularHalfEdgeCount === 2`,
indicating that E2 degree-2 road continuity and miter join synthesis applies across the two
continuous vehicular half-edges (as a separate concern from full-width branching junction trimming).

***

### requiresVehicularJunctionTrimming

> **requiresVehicularJunctionTrimming**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:232

True when at-grade (`layer === 0 && !isBridge && !isTunnel`), not cross-tier-only, and
`vehicularHalfEdgeCount >= 3` (or an explicit multi-way vehicular branching junction),
indicating that E2 full-width vehicular carriageway junction trimming and intersection asphalt
synthesis applies across `vehicularIncidentHalfEdges`.

***

### roles

> **roles**: readonly [`RoadNodeRole`](../../../topology/types/type-aliases/RoadNodeRole.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:208

Non-exclusive canonically sorted list of all topological roles on this node.

***

### vehicularHalfEdgeCount

> **vehicularHalfEdgeCount**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:212

Number of attached half-edges belonging to `'vehicular'` road edges.

***

### vehicularIncidentHalfEdges

> **vehicularIncidentHalfEdges**: readonly [`IncidentHalfEdge`](../../../topology/types/interfaces/IncidentHalfEdge.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:216

Attached half-edges belonging exclusively to `'vehicular'` road edges.
