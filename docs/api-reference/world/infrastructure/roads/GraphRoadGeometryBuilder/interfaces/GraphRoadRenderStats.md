[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/roads/GraphRoadGeometryBuilder](../README.md) / GraphRoadRenderStats

# Interface: GraphRoadRenderStats

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:443

Diagnostic and benchmark counters emitted by the Stage E2 / E2+ graph-driven road geometry builder.

## Properties

### atGradeRoadEdgeCount

> **atGradeRoadEdgeCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:449

Number of road edge descriptors eligible for at-grade ribbon construction (`isAtGradeBuildable`).

***

### branchingJunctionCount

> **branchingJunctionCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:457

Number of vehicular branching junctions (`requiresVehicularJunctionTrimming === true`) meshed.

***

### candidateBlockerCheckCount

> **candidateBlockerCheckCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:485

Total placed-footprint bounding-box candidate checks evaluated during ownership clipping.

***

### crossTierOnlyNodeCount

> **crossTierOnlyNodeCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:463

Number of cross-tier-only interaction nodes (`isCrossTierOnlyInteraction === true`) encountered.

***

### degree2ContinuityJoinCount

> **degree2ContinuityJoinCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:459

Number of degree-2 continuity joins (`requiresVehicularContinuityMiter === true` or path degree-2) resolved.

***

### emptyShapeCount

> **emptyShapeCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:501

Number of E2+ empty `THREE.Shape` conversions (`e2plus_empty_shapes`).

***

### flatRibbonFallbackCount

> **flatRibbonFallbackCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:497

Number of E2+ flat ribbon fallbacks (`e2plus_flat_ribbon_fallback`).

***

### fullySubtractedCount

> **fullySubtractedCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:467

Number of road/path edges or sub-segments completely removed by 2D Boolean carriageway subtraction.

***

### generatedBendDiskPrimitiveCount

> **generatedBendDiskPrimitiveCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:473

Number of interior bend disk primitives generated during E2+ rounded footprint buffering.

***

### generatedCapDiskPrimitiveCount

> **generatedCapDiskPrimitiveCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:475

Number of endpoint or closed-loop cap disk primitives generated during E2+ rounded footprint buffering.

***

### generatedDiskPrimitiveCount

> **generatedDiskPrimitiveCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:477

Total disk primitives (`generatedBendDiskPrimitiveCount + generatedCapDiskPrimitiveCount`) generated in E2+.

***

### generatedRectanglePrimitiveCount

> **generatedRectanglePrimitiveCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:471

Number of segment rectangle primitives generated during E2+ rounded footprint buffering.

***

### generatedTotalPrimitiveCount

> **generatedTotalPrimitiveCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:479

Total rectangle and disk primitives generated during E2+ rounded footprint buffering.

***

### inputRoadEdgeCount

> **inputRoadEdgeCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:447

Total road edge descriptors in the input adapter bundle.

***

### inputRoadNodeCount

> **inputRoadNodeCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:445

Total road node descriptors in the input adapter bundle.

***

### invalidTriangleGeometryCount

> **invalidTriangleGeometryCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:503

Number of E2+ triangulated geometries rejected by `validateAndPruneHorizontalGeometry` (`e2plus_invalid_triangles`).

***

### outputHoleRingCount

> **outputHoleRingCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:491

Total interior hole rings across all emitted at-grade road/junction surfaces.

***

### outputPolygonCount

> **outputPolygonCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:489

Total outer polygon components across all emitted at-grade road/junction surfaces.

***

### outputTriangleCount

> **outputTriangleCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:493

Total indexed triangles emitted across all at-grade road, step-tread, and junction geometries.

***

### overlappingBlockerCount

> **overlappingBlockerCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:487

Number of candidate footprints whose bounding box overlapped and were passed to Boolean clipping.

***

### pathJunctionCount

> **pathJunctionCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:461

Number of pure path-tier branching junctions (`requiresPathJunctionTrimming === true`, `>= 3` arms) meshed.

***

### polygonDifferenceOperationCount

> **polygonDifferenceOperationCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:483

Number of `polygonClipping.difference` operations invoked during ownership clipping.

***

### polygonUnionOperationCount

> **polygonUnionOperationCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:481

Number of `polygonClipping.union` operations invoked during road geometry generation.

***

### processedProvenanceSegmentCount

> **processedProvenanceSegmentCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:451

Total provenance sub-segments processed in the road surface emission pass.

***

### provenanceSplitSegmentCount

> **provenanceSplitSegmentCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:469

Number of additional sub-segments produced by splitting simplified edges at provenance boundaries.

***

### rejectedOrDegenerateCount

> **rejectedOrDegenerateCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:465

Number of degenerate or micro road edges/sub-segments or invalid junction solutions rejected.

***

### renderedJunctionCount

> **renderedJunctionCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:455

Total rendered junction polygon geometry items emitted (vehicular + path junctions).

***

### renderedRoadRibbonCount

> **renderedRoadRibbonCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:453

Total rendered at-grade road/path ribbon geometry items emitted (including provenance sub-segments).

***

### roundedBufferFailureCount

> **roundedBufferFailureCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:495

Number of E2+ rounded buffer construction failures (`e2plus_rounded_buffer_failed`).

***

### surfaceClipFailureCount

> **surfaceClipFailureCount**: `number`

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:499

Number of E2+ surface ownership clipping failures (`e2plus_surface_clip_failed`).
