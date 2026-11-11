[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / validateSurfaceFirstRoadGeometry

# Function: validateSurfaceFirstRoadGeometry()

> **validateSurfaceFirstRoadGeometry**(`scene`, `data`, `options?`): [`SurfaceFirstRoadValidationReport`](../interfaces/SurfaceFirstRoadValidationReport.md)

Defined in: world/infrastructure/roads/SurfaceFirstRoadValidator.ts:502

Performs comprehensive automated geometry correctness validation on a built scene (`Task A`):
- `A1`: Surface coverage, continuity, hole detection, and legitimate ownership accounting
- `A2`: Coplanar positive-area overlap validation by category
- `A3`: Mesh integrity, triangle winding, normal agreement, elevation consistency, and tiny artifact check
- `A4`: Source-feature provenance, multi-segment chaining splits, deduplication lineage, and subtraction accounting

## Parameters

### scene

[`BuiltSceneGeometry`](../interfaces/BuiltSceneGeometry.md)

### data

[`ProcessedMapData`](../../../types/MapFeature/interfaces/ProcessedMapData.md)

### options?

#### roadWidthMultiplier?

`number`

## Returns

[`SurfaceFirstRoadValidationReport`](../interfaces/SurfaceFirstRoadValidationReport.md)
