[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/RailwayNetworkBuilder](../README.md) / buildRailwayNetwork

# Function: buildRailwayNetwork()

> **buildRailwayNetwork**(`input`, `optionsOrPoints?`): [`RailwayNetworkBuildResult`](../../types/interfaces/RailwayNetworkBuildResult.md)

Defined in: world/infrastructure/topology/RailwayNetworkBuilder.ts:882

Pure, deterministic Stage C Railway Network Graph builder (`ADR-0009`).
Constructs `RailwayNetwork`, `RailwayFlatCrossingRelation[]`, and `RailwayNetworkDiagnostics`
without mutating inputs and with zero React, Three.js, renderer, or WebGL dependencies.

## Parameters

### input

[`TopologySourceData`](../../types/interfaces/TopologySourceData.md) \| readonly [`UnchainedRailwayPart`](../../types/interfaces/UnchainedRailwayPart.md)[] \| [`ProcessedMapData`](../../../../../types/MapFeature/interfaces/ProcessedMapData.md)

### optionsOrPoints?

readonly [`InfrastructurePointMetadata`](../../types/interfaces/InfrastructurePointMetadata.md)[] \| [`RailwayNetworkBuildOptions`](../../types/interfaces/RailwayNetworkBuildOptions.md)

## Returns

[`RailwayNetworkBuildResult`](../../types/interfaces/RailwayNetworkBuildResult.md)
