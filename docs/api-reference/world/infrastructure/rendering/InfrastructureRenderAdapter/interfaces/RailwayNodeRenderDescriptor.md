[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / RailwayNodeRenderDescriptor

# Interface: RailwayNodeRenderDescriptor

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:510

Render-ready descriptor for a topological railway node (Stage E3 handoff contract).

Explicitly separates confirmed turnout switches (`turnoutStatus === 'confirmed'`)
from unresolved switches (`'unresolved_main_vs_diverging' | 'unresolved_throat'`)
and non-interchanging flat crossings (`roles.includes('railway_crossing')`).

## Properties

### degree

> **degree**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:528

Total attached half-edge count (`incidentHalfEdges.length`).

***

### flatCrossingIds

> **flatCrossingIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:548

Confirmed `RailwayFlatCrossingRelation.id`s associated with this node.

***

### gradeTransitionIds

> **gradeTransitionIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:550

Confirmed `GradeTransitionRelation.id`s anchored at this railway node.

***

### id

> **id**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:512

Canonical railway node ID.

***

### incidentEdgeIds

> **incidentEdgeIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:534

Deduplicated, canonically sorted unique incident railway edge IDs.

***

### incidentHalfEdges

> **incidentHalfEdges**: readonly [`IncidentHalfEdge`](../../../topology/types/interfaces/IncidentHalfEdge.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:536

All attached railway half-edges (`incidentHalfEdges.length === degree`).

***

### isBoundaryClipped

> **isBoundaryClipped**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:526

True if synthesized at the loaded region clipping boundary.

***

### isBridge

> **isBridge**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:522

True if node belongs to a bridge vertical scope.

***

### isConfirmedSwitch

> **isConfirmedSwitch**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:540

True iff `turnoutStatus === 'confirmed'`.

***

### isTunnel

> **isTunnel**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:524

True if node belongs to a tunnel vertical scope.

***

### isUnresolvedSwitch

> **isUnresolvedSwitch**: `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:542

True iff `turnoutStatus === 'unresolved_main_vs_diverging' || turnoutStatus === 'unresolved_throat'`.

***

### layer

> **layer**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:520

Effective vertical OSM layer.

***

### levelCrossingIds

> **levelCrossingIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:552

Confirmed `LevelCrossingRelation.id`s anchored at this railway node.

***

### nodeIdOrigin

> **nodeIdOrigin**: [`NodeIdOrigin`](../../../topology/types/type-aliases/NodeIdOrigin.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:516

Provenance of node identity (`'explicit_osm' | 'coordinate_fallback' | 'boundary_clip'`).

***

### pointOsmTags?

> `optional` **pointOsmTags?**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:546

Point-level OSM tags if an ingested `InfrastructurePointMetadata` feature matched this node.

***

### position

> **position**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:518

World coordinates `[x, z]` in local meters.

***

### primaryRole

> **primaryRole**: [`RailwayNodeRole`](../../../topology/types/type-aliases/RailwayNodeRole.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:530

Primary topological role selected by precedence.

***

### rawOsmNodeId?

> `optional` **rawOsmNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:514

Verified raw unprefixed OSM node ID if grounded in explicit OSM data.

***

### roles

> **roles**: readonly [`RailwayNodeRole`](../../../topology/types/type-aliases/RailwayNodeRole.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:532

Non-exclusive canonically sorted list of all topological roles on this node.

***

### turnoutStatus

> **turnoutStatus**: [`TurnoutClassificationStatus`](../../../topology/types/type-aliases/TurnoutClassificationStatus.md) \| `"none"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:538

Turnout classification status (`'none'` when node is not a candidate switch).

***

### turnoutTopology?

> `optional` **turnoutTopology?**: [`TurnoutTopologySpec`](../../../topology/types/interfaces/TurnoutTopologySpec.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:544

Full turnout branch specification when `turnoutTopology` is present on the graph node.
