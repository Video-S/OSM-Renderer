[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / InfrastructureFeatureLineageSummary

# Interface: InfrastructureFeatureLineageSummary

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:697

Pre-computed source-feature lineage maps derived from `EdgeProvenance` for downstream E2/E3 diagnostic accounting.

## Properties

### chainingMap

> **chainingMap**: `Record`\<`string`, `string`[]\>

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:699

Maps simplified multi-segment `edge.id` to the ordered list of constituent `sourceFeatureId`s.

***

### deduplicatedMap

> **deduplicatedMap**: `Record`\<`string`, `string`[]\>

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:701

Maps canonical `sourceFeatureId` to exact-duplicate `sourceFeatureId`s collapsed into it.
