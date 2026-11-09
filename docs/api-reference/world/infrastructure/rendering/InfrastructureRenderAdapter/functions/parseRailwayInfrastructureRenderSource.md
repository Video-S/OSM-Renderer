[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / parseRailwayInfrastructureRenderSource

# Function: parseRailwayInfrastructureRenderSource()

> **parseRailwayInfrastructureRenderSource**(`raw`): [`RailwayInfrastructureRenderSource`](../type-aliases/RailwayInfrastructureRenderSource.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:103

Parses a raw string value into a valid `RailwayInfrastructureRenderSource` (`'legacy' | 'graph-preview'`),
resolving any absent or unrecognized value (including `'graph'` during Stage E2) safely to `'legacy'`.

## Parameters

### raw

`string`

## Returns

[`RailwayInfrastructureRenderSource`](../type-aliases/RailwayInfrastructureRenderSource.md)
