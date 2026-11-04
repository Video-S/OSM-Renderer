[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/ZFightingValidator](../README.md) / countInternalMeshSelfOverlaps

# Function: countInternalMeshSelfOverlaps()

> **countInternalMeshSelfOverlaps**(`triangles`, `meshName`, `areaToleranceSqMeters?`): `number`

Defined in: world/ZFightingValidator.ts:302

Counts self-overlapping triangle pairs within a single mesh (such as `Parking_Markings` or `Pitch_Markings`).

## Parameters

### triangles

[`ExtractedSceneTriangle`](../interfaces/ExtractedSceneTriangle.md)[]

### meshName

`string`

### areaToleranceSqMeters?

`number` = `1e-4`

## Returns

`number`
