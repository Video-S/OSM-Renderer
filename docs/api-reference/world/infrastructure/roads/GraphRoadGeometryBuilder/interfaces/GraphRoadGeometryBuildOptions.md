[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/roads/GraphRoadGeometryBuilder](../README.md) / GraphRoadGeometryBuildOptions

# Interface: GraphRoadGeometryBuildOptions

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:450

Input configuration for `buildGraphAtGradeRoadGeometries`.

## Properties

### descriptors

> **descriptors**: [`InfrastructureRenderDescriptorBundle`](../../../rendering/InfrastructureRenderAdapter/interfaces/InfrastructureRenderDescriptorBundle.md)

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:452

Immutable graph-backed render descriptor bundle produced by `InfrastructureRenderAdapter`.

***

### diagnostics?

> `optional` **diagnostics?**: [`MapFeatureDiagnostics`](../../../../../types/MapFeature/interfaces/MapFeatureDiagnostics.md)

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:460

Optional pipeline diagnostics object to record clipping failures or rejected geometry fallbacks.

***

### gradeTransitionCoords?

> `optional` **gradeTransitionCoords?**: readonly (readonly \[`number`, `number`\])[]

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:456

Optional world coordinates `[x, z]` of legacy Stage 6D bridge/tunnel endpoints (retained for interface compatibility).

***

### resourceManager

> **resourceManager**: [`SceneResourceManager`](../../../../SceneResourceManager/classes/SceneResourceManager.md)

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:458

Scene resource manager for deterministic GPU buffer registration and disposal.

***

### roadWidthMultiplier

> **roadWidthMultiplier**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:454

User/scene multiplier applied to canonical road widths.
