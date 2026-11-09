[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/ZFightingValidator](../README.md) / queryActiveWebGLDepthBits

# Function: queryActiveWebGLDepthBits()

> **queryActiveWebGLDepthBits**(`gl?`): `number`

Defined in: world/ZFightingValidator.ts:343

Queries the active depth buffer bit-depth from a WebGLRenderingContext when available,
defaulting to testing both 16-bit (WebGL minimum guarantee) and 24-bit fixed-point depth buffers.

## Parameters

### gl?

`WebGLRenderingContext` \| `WebGL2RenderingContext`

## Returns

`number`
