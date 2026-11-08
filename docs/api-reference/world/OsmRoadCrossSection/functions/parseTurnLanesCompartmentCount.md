[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/OsmRoadCrossSection](../README.md) / parseTurnLanesCompartmentCount

# Function: parseTurnLanesCompartmentCount()

> **parseTurnLanesCompartmentCount**(`raw`, `maxLanes?`): `number`

Defined in: world/OsmRoadCrossSection.ts:119

Parses a pipe-delimited `turn:lanes*` tag (e.g. `"left|through|right"` or `"left|"`),
validating that each non-empty compartment contains recognized turn tokens.

## Parameters

### raw

`unknown`

### maxLanes?

`number` = `12`

## Returns

`number`
