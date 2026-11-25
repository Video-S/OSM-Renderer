[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / GeometryBuilderOptions

# Interface: GeometryBuilderOptions

Defined in: world/GeometryBuilder.ts:187

## Properties

### bevelEnabled?

> `optional` **bevelEnabled?**: `boolean`

Defined in: world/GeometryBuilder.ts:190

***

### buildingHeightMultiplier?

> `optional` **buildingHeightMultiplier?**: `number`

Defined in: world/GeometryBuilder.ts:188

***

### infrastructureRenderOptions?

> `optional` **infrastructureRenderOptions?**: `Partial`\<[`InfrastructureRenderOptions`](../../infrastructure/rendering/InfrastructureRenderAdapter/interfaces/InfrastructureRenderOptions.md)\>

Defined in: world/GeometryBuilder.ts:192

***

### infrastructureRenderPreview?

> `optional` **infrastructureRenderPreview?**: [`InfrastructureRenderPreviewResult`](../../infrastructure/rendering/InfrastructureRenderAdapter/interfaces/InfrastructureRenderPreviewResult.md)

Defined in: world/GeometryBuilder.ts:193

***

### initialCameraZoom?

> `optional` **initialCameraZoom?**: `number`

Defined in: world/GeometryBuilder.ts:191

***

### maxSceneTrees?

> `optional` **maxSceneTrees?**: `number`

Defined in: world/GeometryBuilder.ts:197

Optional procedural tree cap override (default 2200 for production single-scene builds).

***

### precomputedGlobalPlans?

> `optional` **precomputedGlobalPlans?**: `object`

Defined in: world/GeometryBuilder.ts:199

Optional precomputed global plans/phases shared across tiles for exact cross-border continuity.

#### atGradeRoadPlan?

> `optional` **atGradeRoadPlan?**: [`GraphRoadGeometryBuildResult`](../../infrastructure/roads/GraphRoadGeometryBuilder/interfaces/GraphRoadGeometryBuildResult.md)

#### barrierResolution?

> `optional` **barrierResolution?**: `object`

##### barrierResolution.contextsById

> **contextsById**: `ReadonlyMap`\<`string`, [`BarrierStructuralContext`](../../../types/MapFeature/interfaces/BarrierStructuralContext.md)\>

##### barrierResolution.diagnostics

> **diagnostics**: [`StructuralContextDiagnostics`](../../../types/MapFeature/interfaces/StructuralContextDiagnostics.md)

#### existingParkingSpaceBoxes?

> `optional` **existingParkingSpaceBoxes?**: `object`[]

#### planarResolution?

> `optional` **planarResolution?**: `object`

##### planarResolution.polygonRingsById

> **polygonRingsById**: `Map`\<`string`, \[`number`, `number`\][][]\>

##### planarResolution.portalCutoutsApplied

> **portalCutoutsApplied**: `boolean`

##### planarResolution.report

> **report**: [`PlanarValidationReport`](../../PlanarLayerValidator/interfaces/PlanarValidationReport.md)

##### planarResolution.resolvedById

> **resolvedById**: `Map`\<`string`, [`ResolvedPlanarLayer`](../../PlanarLayerValidator/interfaces/ResolvedPlanarLayer.md)\>

##### planarResolution.unclippedGeometriesById?

> `optional` **unclippedGeometriesById?**: `Map`\<`string`, `BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>\>

#### railwayDensifiedPointsByEdgeId?

> `optional` **railwayDensifiedPointsByEdgeId?**: `ReadonlyMap`\<`string`, \[`number`, `number`\][]\>

#### railwayGradeSeparatedPlans?

> `optional` **railwayGradeSeparatedPlans?**: [`GraphGradeSeparatedResolutionResult`](../../BridgeAndTunnelBuilder/interfaces/GraphGradeSeparatedResolutionResult.md)

#### railwayTrackPhases?

> `optional` **railwayTrackPhases?**: `ReadonlyMap`\<`string`, `number`\>

#### roadGradeSeparatedPlans?

> `optional` **roadGradeSeparatedPlans?**: [`GraphGradeSeparatedResolutionResult`](../../BridgeAndTunnelBuilder/interfaces/GraphGradeSeparatedResolutionResult.md)

#### tunnelEntrances?

> `optional` **tunnelEntrances?**: `VerifiedTunnelEntrances`

***

### roadWidthMultiplier?

> `optional` **roadWidthMultiplier?**: `number`

Defined in: world/GeometryBuilder.ts:189

***

### tileClipBounds?

> `optional` **tileClipBounds?**: `WorldBox2D`

Defined in: world/GeometryBuilder.ts:195

Optional XZ tile bounds for regional tiling; clips continuous geometry at boundaries and assigns discrete features by half-open centroid ownership.
