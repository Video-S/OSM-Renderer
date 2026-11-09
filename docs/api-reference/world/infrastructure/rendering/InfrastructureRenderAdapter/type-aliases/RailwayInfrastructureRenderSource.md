[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / RailwayInfrastructureRenderSource

# Type Alias: RailwayInfrastructureRenderSource

> **RailwayInfrastructureRenderSource** = `"legacy"` \| `"graph-preview"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:60

Selects the data source mode for railway infrastructure rendering in Milestone 2.3 Stage E1–E2.

- `'legacy'`: Default production mode. Uses existing `ProcessedMapData.railways`.
- `'graph-preview'`: Builds and validates railway render descriptors alongside the legacy railway renderer.
  (Graph-driven railway rendering `'graph'` remains deferred to Stage E3; setting `topologyRailways=graph`
  in Stage E2 resolves safely to `'legacy'`.)
