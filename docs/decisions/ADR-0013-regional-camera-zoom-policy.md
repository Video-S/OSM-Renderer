# ADR-0013: Regional Orthographic Zoom-Out Safety Policy

## Metadata

- **Decision ID**: `ADR-0013`
- **Status**: **Accepted for the current LOD0 regional viewer**
- **Date recorded**: 2026-11-22
- **Evidence**: TKT-031 regional frame-cost measurements, owner regional zoom smoke test, `RegionalMosaicIdentityAndZoomPolicy.test.ts`

## Context and problem

An orthographic camera's screen coverage expands rapidly as zoom decreases. The 16 × 16 km pilot could previously be viewed at `minZoom=0.015`, causing all 256 detailed LOD0 tiles to become visible and producing expensive GPU work. A multi-LOD overview system does not yet exist. Reducing visibility by limiting zoom-out is an interim safeguard, not a geometric or rendering optimization.

## Decision

1. Centralize camera policy in `src/scene/cameraZoomPolicy.ts` and enforce it through `CameraController.tsx` and `src/app/App.tsx`, including wheel/touch controls, initial view, explicit poses, framing, resets, jumps and transitions.
2. Keep ordinary maps and small streaming fixtures (at most **64 tiles**) at **`minZoom=0.15`, `maxZoom=16.0`**.
3. For larger regional streaming mosaics, use the conservative **`minZoom=0.15`, `maxZoom=16.0`** default. This intentionally means a reset/frame-region action may **not** fit all 16+ km into the viewport.
4. Accept the explicit developer URL parameter `?regionalMinZoom=VALUE` only for finite numeric values in **[0.01, 4.0]**. Invalid values are rejected and fall back to `0.15`, with a diagnostic notice. The regional benchmark explicitly opts into **`0.015`** to retain historical full-region LOD0 workload comparisons.
5. Show the **effective** policy, its source and rejected overrides in Developer Tools. A camera URL override does **not** select a server mosaic; the actual loaded manifest controls dataset identity.

## Consequences and alternatives

- Benefit: users cannot accidentally request a full 16 km detailed overview at the default regional zoom setting.
- Cost: zooming out to see the whole of Twente is restricted until multi-level LOD or an equivalent tile-budget strategy is implemented.
- Explicit overrides can still overload the renderer with LOD0 tiles on large datasets. Do not interpret the validation range as a performance guarantee.
- Future LOD1–LOD3 is a separate architectural milestone, not a feature implemented by this policy.

## Related implementation and evidence

- `src/scene/cameraZoomPolicy.ts` and `src/scene/CameraController.tsx`
- `src/app/App.tsx`, `src/components/DevToolsPanel.tsx`
- `benchmarks/regionalFrameCostRunner.ts`
- `src/world/RegionalMosaicIdentityAndZoomPolicy.test.ts`
- [ADR-0007](ADR-0007-orthographic-camera-framing-and-navigation.md), [ADR-0011](ADR-0011-baked-tiles-and-runtime-streaming.md), [TKT-031](../../tickets/TKT-031-regional-frame-cost-investigation.md)

This ADR **extends rather than supersedes** ADR-0007: orthographic projection and framing remain, but effective zoom limits now depend on the active dataset.
