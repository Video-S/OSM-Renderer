[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / BuiltSceneGeometry

# Interface: BuiltSceneGeometry

Defined in: world/GeometryBuilder.ts:131

## Properties

### barriersGroup

> **barriersGroup**: `Group`

Defined in: world/GeometryBuilder.ts:138

***

### buildingsGroup

> **buildingsGroup**: `Group`

Defined in: world/GeometryBuilder.ts:132

***

### dispose

> **dispose**: () => `void`

Defined in: world/GeometryBuilder.ts:154

#### Returns

`void`

***

### foliageGroup

> **foliageGroup**: `Group`

Defined in: world/GeometryBuilder.ts:139

***

### groundMesh

> **groundMesh**: `Mesh`

Defined in: world/GeometryBuilder.ts:140

***

### infrastructureRenderOptions

> **infrastructureRenderOptions**: [`InfrastructureRenderOptions`](../../infrastructure/rendering/InfrastructureRenderAdapter/interfaces/InfrastructureRenderOptions.md)

Defined in: world/GeometryBuilder.ts:152

***

### infrastructureRenderPreview

> **infrastructureRenderPreview**: [`InfrastructureRenderPreviewResult`](../../infrastructure/rendering/InfrastructureRenderAdapter/interfaces/InfrastructureRenderPreviewResult.md)

Defined in: world/GeometryBuilder.ts:153

***

### interactiveMeshes

> **interactiveMeshes**: `object`

Defined in: world/GeometryBuilder.ts:141

#### buildings

> **buildings**: `Mesh`\<`BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>, `Material`\<`MaterialEventMap`\> \| `Material`\<`MaterialEventMap`\>[], `Object3DEventMap`\>[]

***

### landuseGroup

> **landuseGroup**: `Group`

Defined in: world/GeometryBuilder.ts:137

***

### parksGroup

> **parksGroup**: `Group`

Defined in: world/GeometryBuilder.ts:136

***

### railwaysGroup

> **railwaysGroup**: `Group`

Defined in: world/GeometryBuilder.ts:134

***

### resources

> **resources**: [`SceneResourceManager`](../../SceneResourceManager/classes/SceneResourceManager.md)

Defined in: world/GeometryBuilder.ts:151

***

### roadsGroup

> **roadsGroup**: `Group`

Defined in: world/GeometryBuilder.ts:133

***

### stats

> **stats**: `object`

Defined in: world/GeometryBuilder.ts:144

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

Defined in: world/GeometryBuilder.ts:156

#### Parameters

##### zoom

`number`

#### Returns

`void`

***

### updateTheme

> **updateTheme**: (`theme`) => `void`

Defined in: world/GeometryBuilder.ts:155

#### Parameters

##### theme

[`MapStyleTheme`](../../../types/MapFeature/interfaces/MapStyleTheme.md)

#### Returns

`void`

***

### waterGroup

> **waterGroup**: `Group`

Defined in: world/GeometryBuilder.ts:135
