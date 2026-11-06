[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / GradeTransitionRenderDescriptor

# Interface: GradeTransitionRenderDescriptor

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:484

Render-ready descriptor for a confirmed same-domain grade transition (`bridge_approach` or `tunnel_portal`, Stage E4 handoff).

## Properties

### atGradeEdgeId

> **atGradeEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:491

***

### atGradeEndpoint

> **atGradeEndpoint**: `"end"` \| `"start"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:492

***

### atGradeNodeId

> **atGradeNodeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:490

***

### atGradeOutwardTangent

> **atGradeOutwardTangent**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:499

Unit tangent exiting the at-grade edge toward the portal (`-inwardTangent(atGrade)`).

***

### atGradeSourceFeatureIds

> **atGradeSourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:493

***

### atGradeToStructureDirection

> **atGradeToStructureDirection**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:503

Unit vector pointing in the continuous traversal direction from the at-grade way into the bridge/tunnel structure.

***

### confidence

> **confidence**: `"explicit_osm_node"` \| `"coordinate_fallback_confirmed"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:506

***

### continuousTraversalDot

> **continuousTraversalDot**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:505

Cosine of continuous traversal alignment (`dot(atGradeOutwardTangent, gradeSeparatedInwardTangent)`).

***

### gradeSeparatedEdgeId

> **gradeSeparatedEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:495

***

### gradeSeparatedEndpoint

> **gradeSeparatedEndpoint**: `"end"` \| `"start"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:496

***

### gradeSeparatedInwardTangent

> **gradeSeparatedInwardTangent**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:501

Unit tangent entering the bridge/tunnel edge from the portal (`+inwardTangent(gradeSeparated)`).

***

### gradeSeparatedNodeId

> **gradeSeparatedNodeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:494

***

### gradeSeparatedSourceFeatureIds

> **gradeSeparatedSourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:497

***

### id

> **id**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:485

***

### network

> **network**: [`InfrastructureNetworkKind`](../../../topology/types/type-aliases/InfrastructureNetworkKind.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:486

***

### position

> **position**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:488

***

### rawOsmNodeId?

> `optional` **rawOsmNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:489

***

### transitionType

> **transitionType**: `"bridge_approach"` \| `"tunnel_portal"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:487
