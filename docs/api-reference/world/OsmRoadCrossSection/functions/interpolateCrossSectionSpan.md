[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/OsmRoadCrossSection](../README.md) / interpolateCrossSectionSpan

# Function: interpolateCrossSectionSpan()

> **interpolateCrossSectionSpan**(`profile`, `segStartOrT0`, `segEndOrT1`, `spanStart?`, `spanEnd?`): [`RoadCrossSectionProfile`](../interfaces/RoadCrossSectionProfile.md)

Defined in: world/OsmRoadCrossSection.ts:743

Linearly interpolates a `RoadCrossSectionProfile` onto the sub-span `[spanStart, spanEnd]`
within `[segStartArcLength, segEndArcLength]` (or normalized `[t0, t1]` when 3 arguments are passed).

## Parameters

### profile

[`RoadCrossSectionProfile`](../interfaces/RoadCrossSectionProfile.md)

### segStartOrT0

`number`

### segEndOrT1

`number`

### spanStart?

`number`

### spanEnd?

`number`

## Returns

[`RoadCrossSectionProfile`](../interfaces/RoadCrossSectionProfile.md)
