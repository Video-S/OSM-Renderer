[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/OsmRoadCrossSection](../README.md) / parseExplicitMetricWidth

# Function: parseExplicitMetricWidth()

> **parseExplicitMetricWidth**(`raw`, `maxAllowedMeters?`): `number`

Defined in: world/OsmRoadCrossSection.ts:84

Parses an explicit metric width string or number (e.g. `"7.2"`, `"7.2 m"`, `"7,2m"`).
Rejects non-positive, non-finite, malformed, compound (`"3.5;4.0"`), or out-of-range values.

## Parameters

### raw

`unknown`

### maxAllowedMeters?

`number` = `120`

## Returns

`number`
