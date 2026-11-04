[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/TopologicalNodeIndex](../README.md) / TopologicalNodeIndex

# Class: TopologicalNodeIndex

Defined in: world/TopologicalNodeIndex.ts:24

## Constructors

### Constructor

> **new TopologicalNodeIndex**(`snapTolerance?`): `TopologicalNodeIndex`

Defined in: world/TopologicalNodeIndex.ts:35

#### Parameters

##### snapTolerance?

`number` = `DEFAULT_NODE_SNAP_TOLERANCE_METERS`

#### Returns

`TopologicalNodeIndex`

## Properties

### snapTolerance

> `readonly` **snapTolerance**: `number`

Defined in: world/TopologicalNodeIndex.ts:33

## Methods

### getNodePosition()

> **getNodePosition**(`nodeId`): \[`number`, `number`\]

Defined in: world/TopologicalNodeIndex.ts:192

#### Parameters

##### nodeId

`string`

#### Returns

\[`number`, `number`\]

***

### getOrCreateNode()

> **getOrCreateNode**(`x`, `z`, `layerScope?`, `explicitOsmNodeId?`): `string`

Defined in: world/TopologicalNodeIndex.ts:68

Resolves a canonical node ID for a point [x, z].
- If an explicit OSM node ID is provided, preserves that identifier (scoped by `layerScope`),
  and indexes its spatial position in `this.grid` so subsequent coordinate-only ways at the same
  location in the same `layerScope` resolve to the same node ID.
- If an unnamed coordinate-fallback node was already created within `snapTolerance` in the same
  `layerScope` before this explicit OSM node arrived, promotes that fallback node entry to `osmKey`
  and records an alias in `fallbackToExplicitAlias`.
- Two distinct explicit OSM node IDs are NEVER merged together even if within `snapTolerance`.
- If no explicit OSM node ID is provided, performs a spatial hash lookup within `snapTolerance` (0.15m)
  inside the same `layerScope` across both explicit and fallback nodes.

#### Parameters

##### x

`number`

##### z

`number`

##### layerScope?

`string` = '0\|false\|false'

##### explicitOsmNodeId?

`string` \| `number`

#### Returns

`string`

***

### resolveCanonicalNodeId()

> **resolveCanonicalNodeId**(`nodeId`): `string`

Defined in: world/TopologicalNodeIndex.ts:46

Resolves a canonical node ID if a fallback coordinate node was later promoted to an explicit OSM node.

#### Parameters

##### nodeId

`string`

#### Returns

`string`

***

### resolveWayNodeIds()

> **resolveWayNodeIds**(`points`, `layerScope?`, `rawOsmNodeIds?`): `string`[]

Defined in: world/TopologicalNodeIndex.ts:174

Resolves an array of node IDs for a polyline, preserving per-vertex OSM node IDs
when available in the source feature properties and falling back to spatial snapping.

#### Parameters

##### points

\[`number`, `number`\][]

##### layerScope?

`string` = '0\|false\|false'

##### rawOsmNodeIds?

(`string` \| `number`)[]

#### Returns

`string`[]
