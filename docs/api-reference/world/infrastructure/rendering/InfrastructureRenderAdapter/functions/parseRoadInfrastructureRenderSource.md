[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/rendering/InfrastructureRenderAdapter](../README.md) / parseRoadInfrastructureRenderSource

# Function: parseRoadInfrastructureRenderSource()

> **parseRoadInfrastructureRenderSource**(`raw`): [`RoadInfrastructureRenderSource`](../type-aliases/RoadInfrastructureRenderSource.md)

Defined in: world/infrastructure/rendering/InfrastructureRenderAdapter.ts:88

Parses a raw string value into a valid `RoadInfrastructureRenderSource` (`'legacy' | 'graph-preview' | 'graph'`),
resolving any absent or unrecognized value safely to `'legacy'`.

## Parameters

### raw

`string`

## Returns

[`RoadInfrastructureRenderSource`](../type-aliases/RoadInfrastructureRenderSource.md)
