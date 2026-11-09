[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/PlanarLayerValidator](../README.md) / isGeometricallyContained

# Function: isGeometricallyContained()

> **isGeometricallyContained**(`innerMp`, `outerMp`, `innerPerimeter?`): `boolean`

Defined in: world/PlanarLayerValidator.ts:542

Pure Geometric Containment Test (v5):
Determines whether `innerMp` is geometrically contained within `outerMp`
using ONLY the outside Boolean difference D_out = innerMp \ outerMp:
1. Outside area A_outside <= min(2.5 m², max(0.02 m², 0.05m * Perimeter(innerMp)))
2. Directed boundary excursion of D_out outside outerMp <= 0.25 m
No 92% area-ratio heuristic is applied.

## Parameters

### innerMp

[`MultiPolygonCoords`](../type-aliases/MultiPolygonCoords.md)

### outerMp

[`MultiPolygonCoords`](../type-aliases/MultiPolygonCoords.md)

### innerPerimeter?

`number`

## Returns

`boolean`
