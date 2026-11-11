[**3D Map Viewer API Reference**](../../../../../README.md)

***

[3D Map Viewer API Reference](../../../../../README.md) / [world/infrastructure/topology/RoadNetworkBuilder](../README.md) / normalizeOnewayTag

# Function: normalizeOnewayTag()

> **normalizeOnewayTag**(`rawOnewayTag?`): [`NormalizedOneWay`](../../types/type-aliases/NormalizedOneWay.md)

Defined in: world/infrastructure/topology/RoadNetworkBuilder.ts:69

Normalizes a raw `oneway` tag value into `'forward' | 'reverse' | 'bidirectional' | 'unknown'`
without fabricating traversal rules for unusual values.

## Parameters

### rawOnewayTag?

`string`

## Returns

[`NormalizedOneWay`](../../types/type-aliases/NormalizedOneWay.md)
