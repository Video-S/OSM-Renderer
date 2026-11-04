# ADR-0007: Isometric Orthographic Camera Framing and Region Navigation

## Metadata

- **Decision ID**: `ADR-0007`
- **Status**: `Accepted`
- **Date**: `2026-10-27`
- **Deciders**: `Core Engineering Team`
- **Consulted**: `Camera & UX Team`

---

## Context and Problem

The goal of Goalpost 1 is to provide an intuitive, architectural 3D representation of real-world urban maps. Standard perspective cameras introduce strong vanishing-point foreshortening: vertical building extrusions lean outward toward the screen edges, parallel roads converge, and scale varies dramatically between the foreground and background.

Additionally, fitting a rotated 3D scene (viewed at a $45^\circ$ azimuth and $55^\circ$ tilt) to an arbitrary viewport aspect ratio ($16:9$, $4:3$, vertical mobile) without clipping tall buildings or leaving huge empty letterbox margins requires robust projective math.

---

## Decision

We implement an **Isometric Orthographic Camera System** with projected bounds framing in `src/scene/CameraController.tsx`:

1. **Orthographic Isometric Projection**:
   - Uses `THREE.OrthographicCamera` to eliminate perspective distortion. Parallel streets remain strictly parallel, and vertical walls extrude uniformly upward.
   - Default polar tilt: $\sim 55.4^\circ$ (`Math.PI / 3.25`), the canonical isometric angle.
   - Default azimuth: $45^\circ$ (`Math.PI / 4`).
2. **Projected Bounding-Box Framing (`computeProjectedBoundsFraming`)**:
   - Ground corners of the 2D bounding box `[minX, minZ]` to `[maxX, maxZ]` are projected into camera screen coordinates $(u, v)$ accounting for view azimuth and tilt foreshortening.
   - Applies an **octagonal inscribed factor of `0.78`**: Square bounding boxes rotated at $45^\circ$ contain large empty diagonal corner regions; the 0.78 factor frames the actual urban neighborhood tightly on screen rather than padding empty corners.
   - Computes orthographic zoom as $\min(W / \text{spanU}, H / \text{spanV}) \times \text{paddingFactor}$ clamped within $[0.15, 8.0]$.
3. **Dynamic Frustum Depth Planes (`computeSceneFrustumPlanes`)**:
   - Calculates `near` and `far` clipping planes from the scene diagonal and `verticalEnvelope` (maximum extrusion height), preventing tall towers ($> 100\text{ m}$) from clipping when viewing at low glancing angles ($72^\circ$).
4. **Interactive Controls**:
   - Drei `MapControls` for horizontal panning, orbital rotation, pitch tilt, and scroll-wheel zooming.
   - Dedicated "Reset / Frame Region" button that animates the camera back to the optimal bounding-box frame.
   - Discrete $45^\circ$ stepped rotation buttons.

---

## Alternatives Considered

1. **Perspective Camera with FOV Tuning**:
   - *Pros*: Familiar first-person perspective.
   - *Cons*: Severe keystoning of vertical building walls near screen edges, scale distortion, and difficult distance-based zoom calibration.
2. **Fixed Bounding Sphere Framing**:
   - *Pros*: Direction-independent.
   - *Cons*: Leaves excessive empty space around rectangular urban maps; poor fit on widescreen displays.

---

## Consequences and Trade-Offs

### Positive
- Crisp, architectural isometric visual style.
- Consistent metric scale across the entire screen regardless of distance from the camera.
- Robust framing: The map always fills the viewport comfortably across mobile and desktop displays.

### Negative / Neutral
- Infinite depth perception: Without perspective cues, depth ordering relies entirely on Three.js depth buffer testing and lighting shadows.

---

## Related Source Modules

- `src/scene/CameraController.tsx`
- `src/scene/MapScene.tsx`

---

## Tests and Evidence

- `src/world/GeometryBuilder.test.ts`:
  - `computeProjectedBoundsFraming and computeSceneFrustumPlanes produce valid framing and depth bounds`
- `src/world/JunctionAndTopology.test.ts`:
  - `computeProjectedBoundsFraming fits loaded map bounds to viewport aspect ratio and tilt`

---

## Superseded or Related Decisions

- Related to `ADR-0001` (World Coordinates) and `ADR-0003` (Region Clipping).
