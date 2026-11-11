[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / UnchainedRailwayPart

# Interface: UnchainedRailwayPart

Defined in: world/infrastructure/topology/types.ts:127

Non-destructive railway way part captured immediately after bounding-box clipping (Stage C).

## Properties

### clippedAtEnd

> **clippedAtEnd**: `boolean`

Defined in: world/infrastructure/topology/types.ts:135

***

### clippedAtStart

> **clippedAtStart**: `boolean`

Defined in: world/infrastructure/topology/types.ts:134

***

### electrified?

> `optional` **electrified?**: `string`

Defined in: world/infrastructure/topology/types.ts:143

***

### gauge?

> `optional` **gauge?**: `string`

Defined in: world/infrastructure/topology/types.ts:142

***

### hasExplicitSourceId

> **hasExplicitSourceId**: `boolean`

Defined in: world/infrastructure/topology/types.ts:130

***

### id

> **id**: `string`

Defined in: world/infrastructure/topology/types.ts:128

***

### isBridge

> **isBridge**: `boolean`

Defined in: world/infrastructure/topology/types.ts:139

***

### isSecondaryBranch

> **isSecondaryBranch**: `boolean`

Defined in: world/infrastructure/topology/types.ts:146

***

### isTunnel

> **isTunnel**: `boolean`

Defined in: world/infrastructure/topology/types.ts:140

***

### layer

> **layer**: `number`

Defined in: world/infrastructure/topology/types.ts:138

***

### name?

> `optional` **name?**: `string`

Defined in: world/infrastructure/topology/types.ts:141

***

### osmTags

> **osmTags**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/topology/types.ts:147

***

### partIndex

> **partIndex**: `number`

Defined in: world/infrastructure/topology/types.ts:131

***

### placementClassification?

> `optional` **placementClassification?**: [`InfrastructurePlacementClassification`](../../../../../types/MapFeature/interfaces/InfrastructurePlacementClassification.md)

Defined in: world/infrastructure/topology/types.ts:149

Semantic vertical/enclosure placement classification (M2.3-E4-T).

***

### points

> **points**: readonly \[`number`, `number`\][]

Defined in: world/infrastructure/topology/types.ts:132

***

### railwayType

> **railwayType**: [`RailwayType`](../../../../../types/MapFeature/type-aliases/RailwayType.md)

Defined in: world/infrastructure/topology/types.ts:136

***

### rawOsmNodeIds

> **rawOsmNodeIds**: readonly `string`[]

Defined in: world/infrastructure/topology/types.ts:133

***

### service?

> `optional` **service?**: `string`

Defined in: world/infrastructure/topology/types.ts:144

***

### sourceFeatureId

> **sourceFeatureId**: `string`

Defined in: world/infrastructure/topology/types.ts:129

***

### usage?

> `optional` **usage?**: `string`

Defined in: world/infrastructure/topology/types.ts:145

***

### width

> **width**: `number`

Defined in: world/infrastructure/topology/types.ts:137
