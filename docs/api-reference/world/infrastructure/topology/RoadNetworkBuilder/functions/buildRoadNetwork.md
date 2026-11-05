[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/RoadNetworkBuilder](../README.md) / buildRoadNetwork

# Function: buildRoadNetwork()

> **buildRoadNetwork**(`input`, `optionsOrPoints?`): [`RoadNetworkBuildResult`](../../types/interfaces/RoadNetworkBuildResult.md)

Defined in: world/infrastructure/topology/RoadNetworkBuilder.ts:759

Pure, deterministic Stage B Road Network Graph builder (`ADR-0009`).
Constructs `RoadNetwork` and `RoadNetworkDiagnostics` without mutating inputs
and with zero React, Three.js, renderer, or WebGL dependencies.

## Parameters

### input

[`TopologySourceData`](../../types/interfaces/TopologySourceData.md) \| readonly [`UnchainedRoadPart`](../../types/interfaces/UnchainedRoadPart.md)[] \| [`ProcessedMapData`](../../../../../types/MapFeature/interfaces/ProcessedMapData.md)

### optionsOrPoints?

readonly [`InfrastructurePointMetadata`](../../types/interfaces/InfrastructurePointMetadata.md)[] \| [`RoadNetworkBuildOptions`](../../types/interfaces/RoadNetworkBuildOptions.md)

## Returns

[`RoadNetworkBuildResult`](../../types/interfaces/RoadNetworkBuildResult.md)
