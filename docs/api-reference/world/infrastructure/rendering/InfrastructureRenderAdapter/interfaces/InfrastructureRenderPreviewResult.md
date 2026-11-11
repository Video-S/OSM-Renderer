[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / InfrastructureRenderPreviewResult

# Interface: InfrastructureRenderPreviewResult

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:875

Result returned by `prepareInfrastructureRenderPreview`.
When both `options.roads` and `options.railways` are `'legacy'`, `graph`, `descriptors`, and `validation` are `null`.

## Properties

### descriptors

> **descriptors**: [`InfrastructureRenderDescriptorBundle`](InfrastructureRenderDescriptorBundle.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:878

***

### graph

> **graph**: [`InfrastructureGraph`](../../../topology/types/interfaces/InfrastructureGraph.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:877

***

### options

> **options**: [`InfrastructureRenderOptions`](InfrastructureRenderOptions.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:876

***

### timing

> **timing**: [`InfrastructureRenderPreviewTiming`](InfrastructureRenderPreviewTiming.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:880

***

### validation

> **validation**: [`InfrastructureRenderValidationReport`](InfrastructureRenderValidationReport.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:879
