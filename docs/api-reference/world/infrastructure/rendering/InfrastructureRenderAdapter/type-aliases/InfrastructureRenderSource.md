[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / InfrastructureRenderSource

# Type Alias: InfrastructureRenderSource

> **InfrastructureRenderSource** = `"legacy"` \| `"graph-preview"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:47

Selects the data source mode for road or railway infrastructure rendering in Milestone 2.3 Stage E.

- `'legacy'`: Default production mode. Uses existing `ProcessedMapData.roads` and `ProcessedMapData.railways`
  with zero graph construction or adapter overhead.
- `'graph-preview'`: Stage E1 preview mode. Builds and validates graph-backed render descriptors
  from a single shared `InfrastructureGraph` alongside the legacy renderer without altering
  existing 3D mesh generation. (Actual `'graph'` mesh generation is deferred to Stages E2–E4.)
