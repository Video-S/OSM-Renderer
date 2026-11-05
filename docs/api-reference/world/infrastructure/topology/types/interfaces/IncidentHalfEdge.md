[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / IncidentHalfEdge

# Interface: IncidentHalfEdge

Defined in: world/infrastructure/topology/types.ts:163

Represents a single attached edge endpoint (half-edge) at a node.
For a closed self-loop edge (`fromNodeId === toNodeId`), two IncidentHalfEdge entries
exist at the anchor node (one with `endpoint: 'start'`, one with `endpoint: 'end'`),
while `incidentEdgeIds` contains the unique edge ID once.

## Properties

### edgeId

> **edgeId**: `string`

Defined in: world/infrastructure/topology/types.ts:164

***

### endpoint

> **endpoint**: `"end"` \| `"start"`

Defined in: world/infrastructure/topology/types.ts:165

***

### inwardTangent

> **inwardTangent**: \[`number`, `number`\]

Defined in: world/infrastructure/topology/types.ts:167

Unit tangent [dx, dz] pointing from the node into the interior of the edge along this half-edge.
