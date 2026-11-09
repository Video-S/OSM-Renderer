[**3D Map Viewer API Reference**](../../../README.md)

***

[3D Map Viewer API Reference](../../../README.md) / [world/GeometryBuilder](../README.md) / COVERAGE\_DISCRETIZATION\_RATIO\_TOLERANCE

# Variable: COVERAGE\_DISCRETIZATION\_RATIO\_TOLERANCE

> `const` **COVERAGE\_DISCRETIZATION\_RATIO\_TOLERANCE**: `0.04` = `0.04`

Defined in: world/infrastructure/roads/SurfaceFirstRoadValidator.ts:46

Maximum acceptable area discrepancy ratio between an independent analytical centerline corridor
(with 24-gon round joins/caps) and the emitted 16-gon E2+ mesh union (plus legitimate higher-priority
road occlusion). Accounts for 16-gon vs exact circle discretization (`1 - (16/(2*pi))*sin(2*pi/16) ≈ 2.55%`).
