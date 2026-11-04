[**3D Map Viewer API Reference**](../../README.md)

***

[3D Map Viewer API Reference](../../README.md) / world/PlanarLayerValidator

# world/PlanarLayerValidator

## Interfaces

- [PlanarBoundingBox](interfaces/PlanarBoundingBox.md)
- [PlanarValidationReport](interfaces/PlanarValidationReport.md)
- [PlanarValidationViolation](interfaces/PlanarValidationViolation.md)
- [ResolvedPlanarLayer](interfaces/ResolvedPlanarLayer.md)

## Type Aliases

- [MultiPolygonCoords](type-aliases/MultiPolygonCoords.md)
- [PairwiseOwnershipOutcome](type-aliases/PairwiseOwnershipOutcome.md)
- [SemanticSurfaceClass](type-aliases/SemanticSurfaceClass.md)

## Variables

- [ALL\_SEMANTIC\_SURFACE\_CLASSES](variables/ALL_SEMANTIC_SURFACE_CLASSES.md)
- [COORDINATE\_SNAP\_QUANTUM](variables/COORDINATE_SNAP_QUANTUM.md)
- [DEGENERATE\_COLLAPSE\_THINNESS](variables/DEGENERATE_COLLAPSE_THINNESS.md)
- [MAX\_ALLOWED\_SURFACE\_FILL\_OVERLAP\_AREA](variables/MAX_ALLOWED_SURFACE_FILL_OVERLAP_AREA.md)
- [MIN\_PLANAR\_Y\_SEPARATION](variables/MIN_PLANAR_Y_SEPARATION.md)
- [MIN\_VALIDATED\_Y\_GAP](variables/MIN_VALIDATED_Y_GAP.md)
- [MIN\_VERTEX\_SPACING](variables/MIN_VERTEX_SPACING.md)
- [SURFACE\_MARKING\_Y\_OFFSET](variables/SURFACE_MARKING_Y_OFFSET.md)

## Functions

- [classifyPlanarTier](functions/classifyPlanarTier.md)
- [computeBBoxContainmentRatio](functions/computeBBoxContainmentRatio.md)
- [computeDirectedBoundaryDistance](functions/computeDirectedBoundaryDistance.md)
- [computeMultiPolygonArea](functions/computeMultiPolygonArea.md)
- [computeMultiPolygonBBox](functions/computeMultiPolygonBBox.md)
- [computeMultiPolygonPerimeter](functions/computeMultiPolygonPerimeter.md)
- [computeRingMetrics](functions/computeRingMetrics.md)
- [computeRingPerimeter](functions/computeRingPerimeter.md)
- [computeSignedRingArea](functions/computeSignedRingArea.md)
- [conditionPolygonToMultiPolygon](functions/conditionPolygonToMultiPolygon.md)
- [conditionRing](functions/conditionRing.md)
- [doBoundingBoxesOverlap](functions/doBoundingBoxesOverlap.md)
- [filterDegenerateBooleanArtifacts](functions/filterDegenerateBooleanArtifacts.md)
- [isConfirmedDuplicateSurface](functions/isConfirmedDuplicateSurface.md)
- [isGeometricallyContained](functions/isGeometricallyContained.md)
- [resolveAndValidatePlanarPolygons](functions/resolveAndValidatePlanarPolygons.md)
- [resolvePairwiseOutcome](functions/resolvePairwiseOutcome.md)
- [validatePlanarLayering](functions/validatePlanarLayering.md)
