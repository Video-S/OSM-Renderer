import * as THREE from 'three';
import type { MapStyleTheme, RoadClass } from '../../types/MapFeature';
import { MAP_THEMES } from '../../styles/mapThemes';
import {
  DEPTH_OFFSET_CONFIG,
  getLanduseElevationAndOffset,
  isNonVehicularRoadClass,
} from '../ElevationPolicy';
import {
  configureProceduralRailMaterial,
  configureProceduralSleeperMaterial,
  type ProceduralRailwayMaterialControl,
} from '../infrastructure/rendering/InfrastructureShaderChunks';

interface RegisteredMaterialEntry {
  slotKey: string;
  material: THREE.MeshStandardMaterial;
  applyTheme: (theme: MapStyleTheme) => void;
}

const KNOWN_BARRIER_KEYS = ['hedge', 'wall', 'city_wall', 'fence', 'cliff'] as const;
const KNOWN_FURNITURE_STYLES = ['wood', 'metal', 'lamp', 'stone'] as const;

export class ThemeMaterialRegistry {
  private entries = new Map<string, RegisteredMaterialEntry>();
  private railwayShaderControls: ProceduralRailwayMaterialControl[] = [];
  private activeTheme: MapStyleTheme;
  private currentCameraZoom: number;
  private currentWireframe = false;
  private isDisposed = false;

  constructor(
    initialTheme: MapStyleTheme = MAP_THEMES.tactical,
    initialCameraZoom = 1.0
  ) {
    this.activeTheme = initialTheme;
    this.currentCameraZoom = initialCameraZoom;
    this.preRegisterKnownMaterials();
  }

  get theme(): MapStyleTheme {
    return this.activeTheme;
  }

  get cameraZoom(): number {
    return this.currentCameraZoom;
  }

  get materialCount(): number {
    return this.entries.size;
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  getAllSlotKeys(): string[] {
    return Array.from(this.entries.keys());
  }

  hasMaterial(slotKey: string): boolean {
    return this.entries.has(slotKey);
  }

  getMaterial(slotKey: string): THREE.MeshStandardMaterial {
    if (this.isDisposed) {
      throw new Error(`ThemeMaterialRegistry has been disposed (requested slot "${slotKey}")`);
    }
    const existing = this.entries.get(slotKey);
    if (existing) {
      return existing.material;
    }
    const created = this.createEntryForSlotKey(slotKey);
    created.material.wireframe = this.currentWireframe;
    this.entries.set(slotKey, created);
    return created.material;
  }

  getMaterials(slotKeys: readonly string[]): THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] {
    if (slotKeys.length === 1) {
      return this.getMaterial(slotKeys[0]);
    }
    return slotKeys.map((k) => this.getMaterial(k));
  }

  applyTheme(newTheme: MapStyleTheme): void {
    if (this.isDisposed) return;
    this.activeTheme = newTheme;
    for (const entry of this.entries.values()) {
      entry.applyTheme(newTheme);
    }
    for (const ctrl of this.railwayShaderControls) {
      ctrl.updateThemeColors(newTheme);
    }
  }

  setCameraZoom(zoom: number): void {
    if (this.isDisposed) return;
    if (Math.abs(zoom - this.currentCameraZoom) < 1e-6 && this.railwayShaderControls.length === 0) {
      return;
    }
    this.currentCameraZoom = zoom;
    for (const ctrl of this.railwayShaderControls) {
      ctrl.updateZoom(zoom);
    }
  }

  setWireframe(enabled: boolean): void {
    if (this.isDisposed) return;
    this.currentWireframe = enabled;
    for (const entry of this.entries.values()) {
      entry.material.wireframe = enabled;
    }
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    for (const entry of this.entries.values()) {
      entry.material.dispose();
    }
    this.entries.clear();
    this.railwayShaderControls = [];
  }

  private preRegisterKnownMaterials(): void {
    const fixedSlots: string[] = [
      'ground',
      'water',
      'parking_markings',
      'pitch_markings',
      'bridge_substructure',
      'bridge_parapets',
      'tunnel_portals',
      'tunnel_mouths',
      'tunnel_traces',
      'tunnel_underground_roads',
      'barrier_underground_wall',
      'foliage:trunk',
      'foliage:broadleaved',
      'foliage:needleleaved',
      'landmark_point',
      'building:roof:default',
      'building:wall:default',
      'building:wall:landmark',
      'railway:ballast',
      'railway:sleepers_uv',
      'railway:rails_uv',
      'railway:sleepers_3d',
      'railway:rails_3d',
      'railway:bridge_substructure',
      'railway:bridge_parapets',
      'railway:tunnel_portals',
      'railway:tunnel_traces',
      'railway:tunnel_ug_ballast',
      'railway:tunnel_ug_sleepers',
      'railway:tunnel_ug_rails',
    ];

    for (const key of fixedSlots) {
      this.getMaterial(key);
    }
    for (const bKey of KNOWN_BARRIER_KEYS) {
      this.getMaterial(`barrier:${bKey}`);
    }
    for (const fStyle of KNOWN_FURNITURE_STYLES) {
      this.getMaterial(`furniture:${fStyle}`);
    }

    const themeRef = this.activeTheme;
    for (const roadClass of Object.keys(themeRef.roadColors)) {
      this.getMaterial(`road:${roadClass}`);
    }
    for (const luSubtype of Object.keys(themeRef.landuseColors)) {
      this.getMaterial(`landuse:${luSubtype}`);
    }
    for (const terrainSubtype of Object.keys(themeRef.terrainColors ?? {})) {
      this.getMaterial(`park:${terrainSubtype}`);
    }
    for (const archKey of Object.keys(themeRef.buildingArchetypeColors ?? {})) {
      this.getMaterial(`building:roof:arch_${archKey}`);
      this.getMaterial(`building:wall:arch_${archKey}`);
    }
  }

  private createEntryForSlotKey(slotKey: string): RegisteredMaterialEntry {
    const theme = this.activeTheme;

    if (slotKey === 'ground') {
      const mat = new THREE.MeshStandardMaterial({
        color: theme.groundColor,
        roughness: 0.95,
        metalness: 0.05,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(t.groundColor),
      };
    }

    if (slotKey === 'water') {
      const mat = new THREE.MeshStandardMaterial({
        color: theme.waterColor,
        roughness: 0.15,
        metalness: 0.45,
        side: THREE.DoubleSide,
        ...DEPTH_OFFSET_CONFIG.water,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(t.waterColor),
      };
    }

    if (slotKey === 'parking_markings') {
      const resolveColor = (t: MapStyleTheme) =>
        t.id === 'daylight' ? '#f8fafc' : t.id === 'blueprint' ? '#48cae4' : '#94a3b8';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.5,
        metalness: 0.1,
        side: THREE.DoubleSide,
        ...DEPTH_OFFSET_CONFIG.parkingMarkings,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'pitch_markings') {
      const resolveColor = (t: MapStyleTheme) =>
        t.id === 'blueprint' ? '#90e0ef' : '#e2e8f0';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.55,
        metalness: 0.05,
        side: THREE.DoubleSide,
        ...DEPTH_OFFSET_CONFIG.pitchMarkings,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey.startsWith('landuse:')) {
      const subtype = slotKey.slice('landuse:'.length);
      const tierInfo = getLanduseElevationAndOffset(subtype);
      const resolveColor = (t: MapStyleTheme) =>
        t.landuseColors[subtype] || t.landuseColors.landuse || '#0f172a';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: subtype === 'parking' || subtype === 'parking_space' ? 0.82 : 0.9,
        metalness: 0.05,
        side: THREE.DoubleSide,
        ...tierInfo.depthOffset,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey.startsWith('park:')) {
      const subtype = slotKey.slice('park:'.length);
      const resolveColor = (t: MapStyleTheme) => t.terrainColors?.[subtype] || t.parkColor;
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.78,
        metalness: 0.05,
        side: THREE.DoubleSide,
        ...DEPTH_OFFSET_CONFIG.parks,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey.startsWith('road:')) {
      const roadClass = slotKey.slice('road:'.length) as RoadClass;
      const isPath = isNonVehicularRoadClass(roadClass);
      const depthConfig = isPath ? DEPTH_OFFSET_CONFIG.paths : DEPTH_OFFSET_CONFIG.roads;
      const resolveColor = (t: MapStyleTheme) => t.roadColors[roadClass] || '#64748b';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.8,
        metalness: 0.1,
        side: THREE.DoubleSide,
        ...depthConfig,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'bridge_substructure') {
      const resolveColor = (t: MapStyleTheme) =>
        t.id === 'daylight' ? '#64748b' : t.id === 'blueprint' ? '#0077b6' : '#334155';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.78,
        metalness: 0.18,
        side: THREE.DoubleSide,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'bridge_parapets') {
      const resolveColor = (t: MapStyleTheme) =>
        t.id === 'daylight' ? '#94a3b8' : t.id === 'blueprint' ? '#48cae4' : '#64748b';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.55,
        metalness: 0.3,
        side: THREE.DoubleSide,
        ...DEPTH_OFFSET_CONFIG.roads,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'tunnel_portals') {
      const resolveColor = (t: MapStyleTheme) =>
        t.id === 'daylight' ? '#94a3b8' : t.id === 'blueprint' ? '#0096c7' : '#475569';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.65,
        metalness: 0.25,
        side: THREE.DoubleSide,
        ...DEPTH_OFFSET_CONFIG.roads,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'tunnel_mouths') {
      const mat = new THREE.MeshStandardMaterial({
        color: '#070a12',
        roughness: 0.95,
        metalness: 0.05,
        side: THREE.DoubleSide,
        ...DEPTH_OFFSET_CONFIG.railways,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: () => mat.color.set('#070a12'),
      };
    }

    if (slotKey === 'tunnel_traces') {
      const resolveColor = (t: MapStyleTheme) =>
        t.id === 'daylight' ? '#475569' : t.id === 'blueprint' ? '#00b4d8' : '#38bdf8';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.6,
        metalness: 0.2,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        ...DEPTH_OFFSET_CONFIG.railways,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'tunnel_underground_roads') {
      const resolveColor = (t: MapStyleTheme) =>
        t.id === 'daylight' ? '#475569' : t.id === 'blueprint' ? '#0077b6' : '#334155';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.85,
        metalness: 0.1,
        side: THREE.DoubleSide,
        ...DEPTH_OFFSET_CONFIG.roads,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'barrier_underground_wall') {
      const resolveColor = (t: MapStyleTheme) =>
        (t.barrierColors as Record<string, string> | undefined)?.wall || '#475569';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.82,
        metalness: 0.1,
        side: THREE.DoubleSide,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey.startsWith('barrier:')) {
      const bKey = slotKey.slice('barrier:'.length);
      const resolveColor = (t: MapStyleTheme) =>
        (t.barrierColors as Record<string, string> | undefined)?.[bKey] ||
        (bKey === 'hedge' ? '#15803d' : '#64748b');
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: bKey === 'hedge' ? 0.85 : 0.7,
        metalness: 0.1,
        side: THREE.DoubleSide,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'foliage:trunk') {
      const resolveColor = (t: MapStyleTheme) => t.foliageColors?.trunk || '#451a03';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.9,
        metalness: 0.05,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'foliage:broadleaved') {
      const resolveColor = (t: MapStyleTheme) => t.foliageColors?.broadleaved || '#16a34a';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.78,
        metalness: 0.05,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'foliage:needleleaved') {
      const resolveColor = (t: MapStyleTheme) => t.foliageColors?.needleleaved || '#15803d';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.75,
        metalness: 0.05,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'landmark_point') {
      const resolveColor = (t: MapStyleTheme) => (t.id === 'tactical' ? '#38bdf8' : '#f59e0b');
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.35,
        metalness: 0.65,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey.startsWith('furniture:')) {
      const styleGroup = slotKey.slice('furniture:'.length);
      const resolveColor = (t: MapStyleTheme) => {
        if (styleGroup === 'wood') return t.id === 'blueprint' ? '#48cae4' : '#b45309';
        if (styleGroup === 'metal') return t.id === 'daylight' ? '#475569' : '#94a3b8';
        if (styleGroup === 'lamp') return t.id === 'daylight' ? '#334155' : '#fde047';
        return t.id === 'daylight' ? '#94a3b8' : '#38bdf8';
      };
      const roughness =
        styleGroup === 'wood' ? 0.75 : styleGroup === 'metal' ? 0.4 : styleGroup === 'lamp' ? 0.3 : 0.5;
      const metalness =
        styleGroup === 'wood' ? 0.15 : styleGroup === 'metal' ? 0.7 : styleGroup === 'lamp' ? 0.6 : 0.25;
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness,
        metalness,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'building:wall:default') {
      const mat = new THREE.MeshStandardMaterial({
        color: theme.buildingWallColor,
        roughness: 0.65,
        metalness: 0.15,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(t.buildingWallColor),
      };
    }

    if (slotKey === 'building:roof:default') {
      const mat = new THREE.MeshStandardMaterial({
        color: theme.buildingRoofColor,
        roughness: 0.4,
        metalness: 0.25,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(t.buildingRoofColor),
      };
    }

    if (slotKey === 'building:wall:landmark') {
      const resolveColor = (t: MapStyleTheme) => (t.id === 'tactical' ? '#f59e0b' : '#fef08a');
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.5,
        metalness: 0.3,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey.startsWith('building:wall:arch_') || slotKey.startsWith('building:roof:arch_')) {
      const isRoof = slotKey.startsWith('building:roof:arch_');
      const archKey = slotKey.slice(isRoof ? 'building:roof:arch_'.length : 'building:wall:arch_'.length);
      const resolveColor = (t: MapStyleTheme) => {
        const entry = (t.buildingArchetypeColors as Record<string, { wall: string; roof: string }> | undefined)?.[archKey];
        if (entry) return isRoof ? entry.roof : entry.wall;
        return isRoof ? t.buildingRoofColor : t.buildingWallColor;
      };
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: isRoof ? 0.38 : 0.58,
        metalness: isRoof ? 0.28 : 0.2,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'railway:ballast') {
      const mat = new THREE.MeshStandardMaterial({
        color: theme.railwayColors.ballast,
        roughness: 0.92,
        metalness: 0.08,
        side: THREE.FrontSide,
        depthFunc: THREE.LessEqualDepth,
        stencilWrite: true,
        stencilRef: 14,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilZPass: THREE.ReplaceStencilOp,
        ...DEPTH_OFFSET_CONFIG.railways,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(t.railwayColors.ballast),
      };
    }

    if (slotKey === 'railway:sleepers_uv') {
      const mat = new THREE.MeshStandardMaterial({
        color: '#ffffff',
        roughness: 0.88,
        metalness: 0.06,
        side: THREE.FrontSide,
        depthFunc: THREE.LessEqualDepth,
        stencilWrite: true,
        stencilRef: 15,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilZPass: THREE.ReplaceStencilOp,
        ...DEPTH_OFFSET_CONFIG.railwaySleepers,
      });
      const ctrl = configureProceduralSleeperMaterial(mat, theme, this.currentCameraZoom);
      this.railwayShaderControls.push(ctrl);
      return {
        slotKey,
        material: mat,
        applyTheme: () => {
          // Handled via railwayShaderControls.updateThemeColors
        },
      };
    }

    if (slotKey === 'railway:rails_uv') {
      const mat = new THREE.MeshStandardMaterial({
        color: '#ffffff',
        roughness: 0.72,
        metalness: 0.22,
        side: THREE.FrontSide,
        depthFunc: THREE.LessEqualDepth,
        stencilWrite: true,
        stencilRef: 16,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilZPass: THREE.ReplaceStencilOp,
        ...DEPTH_OFFSET_CONFIG.railwayRails,
      });
      const ctrl = configureProceduralRailMaterial(mat, theme, this.currentCameraZoom);
      this.railwayShaderControls.push(ctrl);
      return {
        slotKey,
        material: mat,
        applyTheme: () => {
          // Handled via railwayShaderControls.updateThemeColors
        },
      };
    }

    if (slotKey === 'railway:sleepers_3d') {
      const resolveColor = (t: MapStyleTheme) => t.railwayColors.sleeper || '#64748b';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.86,
        metalness: 0.08,
        side: THREE.FrontSide,
        ...DEPTH_OFFSET_CONFIG.railwaySleepers,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'railway:rails_3d') {
      const mat = new THREE.MeshStandardMaterial({
        color: theme.railwayColors.rail,
        roughness: 0.65,
        metalness: 0.28,
        side: THREE.FrontSide,
        stencilWrite: true,
        stencilRef: 16,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilZPass: THREE.ReplaceStencilOp,
        ...DEPTH_OFFSET_CONFIG.railwayRails,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(t.railwayColors.rail),
      };
    }

    if (slotKey === 'railway:bridge_substructure') {
      const resolveColor = (t: MapStyleTheme) =>
        t.id === 'daylight' ? '#64748b' : t.id === 'blueprint' ? '#0077b6' : '#334155';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.85,
        metalness: 0.15,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'railway:bridge_parapets') {
      const resolveColor = (t: MapStyleTheme) =>
        t.id === 'daylight' ? '#94a3b8' : t.id === 'blueprint' ? '#48cae4' : '#64748b';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.75,
        metalness: 0.2,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'railway:tunnel_portals') {
      const resolveColor = (t: MapStyleTheme) =>
        t.id === 'daylight' ? '#94a3b8' : t.id === 'blueprint' ? '#0096c7' : '#475569';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.85,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'railway:tunnel_traces') {
      const resolveColor = (t: MapStyleTheme) =>
        t.id === 'daylight' ? '#475569' : t.id === 'blueprint' ? '#00b4d8' : '#38bdf8';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.9,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'railway:tunnel_ug_ballast') {
      const mat = new THREE.MeshStandardMaterial({
        color: theme.railwayColors.ballast,
        roughness: 0.92,
        metalness: 0.08,
        side: THREE.DoubleSide,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(t.railwayColors.ballast),
      };
    }

    if (slotKey === 'railway:tunnel_ug_sleepers') {
      const resolveColor = (t: MapStyleTheme) => t.railwayColors.sleeper || '#64748b';
      const mat = new THREE.MeshStandardMaterial({
        color: resolveColor(theme),
        roughness: 0.88,
        metalness: 0.08,
        side: THREE.DoubleSide,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(resolveColor(t)),
      };
    }

    if (slotKey === 'railway:tunnel_ug_rails') {
      const mat = new THREE.MeshStandardMaterial({
        color: theme.railwayColors.rail,
        roughness: 0.65,
        metalness: 0.28,
        side: THREE.DoubleSide,
      });
      return {
        slotKey,
        material: mat,
        applyTheme: (t) => mat.color.set(t.railwayColors.rail),
      };
    }

    // Fallback material
    const fallback = new THREE.MeshStandardMaterial({
      color: theme.groundColor,
      roughness: 0.85,
      metalness: 0.1,
    });
    return {
      slotKey,
      material: fallback,
      applyTheme: (t) => fallback.color.set(t.groundColor),
    };
  }
}
