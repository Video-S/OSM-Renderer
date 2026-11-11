[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/ZFightingValidator](../README.md) / validateRoadNetworkGeometry

# Function: validateRoadNetworkGeometry()

> **validateRoadNetworkGeometry**(`scene`, `preExtractedTriangles?`): [`RoadNetworkValidationReport`](../interfaces/RoadNetworkValidationReport.md)

Defined in: world/ZFightingValidator.ts:863

Validates all at-grade road ribbons and junction polygons in `scene.roadsGroup` at `Y ≈ 0.050 m`
for:
1. Zero positive-area 2D triangle overlaps (`> 1e-3 m²`) between coplanar triangles, including
   triangles belonging to the same feature (`featureA === featureB`), while ignoring harmless
   0-area shared-edge and shared-vertex contacts.
2. Watertight portal continuity (`<= 0.02 m` gap; `<= 1e-3 m` numerical tolerance) between each
   junction polygon and its connected road ribbons along the actual portal boundary edges,
   treating missing or unmatched connected roads as validation failures.

## Parameters

### scene

[`BuiltSceneGeometry`](../../GeometryBuilder/interfaces/BuiltSceneGeometry.md)

### preExtractedTriangles?

[`ExtractedSceneTriangle`](../interfaces/ExtractedSceneTriangle.md)[]

## Returns

[`RoadNetworkValidationReport`](../interfaces/RoadNetworkValidationReport.md)
