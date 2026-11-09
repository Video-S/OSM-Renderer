[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / requiresInfrastructureGraphPreview

# Function: requiresInfrastructureGraphPreview()

> **requiresInfrastructureGraphPreview**(`options?`): `boolean`

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:173

Returns `true` if at least one domain (`roads` or `railways`) requires `InfrastructureGraph`
and `InfrastructureRenderDescriptorBundle` construction (i.e. `'graph-preview'` or `'graph'`).
When both domains are `'legacy'`, callers must skip `buildInfrastructureGraph` and adapter execution.

## Parameters

### options?

#### railways?

`string`

#### roads?

`string`

## Returns

`boolean`
