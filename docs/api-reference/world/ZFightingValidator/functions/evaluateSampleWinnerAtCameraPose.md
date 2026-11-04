[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/ZFightingValidator](../README.md) / evaluateSampleWinnerAtCameraPose

# Function: evaluateSampleWinnerAtCameraPose()

> **evaluateSampleWinnerAtCameraPose**(`triangles`, `bounds`, `worldX`, `worldZ`, `tiltRadians`, `azimuthRadians`, `viewScaleMeters?`): `object`

Defined in: world/ZFightingValidator.ts:438

Evaluates which feature/mesh wins at a given 3D world sample point (worldX, worldZ)
under an OrthographicCamera configured at the specified tilt, azimuth, and view scale.

## Parameters

### triangles

[`ExtractedSceneTriangle`](../interfaces/ExtractedSceneTriangle.md)[]

### bounds

[`BoundingBox2D`](../../../scene/CameraController/interfaces/BoundingBox2D.md)

### worldX

`number`

### worldZ

`number`

### tiltRadians

`number`

### azimuthRadians

`number`

### viewScaleMeters?

`number` = `400`

## Returns

`object`

### winner16Bit

> **winner16Bit**: [`ExtractedSceneTriangle`](../interfaces/ExtractedSceneTriangle.md)

### winner24Bit

> **winner24Bit**: [`ExtractedSceneTriangle`](../interfaces/ExtractedSceneTriangle.md)
