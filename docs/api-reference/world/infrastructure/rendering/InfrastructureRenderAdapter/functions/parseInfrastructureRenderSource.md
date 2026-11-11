[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / parseInfrastructureRenderSource

# Function: parseInfrastructureRenderSource()

> **parseInfrastructureRenderSource**(`raw`, `domain?`): [`InfrastructureRenderSource`](../type-aliases/InfrastructureRenderSource.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:241

Parses a raw string value into a valid `InfrastructureRenderSource` for the specified domain
(defaults to `'roads'`), resolving any absent or unrecognized value safely to `'legacy'`.

## Parameters

### raw

`string`

### domain?

`"roads"` \| `"railways"` = `'roads'`

## Returns

[`InfrastructureRenderSource`](../type-aliases/InfrastructureRenderSource.md)
