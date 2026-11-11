[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / normalizeInfrastructureRenderOptions

# Function: normalizeInfrastructureRenderOptions()

> **normalizeInfrastructureRenderOptions**(`options?`): [`InfrastructureRenderOptions`](../interfaces/InfrastructureRenderOptions.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:255

Normalizes partial or undefined `InfrastructureRenderOptions` so `roads` is guaranteed to be
`'legacy' | 'graph-preview' | 'graph'` and `railways` is guaranteed to be `'legacy' | 'graph-preview'`.

## Parameters

### options?

#### railwayBallastStrategy?

`string`

#### railways?

`string`

#### railwaySwitchPolicy?

`string`

#### roads?

`string`

## Returns

[`InfrastructureRenderOptions`](../interfaces/InfrastructureRenderOptions.md)
