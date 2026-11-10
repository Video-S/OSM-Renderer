[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / adaptRailwayEdgeDescriptorsToFeatures

# Function: adaptRailwayEdgeDescriptorsToFeatures()

> **adaptRailwayEdgeDescriptorsToFeatures**(`edges`): [`RailwayFeature`](../../../../../types/MapFeature/interfaces/RailwayFeature.md)[]

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:198

Adapts Stage E1/E3 railway edge render descriptors into `RailwayFeature` records
consumed by Candidate B (`RailwayGeometryBuilder.ts`) in Milestone 2.3 Stage E3-A1.

Preserves:
- Edge ID and canonical points polyline `[x, z][]`
- Track gauge, widths, layers, and bridge/tunnel profile flags
- Primary source feature ID and complete constituent `sourceFeatureIds` (retaining full OSM provenance)
- Raw OSM node IDs and original tags
- Railway classifications (`railwayType`, `service`, `usage`)

## Parameters

### edges

readonly [`RailwayEdgeRenderDescriptor`](../interfaces/RailwayEdgeRenderDescriptor.md)[]

## Returns

[`RailwayFeature`](../../../../../types/MapFeature/interfaces/RailwayFeature.md)[]
