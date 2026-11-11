[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [types/MapFeature](../README.md) / ExplicitPlacementHints

# Interface: ExplicitPlacementHints

Defined in: world/InfrastructurePlacementClassifier.ts:119

Optional pre-parsed hints for synthetic test fixtures that construct `RoadFeature` / `RailwayFeature`
directly in memory without populating `osmTags.tunnel` or `osmTags.bridge`.

## Properties

### featureDomain?

> `optional` **featureDomain?**: `"road"` \| `"railway"` \| `"waterway"` \| `"other"`

Defined in: world/InfrastructurePlacementClassifier.ts:124

***

### isBridge?

> `optional` **isBridge?**: `boolean`

Defined in: world/InfrastructurePlacementClassifier.ts:120

***

### isCulvert?

> `optional` **isCulvert?**: `boolean`

Defined in: world/InfrastructurePlacementClassifier.ts:122

***

### isTunnel?

> `optional` **isTunnel?**: `boolean`

Defined in: world/InfrastructurePlacementClassifier.ts:121

***

### layer?

> `optional` **layer?**: `number`

Defined in: world/InfrastructurePlacementClassifier.ts:123
