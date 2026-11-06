[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / BuiltSceneGeometry

# Interface: BuiltSceneGeometry

Defined in: world/GeometryBuilder.ts:121

## Properties

### barriersGroup

> **barriersGroup**: `Group`

Defined in: world/GeometryBuilder.ts:128

***

### buildingsGroup

> **buildingsGroup**: `Group`

Defined in: world/GeometryBuilder.ts:122

***

### dispose

> **dispose**: () => `void`

Defined in: world/GeometryBuilder.ts:144

#### Returns

`void`

***

### foliageGroup

> **foliageGroup**: `Group`

Defined in: world/GeometryBuilder.ts:129

***

### groundMesh

> **groundMesh**: `Mesh`

Defined in: world/GeometryBuilder.ts:130

***

### infrastructureRenderOptions

> **infrastructureRenderOptions**: [`InfrastructureRenderOptions`](../../infrastructure/rendering/InfrastructureRenderAdapter/interfaces/InfrastructureRenderOptions.md)

Defined in: world/GeometryBuilder.ts:142

***

### infrastructureRenderPreview

> **infrastructureRenderPreview**: [`InfrastructureRenderPreviewResult`](../../infrastructure/rendering/InfrastructureRenderAdapter/interfaces/InfrastructureRenderPreviewResult.md)

Defined in: world/GeometryBuilder.ts:143

***

### interactiveMeshes

> **interactiveMeshes**: `object`

Defined in: world/GeometryBuilder.ts:131

#### buildings

> **buildings**: `Mesh`\<`BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>, `Material`\<`MaterialEventMap`\> \| `Material`\<`MaterialEventMap`\>[], `Object3DEventMap`\>[]

***

### landuseGroup

> **landuseGroup**: `Group`

Defined in: world/GeometryBuilder.ts:127

***

### parksGroup

> **parksGroup**: `Group`

Defined in: world/GeometryBuilder.ts:126

***

### railwaysGroup

> **railwaysGroup**: `Group`

Defined in: world/GeometryBuilder.ts:124

***

### resources

> **resources**: [`SceneResourceManager`](../../SceneResourceManager/classes/SceneResourceManager.md)

Defined in: world/GeometryBuilder.ts:141

***

### roadsGroup

> **roadsGroup**: `Group`

Defined in: world/GeometryBuilder.ts:123

***

### stats

> **stats**: `object`

Defined in: world/GeometryBuilder.ts:134

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

Defined in: world/GeometryBuilder.ts:146

#### Parameters

##### zoom

`number`

#### Returns

`void`

***

### updateTheme

> **updateTheme**: (`theme`) => `void`

Defined in: world/GeometryBuilder.ts:145

#### Parameters

##### theme

[`MapStyleTheme`](../../../types/MapFeature/interfaces/MapStyleTheme.md)

#### Returns

`void`

***

### waterGroup

> **waterGroup**: `Group`

Defined in: world/GeometryBuilder.ts:125
