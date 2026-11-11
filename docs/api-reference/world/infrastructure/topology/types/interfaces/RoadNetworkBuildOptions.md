[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / RoadNetworkBuildOptions

# Interface: RoadNetworkBuildOptions

Defined in: world/infrastructure/topology/types.ts:399

Optional configuration for `buildRoadNetwork` (Stage D cross-modal node protection & highway_crossing ingestion).

## Properties

### additionalNodeRolesByOsmId?

> `optional` **additionalNodeRolesByOsmId?**: `ReadonlyMap`\<`string`, readonly [`RoadNodeRole`](../type-aliases/RoadNodeRole.md)[]\>

Defined in: world/infrastructure/topology/types.ts:407

Additional topological roles to attach to retained road nodes keyed by `rawOsmNodeId`.

***

### infrastructurePoints?

> `optional` **infrastructurePoints?**: readonly [`InfrastructurePointMetadata`](InfrastructurePointMetadata.md)[]

Defined in: world/infrastructure/topology/types.ts:401

Point-level infrastructure metadata (`highway=crossing`, etc.) to match against road nodes.

***

### protectedPartVertices?

> `optional` **protectedPartVertices?**: `ReadonlyMap`\<`string`, `ReadonlySet`\<`number`\>\>

Defined in: world/infrastructure/topology/types.ts:405

Specific `(partId, vertexIndex)` pairs that must be split at interior vertices and never contracted at degree 2.

***

### protectedRawOsmNodeIds?

> `optional` **protectedRawOsmNodeIds?**: `ReadonlySet`\<`string`\>

Defined in: world/infrastructure/topology/types.ts:403

Explicit raw OSM node IDs (`rawOsmNodeId`) that must be preserved as topological nodes and never contracted at degree 2.
