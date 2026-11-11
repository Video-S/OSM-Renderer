[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [types/MapFeature](../README.md) / InfrastructurePlacementKind

# Type Alias: InfrastructurePlacementKind

> **InfrastructurePlacementKind** = `"surface_open"` \| `"elevated"` \| `"open_cutting"` \| `"covered_passage"` \| `"underground_tunnel"` \| `"unknown_or_conflicting"`

Defined in: world/InfrastructurePlacementClassifier.ts:8

Primary semantic placement category for road, path, railway, and waterway infrastructure (`M2.3-E4-T`).
Kept strictly separate from 3D geometry construction so it can be reused during ingestion,
graph topology analysis, runtime rendering, and future offline tile/mesh baking.
