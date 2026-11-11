[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / GradeTransitionRenderDescriptor

# Interface: GradeTransitionRenderDescriptor

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:695

Render-ready descriptor for a confirmed same-domain grade transition (`bridge_approach` or `tunnel_portal`, Stage E4 handoff).

## Properties

### atGradeEdgeId

> **atGradeEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:702

***

### atGradeEndpoint

> **atGradeEndpoint**: `"end"` \| `"start"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:703

***

### atGradeNodeId

> **atGradeNodeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:701

***

### atGradeOutwardTangent

> **atGradeOutwardTangent**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:710

Unit tangent exiting the at-grade edge toward the portal (`-inwardTangent(atGrade)`).

***

### atGradeSourceFeatureIds

> **atGradeSourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:704

***

### atGradeToStructureDirection

> **atGradeToStructureDirection**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:714

Unit vector pointing in the continuous traversal direction from the at-grade way into the bridge/tunnel structure.

***

### confidence

> **confidence**: `"explicit_osm_node"` \| `"coordinate_fallback_confirmed"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:717

***

### continuousTraversalDot

> **continuousTraversalDot**: `number`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:716

Cosine of continuous traversal alignment (`dot(atGradeOutwardTangent, gradeSeparatedInwardTangent)`).

***

### gradeSeparatedEdgeId

> **gradeSeparatedEdgeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:706

***

### gradeSeparatedEndpoint

> **gradeSeparatedEndpoint**: `"end"` \| `"start"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:707

***

### gradeSeparatedInwardTangent

> **gradeSeparatedInwardTangent**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:712

Unit tangent entering the bridge/tunnel edge from the portal (`+inwardTangent(gradeSeparated)`).

***

### gradeSeparatedNodeId

> **gradeSeparatedNodeId**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:705

***

### gradeSeparatedSourceFeatureIds

> **gradeSeparatedSourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:708

***

### id

> **id**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:696

***

### network

> **network**: [`InfrastructureNetworkKind`](../../../topology/types/type-aliases/InfrastructureNetworkKind.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:697

***

### position

> **position**: readonly \[`number`, `number`\]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:699

***

### rawOsmNodeId?

> `optional` **rawOsmNodeId?**: `string`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:700

***

### transitionType

> **transitionType**: `"bridge_approach"` \| `"tunnel_portal"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:698
