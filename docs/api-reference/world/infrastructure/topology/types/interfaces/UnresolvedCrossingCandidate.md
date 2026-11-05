[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / UnresolvedCrossingCandidate

# Interface: UnresolvedCrossingCandidate

Defined in: world/infrastructure/topology/types.ts:485

## Properties

### edgeAId

> **edgeAId**: `string`

Defined in: world/infrastructure/topology/types.ts:488

***

### edgeBId

> **edgeBId**: `string`

Defined in: world/infrastructure/topology/types.ts:489

***

### kind

> **kind**: `"road_rail"` \| `"pedestrian_rail"` \| `"rail_rail"` \| `"road_road"`

Defined in: world/infrastructure/topology/types.ts:486

***

### position

> **position**: \[`number`, `number`\]

Defined in: world/infrastructure/topology/types.ts:487

***

### reason

> **reason**: `"coincident_vertex_without_osm_id"` \| `"geometric_intersection_without_shared_node"` \| `"missing_railway_crossing_tag_at_degree_4_node"` \| `"ambiguous_railway_crossing_track_pairing"` \| `"conflicting_crossing_tag_and_road_tier"` \| `"conflicting_explicit_osm_node_id"`

Defined in: world/infrastructure/topology/types.ts:490
