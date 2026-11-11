[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / parseRailwayInfrastructureRenderSource

# Function: parseRailwayInfrastructureRenderSource()

> **parseRailwayInfrastructureRenderSource**(`raw`): [`RailwayInfrastructureRenderSource`](../type-aliases/RailwayInfrastructureRenderSource.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:131

Parses a raw string value into a valid `RailwayInfrastructureRenderSource` (`'legacy' | 'graph-preview' | 'graph' | 'graph-switches'`),
resolving any absent or unrecognized value safely to `'legacy'`.

## Parameters

### raw

`string`

## Returns

[`RailwayInfrastructureRenderSource`](../type-aliases/RailwayInfrastructureRenderSource.md)
