[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / EdgeSegmentProvenance

# Interface: EdgeSegmentProvenance

Defined in: world/infrastructure/topology/types.ts:178

Provenance for a single constituent unchained source part inside a simplified graph edge.

## Properties

### deduplicatedFeatureIds

> **deduplicatedFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/topology/types.ts:184

Additional duplicate feature IDs merged into this segment during strict 1 mm exact deduplication.

***

### endArcLength

> **endArcLength**: `number`

Defined in: world/infrastructure/topology/types.ts:188

End arc-length (meters) along the parent simplified edge in `fromNodeId -> toNodeId` order.

***

### endVertexIndex

> **endVertexIndex**: `number`

Defined in: world/infrastructure/topology/types.ts:192

End vertex index (inclusive) in the parent simplified edge's `points` array (`startVertexIndex < endVertexIndex`).

***

### osmTags

> **osmTags**: [`RawGeoJsonProperties`](../../../../../types/MapFeature/interfaces/RawGeoJsonProperties.md)

Defined in: world/infrastructure/topology/types.ts:203

Original unmodified OSM tags for this constituent way segment.

***

### partId

> **partId**: `string`

Defined in: world/infrastructure/topology/types.ts:180

Unchained part ID (e.g. "way/100-0").

***

### reversedRelativeToSource

> **reversedRelativeToSource**: `boolean`

Defined in: world/infrastructure/topology/types.ts:201

True if this constituent part's traversal along the parent edge (`fromNodeId -> toNodeId`)
runs opposite to its original digitized point order (`sourceStartVertexIndex > sourceEndVertexIndex`).

***

### sourceEndVertexIndex

> **sourceEndVertexIndex**: `number`

Defined in: world/infrastructure/topology/types.ts:196

Corresponding vertex index in the original `UnchainedRoadPart` / `UnchainedRailwayPart` at `endVertexIndex`.

***

### sourceFeatureId

> **sourceFeatureId**: `string`

Defined in: world/infrastructure/topology/types.ts:182

Original OSM feature ID (e.g. "way/100").

***

### sourceStartVertexIndex

> **sourceStartVertexIndex**: `number`

Defined in: world/infrastructure/topology/types.ts:194

Corresponding vertex index in the original `UnchainedRoadPart` / `UnchainedRailwayPart` at `startVertexIndex`.

***

### startArcLength

> **startArcLength**: `number`

Defined in: world/infrastructure/topology/types.ts:186

Start arc-length (meters) along the parent simplified edge in `fromNodeId -> toNodeId` order.

***

### startVertexIndex

> **startVertexIndex**: `number`

Defined in: world/infrastructure/topology/types.ts:190

Start vertex index (inclusive) in the parent simplified edge's `points` array.
