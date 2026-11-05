[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/InfrastructureGraph](../README.md) / buildInfrastructureGraph

# Function: buildInfrastructureGraph()

> **buildInfrastructureGraph**(`input`): [`InfrastructureGraph`](../../types/interfaces/InfrastructureGraph.md)

Defined in: world/infrastructure/topology/InfrastructureGraph.ts:660

Pure, deterministic top-level Infrastructure Graph builder (`ADR-0009` Stages B–D).
Constructs `RoadNetwork`, `RailwayNetwork`, `GradeTransitionRelation[]`,
`RailwayFlatCrossingRelation[]`, `LevelCrossingRelation[]`,
`GradeSeparatedCrossingRelation[]`, and `TopologyDiagnostics` with zero renderer
or Three.js dependencies and without mutating caller inputs.

## Parameters

### input

[`TopologySourceData`](../../types/interfaces/TopologySourceData.md) \| [`ProcessedMapData`](../../../../../types/MapFeature/interfaces/ProcessedMapData.md)

## Returns

[`InfrastructureGraph`](../../types/interfaces/InfrastructureGraph.md)
