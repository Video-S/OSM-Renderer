[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / RailwayNetworkBuildOptions

# Interface: RailwayNetworkBuildOptions

Defined in: world/infrastructure/topology/types.ts:412

Optional configuration for `buildRailwayNetwork` (Stage C/D point ingestion & cross-modal node protection).

## Properties

### additionalNodeRolesByOsmId?

> `optional` **additionalNodeRolesByOsmId?**: `ReadonlyMap`\<`string`, readonly [`RailwayNodeRole`](../type-aliases/RailwayNodeRole.md)[]\>

Defined in: world/infrastructure/topology/types.ts:420

Additional topological roles to attach to retained railway nodes keyed by `rawOsmNodeId`.

***

### infrastructurePoints?

> `optional` **infrastructurePoints?**: readonly [`InfrastructurePointMetadata`](InfrastructurePointMetadata.md)[]

Defined in: world/infrastructure/topology/types.ts:414

Point-level infrastructure metadata (`railway=switch`, `railway=railway_crossing`, etc.).

***

### protectedPartVertices?

> `optional` **protectedPartVertices?**: `ReadonlyMap`\<`string`, `ReadonlySet`\<`number`\>\>

Defined in: world/infrastructure/topology/types.ts:418

Specific `(partId, vertexIndex)` pairs that must be split at interior vertices and never contracted at degree 2.

***

### protectedRawOsmNodeIds?

> `optional` **protectedRawOsmNodeIds?**: `ReadonlySet`\<`string`\>

Defined in: world/infrastructure/topology/types.ts:416

Explicit raw OSM node IDs (`rawOsmNodeId`) that must be preserved as topological nodes and never contracted at degree 2.
