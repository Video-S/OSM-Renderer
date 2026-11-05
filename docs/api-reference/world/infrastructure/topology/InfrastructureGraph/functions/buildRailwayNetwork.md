[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/InfrastructureGraph](../README.md) / buildRailwayNetwork

# Function: buildRailwayNetwork()

> **buildRailwayNetwork**(`input`, `infrastructurePoints?`): [`RailwayNetworkBuildResult`](../../types/interfaces/RailwayNetworkBuildResult.md)

Defined in: world/infrastructure/topology/RailwayNetworkBuilder.ts:855

Pure, deterministic Stage C Railway Network Graph builder (`ADR-0009`).
Constructs `RailwayNetwork`, `RailwayFlatCrossingRelation[]`, and `RailwayNetworkDiagnostics`
without mutating inputs and with zero React, Three.js, renderer, or WebGL dependencies.

## Parameters

### input

[`TopologySourceData`](../../types/interfaces/TopologySourceData.md) \| readonly [`UnchainedRailwayPart`](../../types/interfaces/UnchainedRailwayPart.md)[] \| [`ProcessedMapData`](../../../../../types/MapFeature/interfaces/ProcessedMapData.md)

### infrastructurePoints?

readonly [`InfrastructurePointMetadata`](../../types/interfaces/InfrastructurePointMetadata.md)[]

## Returns

[`RailwayNetworkBuildResult`](../../types/interfaces/RailwayNetworkBuildResult.md)
