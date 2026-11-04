[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/PlanarLayerValidator](../README.md) / conditionRing

# Function: conditionRing()

> **conditionRing**(`ring`): \[`number`, `number`\][]

Defined in: world/PlanarLayerValidator.ts:215

Step 1A & 1B: Two-step ring conditioning in Float64 local meters:
1. Snap coordinates to 0.1 mm (1e-4 m) grid to stabilize sweep-line event ordering.
2. Remove consecutive vertices closer than 1 mm (1e-3 m) and 180-degree zero-width fold-back spikes.

## Parameters

### ring

\[`number`, `number`\][]

## Returns

\[`number`, `number`\][]
