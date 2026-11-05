[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / UnresolvedGradeTransitionCandidate

# Interface: UnresolvedGradeTransitionCandidate

Defined in: world/infrastructure/topology/types.ts:439

## Properties

### candidateAtGradeEdgeIds

> **candidateAtGradeEdgeIds**: readonly `string`[]

Defined in: world/infrastructure/topology/types.ts:444

***

### continuousTraversalDot?

> `optional` **continuousTraversalDot?**: `number`

Defined in: world/infrastructure/topology/types.ts:446

***

### distanceMeters

> **distanceMeters**: `number`

Defined in: world/infrastructure/topology/types.ts:445

***

### gradeSeparatedEdgeId

> **gradeSeparatedEdgeId**: `string`

Defined in: world/infrastructure/topology/types.ts:442

***

### gradeSeparatedEndpoint

> **gradeSeparatedEndpoint**: `"end"` \| `"start"`

Defined in: world/infrastructure/topology/types.ts:443

***

### network

> **network**: [`InfrastructureNetworkKind`](../type-aliases/InfrastructureNetworkKind.md)

Defined in: world/infrastructure/topology/types.ts:440

***

### position

> **position**: \[`number`, `number`\]

Defined in: world/infrastructure/topology/types.ts:441

***

### reason

> **reason**: `"ambiguous_multiple_candidates"` \| `"misaligned_tangent"` \| `"non_terminal_endpoint"` \| `"incompatible_class_or_tier"` \| `"distinct_explicit_osm_nodes"` \| `"exceeds_snap_tolerance"`

Defined in: world/infrastructure/topology/types.ts:447
