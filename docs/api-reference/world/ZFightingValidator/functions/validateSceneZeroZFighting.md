[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/ZFightingValidator](../README.md) / validateSceneZeroZFighting

# Function: validateSceneZeroZFighting()

> **validateSceneZeroZFighting**(`scene`, `bounds`, `samplePoints?`): [`ZFightingValidationReport`](../interfaces/ZFightingValidationReport.md)

Defined in: world/ZFightingValidator.ts:542

Runs the comprehensive Two-Layer Z-Fighting Validation Engine on a built 3D scene:
1. Audits resolved surface-fill triangles (`landuseGroup`, `parksGroup`, `waterGroup`) for
   mutual exclusion (overlap area <= 1e-4 m²).
2. Audits `Parking_Markings` and `Pitch_Markings` for zero internal self-overlapping triangles.
3. Audits screen-space projected triangle pairs across polar tilts (15°, 35°, 55.4°, 72°) and azimuths
   for both 16-bit and 24-bit fixed-point depth quantization.
4. Audits interior 3D sample points (at both 400m macro scale and 12m 2.34cm/px marking close-up scale)
   across baseline and +-0.15° micro-perturbed camera orientations.

## Parameters

### scene

[`BuiltSceneGeometry`](../../GeometryBuilder/interfaces/BuiltSceneGeometry.md)

### bounds

[`BoundingBox2D`](../../../scene/CameraController/interfaces/BoundingBox2D.md)

### samplePoints?

[`InteriorSamplePointSpec`](../interfaces/InteriorSamplePointSpec.md)[] = `[]`

## Returns

[`ZFightingValidationReport`](../interfaces/ZFightingValidationReport.md)
