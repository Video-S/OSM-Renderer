[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / RailwayNode

# Interface: RailwayNode

Defined in: world/infrastructure/topology/types.ts:280

## Extends

- [`BaseInfrastructureNode`](BaseInfrastructureNode.md)\<[`RailwayNodeRole`](../type-aliases/RailwayNodeRole.md)\>

## Properties

### degree

> **degree**: `number`

Defined in: world/infrastructure/topology/types.ts:240

Topological degree: exact count of attached edge endpoints (`incidentHalfEdges.length`).
An ordinary incident edge contributes +1; a closed self-loop edge attaches both endpoints and contributes +2.

#### Inherited from

[`BaseInfrastructureNode`](BaseInfrastructureNode.md).[`degree`](BaseInfrastructureNode.md#degree)

***

### id

> **id**: `string`

Defined in: world/infrastructure/topology/types.ts:217

Deterministic domain-and-scope canonical node ID (e.g. "road_node:0|0|0:osm_5001" or "road_node:0|0|0:fb_1").

#### Inherited from

[`BaseInfrastructureNode`](BaseInfrastructureNode.md).[`id`](BaseInfrastructureNode.md#id)

***

### incidentEdgeIds

> **incidentEdgeIds**: readonly `string`[]

Defined in: world/infrastructure/topology/types.ts:252

Deduplicated, canonically sorted list of unique incident edge IDs.
A closed self-loop edge appears once in `incidentEdgeIds` and twice in `incidentHalfEdges`.

#### Inherited from

[`BaseInfrastructureNode`](BaseInfrastructureNode.md).[`incidentEdgeIds`](BaseInfrastructureNode.md#incidentedgeids)

***

### incidentHalfEdges

> **incidentHalfEdges**: readonly [`IncidentHalfEdge`](IncidentHalfEdge.md)[]

Defined in: world/infrastructure/topology/types.ts:254

All attached half-edges (`incidentHalfEdges.length === degree`).

#### Inherited from

[`BaseInfrastructureNode`](BaseInfrastructureNode.md).[`incidentHalfEdges`](BaseInfrastructureNode.md#incidenthalfedges)

***

### isBoundaryClipped

> **isBoundaryClipped**: `boolean`

Defined in: world/infrastructure/topology/types.ts:235

True if synthesized by region bounding-box clipping (`nodeIdOrigin === 'boundary_clip'`).

#### Inherited from

[`BaseInfrastructureNode`](BaseInfrastructureNode.md).[`isBoundaryClipped`](BaseInfrastructureNode.md#isboundaryclipped)

***

### isBridge

> **isBridge**: `boolean`

Defined in: world/infrastructure/topology/types.ts:231

True if node belongs to a bridge structure scope.

#### Inherited from

[`BaseInfrastructureNode`](BaseInfrastructureNode.md).[`isBridge`](BaseInfrastructureNode.md#isbridge)

***

### isTunnel

> **isTunnel**: `boolean`

Defined in: world/infrastructure/topology/types.ts:233

True if node belongs to a tunnel/underpass structure scope.

#### Inherited from

[`BaseInfrastructureNode`](BaseInfrastructureNode.md).[`isTunnel`](BaseInfrastructureNode.md#istunnel)

***

### layer

> **layer**: `number`

Defined in: world/infrastructure/topology/types.ts:229

Effective vertical OSM layer tag (default 0).

#### Inherited from

[`BaseInfrastructureNode`](BaseInfrastructureNode.md).[`layer`](BaseInfrastructureNode.md#layer)

***

### network

> **network**: `"railway"`

Defined in: world/infrastructure/topology/types.ts:281

Network domain ('road' | 'railway').

#### Overrides

[`BaseInfrastructureNode`](BaseInfrastructureNode.md).[`network`](BaseInfrastructureNode.md#network)

***

### nodeIdOrigin

> **nodeIdOrigin**: [`NodeIdOrigin`](../type-aliases/NodeIdOrigin.md)

Defined in: world/infrastructure/topology/types.ts:223

Explicit provenance of how this node's identity was established.

#### Inherited from

[`BaseInfrastructureNode`](BaseInfrastructureNode.md).[`nodeIdOrigin`](BaseInfrastructureNode.md#nodeidorigin)

***

### pointOsmTags?

> `optional` **pointOsmTags?**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/topology/types.ts:256

Point-level OSM tags if an ingested `InfrastructurePointMetadata` feature matched this node (Stage D).

#### Inherited from

[`BaseInfrastructureNode`](BaseInfrastructureNode.md).[`pointOsmTags`](BaseInfrastructureNode.md#pointosmtags)

***

### primaryRole

> **primaryRole**: [`RailwayNodeRole`](../type-aliases/RailwayNodeRole.md)

Defined in: world/infrastructure/topology/types.ts:242

Primary role selected by deterministic precedence rules for summary inspection.

#### Inherited from

[`BaseInfrastructureNode`](BaseInfrastructureNode.md).[`primaryRole`](BaseInfrastructureNode.md#primaryrole)

***

### rawOsmNodeId?

> `optional` **rawOsmNodeId?**: `string`

Defined in: world/infrastructure/topology/types.ts:221

Explicit raw unprefixed OSM node ID if grounded in OSM data (e.g. "5001"); `undefined` for coordinate fallback or boundary clip.

#### Inherited from

[`BaseInfrastructureNode`](BaseInfrastructureNode.md).[`rawOsmNodeId`](BaseInfrastructureNode.md#rawosmnodeid)

***

### roles

> **roles**: readonly [`RailwayNodeRole`](../type-aliases/RailwayNodeRole.md)[]

Defined in: world/infrastructure/topology/types.ts:247

Non-exclusive, canonically sorted list of all topological roles held by this node
(e.g. `['junction', 'level_crossing']` or `['attribute_break', 'grade_transition']`).

#### Inherited from

[`BaseInfrastructureNode`](BaseInfrastructureNode.md).[`roles`](BaseInfrastructureNode.md#roles)

***

### turnoutTopology?

> `optional` **turnoutTopology?**: [`TurnoutTopologySpec`](TurnoutTopologySpec.md)

Defined in: world/infrastructure/topology/types.ts:282

***

### x

> **x**: `number`

Defined in: world/infrastructure/topology/types.ts:225

Local East-West world coordinate in meters (+X East).

#### Inherited from

[`BaseInfrastructureNode`](BaseInfrastructureNode.md).[`x`](BaseInfrastructureNode.md#x)

***

### z

> **z**: `number`

Defined in: world/infrastructure/topology/types.ts:227

Local North-South world coordinate in meters (+Z South).

#### Inherited from

[`BaseInfrastructureNode`](BaseInfrastructureNode.md).[`z`](BaseInfrastructureNode.md#z)
