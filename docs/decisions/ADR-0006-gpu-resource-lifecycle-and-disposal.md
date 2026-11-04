# ADR-0006: GPU Resource Lifecycle and Deterministic Intermediate Geometry Disposal

## Metadata

- **Decision ID**: `ADR-0006`
- **Status**: `Accepted`
- **Date**: `2026-10-27`
- **Deciders**: `Core Engineering Team`
- **Consulted**: `WebGL & Rendering Performance Team`

---

## Context and Problem

Three.js and WebGL do not automatically garbage collect GPU buffers (VBOs, EBOs), textures, and shaders when JavaScript object references go out of scope. They must be explicitly released via `.dispose()`.

In a procedural map generator:
1. **Intermediate Geometry Leaks**: Thousands of temporary `BufferGeometry` instances are allocated during procedural synthesis (e.g., individual road ribbon segments, extruded building blocks, intermediate triangulated polygons) before being merged into unified meshes via `mergeGeometries`. If these temporary geometries are not disposed immediately during `buildScene()`, browser memory balloons and crashes under repeated dataset reloads.
2. **Scene Reloading Leaks**: Switching regions or unmounting components without cleaning up retained scene meshes leaves orphan WebGL buffers in VRAM.

---

## Decision

We introduce a dedicated **`SceneResourceManager`** (`src/world/SceneResourceManager.ts`) to enforce deterministic, single-pass GPU resource management:

1. **Immediate Intermediate Geometry Cleanup (`releaseIntermediateGeometry`)**:
   - As `GeometryBuilder` creates temporary `BufferGeometry` parts during intermediate stages, it registers them with `resourceManager.registerIntermediateGeometry(geom)`.
   - Once `mergeGeometries()` bundles the parts into the final batched geometry, `resourceManager.releaseIntermediateGeometry()` is invoked immediately, calling `.dispose()` on all temporary buffers before continuing to the next stage.
2. **Tracked Retained Scene Resources**:
   - Geometries, materials, and textures that survive into the final scene graph are registered with `registerGeometry()`, `registerMaterial()`, and `registerTexture()`.
3. **Idempotent Single-Pass Disposal (`BuiltSceneGeometry.dispose`)**:
   - When a dataset is reloaded or the viewer unmounts, `dispose()` traverses the resource manager and invokes `.dispose()` on every registered resource, ensuring zero dangling WebGL allocations. Multiple calls to `.dispose()` are safely handled idempotently without throwing.

---

## Alternatives Considered

1. **Relying on JavaScript Garbage Collection**:
   - *Pros*: Zero manual management code.
   - *Cons*: Fails completely. JavaScript garbage collection does not free WebGL driver GPU memory, rapidly leading to `CONTEXT_LOST_WEBGL` errors.
2. **Full Three.js Scene Traversal on Unmount**:
   - *Pros*: Traverses `scene.traverse((obj) => obj.geometry?.dispose())`.
   - *Cons*: Does not catch intermediate geometries created during synthesis that were never added to the scene graph.

---

## Consequences and Trade-Offs

### Positive
- Zero WebGL VRAM leaks across continuous dataset reloading.
- Low memory footprint: Intermediate geometry memory is freed immediately within each generation phase rather than accumulating until the end of the build.
- Robust and idempotent cleanup verified by automated unit tests.

### Negative / Neutral
- Developer discipline: Any new procedural geometry generator must register intermediate geometries with the resource manager.

---

## Related Source Modules

- `src/world/SceneResourceManager.ts`
- `src/world/GeometryBuilder.ts`
- `src/scene/MapScene.tsx`

---

## Tests and Evidence

- `src/world/GeometryBuilder.test.ts`:
  - `SceneResourceManager immediately disposes intermediate geometries during buildScene and supports idempotent dispose()`
- `src/world/JunctionAndTopology.test.ts`:
  - `SceneResourceManager executes single-pass, idempotent GPU cleanup including releaseIntermediateGeometry`

---

## Superseded or Related Decisions

- Related to `ADR-0005` (Provenance Tracking).
