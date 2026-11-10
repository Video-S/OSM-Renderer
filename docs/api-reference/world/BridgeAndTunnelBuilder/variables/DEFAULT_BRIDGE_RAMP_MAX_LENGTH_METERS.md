[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/BridgeAndTunnelBuilder](../README.md) / DEFAULT\_BRIDGE\_RAMP\_MAX\_LENGTH\_METERS

# Variable: DEFAULT\_BRIDGE\_RAMP\_MAX\_LENGTH\_METERS

> `const` **DEFAULT\_BRIDGE\_RAMP\_MAX\_LENGTH\_METERS**: `12` = `12.0`

Defined in: world/BridgeAndTunnelBuilder.ts:29

Canonical bridge approach ramp transition constants:
- Standard/adapted approach ramp length: `min(12.0 m, 30% of mapped bridge length)`.
- At least `40%` (`MIN_CENTRAL_DECK_FRACTION = 0.40`) of a ramped bridge span remains flat at full
  `targetBridgeElevation` (`ROAD_SURFACE + BRIDGE_BASE_CLEARANCE = 2.850 m` for layer 1) so vertical
  clearance over crossed roads/waterways/railways is never reduced.
- Documented Fallback for Ultra-Short Bridges (`mappedBridgeLength < MIN_RAMPED_BRIDGE_SPAN_METERS = 5.0 m`):
  When a standalone bridge span is shorter than `5.0 m`, interior approach ramps cannot fit without collapsing
  the central clearance zone or producing an excessive ramp gradient. The builder preserves 100% of
  `targetBridgeElevation` across the deck (`rampMode = 'abutment_headwall'`, `rampStartLength = 0`,
  `rampEndLength = 0`) and closes the bridge ends with vertical abutment headwalls down to ground level.
