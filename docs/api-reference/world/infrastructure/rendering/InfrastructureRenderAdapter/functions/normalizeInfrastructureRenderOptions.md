[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / normalizeInfrastructureRenderOptions

# Function: normalizeInfrastructureRenderOptions()

> **normalizeInfrastructureRenderOptions**(`options?`): [`InfrastructureRenderOptions`](../interfaces/InfrastructureRenderOptions.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:203

Normalizes partial or undefined `InfrastructureRenderOptions` to the canonical production
`E2+ / R+` architecture while preserving optional tunnel inspection overlay booleans.

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

#### showHiddenUndergroundGeometry?

`boolean`

#### showUndergroundTunnelTraces?

`boolean`

## Returns

[`InfrastructureRenderOptions`](../interfaces/InfrastructureRenderOptions.md)
