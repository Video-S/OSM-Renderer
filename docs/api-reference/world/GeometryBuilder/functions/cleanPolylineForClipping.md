[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / cleanPolylineForClipping

# Function: cleanPolylineForClipping()

> **cleanPolylineForClipping**(`points`): \[`number`, `number`\][]

Defined in: world/GeometryBuilder.ts:820

Cleans a 2D polyline before retrying Boolean clipping by filtering non-finite points,
deduplicating near-coincident consecutive vertices, and removing near-180-degree fold-back spikes.

## Parameters

### points

\[`number`, `number`\][]

## Returns

\[`number`, `number`\][]
