[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / UnresolvedGradeTransitionCandidate

# Interface: UnresolvedGradeTransitionCandidate

Defined in: world/infrastructure/topology/types.ts:448

## Properties

### candidateAtGradeEdgeIds

> **candidateAtGradeEdgeIds**: readonly `string`[]

Defined in: world/infrastructure/topology/types.ts:453

***

### continuousTraversalDot?

> `optional` **continuousTraversalDot?**: `number`

Defined in: world/infrastructure/topology/types.ts:455

***

### distanceMeters

> **distanceMeters**: `number`

Defined in: world/infrastructure/topology/types.ts:454

***

### gradeSeparatedEdgeId

> **gradeSeparatedEdgeId**: `string`

Defined in: world/infrastructure/topology/types.ts:451

***

### gradeSeparatedEndpoint

> **gradeSeparatedEndpoint**: `"end"` \| `"start"`

Defined in: world/infrastructure/topology/types.ts:452

***

### network

> **network**: [`InfrastructureNetworkKind`](../type-aliases/InfrastructureNetworkKind.md)

Defined in: world/infrastructure/topology/types.ts:449

***

### position

> **position**: \[`number`, `number`\]

Defined in: world/infrastructure/topology/types.ts:450

***

### reason

> **reason**: `"ambiguous_multiple_candidates"` \| `"misaligned_tangent"` \| `"non_terminal_endpoint"` \| `"incompatible_class_or_tier"` \| `"distinct_explicit_osm_nodes"` \| `"exceeds_snap_tolerance"`

Defined in: world/infrastructure/topology/types.ts:456
