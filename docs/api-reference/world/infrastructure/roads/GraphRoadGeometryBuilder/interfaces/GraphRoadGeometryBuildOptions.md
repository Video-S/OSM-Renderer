[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/roads/GraphRoadGeometryBuilder](../README.md) / GraphRoadGeometryBuildOptions

# Interface: GraphRoadGeometryBuildOptions

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:643

## Properties

### descriptors

> **descriptors**: [`InfrastructureRenderDescriptorBundle`](../../../rendering/InfrastructureRenderAdapter/interfaces/InfrastructureRenderDescriptorBundle.md)

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:645

Immutable graph-backed render descriptor bundle produced by `InfrastructureRenderAdapter`.

***

### diagnostics?

> `optional` **diagnostics?**: [`MapFeatureDiagnostics`](../../../../../types/MapFeature/interfaces/MapFeatureDiagnostics.md)

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:655

Optional pipeline diagnostics object to record clipping failures or rejected geometry fallbacks.

***

### gradeTransitionCoords?

> `optional` **gradeTransitionCoords?**: readonly (readonly \[`number`, `number`\])[]

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:651

Optional world coordinates `[x, z]` of legacy Stage 6D bridge/tunnel endpoints (retained for interface compatibility).

***

### resourceManager

> **resourceManager**: [`SceneResourceManager`](../../../../SceneResourceManager/classes/SceneResourceManager.md)

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:653

Scene resource manager for deterministic GPU buffer registration and disposal.

***

### roadGeometryTrace?

> `optional` **roadGeometryTrace?**: [`RoadGeometryTraceTarget`](RoadGeometryTraceTarget.md)

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:665

Optional, read-only, source-filtered trace of actual road generation decisions.

***

### roadWidthMultiplier

> **roadWidthMultiplier**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:647

User/scene multiplier applied to canonical road widths.

***

### surfaceFirst?

> `optional` **surfaceFirst?**: `boolean`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:649

E2+ independent rounded-stroke footprint construction; false preserves E2 exactly.

***

### testOnlyRejectAfterTriangulation?

> `optional` **testOnlyRejectAfterTriangulation?**: (`sourceFeatureId`) => `boolean`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:663

Test-only fault injection: simulate a late triangulation rejection for a
specific source ID. Never used by the app or the offline tile baker.
Lets regression tests prove a non-emitted road cannot occlude later roads.

#### Parameters

##### sourceFeatureId

`string`

#### Returns

`boolean`

***

### tileClipBounds?

> `optional` **tileClipBounds?**: `ClipBox2D`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:657

Optional tile XZ bounds; when provided, clips emitted road/step meshes to exact tile boundaries after priority subtraction.
