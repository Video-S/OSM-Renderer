[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / prepareInfrastructureRenderPreview

# Function: prepareInfrastructureRenderPreview()

> **prepareInfrastructureRenderPreview**(`input`, `options?`): [`InfrastructureRenderPreviewResult`](../interfaces/InfrastructureRenderPreviewResult.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:1799

Prepares the Stage E1 infrastructure render preview for a dataset.

- When both `options.roads` and `options.railways` are `'legacy'` (the default),
  returns immediately with `graph: null, descriptors: null` and zero CPU overhead.
- When either `options.roads` or `options.railways` is `'graph-preview'`,
  builds **one shared `InfrastructureGraph`** for the dataset, adapts it into
  `InfrastructureRenderDescriptorBundle`, and validates its contracts.

## Parameters

### input

[`TopologySourceData`](../../../topology/types/interfaces/TopologySourceData.md) \| [`ProcessedMapData`](../../../../../types/MapFeature/interfaces/ProcessedMapData.md)

### options?

`Partial`\<[`InfrastructureRenderOptions`](../interfaces/InfrastructureRenderOptions.md)\>

## Returns

[`InfrastructureRenderPreviewResult`](../interfaces/InfrastructureRenderPreviewResult.md)
