[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / RailwaySwitchPolicy

# Type Alias: RailwaySwitchPolicy

> **RailwaySwitchPolicy** = `"heuristic"` \| `"graph"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:79

Switch policy governing railway turnout bearer sharing and blade tapering (Stage E3-A2).

- `'heuristic'`: Historical Candidate B behavior using `isTurnoutThroatPair` proximity detection.
- `'graph'`: Graph-informed behavior consuming `RailwayNodeRenderDescriptor.turnoutTopology`.
