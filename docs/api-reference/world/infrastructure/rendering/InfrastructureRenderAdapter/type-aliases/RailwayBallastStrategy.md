[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / RailwayBallastStrategy

# Type Alias: RailwayBallastStrategy

> **RailwayBallastStrategy** = `"ribbon"` \| `"surface-first"`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:86

Strategy governing at-grade railway ballast surface construction (Stage E3-B).

- `'ribbon'`: Candidate B continuous track-aligned UV ribbons with overlapping parallel/switch footprints.
- `'surface-first'`: Stage E3-B consolidated 2D polygonal ballast footprints unioned per connected component.
