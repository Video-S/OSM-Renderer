[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/roads/GraphRoadGeometryBuilder](../README.md) / buildGraphAtGradeRoadGeometries

# Function: buildGraphAtGradeRoadGeometries()

> **buildGraphAtGradeRoadGeometries**(`options`): [`GraphRoadGeometryBuildResult`](../interfaces/GraphRoadGeometryBuildResult.md)

Defined in: world/infrastructure/roads/GraphRoadGeometryBuilder.ts:2312

Constructs at-grade road ribbons, degree-2 continuity joins, and boundary-derived junction
polygons directly from an `InfrastructureRenderDescriptorBundle` (`M2.3-E2`).

Strictly consumes `descriptors.roadNodes` and `descriptors.roadEdges` without calling legacy
`splitRoadsAtSharedInteriorNodes` or `TopologicalNodeIndex`.

## Parameters

### options

[`GraphRoadGeometryBuildOptions`](../interfaces/GraphRoadGeometryBuildOptions.md)

## Returns

[`GraphRoadGeometryBuildResult`](../interfaces/GraphRoadGeometryBuildResult.md)
