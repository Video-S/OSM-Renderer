[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / UnresolvedGradeTransitionCandidate

# Interface: UnresolvedGradeTransitionCandidate

Defined in: world/infrastructure/topology/types.ts:410

## Properties

### candidateAtGradeEdgeIds

> **candidateAtGradeEdgeIds**: readonly `string`[]

Defined in: world/infrastructure/topology/types.ts:415

***

### continuousTraversalDot?

> `optional` **continuousTraversalDot?**: `number`

Defined in: world/infrastructure/topology/types.ts:417

***

### distanceMeters

> **distanceMeters**: `number`

Defined in: world/infrastructure/topology/types.ts:416

***

### gradeSeparatedEdgeId

> **gradeSeparatedEdgeId**: `string`

Defined in: world/infrastructure/topology/types.ts:413

***

### gradeSeparatedEndpoint

> **gradeSeparatedEndpoint**: `"end"` \| `"start"`

Defined in: world/infrastructure/topology/types.ts:414

***

### network

> **network**: [`InfrastructureNetworkKind`](../type-aliases/InfrastructureNetworkKind.md)

Defined in: world/infrastructure/topology/types.ts:411

***

### position

> **position**: \[`number`, `number`\]

Defined in: world/infrastructure/topology/types.ts:412

***

### reason

> **reason**: `"ambiguous_multiple_candidates"` \| `"misaligned_tangent"` \| `"non_terminal_endpoint"` \| `"incompatible_class_or_tier"` \| `"distinct_explicit_osm_nodes"` \| `"exceeds_snap_tolerance"`

Defined in: world/infrastructure/topology/types.ts:418
