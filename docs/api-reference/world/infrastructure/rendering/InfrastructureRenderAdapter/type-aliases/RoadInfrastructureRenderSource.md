[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / RoadInfrastructureRenderSource

# Type Alias: RoadInfrastructureRenderSource

> **RoadInfrastructureRenderSource** = `"legacy"` \| `"graph-preview"` \| `"graph"` \| `"graph-surface"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:52

Selects the data source mode for road infrastructure rendering in Milestone 2.3 Stage E2.

- `'legacy'`: Default production mode. Uses existing `ProcessedMapData.roads`
  with zero graph construction or adapter overhead when both domains are `'legacy'`.
- `'graph-preview'`: Stage E1 preview mode. Builds and validates graph-backed render descriptors
  from a single shared `InfrastructureGraph` alongside the legacy road renderer without altering
  existing 3D mesh generation.
- `'graph'`: Stage E2 graph-driven road rendering mode. Builds and validates `InfrastructureGraph`
  and `InfrastructureRenderDescriptorBundle`, then constructs at-grade road ribbons, degree-2
  continuity joins, and boundary-derived junction polygons directly from the road render descriptors.
- `'graph-surface'`: E2+ experiment: rounded centerline buffers with planar ownership, no junction cuts.
