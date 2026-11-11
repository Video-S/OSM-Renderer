[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / RailwayNodeRenderDescriptor

# Interface: RailwayNodeRenderDescriptor

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:543

Render-ready descriptor for a topological railway node (Stage E3 handoff contract).

Explicitly separates confirmed turnout switches (`turnoutStatus === 'confirmed'`)
from unresolved switches (`'unresolved_main_vs_diverging' | 'unresolved_throat'`)
and non-interchanging flat crossings (`roles.includes('railway_crossing')`).

## Properties

### degree

> **degree**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:561

Total attached half-edge count (`incidentHalfEdges.length`).

***

### flatCrossingIds

> **flatCrossingIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:581

Confirmed `RailwayFlatCrossingRelation.id`s associated with this node.

***

### gradeTransitionIds

> **gradeTransitionIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:583

Confirmed `GradeTransitionRelation.id`s anchored at this railway node.

***

### id

> **id**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:545

Canonical railway node ID.

***

### incidentEdgeIds

> **incidentEdgeIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:567

Deduplicated, canonically sorted unique incident railway edge IDs.

***

### incidentHalfEdges

> **incidentHalfEdges**: readonly [`IncidentHalfEdge`](../../../topology/types/interfaces/IncidentHalfEdge.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:569

All attached railway half-edges (`incidentHalfEdges.length === degree`).

***

### isBoundaryClipped

> **isBoundaryClipped**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:559

True if synthesized at the loaded region clipping boundary.

***

### isBridge

> **isBridge**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:555

True if node belongs to a bridge vertical scope.

***

### isConfirmedSwitch

> **isConfirmedSwitch**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:573

True iff `turnoutStatus === 'confirmed'`.

***

### isTunnel

> **isTunnel**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:557

True if node belongs to a tunnel vertical scope.

***

### isUnresolvedSwitch

> **isUnresolvedSwitch**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:575

True iff `turnoutStatus === 'unresolved_main_vs_diverging' || turnoutStatus === 'unresolved_throat'`.

***

### layer

> **layer**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:553

Effective vertical OSM layer.

***

### levelCrossingIds

> **levelCrossingIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:585

Confirmed `LevelCrossingRelation.id`s anchored at this railway node.

***

### nodeIdOrigin

> **nodeIdOrigin**: [`NodeIdOrigin`](../../../topology/types/type-aliases/NodeIdOrigin.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:549

Provenance of node identity (`'explicit_osm' | 'coordinate_fallback' | 'boundary_clip'`).

***

### pointOsmTags?

> `optional` **pointOsmTags?**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:579

Point-level OSM tags if an ingested `InfrastructurePointMetadata` feature matched this node.

***

### position

> **position**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:551

World coordinates `[x, z]` in local meters.

***

### primaryRole

> **primaryRole**: [`RailwayNodeRole`](../../../topology/types/type-aliases/RailwayNodeRole.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:563

Primary topological role selected by precedence.

***

### rawOsmNodeId?

> `optional` **rawOsmNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:547

Verified raw unprefixed OSM node ID if grounded in explicit OSM data.

***

### roles

> **roles**: readonly [`RailwayNodeRole`](../../../topology/types/type-aliases/RailwayNodeRole.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:565

Non-exclusive canonically sorted list of all topological roles on this node.

***

### turnoutStatus

> **turnoutStatus**: [`TurnoutClassificationStatus`](../../../topology/types/type-aliases/TurnoutClassificationStatus.md) \| `"none"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:571

Turnout classification status (`'none'` when node is not a candidate switch).

***

### turnoutTopology?

> `optional` **turnoutTopology?**: [`TurnoutTopologySpec`](../../../topology/types/interfaces/TurnoutTopologySpec.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:577

Full turnout branch specification when `turnoutTopology` is present on the graph node.
