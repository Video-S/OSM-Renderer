[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / GradeTransitionRenderDescriptor

# Interface: GradeTransitionRenderDescriptor

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:533

Render-ready descriptor for a confirmed same-domain grade transition (`bridge_approach` or `tunnel_portal`, Stage E4 handoff).

## Properties

### atGradeEdgeId

> **atGradeEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:540

***

### atGradeEndpoint

> **atGradeEndpoint**: `"end"` \| `"start"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:541

***

### atGradeNodeId

> **atGradeNodeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:539

***

### atGradeOutwardTangent

> **atGradeOutwardTangent**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:548

Unit tangent exiting the at-grade edge toward the portal (`-inwardTangent(atGrade)`).

***

### atGradeSourceFeatureIds

> **atGradeSourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:542

***

### atGradeToStructureDirection

> **atGradeToStructureDirection**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:552

Unit vector pointing in the continuous traversal direction from the at-grade way into the bridge/tunnel structure.

***

### confidence

> **confidence**: `"explicit_osm_node"` \| `"coordinate_fallback_confirmed"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:555

***

### continuousTraversalDot

> **continuousTraversalDot**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:554

Cosine of continuous traversal alignment (`dot(atGradeOutwardTangent, gradeSeparatedInwardTangent)`).

***

### gradeSeparatedEdgeId

> **gradeSeparatedEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:544

***

### gradeSeparatedEndpoint

> **gradeSeparatedEndpoint**: `"end"` \| `"start"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:545

***

### gradeSeparatedInwardTangent

> **gradeSeparatedInwardTangent**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:550

Unit tangent entering the bridge/tunnel edge from the portal (`+inwardTangent(gradeSeparated)`).

***

### gradeSeparatedNodeId

> **gradeSeparatedNodeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:543

***

### gradeSeparatedSourceFeatureIds

> **gradeSeparatedSourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:546

***

### id

> **id**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:534

***

### network

> **network**: [`InfrastructureNetworkKind`](../../../topology/types/type-aliases/InfrastructureNetworkKind.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:535

***

### position

> **position**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:537

***

### rawOsmNodeId?

> `optional` **rawOsmNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:538

***

### transitionType

> **transitionType**: `"bridge_approach"` \| `"tunnel_portal"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:536
