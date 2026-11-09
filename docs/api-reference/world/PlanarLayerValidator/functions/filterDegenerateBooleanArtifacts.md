[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/PlanarLayerValidator](../README.md) / filterDegenerateBooleanArtifacts

# Function: filterDegenerateBooleanArtifacts()

> **filterDegenerateBooleanArtifacts**(`mp`): [`MultiPolygonCoords`](../type-aliases/MultiPolygonCoords.md)

Defined in: world/PlanarLayerValidator.ts:857

Provenance-Preserving Remainder Filter (v5):
Discards ONLY degenerate numerical collapse artifacts produced by floating-point subtraction
(rings with < 3 distinct vertices, area <= 1e-4 m², or sub-millimeter ribbon thinness Area/Perimeter < 0.0005m).
Preserves all legitimate small geometric remainders.

## Parameters

### mp

[`MultiPolygonCoords`](../type-aliases/MultiPolygonCoords.md)

## Returns

[`MultiPolygonCoords`](../type-aliases/MultiPolygonCoords.md)
