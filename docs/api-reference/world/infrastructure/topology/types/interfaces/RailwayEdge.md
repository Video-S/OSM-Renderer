[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / RailwayEdge

# Interface: RailwayEdge

Defined in: world/infrastructure/topology/types.ts:344

## Extends

- [`BaseInfrastructureEdge`](BaseInfrastructureEdge.md)

## Properties

### clippedAtEnd

> **clippedAtEnd**: `boolean`

Defined in: world/infrastructure/topology/types.ts:316

True if `points[points.length - 1]` was synthesized by Liang-Barsky bounding-box clipping.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`clippedAtEnd`](BaseInfrastructureEdge.md#clippedatend)

***

### clippedAtStart

> **clippedAtStart**: `boolean`

Defined in: world/infrastructure/topology/types.ts:314

True if `points[0]` was synthesized by region bounding-box clipping.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`clippedAtStart`](BaseInfrastructureEdge.md#clippedatstart)

***

### electrified?

> `optional` **electrified?**: `string`

Defined in: world/infrastructure/topology/types.ts:349

***

### endInwardTangent

> **endInwardTangent**: \[`number`, `number`\]

Defined in: world/infrastructure/topology/types.ts:324

Unit tangent [dx, dz] at `points[N-1]` pointing INWARD along the edge (`toNodeId -> points[N-2]`).

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`endInwardTangent`](BaseInfrastructureEdge.md#endinwardtangent)

***

### fromNodeId

> **fromNodeId**: `string`

Defined in: world/infrastructure/topology/types.ts:289

Start topological node ID (`points[0]`).

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`fromNodeId`](BaseInfrastructureEdge.md#fromnodeid)

***

### gauge?

> `optional` **gauge?**: `string`

Defined in: world/infrastructure/topology/types.ts:348

***

### id

> **id**: `string`

Defined in: world/infrastructure/topology/types.ts:285

Deterministic canonical edge ID.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`id`](BaseInfrastructureEdge.md#id)

***

### isBridge

> **isBridge**: `boolean`

Defined in: world/infrastructure/topology/types.ts:308

True if edge is a bridge structure.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`isBridge`](BaseInfrastructureEdge.md#isbridge)

***

### isClosedLoop

> **isClosedLoop**: `boolean`

Defined in: world/infrastructure/topology/types.ts:312

True if `fromNodeId === toNodeId`.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`isClosedLoop`](BaseInfrastructureEdge.md#isclosedloop)

***

### isSecondaryBranch

> **isSecondaryBranch**: `boolean`

Defined in: world/infrastructure/topology/types.ts:352

***

### isTunnel

> **isTunnel**: `boolean`

Defined in: world/infrastructure/topology/types.ts:310

True if edge is a tunnel structure.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`isTunnel`](BaseInfrastructureEdge.md#istunnel)

***

### layer

> **layer**: `number`

Defined in: world/infrastructure/topology/types.ts:306

Effective OSM vertical layer.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`layer`](BaseInfrastructureEdge.md#layer)

***

### lengthMeters

> **lengthMeters**: `number`

Defined in: world/infrastructure/topology/types.ts:304

Cumulative Euclidean arc-length in meters.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`lengthMeters`](BaseInfrastructureEdge.md#lengthmeters)

***

### name?

> `optional` **name?**: `string`

Defined in: world/infrastructure/topology/types.ts:353

***

### network

> **network**: `"railway"`

Defined in: world/infrastructure/topology/types.ts:345

Network domain ('road' | 'railway').

#### Overrides

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`network`](BaseInfrastructureEdge.md#network)

***

### parallelIndex

> **parallelIndex**: `number`

Defined in: world/infrastructure/topology/types.ts:296

Zero-based parallel multi-edge index among all edges sharing the unordered node pair `{fromNodeId, toNodeId}`
(`0` when unique, `0..k-1` when multiple distinct parallel edges connect the same two nodes).

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`parallelIndex`](BaseInfrastructureEdge.md#parallelindex)

***

### points

> **points**: readonly \[`number`, `number`\][]

Defined in: world/infrastructure/topology/types.ts:298

Full 2D metric polyline geometry [x, z][] preserving all intermediate curve/shape vertices.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`points`](BaseInfrastructureEdge.md#points)

***

### provenance

> **provenance**: [`EdgeProvenance`](EdgeProvenance.md)

Defined in: world/infrastructure/topology/types.ts:326

Complete per-segment OSM provenance and arc-length mapping.

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`provenance`](BaseInfrastructureEdge.md#provenance)

***

### railwayType

> **railwayType**: [`RailwayType`](../../../../../types/MapFeature/type-aliases/RailwayType.md)

Defined in: world/infrastructure/topology/types.ts:346

***

### service?

> `optional` **service?**: `string`

Defined in: world/infrastructure/topology/types.ts:350

***

### startInwardTangent

> **startInwardTangent**: \[`number`, `number`\]

Defined in: world/infrastructure/topology/types.ts:320

Unit tangent [dx, dz] at `points[0]` pointing INWARD along the edge (`fromNodeId -> points[1]`).

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`startInwardTangent`](BaseInfrastructureEdge.md#startinwardtangent)

***

### toNodeId

> **toNodeId**: `string`

Defined in: world/infrastructure/topology/types.ts:291

End topological node ID (`points[points.length - 1]`).

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`toNodeId`](BaseInfrastructureEdge.md#tonodeid)

***

### usage?

> `optional` **usage?**: `string`

Defined in: world/infrastructure/topology/types.ts:351

***

### vertexRawOsmNodeIds

> **vertexRawOsmNodeIds**: readonly `string`[]

Defined in: world/infrastructure/topology/types.ts:302

Raw unprefixed OSM node IDs aligned 1:1 with `points` (`undefined` where a vertex had no explicit OSM node ID).

#### Inherited from

[`BaseInfrastructureEdge`](BaseInfrastructureEdge.md).[`vertexRawOsmNodeIds`](BaseInfrastructureEdge.md#vertexrawosmnodeids)

***

### width

> **width**: `number`

Defined in: world/infrastructure/topology/types.ts:347
