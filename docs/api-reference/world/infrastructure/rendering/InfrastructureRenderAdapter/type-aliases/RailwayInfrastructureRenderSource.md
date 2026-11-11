[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / RailwayInfrastructureRenderSource

# Type Alias: RailwayInfrastructureRenderSource

> **RailwayInfrastructureRenderSource** = `"legacy"` \| `"graph-preview"` \| `"graph"` \| `"graph-switches"` \| `"graph-R+"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:66

Selects the data source mode for railway infrastructure rendering in Milestone 2.3 Stage E1–E3.

- `'legacy'`: Default production mode. Uses existing `ProcessedMapData.railways`.
- `'graph-preview'`: Builds and validates railway render descriptors alongside the legacy railway renderer.
- `'graph'`: Stage E3-A1 graph-driven railway rendering mode. Adapts `RailwayEdgeRenderDescriptor`s
  into Candidate B inputs preserving baseline heuristic switch geometry.
- `'graph-switches'`: Stage E3-A2 graph-informed switch rendering mode. Uses verified
  `turnoutTopology` descriptors to govern bearer sharing, sleeper support, and blade tapering.
- `'graph-R+'`: Stage E3-B experimental surface-first railway ballast mode. Uses consolidated 2D
  ballast footprints while preserving graph-informed rails, sleepers, and switch semantics.
