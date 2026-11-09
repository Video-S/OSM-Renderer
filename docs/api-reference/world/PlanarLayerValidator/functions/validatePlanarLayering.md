[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/PlanarLayerValidator](../README.md) / validatePlanarLayering

# Function: validatePlanarLayering()

> **validatePlanarLayering**(`layers`, `overlappingPairsChecked?`, `conflictsResolved?`, `maxStackDepth?`): [`PlanarValidationReport`](../interfaces/PlanarValidationReport.md)

Defined in: world/PlanarLayerValidator.ts:1446

Validates a list of resolved planar layers.
Checks both:
1. Residual 2D MultiPolygon overlap when `resolvedMultiPolygon` is present (must be <= 1e-4 m²), OR
2. Vertical separation when two unclipped layers share overlapping footprints without Boolean subtraction.

## Parameters

### layers

[`ResolvedPlanarLayer`](../interfaces/ResolvedPlanarLayer.md)[]

### overlappingPairsChecked?

`number` = `0`

### conflictsResolved?

`number` = `0`

### maxStackDepth?

`number` = `1`

## Returns

[`PlanarValidationReport`](../interfaces/PlanarValidationReport.md)
