import * as THREE from 'three';
import type { MapStyleTheme } from '../../types/MapFeature';
import type { BuiltSceneGeometry } from '../GeometryBuilder';
import { SceneResourceManager } from '../SceneResourceManager';
import type { StudyGridSpec } from './TileGrid';
import type {
  IngestedStudyRegion,
  TiledStudyBuildResult,
} from './TiledStudyPipeline';

export type M1aVisualComparisonMode = 'tiled' | 'reference';

export interface M1aTileBoundaryOverlayResult {
  group: THREE.Group;
  tileCount: number;
  internalSeamCount: number;
  dispose: () => void;
}

/**
 * Assembles the 64 individually built M1a study tiles (`buildTiledStudyScenes`) into a single
 * composite `BuiltSceneGeometry` object that can be rendered directly by `MapScene.tsx`
 * without altering, re-merging, or approximating any tile geometry or materials.
 *
 * Every tile's layer groups (`buildingsGroup`, `roadsGroup`, `railwaysGroup`, `waterGroup`,
 * `parksGroup`, `landuseGroup`, `barriersGroup`, `foliageGroup`) are mounted as direct children
 * of the corresponding composite layer group, preserving each tile's Three.js meshes,
 * `userData`, BVH trees, and procedural R+ railway shaders.
 */
export function assembleTiledStudyCompositeScene(
  tiled: TiledStudyBuildResult,
  ingested: IngestedStudyRegion,
  initialTheme: MapStyleTheme
): BuiltSceneGeometry {
  const buildingsGroup = new THREE.Group();
  buildingsGroup.name = 'M1a_Composite_Buildings';

  const roadsGroup = new THREE.Group();
  roadsGroup.name = 'M1a_Composite_Roads';

  const railwaysGroup = new THREE.Group();
  railwaysGroup.name = 'M1a_Composite_Railways';

  const waterGroup = new THREE.Group();
  waterGroup.name = 'M1a_Composite_Water';

  const parksGroup = new THREE.Group();
  parksGroup.name = 'M1a_Composite_Parks';

  const landuseGroup = new THREE.Group();
  landuseGroup.name = 'M1a_Composite_Landuse';

  const barriersGroup = new THREE.Group();
  barriersGroup.name = 'M1a_Composite_Barriers';

  const foliageGroup = new THREE.Group();
  foliageGroup.name = 'M1a_Composite_Foliage';

  const compositeResources = new SceneResourceManager();
  const bounds = ingested.grid.studyLocalBounds;
  const width = Math.max((bounds.maxX - bounds.minX) * 1.5, 1600);
  const depth = Math.max((bounds.maxZ - bounds.minZ) * 1.5, 1600);
  const cx = (bounds.minX + bounds.maxX) * 0.5;
  const cz = (bounds.minZ + bounds.maxZ) * 0.5;

  const groundGeo = compositeResources.registerGeometry(
    new THREE.PlaneGeometry(width, depth)
  );
  const groundMat = compositeResources.registerMaterial(
    new THREE.MeshStandardMaterial({
      color: initialTheme.groundColor,
      roughness: 0.95,
      metalness: 0.05,
    })
  );
  const groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.position.set(cx, -0.05, cz);
  groundMesh.receiveShadow = true;
  groundMesh.name = 'M1a_Composite_GroundPlane';

  const interactiveBuildings: THREE.Mesh[] = [];
  let totalVertices = 0;
  let totalTriangles = 0;
  let totalDrawCalls = 0;
  let renderedFeaturesCount = 0;
  let forestTreesCount = 0;

  for (const entry of tiled.tiles) {
    const tileScene = entry.scene;
    const tag = `${entry.tile.gridCol}_${entry.tile.gridRow}`;

    tileScene.buildingsGroup.name = `Tile_${tag}_Buildings`;
    tileScene.roadsGroup.name = `Tile_${tag}_Roads`;
    tileScene.railwaysGroup.name = `Tile_${tag}_Railways`;
    tileScene.waterGroup.name = `Tile_${tag}_Water`;
    tileScene.parksGroup.name = `Tile_${tag}_Parks`;
    tileScene.landuseGroup.name = `Tile_${tag}_Landuse`;
    tileScene.barriersGroup.name = `Tile_${tag}_Barriers`;
    tileScene.foliageGroup.name = `Tile_${tag}_Foliage`;

    buildingsGroup.add(tileScene.buildingsGroup);
    roadsGroup.add(tileScene.roadsGroup);
    railwaysGroup.add(tileScene.railwaysGroup);
    waterGroup.add(tileScene.waterGroup);
    parksGroup.add(tileScene.parksGroup);
    landuseGroup.add(tileScene.landuseGroup);
    barriersGroup.add(tileScene.barriersGroup);
    foliageGroup.add(tileScene.foliageGroup);

    if (Array.isArray(tileScene.interactiveMeshes?.buildings)) {
      interactiveBuildings.push(...tileScene.interactiveMeshes.buildings);
    }

    totalVertices += tileScene.stats.totalVertices || 0;
    totalTriangles += tileScene.stats.totalTriangles || 0;
    totalDrawCalls += tileScene.stats.totalDrawCalls || 0;
    renderedFeaturesCount += tileScene.stats.renderedFeaturesCount || 0;
    forestTreesCount += tileScene.stats.forestTreesCount || 0;
  }

  const updateCameraZoom = (zoom: number) => {
    for (const entry of tiled.tiles) {
      entry.scene.updateCameraZoom?.(zoom);
    }
  };
  railwaysGroup.userData.updateCameraZoom = updateCameraZoom;

  const firstTileScene = tiled.tiles[0]?.scene;
  const fallbackRenderOpts =
    firstTileScene?.infrastructureRenderOptions ?? ingested.infrastructureRenderOptions;
  const fullPreview =
    ingested.descriptors && ingested.previewMeta
      ? {
          options: ingested.infrastructureRenderOptions,
          graph: ingested.previewMeta.graph,
          descriptors: ingested.descriptors,
          validation: ingested.previewMeta.validation,
          timing: ingested.previewMeta.timing,
        }
      : null;

  const baseGetCpuStats = compositeResources.getCpuBufferMemoryStats.bind(compositeResources);
  const baseGetBvhStats = compositeResources.getBvhMemoryStats.bind(compositeResources);
  compositeResources.getCpuBufferMemoryStats = () => {
    const base = baseGetCpuStats();
    let geometryCount = base.geometryCount;
    let attributeBytes = base.attributeBytes;
    let indexBytes = base.indexBytes;
    for (const entry of tiled.tiles) {
      const s = entry.scene.resources?.getCpuBufferMemoryStats?.();
      if (!s) continue;
      geometryCount += s.geometryCount;
      attributeBytes += s.attributeBytes;
      indexBytes += s.indexBytes;
    }
    const totalBytes = attributeBytes + indexBytes;
    return {
      geometryCount,
      attributeBytes,
      indexBytes,
      totalBytes,
      totalMB: Number((totalBytes / (1024 * 1024)).toFixed(3)),
    };
  };
  compositeResources.getBvhMemoryStats = () => {
    const base = baseGetBvhStats();
    let bvhCount = base.bvhCount;
    let rootBytes = base.rootBytes;
    let indirectBufferBytes = base.indirectBufferBytes;
    for (const entry of tiled.tiles) {
      const s = entry.scene.resources?.getBvhMemoryStats?.();
      if (!s) continue;
      bvhCount += s.bvhCount;
      rootBytes += s.rootBytes;
      indirectBufferBytes += s.indirectBufferBytes;
    }
    const totalBytes = rootBytes + indirectBufferBytes;
    return {
      bvhCount,
      rootBytes,
      indirectBufferBytes,
      totalBytes,
      totalMB: Number((totalBytes / (1024 * 1024)).toFixed(3)),
    };
  };

  return {
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
      totalVertices,
      totalTriangles,
      totalDrawCalls,
      renderedFeaturesCount,
      forestTreesCount,
    },
    resources: compositeResources,
    infrastructureRenderOptions: fallbackRenderOpts,
    infrastructureRenderPreview: fullPreview,
    updateCameraZoom,
    updateTheme: (nextTheme: MapStyleTheme) => {
      groundMat.color.set(nextTheme.groundColor);
      for (const entry of tiled.tiles) {
        entry.scene.updateTheme(nextTheme);
      }
    },
    dispose: () => {
      compositeResources.dispose();
      tiled.dispose();
    },
  };
}

/**
 * Creates a developer-only 3D overlay group rendering the 512 m × 512 m tile grid boundaries
 * (`8 × 8 = 64` tiles, `112` internal seams, plus the outer `4,096 × 4,096 m` study perimeter).
 * Raycasting is disabled on all overlay lines so hover/click feature inspection remains unaffected.
 */
export function createM1aTileBoundaryOverlay(
  grid: StudyGridSpec,
  elevationY: number = 0.45
): M1aTileBoundaryOverlayResult {
  const group = new THREE.Group();
  group.name = 'DevTools_M1aTileBoundaryOverlay';
  group.raycast = () => {};

  const b = grid.studyLocalBounds;
  const internalPositions: number[] = [];

  // Internal vertical seams (between columns c and c+1)
  for (let c = 1; c < grid.cols; c++) {
    const x = b.minX + c * grid.tileSizeMeters;
    internalPositions.push(x, elevationY, b.minZ, x, elevationY, b.maxZ);
  }

  // Internal horizontal seams (between rows r and r+1)
  for (let r = 1; r < grid.rows; r++) {
    const z = b.minZ + r * grid.tileSizeMeters;
    internalPositions.push(b.minX, elevationY, z, b.maxX, elevationY, z);
  }

  const internalGeo = new THREE.BufferGeometry();
  internalGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(internalPositions, 3)
  );
  const internalMat = new THREE.LineBasicMaterial({
    color: 0x22d3ee, // high-contrast cyan for the 112 internal 512m seams
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  });
  const internalLines = new THREE.LineSegments(internalGeo, internalMat);
  internalLines.name = 'M1a_InternalTileSeams';
  internalLines.renderOrder = 950;
  internalLines.raycast = () => {};
  group.add(internalLines);

  // Outer study region perimeter rectangle (4,096 × 4,096 m)
  const outerPositions = [
    b.minX, elevationY, b.minZ, b.maxX, elevationY, b.minZ,
    b.maxX, elevationY, b.minZ, b.maxX, elevationY, b.maxZ,
    b.maxX, elevationY, b.maxZ, b.minX, elevationY, b.maxZ,
    b.minX, elevationY, b.maxZ, b.minX, elevationY, b.minZ,
  ];
  const outerGeo = new THREE.BufferGeometry();
  outerGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(outerPositions, 3)
  );
  const outerMat = new THREE.LineBasicMaterial({
    color: 0xf59e0b, // amber outer study region border
    transparent: true,
    opacity: 0.95,
    depthTest: false,
  });
  const outerLines = new THREE.LineSegments(outerGeo, outerMat);
  outerLines.name = 'M1a_OuterStudyPerimeter';
  outerLines.renderOrder = 951;
  outerLines.raycast = () => {};
  group.add(outerLines);

  const internalSeamCount =
    Math.max(0, grid.cols - 1) * grid.rows +
    grid.cols * Math.max(0, grid.rows - 1);

  return {
    group,
    tileCount: grid.tiles.length,
    internalSeamCount,
    dispose: () => {
      internalGeo.dispose();
      internalMat.dispose();
      outerGeo.dispose();
      outerMat.dispose();
    },
  };
}
