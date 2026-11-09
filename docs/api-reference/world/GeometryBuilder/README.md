[**3D Map Viewer API Reference**](../../README.md)

***

[3D Map Viewer API Reference](../../README.md) / world/GeometryBuilder

# world/GeometryBuilder

## Classes

- [GeometryBuilder](classes/GeometryBuilder.md)

## Interfaces

- [BuiltSceneGeometry](interfaces/BuiltSceneGeometry.md)
- [CategorizedRoadOverlapDefect](interfaces/CategorizedRoadOverlapDefect.md)
- [FaceFeatureRange](interfaces/FaceFeatureRange.md)
- [GeometryBuilderOptions](interfaces/GeometryBuilderOptions.md)
- [RoadRibbonOptions](interfaces/RoadRibbonOptions.md)
- [SurfaceCoverageDefect](interfaces/SurfaceCoverageDefect.md)
- [SurfaceFirstCoverageValidationReport](interfaces/SurfaceFirstCoverageValidationReport.md)
- [SurfaceFirstMeshIntegrityValidationReport](interfaces/SurfaceFirstMeshIntegrityValidationReport.md)
- [SurfaceFirstOverlapValidationReport](interfaces/SurfaceFirstOverlapValidationReport.md)
- [SurfaceFirstProvenanceValidationReport](interfaces/SurfaceFirstProvenanceValidationReport.md)
- [SurfaceFirstRoadValidationReport](interfaces/SurfaceFirstRoadValidationReport.md)
- [SurfaceMeshArtifactDefect](interfaces/SurfaceMeshArtifactDefect.md)
- [SurfaceProvenanceDefect](interfaces/SurfaceProvenanceDefect.md)

## Type Aliases

- [SurfaceCoverageDefectKind](type-aliases/SurfaceCoverageDefectKind.md)
- [SurfaceOverlapCategory](type-aliases/SurfaceOverlapCategory.md)

## Variables

- [COVERAGE\_DISCRETIZATION\_RATIO\_TOLERANCE](variables/COVERAGE_DISCRETIZATION_RATIO_TOLERANCE.md)
- [MIN\_COVERAGE\_DEFECT\_AREA\_M2](variables/MIN_COVERAGE_DEFECT_AREA_M2.md)
- [TINY\_DISCONNECTED\_ARTIFACT\_AREA\_M2](variables/TINY_DISCONNECTED_ARTIFACT_AREA_M2.md)
- [UNINTENDED\_INTERIOR\_HOLE\_MAX\_AREA\_M2](variables/UNINTENDED_INTERIOR_HOLE_MAX_AREA_M2.md)

## Functions

- [buildIndependentAnalyticalRoadCorridor](functions/buildIndependentAnalyticalRoadCorridor.md)
- [buildRoadRibbonOutlineRing](functions/buildRoadRibbonOutlineRing.md)
- [buildSafeExteriorSubPolylines](functions/buildSafeExteriorSubPolylines.md)
- [cleanPolylineForClipping](functions/cleanPolylineForClipping.md)
- [createShapeFromRings](functions/createShapeFromRings.md)
- [createShapesFromMultiPolygon](functions/createShapesFromMultiPolygon.md)
- [generateExtrudedBarrierRibbon](functions/generateExtrudedBarrierRibbon.md)
- [generateParkingStallMarkings](functions/generateParkingStallMarkings.md)
- [generateRoadRibbon](functions/generateRoadRibbon.md)
- [generateStepTreads](functions/generateStepTreads.md)
- [hasRingSelfIntersection](functions/hasRingSelfIntersection.md)
- [resolveInspectedFeature](functions/resolveInspectedFeature.md)
- [sanitizeOsmTags](functions/sanitizeOsmTags.md)
- [splitRoadsAtSharedInteriorNodes](functions/splitRoadsAtSharedInteriorNodes.md)
- [validateSurfaceFirstRoadGeometry](functions/validateSurfaceFirstRoadGeometry.md)

## References

### adaptInfrastructureGraphToRenderDescriptors

Re-exports [adaptInfrastructureGraphToRenderDescriptors](../infrastructure/rendering/InfrastructureRenderAdapter/variables/adaptInfrastructureGraphToRenderDescriptors.md)

***

### auditGraphRoadMeshIntegrity

Re-exports [auditGraphRoadMeshIntegrity](../infrastructure/roads/GraphRoadGeometryBuilder/functions/auditGraphRoadMeshIntegrity.md)

***

### buildGraphAtGradeRoadGeometries

Re-exports [buildGraphAtGradeRoadGeometries](../infrastructure/roads/GraphRoadGeometryBuilder/functions/buildGraphAtGradeRoadGeometries.md)

***

### buildInfrastructureRenderDescriptors

Re-exports [buildInfrastructureRenderDescriptors](../infrastructure/rendering/InfrastructureRenderAdapter/functions/buildInfrastructureRenderDescriptors.md)

***

### cloneDescriptorOsmTags

Re-exports [cloneDescriptorOsmTags](../infrastructure/rendering/InfrastructureRenderAdapter/functions/cloneDescriptorOsmTags.md)

***

### DEFAULT\_INFRASTRUCTURE\_RENDER\_OPTIONS

Re-exports [DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS](../infrastructure/rendering/InfrastructureRenderAdapter/variables/DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS.md)

***

### GraphRoadDegenerateTriangleDefect

Re-exports [GraphRoadDegenerateTriangleDefect](../infrastructure/roads/GraphRoadGeometryBuilder/interfaces/GraphRoadDegenerateTriangleDefect.md)

***

### GraphRoadGenerationTiming

Re-exports [GraphRoadGenerationTiming](../infrastructure/roads/GraphRoadGeometryBuilder/interfaces/GraphRoadGenerationTiming.md)

***

### GraphRoadGeometryBuildOptions

Re-exports [GraphRoadGeometryBuildOptions](../infrastructure/roads/GraphRoadGeometryBuilder/interfaces/GraphRoadGeometryBuildOptions.md)

***

### GraphRoadGeometryBuildResult

Re-exports [GraphRoadGeometryBuildResult](../infrastructure/roads/GraphRoadGeometryBuilder/interfaces/GraphRoadGeometryBuildResult.md)

***

### GraphRoadMeshIntegrityReport

Re-exports [GraphRoadMeshIntegrityReport](../infrastructure/roads/GraphRoadGeometryBuilder/interfaces/GraphRoadMeshIntegrityReport.md)

***

### GraphRoadRenderStats

Re-exports [GraphRoadRenderStats](../infrastructure/roads/GraphRoadGeometryBuilder/interfaces/GraphRoadRenderStats.md)

***

### GraphRoadWindingDefect

Re-exports [GraphRoadWindingDefect](../infrastructure/roads/GraphRoadGeometryBuilder/interfaces/GraphRoadWindingDefect.md)

***

### InfrastructureRenderDescriptorBundle

Re-exports [InfrastructureRenderDescriptorBundle](../infrastructure/rendering/InfrastructureRenderAdapter/interfaces/InfrastructureRenderDescriptorBundle.md)

***

### InfrastructureRenderOptions

Re-exports [InfrastructureRenderOptions](../infrastructure/rendering/InfrastructureRenderAdapter/interfaces/InfrastructureRenderOptions.md)

***

### InfrastructureRenderPreviewResult

Re-exports [InfrastructureRenderPreviewResult](../infrastructure/rendering/InfrastructureRenderAdapter/interfaces/InfrastructureRenderPreviewResult.md)

***

### InfrastructureRenderSource

Re-exports [InfrastructureRenderSource](../infrastructure/rendering/InfrastructureRenderAdapter/type-aliases/InfrastructureRenderSource.md)

***

### InfrastructureRenderValidationReport

Re-exports [InfrastructureRenderValidationReport](../infrastructure/rendering/InfrastructureRenderAdapter/interfaces/InfrastructureRenderValidationReport.md)

***

### MIN\_NONDEGENERATE\_TRIANGLE\_AREA\_M2

Re-exports [MIN_NONDEGENERATE_TRIANGLE_AREA_M2](../infrastructure/roads/GraphRoadGeometryBuilder/variables/MIN_NONDEGENERATE_TRIANGLE_AREA_M2.md)

***

### normalizeInfrastructureRenderOptions

Re-exports [normalizeInfrastructureRenderOptions](../infrastructure/rendering/InfrastructureRenderAdapter/functions/normalizeInfrastructureRenderOptions.md)

***

### parseInfrastructureRenderOptionsFromSearch

Re-exports [parseInfrastructureRenderOptionsFromSearch](../infrastructure/rendering/InfrastructureRenderAdapter/functions/parseInfrastructureRenderOptionsFromSearch.md)

***

### parseInfrastructureRenderSource

Re-exports [parseInfrastructureRenderSource](../infrastructure/rendering/InfrastructureRenderAdapter/functions/parseInfrastructureRenderSource.md)

***

### parseRailwayInfrastructureRenderSource

Re-exports [parseRailwayInfrastructureRenderSource](../infrastructure/rendering/InfrastructureRenderAdapter/functions/parseRailwayInfrastructureRenderSource.md)

***

### parseRoadInfrastructureRenderSource

Re-exports [parseRoadInfrastructureRenderSource](../infrastructure/rendering/InfrastructureRenderAdapter/functions/parseRoadInfrastructureRenderSource.md)

***

### prepareInfrastructureRenderPreview

Re-exports [prepareInfrastructureRenderPreview](../infrastructure/rendering/InfrastructureRenderAdapter/functions/prepareInfrastructureRenderPreview.md)

***

### RailwayInfrastructureRenderSource

Re-exports [RailwayInfrastructureRenderSource](../infrastructure/rendering/InfrastructureRenderAdapter/type-aliases/RailwayInfrastructureRenderSource.md)

***

### requiresInfrastructureGraphPreview

Re-exports [requiresInfrastructureGraphPreview](../infrastructure/rendering/InfrastructureRenderAdapter/functions/requiresInfrastructureGraphPreview.md)

***

### RoadInfrastructureRenderSource

Re-exports [RoadInfrastructureRenderSource](../infrastructure/rendering/InfrastructureRenderAdapter/type-aliases/RoadInfrastructureRenderSource.md)

***

### SceneResourceManager

Re-exports [SceneResourceManager](../SceneResourceManager/classes/SceneResourceManager.md)

***

### validateInfrastructureRenderDescriptors

Re-exports [validateInfrastructureRenderDescriptors](../infrastructure/rendering/InfrastructureRenderAdapter/functions/validateInfrastructureRenderDescriptors.md)
