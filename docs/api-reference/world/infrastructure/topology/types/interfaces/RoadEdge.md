[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / RoadEdge

# Interface: RoadEdge

Defined in: world/infrastructure/topology/types.ts:331

## Extends

- [`BaseInfrastructureEdge`](BaseInfrastructureEdge.md)

## Properties

### clippedAtEnd

> **clippedAtEnd**: `boolean`

Defined in: world/infrastructure/topology/types.ts:318

True if `points[points.length - 1]` was synthesized by Liang-Barsky bounding-box clipping.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`clippedAtEnd`](BaseInfrastructureEdge.md#clippedatend)

***

### clippedAtStart

> **clippedAtStart**: `boolean`

Defined in: world/infrastructure/topology/types.ts:316

True if `points[0]` was synthesized by region bounding-box clipping.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`clippedAtStart`](BaseInfrastructureEdge.md#clippedatstart)

***

### endInwardTangent

> **endInwardTangent**: \[`number`, `number`\]

Defined in: world/infrastructure/topology/types.ts:326

Unit tangent [dx, dz] at `points[N-1]` pointing INWARD along the edge (`toNodeId -> points[N-2]`).

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`endInwardTangent`](BaseInfrastructureEdge.md#endinwardtangent)

***

### fromNodeId

> **fromNodeId**: `string`

Defined in: world/infrastructure/topology/types.ts:291

Start topological node ID (`points[0]`).

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`fromNodeId`](BaseInfrastructureEdge.md#fromnodeid)

***

### id

> **id**: `string`

Defined in: world/infrastructure/topology/types.ts:287

Deterministic canonical edge ID.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`id`](BaseInfrastructureEdge.md#id)

***

### isBridge

> **isBridge**: `boolean`

Defined in: world/infrastructure/topology/types.ts:310

True if edge is a bridge structure.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`isBridge`](BaseInfrastructureEdge.md#isbridge)

***

### isClosedLoop

> **isClosedLoop**: `boolean`

Defined in: world/infrastructure/topology/types.ts:314

True if `fromNodeId === toNodeId`.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`isClosedLoop`](BaseInfrastructureEdge.md#isclosedloop)

***

### isCulvert

> **isCulvert**: `boolean`

Defined in: world/infrastructure/topology/types.ts:343

***

### isTunnel

> **isTunnel**: `boolean`

Defined in: world/infrastructure/topology/types.ts:312

True if edge is a tunnel structure.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`isTunnel`](BaseInfrastructureEdge.md#istunnel)

***

### lanes?

> `optional` **lanes?**: `number`

Defined in: world/infrastructure/topology/types.ts:336

***

### layer

> **layer**: `number`

Defined in: world/infrastructure/topology/types.ts:308

Effective OSM vertical layer.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`layer`](BaseInfrastructureEdge.md#layer)

***

### lengthMeters

> **lengthMeters**: `number`

Defined in: world/infrastructure/topology/types.ts:306

Cumulative Euclidean arc-length in meters.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`lengthMeters`](BaseInfrastructureEdge.md#lengthmeters)

***

### name?

> `optional` **name?**: `string`

Defined in: world/infrastructure/topology/types.ts:341

***

### network

> **network**: `"road"`

Defined in: world/infrastructure/topology/types.ts:332

Network domain ('road' | 'railway').

#### Overrides

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`network`](BaseInfrastructureEdge.md#network)

***

### normalizedOneway

> **normalizedOneway**: [`NormalizedOneWay`](../type-aliases/NormalizedOneWay.md)

Defined in: world/infrastructure/topology/types.ts:338

Normalized directionality relative to `fromNodeId -> toNodeId`.

***

### parallelIndex

> **parallelIndex**: `number`

Defined in: world/infrastructure/topology/types.ts:298

Zero-based parallel multi-edge index among all edges sharing the unordered node pair `{fromNodeId, toNodeId}`
(`0` when unique, `0..k-1` when multiple distinct parallel edges connect the same two nodes).

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`parallelIndex`](BaseInfrastructureEdge.md#parallelindex)

***

### points

> **points**: readonly \[`number`, `number`\][]

Defined in: world/infrastructure/topology/types.ts:300

Full 2D metric polyline geometry [x, z][] preserving all intermediate curve/shape vertices.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`points`](BaseInfrastructureEdge.md#points)

***

### provenance

> **provenance**: [`EdgeProvenance`](EdgeProvenance.md)

Defined in: world/infrastructure/topology/types.ts:328

Complete per-segment OSM provenance and arc-length mapping.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`provenance`](BaseInfrastructureEdge.md#provenance)

***

### rawOnewayTag?

> `optional` **rawOnewayTag?**: `string`

Defined in: world/infrastructure/topology/types.ts:340

Exact raw `oneway` tag value from OSM if present (e.g. "yes", "-1", "reversible"), or `undefined`.

***

### roadClass

> **roadClass**: [`RoadClass`](../../../../../types/MapFeature/type-aliases/RoadClass.md)

Defined in: world/infrastructure/topology/types.ts:333

***

### startInwardTangent

> **startInwardTangent**: \[`number`, `number`\]

Defined in: world/infrastructure/topology/types.ts:322

Unit tangent [dx, dz] at `points[0]` pointing INWARD along the edge (`fromNodeId -> points[1]`).

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`startInwardTangent`](BaseInfrastructureEdge.md#startinwardtangent)

***

### surface?

> `optional` **surface?**: `string`

Defined in: world/infrastructure/topology/types.ts:342

***

### tier

> **tier**: [`RoadTier`](../type-aliases/RoadTier.md)

Defined in: world/infrastructure/topology/types.ts:334

***

### toNodeId

> **toNodeId**: `string`

Defined in: world/infrastructure/topology/types.ts:293

End topological node ID (`points[points.length - 1]`).

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`toNodeId`](BaseInfrastructureEdge.md#tonodeid)

***

### vertexRawOsmNodeIds

> **vertexRawOsmNodeIds**: readonly `string`[]

Defined in: world/infrastructure/topology/types.ts:304

Raw unprefixed OSM node IDs aligned 1:1 with `points` (`undefined` where a vertex had no explicit OSM node ID).

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`vertexRawOsmNodeIds`](BaseInfrastructureEdge.md#vertexrawosmnodeids)

***

### width

> **width**: `number`

Defined in: world/infrastructure/topology/types.ts:335
