import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import type { InspectableFeatureInfo, MapStyleTheme } from '../../types/MapFeature';
import {
  SceneResourceManager,
  type BuiltSceneGeometry,
  type FaceFeatureRange,
} from '../GeometryBuilder';
import {
  applyFoliageRuntimeStateToBatches,
  computeConservativeInstancedBounds,
  CONSERVATIVE_FOLIAGE_BOUNDS_MARGIN_METERS,
  FoliagePrototypeRegistry,
  isFoliagePrototypeKind,
  normalizeFoliageOptimizationConfig,
  resolveFoliageRuntimeState,
  type FoliageBatchTarget,
  type FoliageOptimizationConfig,
  type FoliageRuntimeState,
} from '../FoliageLodSystem';
import {
  attachInstancedSpatialIndex,
  attachPreparedInstancedSpatialIndex,
  disposeInstancedSpatialIndex,
  type InstancedPickingAggregateStats,
} from '../InstancedSpatialIndex';
import { DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS } from '../infrastructure/rendering/InfrastructureRenderAdapter';
import {
  RAILWAY_DIMENSION_SPEC,
  type SleeperBearerBox3D,
} from '../infrastructure/railways/RailwayTopology';
import { buildUnitSleeperBoxGeometry } from '../infrastructure/railways/RailwayGeometryBuilder';
import {
  isCompactDecodedTilePayload,
  LazyTileFeatureTable,
  materializeSleeperBoxesFromCompact,
  type AnyDecodedTilePayload,
  type CompactInstancedBatchRecord,
  type CompactMeshRecord,
  type PackedFaceRangeLookup,
} from './CompactTileTransport';
import {
  TILE_MESH_FLAG_CAST_SHADOW,
  TILE_MESH_FLAG_FRUSTUM_CULLED,
  TILE_MESH_FLAG_HIDDEN_UNDERGROUND,
  TILE_MESH_FLAG_RECEIVE_SHADOW,
  TILE_MESH_FLAG_STRUCTURAL_3D,
  TILE_MESH_FLAG_UNDERGROUND_GEOM,
  TILE_MESH_FLAG_UNDERGROUND_TRACE,
  TILE_MESH_FLAG_VISIBLE,
  type TileCoordinatePlacementMode,
  type TileInstancedBatchRecord,
  type TileLayerKind,
  type TileMeshRecord,
} from './TilePackContract';
import { ThemeMaterialRegistry } from './ThemeMaterialRegistry';

export interface ReconstructTileSceneOptions {
  materialRegistry: ThemeMaterialRegistry;
  placementMode?: TileCoordinatePlacementMode;
  initialCameraZoom?: number;
  /** Optional shared foliage prototype registry owned by TileStreamManager (avoids per-tile prototype allocation). */
  foliagePrototypeRegistry?: FoliagePrototypeRegistry;
  /** Optional initial foliage optimization config for standalone tile reconstruction. */
  foliageOptimizationConfig?: Partial<FoliageOptimizationConfig>;
  /** Optional externally managed foliage runtime state (pushed uniformly across streamed tiles). */
  foliageRuntimeState?: FoliageRuntimeState;
  /** Optional profiling flag to measure static MeshBVH deserialization timing (default: false). */
  collectStageTimings?: boolean;
  /**
   * TKT-040 Work Package D: eliminate avoidable main-thread preparation work
   * (zero-copy `instanceMatrix` adoption, O(1) bounds from worker BVH root, lazy metadata getters).
   * Defaults to `true` when reconstructing a compact payload, else `false` for baseline parity.
   */
  optimizeMainThreadPrep?: boolean;
}

export interface ReconstructedTileSceneResult {
  scene: BuiltSceneGeometry;
  tileCenterXZ: [number, number];
  overhangBounds: {
    min: [number, number, number];
    max: [number, number, number];
  };
  /** Applies a new shared foliage LOD / trunk suppression / frustum culling state in O(foliage batches). */
  applyFoliageRuntimeState: (state: FoliageRuntimeState) => void;
  foliageBatchCount: number;
  /** Aggregate spatial picking index memory/build stats for this tile's InstancedMesh batches. */
  instancedPickingStats: InstancedPickingAggregateStats;
  /** Breakdown of BVH reconstruction timings when `collectStageTimings` is enabled. */
  stageTimings: {
    staticBvhDeserializeMs: number;
    instancedBvhBuildMs: number;
    instancedBvhAdoptMs: number;
    workerBvhAdoptedCount: number;
    syncBvhFallbackCount: number;
  };
  dispose: () => void;
}

function defineLazyProperty<T>(
  target: Record<string, unknown>,
  key: string,
  compute: () => T
): void {
  let cached: T | undefined;
  let initialized = false;
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get(): T {
      if (!initialized) {
        cached = compute();
        initialized = true;
      }
      return cached!;
    },
    set(value: T) {
      cached = value;
      initialized = true;
    },
  });
}

export function reconstructTileSceneFromDecoded(
  decoded: AnyDecodedTilePayload,
  options: ReconstructTileSceneOptions
): ReconstructedTileSceneResult {
  const isCompact = isCompactDecodedTilePayload(decoded);
  const {
    materialRegistry,
    placementMode = 'tile-local',
    initialCameraZoom = materialRegistry.cameraZoom,
    collectStageTimings = false,
    optimizeMainThreadPrep = isCompact,
  } = options;

  let staticBvhDeserializeMs = 0;
  let syncInstancedBvhBuildMs = 0;
  let instancedBvhAdoptMs = 0;
  let workerBvhAdoptedCount = 0;
  let syncBvhFallbackCount = 0;

  const featureTable = isCompact
    ? new LazyTileFeatureTable(decoded.featureTable)
    : null;
  const legacyFeatureInfos = !isCompact ? decoded.featureInfos : null;

  // Tile-scoped resource manager owns ONLY this tile's BufferGeometries & BVHs,
  // never shared ThemeMaterialRegistry materials.
  const resourceManager = new SceneResourceManager();

  const buildingsGroup = new THREE.Group();
  buildingsGroup.name = 'Buildings';
  const roadsGroup = new THREE.Group();
  roadsGroup.name = 'Roads';
  const railwaysGroup = new THREE.Group();
  railwaysGroup.name = 'Railways';
  const waterGroup = new THREE.Group();
  waterGroup.name = 'Water';
  const parksGroup = new THREE.Group();
  parksGroup.name = 'Parks';
  parksGroup.renderOrder = 3;
  const landuseGroup = new THREE.Group();
  landuseGroup.name = 'Landuse';
  landuseGroup.renderOrder = 1;
  const barriersGroup = new THREE.Group();
  barriersGroup.name = 'Barriers';
  const foliageGroup = new THREE.Group();
  foliageGroup.name = 'Foliage';
  waterGroup.renderOrder = 2;

  const groupByLayer: Record<Exclude<TileLayerKind, 'ground'>, THREE.Group> = {
    buildings: buildingsGroup,
    roads: roadsGroup,
    railways: railwaysGroup,
    water: waterGroup,
    parks: parksGroup,
    landuse: landuseGroup,
    barriers: barriersGroup,
    foliage: foliageGroup,
  };

  const shiftX =
    placementMode === 'study-world-mesh-offset' ? decoded.tileCenterX : 0;
  const shiftZ =
    placementMode === 'study-world-mesh-offset' ? decoded.tileCenterZ : 0;

  let groundMesh: THREE.Mesh | null = null;
  const interactiveBuildings: THREE.Mesh[] = [];
  const railwayChunkGroups = new Map<string, THREE.Group>();
  const railwayZoomTargets: {
    sleepers3D: THREE.Object3D[];
    rails3D: THREE.Object3D[];
    sleepersRibbon: THREE.Object3D[];
    railsRibbon: THREE.Object3D[];
  } = {
    sleepers3D: [],
    rails3D: [],
    sleepersRibbon: [],
    railsRibbon: [],
  };

  const trackRailwayTarget = (obj: THREE.Object3D, name: string) => {
    const baseName = name.split('_chunk_')[0];
    if (baseName === 'Railway_Sleepers_3D') {
      railwayZoomTargets.sleepers3D.push(obj);
    } else if (baseName === 'Railway_Rails_3D') {
      railwayZoomTargets.rails3D.push(obj);
    } else if (baseName === 'Railway_Sleepers') {
      railwayZoomTargets.sleepersRibbon.push(obj);
    } else if (baseName === 'Railway_Rails') {
      railwayZoomTargets.railsRibbon.push(obj);
    }
  };

  const addToLayerGroup = (
    layer: TileLayerKind,
    mesh: THREE.Object3D,
    isChunkedRailwayChild: boolean,
    visibleFlag: boolean
  ) => {
    if (layer === 'ground') {
      groundMesh = mesh as THREE.Mesh;
      return;
    }
    const targetLayerGroup = groupByLayer[layer];
    if (layer === 'railways' && isChunkedRailwayChild) {
      const baseName = mesh.name.split('_chunk_')[0];
      let chunkParent = railwayChunkGroups.get(baseName);
      if (!chunkParent) {
        chunkParent = new THREE.Group();
        chunkParent.name = baseName;
        chunkParent.visible = visibleFlag;
        chunkParent.userData = {};
        railwayChunkGroups.set(baseName, chunkParent);
        targetLayerGroup.add(chunkParent);
        trackRailwayTarget(chunkParent, baseName);
      }
      chunkParent.add(mesh);
      return;
    }
    targetLayerGroup.add(mesh);
    if (layer === 'railways') {
      trackRailwayTarget(mesh, mesh.name);
    }
  };

  // Reconstruct static meshes
  for (let mi = 0; mi < decoded.meshes.length; mi++) {
    const m = decoded.meshes[mi];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    if (m.normals)
      geo.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    if (m.uvs) geo.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
    if (m.switchAttrs)
      geo.setAttribute(
        'aSwitchAttr',
        new THREE.BufferAttribute(m.switchAttrs, 2)
      );
    if (m.colors)
      geo.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
    if (m.indices) geo.setIndex(new THREE.BufferAttribute(m.indices, 1));

    if (isCompact) {
      const cm = m as CompactMeshRecord;
      const packedGroups = decoded.packedGroups;
      for (let g = 0; g < cm.groupCount; g++) {
        const base = (cm.groupOffset + g) * 3;
        geo.addGroup(
          packedGroups[base],
          packedGroups[base + 1],
          packedGroups[base + 2]
        );
      }
    } else {
      const lm = m as TileMeshRecord;
      for (const g of lm.groups) {
        geo.addGroup(g.start, g.count, g.materialIndex);
      }
    }

    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(m.bboxMin[0], m.bboxMin[1], m.bboxMin[2]),
      new THREE.Vector3(m.bboxMax[0], m.bboxMax[1], m.bboxMax[2])
    );
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    resourceManager.registerGeometry(geo);

    if (m.bvh) {
      const tBvh0 = collectStageTimings ? performance.now() : 0;
      const bvh = MeshBVH.deserialize(
        {
          version: m.bvh.version,
          roots: m.bvh.roots,
          index: geo.index
            ? (geo.index.array as Uint32Array | Uint16Array)
            : null,
          indirectBuffer: m.bvh.indirectBuffer,
        } as unknown as Parameters<typeof MeshBVH.deserialize>[0],
        geo,
        {
          setIndex: false,
          indirect: Boolean(m.bvh.indirectBuffer),
        } as unknown as Parameters<typeof MeshBVH.deserialize>[2]
      );
      (geo as unknown as { boundsTree: MeshBVH }).boundsTree = bvh;
      if (collectStageTimings) {
        staticBvhDeserializeMs += performance.now() - tBvh0;
      }
    }

    const material = materialRegistry.getMaterials(m.materialSlotKeys);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = m.name;
    mesh.renderOrder = m.renderOrder;
    mesh.visible = (m.flags & TILE_MESH_FLAG_VISIBLE) !== 0;
    mesh.castShadow = (m.flags & TILE_MESH_FLAG_CAST_SHADOW) !== 0;
    mesh.receiveShadow = (m.flags & TILE_MESH_FLAG_RECEIVE_SHADOW) !== 0;
    mesh.frustumCulled = (m.flags & TILE_MESH_FLAG_FRUSTUM_CULLED) !== 0;
    mesh.position.set(
      m.localPositionOffset[0] + shiftX,
      m.localPositionOffset[1],
      m.localPositionOffset[2] + shiftZ
    );
    if (m.bvh) {
      mesh.raycast = acceleratedRaycast;
    }

    const baseUserData: Record<string, unknown> = {};
    if (isCompact) {
      const cm = m as CompactMeshRecord;
      if (featureTable) {
        baseUserData.__featureTable = featureTable;
      }
      if (cm.singleFeatureIdx >= 0 && featureTable) {
        if (!optimizeMainThreadPrep) {
          const singleInfo = featureTable.getFeatureInfo(cm.singleFeatureIdx);
          if (singleInfo) {
            Object.assign(baseUserData, singleInfo);
          }
        }
        baseUserData.__singleFeatureIdx = cm.singleFeatureIdx;
      }
      if (cm.faceRangeCount > 0 && featureTable) {
        const packedLookup: PackedFaceRangeLookup = {
          data: decoded.packedFaceRanges,
          offset: cm.faceRangeOffset,
          count: cm.faceRangeCount,
          featureTable,
        };
        baseUserData.__packedFaceRanges = packedLookup;
        defineLazyProperty<FaceFeatureRange[]>(baseUserData, 'faceRanges', () => {
          const out: FaceFeatureRange[] = new Array(cm.faceRangeCount);
          const data = decoded.packedFaceRanges;
          for (let r = 0; r < cm.faceRangeCount; r++) {
            const base = (cm.faceRangeOffset + r) * 3;
            out[r] = {
              startFace: data[base],
              endFace: data[base + 1],
              info: featureTable.getFeatureInfo(data[base + 2] | 0)!,
            };
          }
          return out;
        });
      } else {
        baseUserData.faceRanges = [];
      }
    } else {
      const lm = m as TileMeshRecord;
      if (lm.singleFeatureIdx >= 0 && legacyFeatureInfos) {
        Object.assign(baseUserData, legacyFeatureInfos[lm.singleFeatureIdx]);
      }
      if (optimizeMainThreadPrep && legacyFeatureInfos) {
        if (lm.faceRanges.length > 0) {
          baseUserData.__rawFaceRanges = lm.faceRanges;
          baseUserData.__featureInfosArray = legacyFeatureInfos;
          defineLazyProperty<FaceFeatureRange[]>(baseUserData, 'faceRanges', () =>
            lm.faceRanges.map((r) => ({
              startFace: r.startFace,
              endFace: r.endFace,
              info: legacyFeatureInfos[r.infoIdx],
            }))
          );
        } else {
          baseUserData.faceRanges = [];
        }
      } else {
        baseUserData.faceRanges = lm.faceRanges.map((r) => ({
          startFace: r.startFace,
          endFace: r.endFace,
          info: legacyFeatureInfos![r.infoIdx],
        }));
      }
    }

    if ((m.flags & TILE_MESH_FLAG_STRUCTURAL_3D) !== 0)
      baseUserData.isStructural3D = true;
    if ((m.flags & TILE_MESH_FLAG_UNDERGROUND_GEOM) !== 0) {
      baseUserData.isUndergroundTunnelGeometry = true;
    }
    if ((m.flags & TILE_MESH_FLAG_UNDERGROUND_TRACE) !== 0) {
      baseUserData.isUndergroundTunnelTrace = true;
    }
    if ((m.flags & TILE_MESH_FLAG_HIDDEN_UNDERGROUND) !== 0) {
      baseUserData.isHiddenUnderground = true;
    }
    if (m.chunkKey !== undefined) {
      baseUserData.chunkKey = m.chunkKey;
    }
    mesh.userData = baseUserData;

    const isChunked = m.layer === 'railways' && m.name.includes('_chunk_');
    addToLayerGroup(m.layer, mesh, isChunked, mesh.visible);

    if (m.layer === 'buildings') {
      interactiveBuildings.push(mesh);
    }
  }

  // Finalize chunked railway parent userData.faceRanges (lazy in compact/optimized mode)
  for (const chunkParent of railwayChunkGroups.values()) {
    const buildAggRanges = (): FaceFeatureRange[] => {
      const aggRanges: FaceFeatureRange[] = [];
      let runningFace = 0;
      for (const child of chunkParent.children) {
        const childMesh = child as THREE.Mesh;
        const childRanges = childMesh.userData?.faceRanges as
          | FaceFeatureRange[]
          | undefined;
        if (childRanges) {
          for (const cr of childRanges) {
            aggRanges.push({
              startFace: runningFace + cr.startFace,
              endFace: runningFace + cr.endFace,
              info: cr.info,
            });
          }
        }
        const cg = childMesh.geometry;
        const triCount = cg.index
          ? Math.floor(cg.index.count / 3)
          : Math.floor((cg.attributes.position?.count ?? 0) / 3);
        runningFace += triCount;
      }
      return aggRanges;
    };

    if (isCompact || optimizeMainThreadPrep) {
      defineLazyProperty<FaceFeatureRange[]>(
        chunkParent.userData,
        'faceRanges',
        buildAggRanges
      );
    } else {
      chunkParent.userData.faceRanges = buildAggRanges();
    }
  }

  // Reconstruct InstancedMesh batches
  const externalFoliageRegistry = options.foliagePrototypeRegistry ?? null;
  let ownedFoliageRegistry: FoliagePrototypeRegistry | null = null;
  const getFoliageRegistry = (): FoliagePrototypeRegistry => {
    if (externalFoliageRegistry) return externalFoliageRegistry;
    if (!ownedFoliageRegistry) {
      ownedFoliageRegistry = new FoliagePrototypeRegistry();
    }
    return ownedFoliageRegistry;
  };

  const standaloneFoliageConfig = normalizeFoliageOptimizationConfig(
    options.foliageOptimizationConfig
  );
  const externallyManagedFoliage = options.foliageRuntimeState !== undefined;
  let currentFoliageState: FoliageRuntimeState =
    options.foliageRuntimeState ??
    resolveFoliageRuntimeState(initialCameraZoom, null, standaloneFoliageConfig);

  let sleeperProtoGeo: THREE.BufferGeometry | null = null;
  const sleeperChunkParents = new Map<string, THREE.Group>();
  const foliageTargets: FoliageBatchTarget[] = [];
  const tileInstancedMeshes: THREE.InstancedMesh[] = [];
  const instancedPickingStats: InstancedPickingAggregateStats = {
    indexedBatchCount: 0,
    totalIndexedInstances: 0,
    totalIndexNodes: 0,
    totalIndexMemoryBytes: 0,
    totalBuildTimeMs: 0,
    workerBuiltBatchCount: 0,
    syncFallbackBatchCount: 0,
    totalAdoptTimeMs: 0,
  };

  for (let bi = 0; bi < decoded.instancedBatches.length; bi++) {
    const b = decoded.instancedBatches[bi];
    const foliageKind = isFoliagePrototypeKind(b.prototypeKind)
      ? b.prototypeKind
      : null;
    let protoGeo: THREE.BufferGeometry;
    if (foliageKind) {
      const foliageRegistry = getFoliageRegistry();
      protoGeo = foliageRegistry.getGeometry(
        foliageKind,
        currentFoliageState.activeLod
      );
    } else {
      if (!sleeperProtoGeo) {
        sleeperProtoGeo = resourceManager.registerGeometry(
          buildUnitSleeperBoxGeometry()
        );
      }
      protoGeo = sleeperProtoGeo;
    }

    const mat = materialRegistry.getMaterial(b.materialSlotKey);
    let inst: THREE.InstancedMesh;
    if (optimizeMainThreadPrep) {
      // TKT-040 Work Package D: adopt the transferred Float32Array directly without
      // allocating and copying a second 16 * N Float32Array on the main thread.
      inst = new THREE.InstancedMesh(protoGeo, mat, 0);
      inst.instanceMatrix = new THREE.InstancedBufferAttribute(b.matrices, 16);
      inst.instanceMatrix.needsUpdate = true;
      inst.count = b.instanceCount;
    } else {
      inst = new THREE.InstancedMesh(protoGeo, mat, b.instanceCount);
      const instMatrixArr = inst.instanceMatrix.array as Float32Array;
      instMatrixArr.set(b.matrices);
      inst.instanceMatrix.needsUpdate = true;
    }

    tileInstancedMeshes.push(inst);
    inst.name = b.name;
    inst.renderOrder = b.renderOrder;
    const baseVisible = (b.flags & TILE_MESH_FLAG_VISIBLE) !== 0;
    inst.visible = baseVisible;
    inst.castShadow = (b.flags & TILE_MESH_FLAG_CAST_SHADOW) !== 0;
    inst.receiveShadow = (b.flags & TILE_MESH_FLAG_RECEIVE_SHADOW) !== 0;
    inst.frustumCulled = (b.flags & TILE_MESH_FLAG_FRUSTUM_CULLED) !== 0;
    inst.position.set(shiftX, 0, shiftZ);

    if (b.instanceColors) {
      const colorAttr = new THREE.InstancedBufferAttribute(b.instanceColors, 3);
      inst.instanceColor = colorAttr;
      inst.instanceColor.needsUpdate = true;
    }

    const preparedSpatialIndex =
      b.preparedSpatialIndex &&
      b.preparedSpatialIndex.instanceCount === b.instanceCount
        ? b.preparedSpatialIndex
        : null;

    if (foliageKind) {
      if (optimizeMainThreadPrep && preparedSpatialIndex && b.instanceCount > 0) {
        // O(1) conservative bounds directly from worker-computed exact Arvo root bounds
        // (+0.25 m margin), matching computeConservativeInstancedBounds bit-for-bit.
        const mrg = CONSERVATIVE_FOLIAGE_BOUNDS_MARGIN_METERS;
        const rMin = preparedSpatialIndex.rootBoundsMin;
        const rMax = preparedSpatialIndex.rootBoundsMax;
        inst.boundingBox = new THREE.Box3(
          new THREE.Vector3(rMin[0] - mrg, rMin[1] - mrg, rMin[2] - mrg),
          new THREE.Vector3(rMax[0] + mrg, rMax[1] + mrg, rMax[2] + mrg)
        );
        inst.boundingSphere = inst.boundingBox.getBoundingSphere(
          new THREE.Sphere()
        );
      } else {
        const foliageRegistry = getFoliageRegistry();
        const bounds = computeConservativeInstancedBounds(
          b.matrices,
          b.instanceCount,
          foliageRegistry.getUnionLocalBounds(foliageKind)
        );
        inst.boundingBox = bounds.boundingBox;
        inst.boundingSphere = bounds.boundingSphere;
      }
    } else {
      inst.boundingBox = new THREE.Box3(
        new THREE.Vector3(b.bboxMin[0], b.bboxMin[1], b.bboxMin[2]),
        new THREE.Vector3(b.bboxMax[0], b.bboxMax[1], b.bboxMax[2])
      );
      inst.boundingSphere = inst.boundingBox.getBoundingSphere(
        new THREE.Sphere()
      );
    }

    const userData: Record<string, unknown> = {
      isInstanced: true,
    };

    let eagerInstanceInfos: InspectableFeatureInfo[] | null = null;
    if (isCompact && featureTable) {
      const cb = b as CompactInstancedBatchRecord;
      userData.__instanceFeatureIdxs = cb.instanceFeatureIdxs;
      userData.__featureTable = featureTable;
      defineLazyProperty<InspectableFeatureInfo[]>(
        userData,
        'instanceInfos',
        () => {
          const arr: InspectableFeatureInfo[] = new Array(cb.instanceCount);
          for (let i = 0; i < cb.instanceCount; i++) {
            const idx = cb.instanceFeatureIdxs[i];
            arr[i] =
              idx >= 0
                ? (featureTable.getFeatureInfo(idx) ??
                  ({} as InspectableFeatureInfo))
                : ({} as InspectableFeatureInfo);
          }
          return arr;
        }
      );
      if (cb.sleeperBoxFloats && cb.sleeperBoxTrackStrIdxs) {
        const boxFloats = cb.sleeperBoxFloats;
        const boxTracks = cb.sleeperBoxTrackStrIdxs;
        defineLazyProperty<SleeperBearerBox3D[]>(
          userData,
          'instanceBoxes',
          () =>
            materializeSleeperBoxesFromCompact(
              boxFloats,
              boxTracks,
              featureTable,
              shiftX,
              shiftZ
            )
        );
      }
    } else {
      const lb = b as TileInstancedBatchRecord;
      if (optimizeMainThreadPrep && legacyFeatureInfos) {
        userData.__instanceFeatureIdxs = lb.instanceFeatureIdxs;
        userData.__featureInfosArray = legacyFeatureInfos;
        defineLazyProperty<InspectableFeatureInfo[]>(
          userData,
          'instanceInfos',
          () => {
            const arr: InspectableFeatureInfo[] = new Array(lb.instanceCount);
            for (let i = 0; i < lb.instanceCount; i++) {
              const idx = lb.instanceFeatureIdxs[i];
              arr[i] =
                idx >= 0
                  ? legacyFeatureInfos[idx]
                  : ({} as InspectableFeatureInfo);
            }
            return arr;
          }
        );
        if (lb.sleeperBoxes) {
          const rawBoxes = lb.sleeperBoxes;
          defineLazyProperty<SleeperBearerBox3D[]>(
            userData,
            'instanceBoxes',
            () =>
              rawBoxes.map((sb) => ({
                ...sb,
                cx: sb.cx + shiftX,
                cz: sb.cz + shiftZ,
              }))
          );
        }
      } else {
        eagerInstanceInfos = new Array(lb.instanceCount);
        for (let i = 0; i < lb.instanceCount; i++) {
          const idx = lb.instanceFeatureIdxs[i];
          eagerInstanceInfos[i] =
            idx >= 0
              ? legacyFeatureInfos![idx]
              : ({} as InspectableFeatureInfo);
        }
        userData.instanceInfos = eagerInstanceInfos;
        if (lb.sleeperBoxes) {
          userData.instanceBoxes = lb.sleeperBoxes.map((sb) => ({
            ...sb,
            cx: sb.cx + shiftX,
            cz: sb.cz + shiftZ,
          }));
        }
      }
    }

    if (foliageKind) {
      userData.foliagePrototypeKind = foliageKind;
      foliageTargets.push({
        mesh: inst,
        prototypeKind: foliageKind,
        baseVisible,
      });
    }
    if ((b.flags & TILE_MESH_FLAG_STRUCTURAL_3D) !== 0) {
      userData.isStructural3D = true;
    }
    if (b.chunkKey !== undefined) {
      userData.chunkKey = b.chunkKey;
    }
    inst.userData = userData;

    // Adopt worker-prepared BVH in O(1) when available, else fall back to synchronous build.
    let spatialIdx;
    if (preparedSpatialIndex) {
      const tAdopt0 = performance.now();
      spatialIdx = attachPreparedInstancedSpatialIndex(inst, preparedSpatialIndex);
      instancedBvhAdoptMs += performance.now() - tAdopt0;
      workerBvhAdoptedCount += 1;
    } else {
      const indexLocalBox = foliageKind
        ? getFoliageRegistry().getUnionLocalBounds(foliageKind)
        : (() => {
            if (!protoGeo.boundingBox) protoGeo.computeBoundingBox();
            return protoGeo.boundingBox!;
          })();
      const tBuild0 = performance.now();
      spatialIdx = attachInstancedSpatialIndex(inst, indexLocalBox, {
        matrices: b.matrices,
        instanceCount: b.instanceCount,
      });
      syncInstancedBvhBuildMs += performance.now() - tBuild0;
      syncBvhFallbackCount += 1;
    }

    const idxStats = spatialIdx.getStats();
    instancedPickingStats.indexedBatchCount += 1;
    instancedPickingStats.totalIndexedInstances += idxStats.instanceCount;
    instancedPickingStats.totalIndexNodes += idxStats.nodeCount;
    instancedPickingStats.totalIndexMemoryBytes += idxStats.estimatedMemoryBytes;
    instancedPickingStats.totalBuildTimeMs = Number(
      (instancedPickingStats.totalBuildTimeMs + idxStats.buildTimeMs).toFixed(3)
    );
    if (preparedSpatialIndex) {
      instancedPickingStats.workerBuiltBatchCount =
        (instancedPickingStats.workerBuiltBatchCount ?? 0) + 1;
      instancedPickingStats.totalAdoptTimeMs = Number(
        (
          (instancedPickingStats.totalAdoptTimeMs ?? 0) +
          (idxStats.adoptTimeMs ?? 0)
        ).toFixed(4)
      );
    } else {
      instancedPickingStats.syncFallbackBatchCount =
        (instancedPickingStats.syncFallbackBatchCount ?? 0) + 1;
    }

    if (b.layer === 'railways' && b.name.includes('_chunk_')) {
      const baseName = b.name.split('_chunk_')[0];
      let parentGroup = sleeperChunkParents.get(baseName);
      if (!parentGroup) {
        parentGroup = new THREE.Group();
        parentGroup.name = baseName;
        parentGroup.visible = inst.visible;
        parentGroup.userData = {
          isInstanced: true,
          isStructural3D: true,
        };
        if (isCompact || optimizeMainThreadPrep) {
          const capturedParent = parentGroup;
          defineLazyProperty<InspectableFeatureInfo[]>(
            parentGroup.userData,
            'instanceInfos',
            () => {
              const merged: InspectableFeatureInfo[] = [];
              for (const child of capturedParent.children) {
                const infos = child.userData?.instanceInfos as
                  | InspectableFeatureInfo[]
                  | undefined;
                if (infos) merged.push(...infos);
              }
              return merged;
            }
          );
        } else {
          parentGroup.userData.instanceInfos = [] as InspectableFeatureInfo[];
        }
        sleeperChunkParents.set(baseName, parentGroup);
        railwaysGroup.add(parentGroup);
        trackRailwayTarget(parentGroup, baseName);
      }
      if (!isCompact && !optimizeMainThreadPrep && eagerInstanceInfos) {
        (parentGroup.userData.instanceInfos as InspectableFeatureInfo[]).push(
          ...eagerInstanceInfos
        );
      }
      parentGroup.add(inst);
    } else {
      groupByLayer[b.layer].add(inst);
      if (b.layer === 'railways') {
        trackRailwayTarget(inst, inst.name);
      }
    }
  }

  const applyFoliageRuntimeState = (nextState: FoliageRuntimeState) => {
    currentFoliageState = nextState;
    if (foliageTargets.length === 0) return;
    const registry = externalFoliageRegistry ?? ownedFoliageRegistry;
    if (!registry || registry.disposed) return;
    applyFoliageRuntimeStateToBatches(foliageTargets, nextState, registry);
  };

  if (foliageTargets.length > 0) {
    applyFoliageRuntimeState(currentFoliageState);
  }

  // Fallback GroundPlane if decoded tile had none
  if (!groundMesh) {
    const fallbackGeo = resourceManager.registerGeometry(
      new THREE.PlaneGeometry(
        decoded.tileSizeMeters,
        decoded.tileSizeMeters,
        1,
        1
      )
    );
    fallbackGeo.rotateX(-Math.PI / 2);
    groundMesh = new THREE.Mesh(
      fallbackGeo,
      materialRegistry.getMaterial('ground')
    );
    groundMesh.name = 'GroundPlane';
    groundMesh.position.set(shiftX, -0.015, shiftZ);
    groundMesh.receiveShadow = true;
  }

  let lastZoom = -1;
  const updateCameraZoom = (zoom: number) => {
    if (Math.abs(zoom - lastZoom) < 0.002) return;
    lastZoom = zoom;
    materialRegistry.setCameraZoom(zoom);
    const show3D = zoom > RAILWAY_DIMENSION_SPEC.hybridCloseZoomThresholdPxPerMeter;
    for (const t of railwayZoomTargets.sleepers3D) t.visible = show3D;
    for (const t of railwayZoomTargets.rails3D) t.visible = show3D;
    for (const t of railwayZoomTargets.sleepersRibbon) t.visible = !show3D;
    for (const t of railwayZoomTargets.railsRibbon) t.visible = !show3D;

    if (!externallyManagedFoliage && foliageTargets.length > 0) {
      const nextFoliageState = resolveFoliageRuntimeState(
        zoom,
        currentFoliageState,
        standaloneFoliageConfig
      );
      applyFoliageRuntimeState(nextFoliageState);
    }
  };
  updateCameraZoom(initialCameraZoom);

  railwaysGroup.userData.railwayStats = {
    sleeper3DBoxCount: decoded.sleeper3DBoxCount,
    railwayRenderSource: decoded.railwayRenderSource,
  };
  railwaysGroup.userData.updateCameraZoom = updateCameraZoom;

  const updateTheme = (newTheme: MapStyleTheme) => {
    materialRegistry.applyTheme(newTheme);
  };

  const dispose = () => {
    for (let i = 0; i < tileInstancedMeshes.length; i++) {
      disposeInstancedSpatialIndex(tileInstancedMeshes[i]);
      tileInstancedMeshes[i].dispose();
    }
    tileInstancedMeshes.length = 0;
    foliageTargets.length = 0;
    buildingsGroup.clear();
    roadsGroup.clear();
    railwaysGroup.clear();
    waterGroup.clear();
    parksGroup.clear();
    landuseGroup.clear();
    barriersGroup.clear();
    foliageGroup.clear();
    if (ownedFoliageRegistry) {
      ownedFoliageRegistry.dispose();
      ownedFoliageRegistry = null;
    }
    resourceManager.dispose();
  };

  const builtScene: BuiltSceneGeometry = {
    buildingsGroup,
    roadsGroup,
    railwaysGroup,
    waterGroup,
    parksGroup,
    landuseGroup,
    barriersGroup,
    foliageGroup,
    groundMesh,
    interactiveMeshes: {
      buildings: interactiveBuildings,
    },
    stats: {
      totalVertices: decoded.totalVertices,
      totalTriangles: decoded.totalTriangles,
      totalDrawCalls: decoded.totalDrawCalls,
      renderedFeaturesCount: decoded.renderedFeaturesCount,
      forestTreesCount: decoded.forestTreesCount,
    },
    resources: resourceManager,
    infrastructureRenderOptions: { ...DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS },
    infrastructureRenderPreview: null,
    dispose,
    updateTheme,
    updateCameraZoom,
  };

  // Ensure matrixWorld reflects any mesh offsets for world-space checks (e.g. auditGraphRoadMeshIntegrity)
  for (const grp of Object.values(groupByLayer)) {
    grp.updateMatrixWorld(true);
  }
  groundMesh.updateMatrixWorld(true);

  return {
    scene: builtScene,
    tileCenterXZ: [decoded.tileCenterX, decoded.tileCenterZ],
    overhangBounds: {
      min: [
        decoded.overhangBoundsMin[0] + shiftX,
        decoded.overhangBoundsMin[1],
        decoded.overhangBoundsMin[2] + shiftZ,
      ],
      max: [
        decoded.overhangBoundsMax[0] + shiftX,
        decoded.overhangBoundsMax[1],
        decoded.overhangBoundsMax[2] + shiftZ,
      ],
    },
    applyFoliageRuntimeState,
    foliageBatchCount: foliageTargets.length,
    instancedPickingStats,
    stageTimings: {
      staticBvhDeserializeMs: Number(staticBvhDeserializeMs.toFixed(3)),
      instancedBvhBuildMs: Number(syncInstancedBvhBuildMs.toFixed(3)),
      instancedBvhAdoptMs: Number(instancedBvhAdoptMs.toFixed(4)),
      workerBvhAdoptedCount,
      syncBvhFallbackCount,
    },
    dispose,
  };
}
