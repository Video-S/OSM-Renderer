[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / NormalizedOneWay

# Type Alias: NormalizedOneWay

> **NormalizedOneWay** = `"forward"` \| `"reverse"` \| `"bidirectional"` \| `"unknown"`

Defined in: world/infrastructure/topology/types.ts:18

Normalized directionality relative to an edge's `fromNodeId -> toNodeId` vertex order.
- 'forward': one-way traversal permitted in `fromNodeId -> toNodeId` direction (`oneway=yes|1|true`)
- 'reverse': one-way traversal permitted in `toNodeId -> fromNodeId` direction (`oneway=-1|reverse`)
- 'bidirectional': two-way (`oneway=no|0|false` or default when omitted)
- 'unknown': unusual/conditional OSM value (`oneway=reversible|alternating|<custom>`); preserved verbatim in `rawOnewayTag`
