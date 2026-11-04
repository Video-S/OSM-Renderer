[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / BuiltSceneGeometry

# Interface: BuiltSceneGeometry

Defined in: world/GeometryBuilder.ts:67

## Properties

### barriersGroup

> **barriersGroup**: `Group`

Defined in: world/GeometryBuilder.ts:74

***

### buildingsGroup

> **buildingsGroup**: `Group`

Defined in: world/GeometryBuilder.ts:68

***

### dispose

> **dispose**: () => `void`

Defined in: world/GeometryBuilder.ts:88

#### Returns

`void`

***

### foliageGroup

> **foliageGroup**: `Group`

Defined in: world/GeometryBuilder.ts:75

***

### groundMesh

> **groundMesh**: `Mesh`

Defined in: world/GeometryBuilder.ts:76

***

### interactiveMeshes

> **interactiveMeshes**: `object`

Defined in: world/GeometryBuilder.ts:77

#### buildings

> **buildings**: `Mesh`\<`BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>, `Material`\<`MaterialEventMap`\> \| `Material`\<`MaterialEventMap`\>[], `Object3DEventMap`\>[]

***

### landuseGroup

> **landuseGroup**: `Group`

Defined in: world/GeometryBuilder.ts:73

***

### parksGroup

> **parksGroup**: `Group`

Defined in: world/GeometryBuilder.ts:72

***

### railwaysGroup

> **railwaysGroup**: `Group`

Defined in: world/GeometryBuilder.ts:70

***

### resources

> **resources**: [`SceneResourceManager`](../../SceneResourceManager/classes/SceneResourceManager.md)

Defined in: world/GeometryBuilder.ts:87

***

### roadsGroup

> **roadsGroup**: `Group`

Defined in: world/GeometryBuilder.ts:69

***

### stats

> **stats**: `object`

Defined in: world/GeometryBuilder.ts:80

#### forestTreesCount?

> `optional` **forestTreesCount?**: `number`

#### renderedFeaturesCount

> **renderedFeaturesCount**: `number`

#### totalDrawCalls

> **totalDrawCalls**: `number`

#### totalTriangles

> **totalTriangles**: `number`

#### totalVertices

> **totalVertices**: `number`

***

### updateCameraZoom?

> `optional` **updateCameraZoom?**: (`zoom`) => `void`

Defined in: world/GeometryBuilder.ts:90

#### Parameters

##### zoom

`number`

#### Returns

`void`

***

### updateTheme

> **updateTheme**: (`theme`) => `void`

Defined in: world/GeometryBuilder.ts:89

#### Parameters

##### theme

[`MapStyleTheme`](../../../types/MapFeature/interfaces/MapStyleTheme.md)

#### Returns

`void`

***

### waterGroup

> **waterGroup**: `Group`

Defined in: world/GeometryBuilder.ts:71
