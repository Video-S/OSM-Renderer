/**
 * Incremental Offscreen GPU Resource Preparer (TKT-041-F1)
 *
 * Three.js (`0.186.1`) verification note:
 *   `WebGLRenderer.compile(scene, camera)` compiles shader programs/materials only;
 *   it does NOT upload `BufferGeometry` vertex/index buffers or `InstancedMesh`
 *   `instanceMatrix`/`instanceColor` buffers to WebGL. Those `gl.bufferData` uploads
 *   occur inside `WebGLObjects.update(object)` -> `WebGLGeometries.update(...)` and
 *   `WebGLAttributes.update(...)` during `WebGLRenderer.render(...)`.
 *
 * Supported public-API mechanism:
 *   To distribute GPU buffer uploads of off-scene destination tiles across multiple
 *   frames WITHOUT touching private renderer internals, without rendering duplicate
 *   visible geography, and without exposing extra picking targets, this preparer uses:
 *     - A private 1×1 `THREE.WebGLRenderTarget`
 *     - An isolated staging `THREE.Scene` (tagged `userData.__isGpuPrepStagingScene = true`
 *       so `MapScene.tsx`'s frame telemetry wrapper passes it straight through without
 *       recording a synthetic frame or GPU timer query)
 *     - A tiny `THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1)`
 *
 *   For each bounded batch of meshes/instanced batches belonging to a detached
 *   `prepared_inactive` tile, the preparer temporarily moves the exact `Mesh` or
 *   `InstancedMesh` into the 1×1 staging scene (disabling shadow maps and preserving
 *   `renderTarget`, `autoClear`, `xr.enabled`, `parent`, `frustumCulled`, and `visible`),
 *   invokes public `renderer.render(stagingScene, stagingCamera)`, and restores the exact
 *   original parent/child order synchronously in a `finally` block.
 *
 *   Because the exact `BufferGeometry` and `InstancedMesh` instances are rendered,
 *   Three.js registers their real `dispose` listeners (`onGeometryDispose` /
 *   `onInstancedMeshDispose`), ensuring 100% clean GPU buffer cleanup on later eviction.
 *
 * Important timing caveat:
 *   `submitMs` measures synchronous CPU submission time (`renderer.render` issuing
 *   `gl.bufferData` / VAO setup commands), NOT asynchronous GPU DMA/execution completion.
 */

import * as THREE from 'three';
import type { ReconstructedTileSceneResult } from './TileSceneReconstructor';

export const GPU_PREP_STAGING_SCENE_FLAG = '__isGpuPrepStagingScene';

export interface GpuUploadMeshUnit {
  mesh: THREE.Mesh;
  estimatedBytes: number;
  isInstanced: boolean;
}

export interface TileGpuPrepState {
  tileKey: string;
  units: GpuUploadMeshUnit[];
  nextUnitIndex: number;
  totalUnits: number;
  uploadedUnits: number;
  totalEstimatedBytes: number;
  uploadedEstimatedBytes: number;
  contextEpoch: number;
  complete: boolean;
}

export interface GpuPrepStepResult {
  uploadedUnits: number;
  uploadedEstimatedBytes: number;
  /** Synchronous CPU submission time (`renderer.render` / adapter call); NOT GPU completion time. */
  uploadSubmitMs: number;
  tileCompleted: boolean;
  reusedAlreadyPrepared: boolean;
}

export interface GpuPrepUploadAdapter {
  /** Upload a single mesh/instanced batch using supported GPU APIs. */
  uploadMeshUnit(unit: GpuUploadMeshUnit): void;
  /** Optional context epoch accessor for context-loss invalidation. */
  getContextEpoch(): number;
  /** Dispose offscreen staging resources (e.g. 1×1 WebGLRenderTarget). */
  dispose(): void;
}

export interface IncrementalGpuPreparerStats {
  attachedRenderer: boolean;
  contextLost: boolean;
  contextEpoch: number;
  totalTilesStarted: number;
  totalTilesCompleted: number;
  totalTilesReused: number;
  totalTilesCancelled: number;
  totalUnitsUploaded: number;
  totalEstimatedBytesUploaded: number;
  totalUploadSubmitMs: number;
  activePendingTiles: number;
}

/**
 * Estimates vertex + index + instanced buffer bytes that will be uploaded to WebGL
 * for a single `Mesh` or `InstancedMesh`.
 */
export function estimateMeshGpuUploadBytes(mesh: THREE.Mesh): number {
  let bytes = 0;
  const geom = mesh.geometry as THREE.BufferGeometry | undefined;
  if (geom) {
    if (geom.index && geom.index.array) {
      bytes += geom.index.array.byteLength;
    }
    const attrs = geom.attributes;
    for (const key in attrs) {
      const attr = attrs[key];
      if (attr && (attr as THREE.BufferAttribute).array) {
        bytes += (attr as THREE.BufferAttribute).array.byteLength;
      }
    }
  }
  if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
    const inst = mesh as THREE.InstancedMesh;
    if (inst.instanceMatrix?.array) {
      bytes += inst.instanceMatrix.array.byteLength;
    }
    if (inst.instanceColor?.array) {
      bytes += inst.instanceColor.array.byteLength;
    }
  }
  return bytes;
}

/**
 * Collects all drawable `Mesh` / `InstancedMesh` units from a reconstructed tile scene
 * in deterministic layer order (largest / heaviest layers first or scene order).
 */
export function collectTileGpuUploadUnits(
  reconstructed: ReconstructedTileSceneResult
): GpuUploadMeshUnit[] {
  const s = reconstructed.scene;
  const groups: THREE.Group[] = [
    s.buildingsGroup,
    s.roadsGroup,
    s.railwaysGroup,
    s.waterGroup,
    s.parksGroup,
    s.landuseGroup,
    s.barriersGroup,
    s.foliageGroup,
  ];
  const units: GpuUploadMeshUnit[] = [];
  for (let g = 0; g < groups.length; g++) {
    const grp = groups[g];
    if (grp.children.length === 0) continue;
    grp.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      const isInstanced = Boolean((mesh as THREE.InstancedMesh).isInstancedMesh);
      if (isInstanced && (mesh as THREE.InstancedMesh).count <= 0) {
        return;
      }
      const estimatedBytes = estimateMeshGpuUploadBytes(mesh);
      if (estimatedBytes <= 0) return;
      units.push({ mesh, estimatedBytes, isInstanced });
    });
  }
  return units;
}

/**
 * Public-API Three.js WebGL2 offscreen 1×1 staging adapter.
 * Uses only documented Three.js APIs: `WebGLRenderTarget`, `Scene`, `OrthographicCamera`,
 * `renderer.setRenderTarget`, and `renderer.render`.
 */
export class ThreeWebGLOffscreenUploadAdapter implements GpuPrepUploadAdapter {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly renderTarget: THREE.WebGLRenderTarget;
  private readonly stagingScene: THREE.Scene;
  private readonly stagingCamera: THREE.OrthographicCamera;
  private contextEpoch = 1;
  private contextLost = false;
  private disposed = false;

  private readonly onContextLost: (event: Event) => void;
  private readonly onContextRestored: () => void;

  constructor(
    renderer: THREE.WebGLRenderer,
    onContextEpochChange?: (epoch: number, lost: boolean) => void
  ) {
    this.renderer = renderer;
    this.renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
    this.stagingScene = new THREE.Scene();
    this.stagingScene.name = 'TKT041_F1_GpuPrepStagingScene';
    this.stagingScene.userData[GPU_PREP_STAGING_SCENE_FLAG] = true;
    this.stagingCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    this.stagingCamera.position.set(0, 0, 1);
    this.stagingCamera.lookAt(0, 0, 0);
    this.stagingCamera.updateMatrixWorld(true);
    this.stagingCamera.updateProjectionMatrix();

    this.onContextLost = () => {
      this.contextLost = true;
      this.contextEpoch += 1;
      onContextEpochChange?.(this.contextEpoch, true);
    };
    this.onContextRestored = () => {
      this.contextLost = false;
      this.contextEpoch += 1;
      onContextEpochChange?.(this.contextEpoch, false);
    };

    const dom = renderer.domElement;
    if (dom && typeof dom.addEventListener === 'function') {
      dom.addEventListener('webglcontextlost', this.onContextLost, false);
      dom.addEventListener('webglcontextrestored', this.onContextRestored, false);
    }
  }

  get isContextLost(): boolean {
    return this.contextLost;
  }

  getContextEpoch(): number {
    return this.contextEpoch;
  }

  uploadMeshUnit(unit: GpuUploadMeshUnit): void {
    if (this.disposed || this.contextLost) return;
    const mesh = unit.mesh;
    const origParent = mesh.parent;
    const origIndex = origParent ? origParent.children.indexOf(mesh) : -1;
    const origFrustumCulled = mesh.frustumCulled;
    const origVisible = mesh.visible;
    const origCastShadow = mesh.castShadow;
    const origReceiveShadow = mesh.receiveShadow;

    const prevTarget = this.renderer.getRenderTarget();
    const prevAutoClear = this.renderer.autoClear;
    const prevShadowEnabled = this.renderer.shadowMap.enabled;
    const prevXrEnabled = this.renderer.xr.enabled;

    try {
      mesh.frustumCulled = false;
      mesh.visible = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;

      // Move detached tile mesh into isolated 1x1 staging scene (tile itself is NOT in MapRoot)
      this.stagingScene.add(mesh);

      this.renderer.shadowMap.enabled = false;
      this.renderer.xr.enabled = false;
      this.renderer.autoClear = false;
      this.renderer.setRenderTarget(this.renderTarget);
      this.renderer.render(this.stagingScene, this.stagingCamera);
    } finally {
      this.stagingScene.remove(mesh);
      mesh.frustumCulled = origFrustumCulled;
      mesh.visible = origVisible;
      mesh.castShadow = origCastShadow;
      mesh.receiveShadow = origReceiveShadow;

      if (origParent) {
        origParent.add(mesh);
        if (origIndex >= 0 && origIndex < origParent.children.length - 1) {
          const moved = origParent.children.pop()!;
          origParent.children.splice(origIndex, 0, moved);
        }
      }

      this.renderer.setRenderTarget(prevTarget);
      this.renderer.autoClear = prevAutoClear;
      this.renderer.shadowMap.enabled = prevShadowEnabled;
      this.renderer.xr.enabled = prevXrEnabled;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const dom = this.renderer.domElement;
    if (dom && typeof dom.removeEventListener === 'function') {
      dom.removeEventListener('webglcontextlost', this.onContextLost, false);
      dom.removeEventListener('webglcontextrestored', this.onContextRestored, false);
    }
    this.stagingScene.clear();
    this.renderTarget.dispose();
  }
}

/**
 * Manages per-tile incremental GPU resource preparation state, byte/unit/time pacing,
 * reuse across cancel/re-enter/cache hits, and context-loss invalidation.
 */
export class IncrementalGpuPreparer {
  private adapter: GpuPrepUploadAdapter | null = null;
  private ownsAdapter = false;
  private contextLost = false;
  private contextEpoch = 1;
  private readonly nowFn: () => number;

  /** Tracks in-progress or completed prep state keyed by `ReconstructedTileSceneResult` object identity. */
  private readonly stateByTile = new WeakMap<
    ReconstructedTileSceneResult,
    TileGpuPrepState
  >();
  private readonly activePendingKeys = new Set<string>();

  private totalTilesStarted = 0;
  private totalTilesCompleted = 0;
  private totalTilesReused = 0;
  private totalTilesCancelled = 0;
  private totalUnitsUploaded = 0;
  private totalEstimatedBytesUploaded = 0;
  private totalUploadSubmitMs = 0;

  constructor(options?: {
    adapter?: GpuPrepUploadAdapter | null;
    nowFn?: () => number;
  }) {
    this.nowFn = options?.nowFn ?? (() => performance.now());
    if (options?.adapter) {
      this.adapter = options.adapter;
      this.ownsAdapter = false;
      this.contextEpoch = options.adapter.getContextEpoch();
    }
  }

  get hasAdapter(): boolean {
    return this.adapter !== null;
  }

  get isContextLost(): boolean {
    return this.contextLost;
  }

  attachRenderer(renderer: THREE.WebGLRenderer | null): void {
    if (this.adapter && this.ownsAdapter) {
      this.adapter.dispose();
    }
    this.adapter = null;
    this.ownsAdapter = false;
    this.contextLost = false;
    this.activePendingKeys.clear();
    this.contextEpoch += 1;

    if (renderer) {
      this.adapter = new ThreeWebGLOffscreenUploadAdapter(
        renderer,
        (epoch, lost) => {
          this.contextEpoch = epoch;
          this.contextLost = lost;
          this.activePendingKeys.clear();
        }
      );
      this.ownsAdapter = true;
      this.contextEpoch = this.adapter.getContextEpoch();
    }
  }

  setAdapter(adapter: GpuPrepUploadAdapter | null): void {
    if (this.adapter && this.ownsAdapter) {
      this.adapter.dispose();
    }
    this.adapter = adapter;
    this.ownsAdapter = false;
    this.contextLost = false;
    this.activePendingKeys.clear();
    this.contextEpoch = adapter ? adapter.getContextEpoch() : this.contextEpoch + 1;
  }

  /**
   * Simulates or signals a WebGL context loss/restoration (invalidates all prepared tiles).
   */
  invalidateAllForContextLoss(lost = false): void {
    this.contextLost = lost;
    this.contextEpoch += 1;
    this.activePendingKeys.clear();
  }

  /**
   * Returns true if the given reconstructed tile is already GPU-prepared for the
   * current renderer context epoch (or if no WebGL adapter is attached).
   */
  isTilePrepared(reconstructed: ReconstructedTileSceneResult): boolean {
    if (!this.adapter || this.contextLost) return true;
    const state = this.stateByTile.get(reconstructed);
    if (!state) return false;
    const currentEpoch = this.adapter.getContextEpoch();
    return state.complete && state.contextEpoch === currentEpoch;
  }

  getRemainingUnits(reconstructed: ReconstructedTileSceneResult): number {
    if (!this.adapter || this.contextLost) return 0;
    const state = this.stateByTile.get(reconstructed);
    if (!state) {
      return collectTileGpuUploadUnits(reconstructed).length;
    }
    const currentEpoch = this.adapter.getContextEpoch();
    if (state.contextEpoch !== currentEpoch) {
      return collectTileGpuUploadUnits(reconstructed).length;
    }
    if (state.complete) return 0;
    return Math.max(0, state.totalUnits - state.uploadedUnits);
  }

  /**
   * Marks a tile that was already rendered via the main pass (e.g., an active loaded
   * tile moving to `cached_inactive`) as GPU-prepared for the current context epoch
   * so re-activating it later does not redundantly re-upload its buffers.
   */
  markTilePreparedByMainRender(
    tileKey: string,
    reconstructed: ReconstructedTileSceneResult
  ): void {
    if (!this.adapter || this.contextLost) return;
    const currentEpoch = this.adapter.getContextEpoch();
    const existing = this.stateByTile.get(reconstructed);
    if (existing && existing.complete && existing.contextEpoch === currentEpoch) {
      return;
    }
    this.stateByTile.set(reconstructed, {
      tileKey,
      units: [],
      nextUnitIndex: 0,
      totalUnits: 0,
      uploadedUnits: 0,
      totalEstimatedBytes: 0,
      uploadedEstimatedBytes: 0,
      contextEpoch: currentEpoch,
      complete: true,
    });
    this.activePendingKeys.delete(tileKey);
  }

  /**
   * Cancels in-progress incremental preparation tracking for a tile (e.g. evicted or
   * transition cancelled). Does NOT invalidate already-completed uploads on cached tiles
   * unless `clearCompleted = true`.
   */
  cancelTile(
    tileKey: string,
    reconstructed: ReconstructedTileSceneResult | null,
    clearCompleted = false
  ): void {
    const wasPending = this.activePendingKeys.delete(tileKey);
    if (wasPending) {
      this.totalTilesCancelled += 1;
    }
    if (clearCompleted && reconstructed) {
      this.stateByTile.delete(reconstructed);
    }
  }

  /**
   * Executes one bounded incremental GPU upload slice for a single off-scene tile.
   * Always submits at least 1 mesh unit when work remains (starvation prevention),
   * then stops when `maxUnits`, `maxBytes`, or `maxTimeMs` is reached.
   */
  prepareTileSlice(
    tileKey: string,
    reconstructed: ReconstructedTileSceneResult,
    limits: {
      maxUnits: number;
      maxBytes: number;
      maxTimeMs: number;
    }
  ): GpuPrepStepResult {
    if (!this.adapter || this.contextLost) {
      return {
        uploadedUnits: 0,
        uploadedEstimatedBytes: 0,
        uploadSubmitMs: 0,
        tileCompleted: true,
        reusedAlreadyPrepared: true,
      };
    }

    const currentEpoch = this.adapter.getContextEpoch();
    let state = this.stateByTile.get(reconstructed);
    if (state && state.contextEpoch !== currentEpoch) {
      state = undefined;
    }

    if (state && state.complete) {
      this.totalTilesReused += 1;
      this.activePendingKeys.delete(tileKey);
      return {
        uploadedUnits: 0,
        uploadedEstimatedBytes: 0,
        uploadSubmitMs: 0,
        tileCompleted: true,
        reusedAlreadyPrepared: true,
      };
    }

    if (!state) {
      const units = collectTileGpuUploadUnits(reconstructed);
      let totalEstimatedBytes = 0;
      for (let i = 0; i < units.length; i++) {
        totalEstimatedBytes += units[i].estimatedBytes;
      }
      state = {
        tileKey,
        units,
        nextUnitIndex: 0,
        totalUnits: units.length,
        uploadedUnits: 0,
        totalEstimatedBytes,
        uploadedEstimatedBytes: 0,
        contextEpoch: currentEpoch,
        complete: units.length === 0,
      };
      this.stateByTile.set(reconstructed, state);
      this.totalTilesStarted += 1;
      if (state.complete) {
        this.totalTilesCompleted += 1;
        this.activePendingKeys.delete(tileKey);
        return {
          uploadedUnits: 0,
          uploadedEstimatedBytes: 0,
          uploadSubmitMs: 0,
          tileCompleted: true,
          reusedAlreadyPrepared: false,
        };
      }
      this.activePendingKeys.add(tileKey);
    }

    const maxUnits = Math.max(1, Math.floor(limits.maxUnits));
    const maxBytes = Math.max(1, limits.maxBytes);
    const maxTimeMs =
      Number.isFinite(limits.maxTimeMs) && limits.maxTimeMs > 0
        ? limits.maxTimeMs
        : Number.POSITIVE_INFINITY;

    const t0 = this.nowFn();
    let uploadedUnits = 0;
    let uploadedBytes = 0;

    while (state.nextUnitIndex < state.units.length) {
      if (uploadedUnits > 0) {
        if (uploadedUnits >= maxUnits) break;
        if (uploadedBytes >= maxBytes) break;
        if (this.nowFn() - t0 >= maxTimeMs) break;
      }
      const unit = state.units[state.nextUnitIndex];
      this.adapter.uploadMeshUnit(unit);
      state.nextUnitIndex += 1;
      state.uploadedUnits += 1;
      state.uploadedEstimatedBytes += unit.estimatedBytes;
      uploadedUnits += 1;
      uploadedBytes += unit.estimatedBytes;
    }

    const submitMs = Math.max(0, this.nowFn() - t0);
    this.totalUnitsUploaded += uploadedUnits;
    this.totalEstimatedBytesUploaded += uploadedBytes;
    this.totalUploadSubmitMs += submitMs;

    if (state.nextUnitIndex >= state.units.length) {
      state.complete = true;
      // Release temporary unit array references once uploaded
      state.units = [];
      this.activePendingKeys.delete(tileKey);
      this.totalTilesCompleted += 1;
    }

    return {
      uploadedUnits,
      uploadedEstimatedBytes: uploadedBytes,
      uploadSubmitMs: submitMs,
      tileCompleted: state.complete,
      reusedAlreadyPrepared: false,
    };
  }

  getStats(): IncrementalGpuPreparerStats {
    return {
      attachedRenderer: this.adapter !== null,
      contextLost: this.contextLost,
      contextEpoch: this.adapter ? this.adapter.getContextEpoch() : this.contextEpoch,
      totalTilesStarted: this.totalTilesStarted,
      totalTilesCompleted: this.totalTilesCompleted,
      totalTilesReused: this.totalTilesReused,
      totalTilesCancelled: this.totalTilesCancelled,
      totalUnitsUploaded: this.totalUnitsUploaded,
      totalEstimatedBytesUploaded: this.totalEstimatedBytesUploaded,
      totalUploadSubmitMs: Number(this.totalUploadSubmitMs.toFixed(3)),
      activePendingTiles: this.activePendingKeys.size,
    };
  }

  resetStats(): void {
    this.totalTilesStarted = 0;
    this.totalTilesCompleted = 0;
    this.totalTilesReused = 0;
    this.totalTilesCancelled = 0;
    this.totalUnitsUploaded = 0;
    this.totalEstimatedBytesUploaded = 0;
    this.totalUploadSubmitMs = 0;
  }

  dispose(): void {
    if (this.adapter && this.ownsAdapter) {
      this.adapter.dispose();
    }
    this.adapter = null;
    this.ownsAdapter = false;
    this.activePendingKeys.clear();
  }
}
