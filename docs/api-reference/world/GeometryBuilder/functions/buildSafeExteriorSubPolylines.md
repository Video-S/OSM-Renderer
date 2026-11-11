[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / buildSafeExteriorSubPolylines

# Function: buildSafeExteriorSubPolylines()

> **buildSafeExteriorSubPolylines**(`points`, `width`, `overlappingBoxes`): \[`number`, `number`\][][]

Defined in: world/GeometryBuilder.ts:944

Documented safe fallback when sweep-line Boolean clipping fails on a degenerate/self-intersecting path:
Clips each individual segment of the path to the exterior of the expanded bounding boxes of all
overlapping road footprints, returning only clean, non-self-intersecting exterior sub-polylines
that never overlap the conflicting road surface.

## Parameters

### points

\[`number`, `number`\][]

### width

`number`

### overlappingBoxes

`object`[]

## Returns

\[`number`, `number`\][][]
