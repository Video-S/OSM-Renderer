[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / InfrastructureRenderPreviewResult

# Interface: InfrastructureRenderPreviewResult

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:680

Result returned by `prepareInfrastructureRenderPreview`.
When both `options.roads` and `options.railways` are `'legacy'`, `graph`, `descriptors`, and `validation` are `null`.

## Properties

### descriptors

> **descriptors**: [`InfrastructureRenderDescriptorBundle`](InfrastructureRenderDescriptorBundle.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:683

***

### graph

> **graph**: [`InfrastructureGraph`](../../../topology/types/interfaces/InfrastructureGraph.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:682

***

### options

> **options**: [`InfrastructureRenderOptions`](InfrastructureRenderOptions.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:681

***

### timing

> **timing**: [`InfrastructureRenderPreviewTiming`](InfrastructureRenderPreviewTiming.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:685

***

### validation

> **validation**: [`InfrastructureRenderValidationReport`](InfrastructureRenderValidationReport.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:684
