[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/types](../README.md) / EdgeProvenance

# Interface: EdgeProvenance

Defined in: world/infrastructure/topology/types.ts:209

Complete OSMnx-style lineage for a simplified graph edge.

## Properties

### mergedPartIds

> **mergedPartIds**: readonly `string`[]

Defined in: world/infrastructure/topology/types.ts:213

Ordered list of unchained part IDs along `fromNodeId -> toNodeId`.

***

### primaryPartId

> **primaryPartId**: `string`

Defined in: world/infrastructure/topology/types.ts:211

Deterministic primary part ID (`segments[0].partId`).

***

### segments

> **segments**: readonly [`EdgeSegmentProvenance`](EdgeSegmentProvenance.md)[]

Defined in: world/infrastructure/topology/types.ts:217

Contiguous, non-overlapping segment intervals covering `[0, lengthMeters]` in parent edge traversal order.

***

### sourceFeatureIds

> **sourceFeatureIds**: readonly `string`[]

Defined in: world/infrastructure/topology/types.ts:215

Deduplicated, canonically sorted list of all raw OSM `sourceFeatureId`s (including exact duplicates).
