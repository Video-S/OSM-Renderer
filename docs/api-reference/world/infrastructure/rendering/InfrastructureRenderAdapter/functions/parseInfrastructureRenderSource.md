[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / parseInfrastructureRenderSource

# Function: parseInfrastructureRenderSource()

> **parseInfrastructureRenderSource**(`raw`, `domain?`): [`RoadInfrastructureRenderSource`](../type-aliases/RoadInfrastructureRenderSource.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:114

Parses a raw string value into a valid `InfrastructureRenderSource` for the specified domain
(defaults to `'roads'`), resolving any absent or unrecognized value safely to `'legacy'`.

## Parameters

### raw

`string`

### domain?

`"roads"` \| `"railways"` = `'roads'`

## Returns

[`RoadInfrastructureRenderSource`](../type-aliases/RoadInfrastructureRenderSource.md)
