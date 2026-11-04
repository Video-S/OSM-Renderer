[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/PlanarLayerValidator](../README.md) / computeDirectedBoundaryDistance

# Function: computeDirectedBoundaryDistance()

> **computeDirectedBoundaryDistance**(`sourceMp`, `targetMp`, `maxStepMeters?`): `number`

Defined in: world/PlanarLayerValidator.ts:466

Computes directed segment-to-segment boundary excursion:
sup_{p in boundary(source)} dist(p, boundary(target))
by sampling all vertices and dense sub-segment points (every <= 0.25m) of `source`
against the exact line segments of `target`.

## Parameters

### sourceMp

[`MultiPolygonCoords`](../type-aliases/MultiPolygonCoords.md)

### targetMp

[`MultiPolygonCoords`](../type-aliases/MultiPolygonCoords.md)

### maxStepMeters?

`number` = `0.25`

## Returns

`number`
