[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [scene/CameraController](../README.md) / computeSceneFrustumPlanes

# Function: computeSceneFrustumPlanes()

> **computeSceneFrustumPlanes**(`bounds`, `cameraPosition`, `cameraTarget`, `verticalEnvelope?`): `object`

Defined in: scene/CameraController.tsx:122

Computes tight scene-derived orthographic clipping planes [near, far] from the actual
3D world-space scene bounding box ([minX..maxX] x [yMin..yMax] x [minZ..maxZ]) and camera pose.
Prevents near-plane clipping when panning/zooming close to tall structures while maximizing
fixed-point depth-buffer precision.

## Parameters

### bounds

[`BoundingBox2D`](../interfaces/BoundingBox2D.md)

### cameraPosition

\[`number`, `number`, `number`\]

### cameraTarget

\[`number`, `number`, `number`\]

### verticalEnvelope?

[`VerticalEnvelope`](../interfaces/VerticalEnvelope.md) = `...`

## Returns

`object`

### depthSpan

> **depthSpan**: `number`

### far

> **far**: `number`

### near

> **near**: `number`
