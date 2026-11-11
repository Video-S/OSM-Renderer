[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / RoadNodeRole

# Type Alias: RoadNodeRole

> **RoadNodeRole** = `"junction"` \| `"dead_end"` \| `"boundary_clip"` \| `"grade_transition"` \| `"attribute_break"` \| `"level_crossing"` \| `"highway_crossing"` \| `"cross_tier"` \| `"loop_anchor"`

Defined in: world/infrastructure/topology/types.ts:33

Non-exclusive topological roles that a RoadNode may hold simultaneously.
A single RoadNode can be e.g. both `'junction'` and `'level_crossing'`, or `'grade_transition'` and `'attribute_break'`.
