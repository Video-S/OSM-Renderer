[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/ZFightingValidator](../README.md) / clip2DTriangles

# Function: clip2DTriangles()

> **clip2DTriangles**(`triA`, `triB`): \[`number`, `number`\][]

Defined in: world/ZFightingValidator.ts:242

Exact 2D convex polygon clipping (Sutherland-Hodgman) for two 2D triangles.
Since every triangle is convex, clipping triangle A against the 3 half-planes of triangle B
is mathematically exact and allocation-light.

## Parameters

### triA

\[`number`, `number`\][]

### triB

\[`number`, `number`\][]

## Returns

\[`number`, `number`\][]
