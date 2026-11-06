[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / requiresInfrastructureGraphPreview

# Function: requiresInfrastructureGraphPreview()

> **requiresInfrastructureGraphPreview**(`options?`): `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:125

Returns `true` if at least one domain (`roads` or `railways`) is configured for `'graph-preview'`.
When both domains are `'legacy'`, callers must skip `buildInfrastructureGraph` and adapter execution.

## Parameters

### options?

`Partial`\<[`InfrastructureRenderOptions`](../interfaces/InfrastructureRenderOptions.md)\>

## Returns

`boolean`
