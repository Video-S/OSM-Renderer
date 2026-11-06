[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / buildInfrastructureRenderDescriptors

# Function: buildInfrastructureRenderDescriptors()

> **buildInfrastructureRenderDescriptors**(`graph`, `options?`): [`InfrastructureRenderDescriptorBundle`](../interfaces/InfrastructureRenderDescriptorBundle.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:871

Pure, deterministic Graph-to-Renderer Adapter (`ADR-0009`, Milestone 2.3 Stage E1).

Converts an `InfrastructureGraph` into render-ready road, railway, and cross-domain
descriptors without Three.js, React, or WebGL dependencies and without mutating inputs.

## Parameters

### graph

[`InfrastructureGraph`](../../../topology/types/interfaces/InfrastructureGraph.md)

### options?

`Partial`\<[`InfrastructureRenderOptions`](../interfaces/InfrastructureRenderOptions.md)\>

## Returns

[`InfrastructureRenderDescriptorBundle`](../interfaces/InfrastructureRenderDescriptorBundle.md)
