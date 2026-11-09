[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / splitRoadsAtSharedInteriorNodes

# Function: splitRoadsAtSharedInteriorNodes()

> **splitRoadsAtSharedInteriorNodes**(`roads`, `topoIndex`): [`RoadFeature`](../../../types/MapFeature/interfaces/RoadFeature.md)[]

Defined in: world/GeometryBuilder.ts:1011

Splits road polylines wherever an interior vertex is shared with another road in the same tier
so that all T-junctions and mid-polyline cross-streets are exposed as true endpoints for junction meshing.

## Parameters

### roads

[`RoadFeature`](../../../types/MapFeature/interfaces/RoadFeature.md)[]

### topoIndex

[`TopologicalNodeIndex`](../../TopologicalNodeIndex/classes/TopologicalNodeIndex.md)

## Returns

[`RoadFeature`](../../../types/MapFeature/interfaces/RoadFeature.md)[]
