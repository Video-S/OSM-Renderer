[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / BaseInfrastructureNode

# Interface: BaseInfrastructureNode\<TRole\>

Defined in: world/infrastructure/topology/types.ts:215

## Extended by

- [`RoadNode`](RoadNode.md)
- [`RailwayNode`](RailwayNode.md)

## Type Parameters

### TRole

`TRole` *extends* `string`

## Properties

### degree

> **degree**: `number`

Defined in: world/infrastructure/topology/types.ts:240

Topological degree: exact count of attached edge endpoints (`incidentHalfEdges.length`).
An ordinary incident edge contributes +1; a closed self-loop edge attaches both endpoints and contributes +2.

***

### id

> **id**: `string`

Defined in: world/infrastructure/topology/types.ts:217

Deterministic domain-and-scope canonical node ID (e.g. "road_node:0|0|0:osm_5001" or "road_node:0|0|0:fb_1").

***

### incidentEdgeIds

> **incidentEdgeIds**: readonly `string`[]

Defined in: world/infrastructure/topology/types.ts:252

Deduplicated, canonically sorted list of unique incident edge IDs.
A closed self-loop edge appears once in `incidentEdgeIds` and twice in `incidentHalfEdges`.

***

### incidentHalfEdges

> **incidentHalfEdges**: readonly [`IncidentHalfEdge`](IncidentHalfEdge.md)[]

Defined in: world/infrastructure/topology/types.ts:254

All attached half-edges (`incidentHalfEdges.length === degree`).

***

### isBoundaryClipped

> **isBoundaryClipped**: `boolean`

Defined in: world/infrastructure/topology/types.ts:235

True if synthesized by region bounding-box clipping (`nodeIdOrigin === 'boundary_clip'`).

***

### isBridge

> **isBridge**: `boolean`

Defined in: world/infrastructure/topology/types.ts:231

True if node belongs to a bridge structure scope.

***

### isTunnel

> **isTunnel**: `boolean`

Defined in: world/infrastructure/topology/types.ts:233

True if node belongs to a tunnel/underpass structure scope.

***

### layer

> **layer**: `number`

Defined in: world/infrastructure/topology/types.ts:229

Effective vertical OSM layer tag (default 0).

***

### network

> **network**: [`InfrastructureNetworkKind`](../type-aliases/InfrastructureNetworkKind.md)

Defined in: world/infrastructure/topology/types.ts:219

Network domain ('road' | 'railway').

***

### nodeIdOrigin

> **nodeIdOrigin**: [`NodeIdOrigin`](../type-aliases/NodeIdOrigin.md)

Defined in: world/infrastructure/topology/types.ts:223

Explicit provenance of how this node's identity was established.

***

### pointOsmTags?

> `optional` **pointOsmTags?**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/topology/types.ts:256

Point-level OSM tags if an ingested `InfrastructurePointMetadata` feature matched this node (Stage D).

***

### primaryRole

> **primaryRole**: `TRole`

Defined in: world/infrastructure/topology/types.ts:242

Primary role selected by deterministic precedence rules for summary inspection.

***

### rawOsmNodeId?

> `optional` **rawOsmNodeId?**: `string`

Defined in: world/infrastructure/topology/types.ts:221

Explicit raw unprefixed OSM node ID if grounded in OSM data (e.g. "5001"); `undefined` for coordinate fallback or boundary clip.

***

### roles

> **roles**: readonly `TRole`[]

Defined in: world/infrastructure/topology/types.ts:247

Non-exclusive, canonically sorted list of all topological roles held by this node
(e.g. `['junction', 'level_crossing']` or `['attribute_break', 'grade_transition']`).

***

### x

> **x**: `number`

Defined in: world/infrastructure/topology/types.ts:225

Local East-West world coordinate in meters (+X East).

***

### z

> **z**: `number`

Defined in: world/infrastructure/topology/types.ts:227

Local North-South world coordinate in meters (+Z South).
