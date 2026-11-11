[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / BaseInfrastructureNode

# Interface: BaseInfrastructureNode\<TRole\>

Defined in: world/infrastructure/topology/types.ts:220

## Extended by

- [`RoadNode`](RoadNode.md)
- [`RailwayNode`](RailwayNode.md)

## Type Parameters

### TRole

`TRole` *extends* `string`

## Properties

### degree

> **degree**: `number`

Defined in: world/infrastructure/topology/types.ts:245

Topological degree: exact count of attached edge endpoints (`incidentHalfEdges.length`).
An ordinary incident edge contributes +1; a closed self-loop edge attaches both endpoints and contributes +2.

***

### id

> **id**: `string`

Defined in: world/infrastructure/topology/types.ts:222

Deterministic domain-and-scope canonical node ID (e.g. "road_node:0|0|0:osm_5001" or "road_node:0|0|0:fb_1").

***

### incidentEdgeIds

> **incidentEdgeIds**: readonly `string`[]

Defined in: world/infrastructure/topology/types.ts:257

Deduplicated, canonically sorted list of unique incident edge IDs.
A closed self-loop edge appears once in `incidentEdgeIds` and twice in `incidentHalfEdges`.

***

### incidentHalfEdges

> **incidentHalfEdges**: readonly [`IncidentHalfEdge`](IncidentHalfEdge.md)[]

Defined in: world/infrastructure/topology/types.ts:259

All attached half-edges (`incidentHalfEdges.length === degree`).

***

### isBoundaryClipped

> **isBoundaryClipped**: `boolean`

Defined in: world/infrastructure/topology/types.ts:240

True if synthesized by region bounding-box clipping (`nodeIdOrigin === 'boundary_clip'`).

***

### isBridge

> **isBridge**: `boolean`

Defined in: world/infrastructure/topology/types.ts:236

True if node belongs to a bridge structure scope.

***

### isTunnel

> **isTunnel**: `boolean`

Defined in: world/infrastructure/topology/types.ts:238

True if node belongs to a tunnel/underpass structure scope.

***

### layer

> **layer**: `number`

Defined in: world/infrastructure/topology/types.ts:234

Effective vertical OSM layer tag (default 0).

***

### network

> **network**: [`InfrastructureNetworkKind`](../type-aliases/InfrastructureNetworkKind.md)

Defined in: world/infrastructure/topology/types.ts:224

Network domain ('road' | 'railway').

***

### nodeIdOrigin

> **nodeIdOrigin**: [`NodeIdOrigin`](../type-aliases/NodeIdOrigin.md)

Defined in: world/infrastructure/topology/types.ts:228

Explicit provenance of how this node's identity was established.

***

### pointOsmTags?

> `optional` **pointOsmTags?**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/topology/types.ts:261

Point-level OSM tags if an ingested `InfrastructurePointMetadata` feature matched this node (Stage D).

***

### primaryRole

> **primaryRole**: `TRole`

Defined in: world/infrastructure/topology/types.ts:247

Primary role selected by deterministic precedence rules for summary inspection.

***

### rawOsmNodeId?

> `optional` **rawOsmNodeId?**: `string`

Defined in: world/infrastructure/topology/types.ts:226

Explicit raw unprefixed OSM node ID if grounded in OSM data (e.g. "5001"); `undefined` for coordinate fallback or boundary clip.

***

### roles

> **roles**: readonly `TRole`[]

Defined in: world/infrastructure/topology/types.ts:252

Non-exclusive, canonically sorted list of all topological roles held by this node
(e.g. `['junction', 'level_crossing']` or `['attribute_break', 'grade_transition']`).

***

### x

> **x**: `number`

Defined in: world/infrastructure/topology/types.ts:230

Local East-West world coordinate in meters (+X East).

***

### z

> **z**: `number`

Defined in: world/infrastructure/topology/types.ts:232

Local North-South world coordinate in meters (+Z South).
