[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / prepareInfrastructureRenderPreview

# Function: prepareInfrastructureRenderPreview()

> **prepareInfrastructureRenderPreview**(`input`, `options?`): [`InfrastructureRenderPreviewResult`](../interfaces/InfrastructureRenderPreviewResult.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:1797

Prepares the unified `InfrastructureGraph` and `InfrastructureRenderDescriptorBundle`
consumed by the production `E2+ / R+` road and railway geometry builders.

## Parameters

### input

[`TopologySourceData`](../../../topology/types/interfaces/TopologySourceData.md) \| [`ProcessedMapData`](../../../../../types/MapFeature/interfaces/ProcessedMapData.md)

### options?

`Partial`\<[`InfrastructureRenderOptions`](../interfaces/InfrastructureRenderOptions.md)\>

## Returns

[`InfrastructureRenderPreviewResult`](../interfaces/InfrastructureRenderPreviewResult.md)
