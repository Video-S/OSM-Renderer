[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [scene/CameraController](../README.md) / computeProjectedBoundsFraming

# Function: computeProjectedBoundsFraming()

> **computeProjectedBoundsFraming**(`bounds`, `viewportWidth`, `viewportHeight`, `fixedTiltAngle?`, `azimuthAngle?`, `paddingFactor?`): `object`

Defined in: scene/CameraController.tsx:52

Computes projected bounds framing for the orthographic camera.
Projects the 4 ground corners of the bounding box into screen coordinates
taking into account camera azimuth and polar tilt, applying viewport aspect ratio and padding.

## Parameters

### bounds

[`BoundingBox2D`](../interfaces/BoundingBox2D.md)

### viewportWidth

`number`

### viewportHeight

`number`

### fixedTiltAngle?

`number` = `DEFAULT_TILT_ANGLE`

### azimuthAngle?

`number` = `DEFAULT_AZIMUTH`

### paddingFactor?

`number` = `1.25`

## Returns

`object`

### position

> **position**: \[`number`, `number`, `number`\]

### target

> **target**: \[`number`, `number`, `number`\]

### zoom

> **zoom**: `number`
