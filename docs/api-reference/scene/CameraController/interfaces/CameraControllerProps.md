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

Defined in: scene/CameraController.tsx:51

***

### explicitPose?

> `optional` **explicitPose?**: `object`

Defined in: scene/CameraController.tsx:40

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

Defined in: scene/CameraController.tsx:36

***

### frameRegionSignal?

> `optional` **frameRegionSignal?**: `number`

Defined in: scene/CameraController.tsx:32

***

### initialZoom?

> `optional` **initialZoom?**: `number`

Defined in: scene/CameraController.tsx:39

***

### maxZoom?

> `optional` **maxZoom?**: `number`

Defined in: scene/CameraController.tsx:38

***

### minZoom?

> `optional` **minZoom?**: `number`

Defined in: scene/CameraController.tsx:37

***

### onRegisterImperativePoseSetter?

> `optional` **onRegisterImperativePoseSetter?**: (`setter`) => `void`

Defined in: scene/CameraController.tsx:46

#### Parameters

##### setter

(`target`, `zoom`, `azimuthDeg?`) => `void`

#### Returns

`void`

***

### onResetComplete?

> `optional` **onResetComplete?**: () => `void`

Defined in: scene/CameraController.tsx:34

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

Defined in: scene/CameraController.tsx:35

***

### verticalEnvelope?

> `optional` **verticalEnvelope?**: [`VerticalEnvelope`](VerticalEnvelope.md)

Defined in: scene/CameraController.tsx:30
