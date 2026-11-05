[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / BaseInfrastructureEdge

# Interface: BaseInfrastructureEdge

Defined in: world/infrastructure/topology/types.ts:283

## Extended by

- [`RoadEdge`](RoadEdge.md)
- [`RailwayEdge`](RailwayEdge.md)

## Properties

### clippedAtEnd

> **clippedAtEnd**: `boolean`

Defined in: world/infrastructure/topology/types.ts:316

True if `points[points.length - 1]` was synthesized by Liang-Barsky bounding-box clipping.

***

### clippedAtStart

> **clippedAtStart**: `boolean`

Defined in: world/infrastructure/topology/types.ts:314

True if `points[0]` was synthesized by region bounding-box clipping.

***

### endInwardTangent

> **endInwardTangent**: \[`number`, `number`\]

Defined in: world/infrastructure/topology/types.ts:324

Unit tangent [dx, dz] at `points[N-1]` pointing INWARD along the edge (`toNodeId -> points[N-2]`).

***

### fromNodeId

> **fromNodeId**: `string`

Defined in: world/infrastructure/topology/types.ts:289

Start topological node ID (`points[0]`).

***

### id

> **id**: `string`

Defined in: world/infrastructure/topology/types.ts:285

Deterministic canonical edge ID.

***

### isBridge

> **isBridge**: `boolean`

Defined in: world/infrastructure/topology/types.ts:308

True if edge is a bridge structure.

***

### isClosedLoop

> **isClosedLoop**: `boolean`

Defined in: world/infrastructure/topology/types.ts:312

True if `fromNodeId === toNodeId`.

***

### isTunnel

> **isTunnel**: `boolean`

Defined in: world/infrastructure/topology/types.ts:310

True if edge is a tunnel structure.

***

### layer

> **layer**: `number`

Defined in: world/infrastructure/topology/types.ts:306

Effective OSM vertical layer.

***

### lengthMeters

> **lengthMeters**: `number`

Defined in: world/infrastructure/topology/types.ts:304

Cumulative Euclidean arc-length in meters.

***

### network

> **network**: [`InfrastructureNetworkKind`](../type-aliases/InfrastructureNetworkKind.md)

Defined in: world/infrastructure/topology/types.ts:287

Network domain ('road' | 'railway').

***

### parallelIndex

> **parallelIndex**: `number`

Defined in: world/infrastructure/topology/types.ts:296

Zero-based parallel multi-edge index among all edges sharing the unordered node pair `{fromNodeId, toNodeId}`
(`0` when unique, `0..k-1` when multiple distinct parallel edges connect the same two nodes).

***

### points

> **points**: readonly \[`number`, `number`\][]

Defined in: world/infrastructure/topology/types.ts:298

Full 2D metric polyline geometry [x, z][] preserving all intermediate curve/shape vertices.

***

### provenance

> **provenance**: [`EdgeProvenance`](EdgeProvenance.md)

Defined in: world/infrastructure/topology/types.ts:326

Complete per-segment OSM provenance and arc-length mapping.

***

### startInwardTangent

> **startInwardTangent**: \[`number`, `number`\]

Defined in: world/infrastructure/topology/types.ts:320

Unit tangent [dx, dz] at `points[0]` pointing INWARD along the edge (`fromNodeId -> points[1]`).

***

### toNodeId

> **toNodeId**: `string`

Defined in: world/infrastructure/topology/types.ts:291

End topological node ID (`points[points.length - 1]`).

***

### vertexRawOsmNodeIds

> **vertexRawOsmNodeIds**: readonly `string`[]

Defined in: world/infrastructure/topology/types.ts:302

Raw unprefixed OSM node IDs aligned 1:1 with `points` (`undefined` where a vertex had no explicit OSM node ID).
