[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [scene/CameraController](../README.md) / CameraControllerProps

# Interface: CameraControllerProps

Defined in: scene/CameraController.tsx:28

## Properties

### bounds?

> `optional` **bounds?**: [`BoundingBox2D`](BoundingBox2D.md)

Defined in: scene/CameraController.tsx:29

***

### controlsEnabled?

> `optional` **controlsEnabled?**: `boolean`

Defined in: scene/CameraController.tsx:54

***

### explicitPose?

> `optional` **explicitPose?**: `object`

Defined in: scene/CameraController.tsx:42

#### animate?

> `optional` **animate?**: `boolean`

#### azimuthRad?

> `optional` **azimuthRad?**: `number`

#### signal

> **signal**: `number`

#### target

> **target**: \[`number`, `number`, `number`\]

#### zoom

> **zoom**: `number`

***

### fixedTiltAngle?

> `optional` **fixedTiltAngle?**: `number`

Defined in: scene/CameraController.tsx:38

***

### frameRegionSignal?

> `optional` **frameRegionSignal?**: `number`

Defined in: scene/CameraController.tsx:32

***

### initialZoom?

> `optional` **initialZoom?**: `number`

Defined in: scene/CameraController.tsx:41

***

### maxZoom?

> `optional` **maxZoom?**: `number`

Defined in: scene/CameraController.tsx:40

***

### minZoom?

> `optional` **minZoom?**: `number`

Defined in: scene/CameraController.tsx:39

***

### onCameraOrientationChange?

> `optional` **onCameraOrientationChange?**: (`orientation`) => `void`

Defined in: scene/CameraController.tsx:36

#### Parameters

##### orientation

###### azimuthDeg

`number`

###### zoom

`number`

#### Returns

`void`

***

### onRegisterImperativePoseSetter?

> `optional` **onRegisterImperativePoseSetter?**: (`setter`) => `void`

Defined in: scene/CameraController.tsx:49

#### Parameters

##### setter

(`target`, `zoom`, `azimuthDeg?`) => `void`

#### Returns

`void`

***

### onResetComplete?

> `optional` **onResetComplete?**: () => `void`

Defined in: scene/CameraController.tsx:35

#### Returns

`void`

***

### resetSignal?

> `optional` **resetSignal?**: `number`

Defined in: scene/CameraController.tsx:31

***

### rotateStepSignal?

> `optional` **rotateStepSignal?**: `number`

Defined in: scene/CameraController.tsx:33

***

### target?

> `optional` **target?**: \[`number`, `number`, `number`\]

Defined in: scene/CameraController.tsx:37

***

### verticalEnvelope?

> `optional` **verticalEnvelope?**: [`VerticalEnvelope`](VerticalEnvelope.md)

Defined in: scene/CameraController.tsx:30

***

### zoomStepSignal?

> `optional` **zoomStepSignal?**: `number`

Defined in: scene/CameraController.tsx:34
