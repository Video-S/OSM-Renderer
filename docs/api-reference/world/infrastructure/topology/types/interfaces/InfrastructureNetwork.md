[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / InfrastructureNetwork

# Interface: InfrastructureNetwork\<TNode, TEdge\>

Defined in: world/infrastructure/topology/types.ts:356

## Type Parameters

### TNode

`TNode`

### TEdge

`TEdge`

## Properties

### edges

> **edges**: `ReadonlyMap`\<`string`, `TEdge`\>

Defined in: world/infrastructure/topology/types.ts:360

Map from canonical edge ID to edge record.

***

### featureToEdgeIds

> **featureToEdgeIds**: `ReadonlyMap`\<`string`, readonly `string`[]\>

Defined in: world/infrastructure/topology/types.ts:362

Map from original `sourceFeatureId` (or unchained part ID) to the simplified edge ID(s) containing it.

***

### nodes

> **nodes**: `ReadonlyMap`\<`string`, `TNode`\>

Defined in: world/infrastructure/topology/types.ts:358

Map from canonical node ID to node record.
