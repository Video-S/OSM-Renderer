[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / normalizeInfrastructureRenderOptions

# Function: normalizeInfrastructureRenderOptions()

> **normalizeInfrastructureRenderOptions**(`options?`): [`InfrastructureRenderOptions`](../interfaces/InfrastructureRenderOptions.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:81

Normalizes partial or undefined `InfrastructureRenderOptions` so both `roads` and `railways`
are guaranteed to be `'legacy' | 'graph-preview'`.

## Parameters

### options?

`Partial`\<[`InfrastructureRenderOptions`](../interfaces/InfrastructureRenderOptions.md)\>

## Returns

[`InfrastructureRenderOptions`](../interfaces/InfrastructureRenderOptions.md)
