[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/roads/GraphRoadGeometryBuilder](../README.md) / GraphRoadGeometryBuildOptions

# Interface: GraphRoadGeometryBuildOptions

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:112

Input configuration for `buildGraphAtGradeRoadGeometries`.

## Properties

### descriptors

> **descriptors**: [`InfrastructureRenderDescriptorBundle`](../../../rendering/InfrastructureRenderAdapter/interfaces/InfrastructureRenderDescriptorBundle.md)

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:114

Immutable graph-backed render descriptor bundle produced by `InfrastructureRenderAdapter`.

***

### diagnostics?

> `optional` **diagnostics?**: [`MapFeatureDiagnostics`](../../../../../types/MapFeature/interfaces/MapFeatureDiagnostics.md)

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:122

Optional pipeline diagnostics object to record clipping failures or fully subtracted features.

***

### gradeTransitionCoords?

> `optional` **gradeTransitionCoords?**: readonly (readonly \[`number`, `number`\])[]

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:118

Optional world coordinates `[x, z]` of legacy Stage 6D bridge/tunnel endpoints for cap suppression.

***

### resourceManager

> **resourceManager**: [`SceneResourceManager`](../../../../SceneResourceManager/classes/SceneResourceManager.md)

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:120

Scene resource manager for deterministic GPU buffer registration and disposal.

***

### roadWidthMultiplier

> **roadWidthMultiplier**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:116

User/scene multiplier applied to canonical road widths.
