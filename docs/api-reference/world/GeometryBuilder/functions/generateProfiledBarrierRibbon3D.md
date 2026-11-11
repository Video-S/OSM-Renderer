[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / generateProfiledBarrierRibbon3D

# Function: generateProfiledBarrierRibbon3D()

> **generateProfiledBarrierRibbon3D**(`profile`, `width`): `BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>

Defined in: world/StructuralContextResolver.ts:862

Extrudes a 3D wall/barrier ribbon with per-vertex variable `[baseY, topY]` elevations (M2.3-E4-T2).
Supports both constant-elevation surface barriers and sloped/depressed cutting or subterranean retaining walls.

## Parameters

### profile

readonly [`BarrierProfileVertex3D`](../../../types/MapFeature/interfaces/BarrierProfileVertex3D.md)[]

### width

`number`

## Returns

`BufferGeometry`\<`NormalBufferAttributes`, `BufferGeometryEventMap`\>
