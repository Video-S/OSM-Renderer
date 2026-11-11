[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / GradeTransitionRenderDescriptor

# Interface: GradeTransitionRenderDescriptor

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:728

Render-ready descriptor for a confirmed same-domain grade transition (`bridge_approach` or `tunnel_portal`, Stage E4 handoff).

## Properties

### atGradeEdgeId

> **atGradeEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:735

***

### atGradeEndpoint

> **atGradeEndpoint**: `"end"` \| `"start"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:736

***

### atGradeNodeId

> **atGradeNodeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:734

***

### atGradeOutwardTangent

> **atGradeOutwardTangent**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:743

Unit tangent exiting the at-grade edge toward the portal (`-inwardTangent(atGrade)`).

***

### atGradeSourceFeatureIds

> **atGradeSourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:737

***

### atGradeToStructureDirection

> **atGradeToStructureDirection**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:747

Unit vector pointing in the continuous traversal direction from the at-grade way into the bridge/tunnel structure.

***

### confidence

> **confidence**: `"explicit_osm_node"` \| `"coordinate_fallback_confirmed"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:750

***

### continuousTraversalDot

> **continuousTraversalDot**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:749

Cosine of continuous traversal alignment (`dot(atGradeOutwardTangent, gradeSeparatedInwardTangent)`).

***

### gradeSeparatedEdgeId

> **gradeSeparatedEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:739

***

### gradeSeparatedEndpoint

> **gradeSeparatedEndpoint**: `"end"` \| `"start"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:740

***

### gradeSeparatedInwardTangent

> **gradeSeparatedInwardTangent**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:745

Unit tangent entering the bridge/tunnel edge from the portal (`+inwardTangent(gradeSeparated)`).

***

### gradeSeparatedNodeId

> **gradeSeparatedNodeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:738

***

### gradeSeparatedSourceFeatureIds

> **gradeSeparatedSourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:741

***

### id

> **id**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:729

***

### network

> **network**: [`InfrastructureNetworkKind`](../../../topology/types/type-aliases/InfrastructureNetworkKind.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:730

***

### position

> **position**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:732

***

### rawOsmNodeId?

> `optional` **rawOsmNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:733

***

### transitionType

> **transitionType**: `"bridge_approach"` \| `"tunnel_portal"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:731
