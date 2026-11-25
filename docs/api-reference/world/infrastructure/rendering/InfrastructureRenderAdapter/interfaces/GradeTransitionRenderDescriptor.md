[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / GradeTransitionRenderDescriptor

# Interface: GradeTransitionRenderDescriptor

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:632

Render-ready descriptor for a confirmed same-domain grade transition (`bridge_approach` or `tunnel_portal`, Stage E4 handoff).

## Properties

### atGradeEdgeId

> **atGradeEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:639

***

### atGradeEndpoint

> **atGradeEndpoint**: `"start"` \| `"end"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:640

***

### atGradeNodeId

> **atGradeNodeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:638

***

### atGradeOutwardTangent

> **atGradeOutwardTangent**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:647

Unit tangent exiting the at-grade edge toward the portal (`-inwardTangent(atGrade)`).

***

### atGradeSourceFeatureIds

> **atGradeSourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:641

***

### atGradeToStructureDirection

> **atGradeToStructureDirection**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:651

Unit vector pointing in the continuous traversal direction from the at-grade way into the bridge/tunnel structure.

***

### confidence

> **confidence**: `"explicit_osm_node"` \| `"coordinate_fallback_confirmed"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:654

***

### continuousTraversalDot

> **continuousTraversalDot**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:653

Cosine of continuous traversal alignment (`dot(atGradeOutwardTangent, gradeSeparatedInwardTangent)`).

***

### gradeSeparatedEdgeId

> **gradeSeparatedEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:643

***

### gradeSeparatedEndpoint

> **gradeSeparatedEndpoint**: `"start"` \| `"end"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:644

***

### gradeSeparatedInwardTangent

> **gradeSeparatedInwardTangent**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:649

Unit tangent entering the bridge/tunnel edge from the portal (`+inwardTangent(gradeSeparated)`).

***

### gradeSeparatedNodeId

> **gradeSeparatedNodeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:642

***

### gradeSeparatedSourceFeatureIds

> **gradeSeparatedSourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:645

***

### id

> **id**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:633

***

### network

> **network**: [`InfrastructureNetworkKind`](../../../topology/types/type-aliases/InfrastructureNetworkKind.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:634

***

### position

> **position**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:636

***

### rawOsmNodeId?

> `optional` **rawOsmNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:637

***

### transitionType

> **transitionType**: `"bridge_approach"` \| `"tunnel_portal"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:635
