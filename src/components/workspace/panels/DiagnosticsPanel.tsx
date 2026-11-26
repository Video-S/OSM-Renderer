import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Lock,
  Upload,
} from 'lucide-react';
import type { CameraZoomPolicy } from '../../../scene/cameraZoomPolicy';
import type { InspectableFeatureInfo, ProcessedMapData } from '../../../types/MapFeature';
import type { MapLoadDiagnosticsRecord } from '../../../world/dev/MapLoadDiagnostics';
import {
  buildReproductionPackage,
  type DeveloperReproductionPackage,
  type SerializedCameraPose,
  validateReproductionPackage,
} from '../../../world/dev/ReproductionReport';
import type {
  InfrastructureRenderOptions,
  InfrastructureRenderPreviewTiming,
} from '../../../world/infrastructure/rendering/InfrastructureRenderAdapter';
import type {
  GraphRoadGenerationTiming,
  GraphRoadRenderStats,
} from '../../../world/infrastructure/roads/GraphRoadGeometryBuilder';
import type { LiveWebGLTelemetrySnapshot } from '../../../world/prototype/PerformanceBaselineHarness';
import type { ActiveMosaicIdentity } from '../../../world/tiling/ActiveMosaicIdentity';
import type {
  FoliageLodMode,
  FoliageOptimizationConfig,
} from '../../../world/FoliageLodSystem';
import type { InstancedPickingMode } from '../../../world/InstancedSpatialIndex';
import type { TilePreparationVariantId } from '../../../world/tiling/TilePreparationConfig';
import type {
  HierarchicalStreamingDiagnosticsSnapshot,
  StreamingFrameBudgetDiagnosticsSnapshot,
} from '../../../world/tiling/TileStreamManager';
import type {
  HierarchicalResolutionMode,
  HierarchicalResolutionPolicyConfig,
} from '../../../world/tiling/HierarchicalResolutionPolicy';
import type { HierarchicalResourceBudgetConfig } from '../../../world/tiling/HierarchicalResourceBudget';
import {
  identifyStreamingF1Variant,
  type StreamingF1VariantId,
  type StreamingFrameBudgetConfig,
} from '../../../world/tiling/StreamingSchedulerConfig';
import type { ReproFormSessionState } from '../workspaceTypes';

export interface DiagnosticsPanelProps {
  wireframe: boolean;
  onToggleWireframe: () => void;
  isBakedTileMode: boolean;
  isM1aHarnessActive: boolean;
  showM1aTileBoundaries: boolean;
  onToggleM1aTileBoundaries: () => void;
  isM2aStreamingActive: boolean;
  showM2aTileBoundaries: boolean;
  onToggleM2aTileBoundaries: () => void;
  tileSizeMeters: number | null;
  showGraphOverlay: boolean;
  onToggleGraphOverlay: () => void;
  infrastructureRenderOptions: InfrastructureRenderOptions;
  roadRenderStats: GraphRoadRenderStats | null;
  roadRenderTiming: GraphRoadGenerationTiming | null;
  infrastructurePreviewTiming: InfrastructureRenderPreviewTiming | null;
  cpuBuildTimeMs: number | null;
  lastLoadDiagnostics: MapLoadDiagnosticsRecord | null;
  loadDiagnosticsHistory: MapLoadDiagnosticsRecord[];
  liveWebGLSnapshot: LiveWebGLTelemetrySnapshot | null;
  activeMosaicIdentity: ActiveMosaicIdentity;
  cameraZoomPolicy: CameraZoomPolicy;
  mapData: ProcessedMapData | null;
  currentRawGeoJson: any;
  currentCameraPose: SerializedCameraPose;
  selectedFeature: InspectableFeatureInfo | null;
  selectedFeatures: InspectableFeatureInfo[];
  focusedFeatureId: string | null;
  selectedBoxMeters: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
  roadWidthMultiplier: number;
  heightMultiplier: number;
  themeId: string;
  reproForm: ReproFormSessionState;
  onChangeReproForm: React.Dispatch<React.SetStateAction<ReproFormSessionState>>;
  onImportReproductionPackage: (pkg: DeveloperReproductionPackage) => void;
  foliageConfig: FoliageOptimizationConfig;
  onChangeFoliageConfig: (partial: Partial<FoliageOptimizationConfig>) => void;
  instancedPickingMode?: InstancedPickingMode;
  onChangeInstancedPickingMode?: (mode: InstancedPickingMode) => void;
  streamingProfilerEnabled?: boolean;
  onToggleStreamingProfiler?: () => void;
  onExportStreamingProfile?: () => void;
  streamingProfilerSummary?: {
    totalFrames: number;
    totalEvents: number;
    longTasks: number;
    loafs: number;
  } | null;
  tilePreparationVariant?: TilePreparationVariantId | 'custom';
  onChangeTilePreparationVariant?: (variant: TilePreparationVariantId) => void;
  tilePreparationStats?: {
    workerBvhAdoptedTotal: number;
    syncBvhFallbackTotal: number;
    pendingReadyTileBytes: number;
  } | null;
  hierarchicalDiagnostics?: HierarchicalStreamingDiagnosticsSnapshot | null;
  hierarchicalPolicy?: HierarchicalResolutionPolicyConfig;
  hierarchicalBudget?: HierarchicalResourceBudgetConfig;
  onChangeHierarchicalPolicy?: (
    partial: Partial<HierarchicalResolutionPolicyConfig>
  ) => void;
  onChangeHierarchicalBudget?: (
    partial: Partial<HierarchicalResourceBudgetConfig>
  ) => void;
  streamingFrameBudget?: StreamingFrameBudgetConfig;
  frameBudgetDiagnostics?: StreamingFrameBudgetDiagnosticsSnapshot | null;
  onChangeStreamingFrameBudget?: (
    input: StreamingF1VariantId | Partial<StreamingFrameBudgetConfig>
  ) => void;
}

function formatDiagMs(val: number | null | undefined): string {
  if (typeof val !== 'number' || !Number.isFinite(val)) return '—';
  return `${val.toFixed(1)} ms`;
}

function formatDiagMb(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '0.0 MB';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const DiagnosticsPanel: React.FC<DiagnosticsPanelProps> = ({
  wireframe,
  onToggleWireframe,
  isBakedTileMode,
  isM1aHarnessActive,
  showM1aTileBoundaries,
  onToggleM1aTileBoundaries,
  isM2aStreamingActive,
  showM2aTileBoundaries,
  onToggleM2aTileBoundaries,
  tileSizeMeters,
  showGraphOverlay,
  onToggleGraphOverlay,
  infrastructureRenderOptions,
  roadRenderStats,
  roadRenderTiming,
  infrastructurePreviewTiming,
  cpuBuildTimeMs,
  lastLoadDiagnostics,
  loadDiagnosticsHistory,
  liveWebGLSnapshot,
  activeMosaicIdentity,
  cameraZoomPolicy,
  mapData,
  currentRawGeoJson,
  currentCameraPose,
  selectedFeature,
  selectedFeatures,
  focusedFeatureId,
  selectedBoxMeters,
  roadWidthMultiplier,
  heightMultiplier,
  themeId,
  reproForm,
  onChangeReproForm,
  onImportReproductionPackage,
  foliageConfig,
  onChangeFoliageConfig,
  instancedPickingMode = 'accelerated',
  onChangeInstancedPickingMode,
  streamingProfilerEnabled = false,
  onToggleStreamingProfiler,
  onExportStreamingProfile,
  streamingProfilerSummary = null,
  tilePreparationVariant = 'combined',
  onChangeTilePreparationVariant,
  tilePreparationStats = null,
  hierarchicalDiagnostics = null,
  hierarchicalPolicy,
  hierarchicalBudget,
  onChangeHierarchicalPolicy,
  onChangeHierarchicalBudget,
  streamingFrameBudget,
  frameBudgetDiagnostics = null,
  onChangeStreamingFrameBudget,
}) => {
  const [copiedStatus, setCopiedStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [exportSuccessMsg, setExportSuccessMsg] = useState<string | null>(null);
  const [exportErrorMsg, setExportErrorMsg] = useState<string | null>(null);
  const [importErrorMsg, setImportErrorMsg] = useState<string | null>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  const showTileGridToggle = isM2aStreamingActive || isM1aHarnessActive;
  const tileGridActive = isM2aStreamingActive ? showM2aTileBoundaries : showM1aTileBoundaries;
  const onToggleTileGrid = isM2aStreamingActive
    ? onToggleM2aTileBoundaries
    : onToggleM1aTileBoundaries;

  const handleCopyLoadDiagnostics = async () => {
    const payload = {
      schema: 'tkt021-map-load-diagnostics-v1',
      capturedAtIso: new Date().toISOString(),
      environment: {
        locationHref:
          typeof window !== 'undefined'
            ? window.location.origin + window.location.pathname
            : null,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : null,
        hardwareConcurrency:
          typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : null,
        gpuVendor: liveWebGLSnapshot?.gpuVendor ?? null,
        gpuRenderer: liveWebGLSnapshot?.gpuRenderer ?? null,
      },
      latestLoad: lastLoadDiagnostics,
      recentHistory: loadDiagnosticsHistory,
      activeMosaic: activeMosaicIdentity,
      cameraZoomPolicy,
    };
    const jsonText = JSON.stringify(payload, null, 2);

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(jsonText);
      } else if (typeof document !== 'undefined') {
        const textarea = document.createElement('textarea');
        textarea.value = jsonText;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      } else {
        throw new Error('Clipboard unavailable');
      }
      setCopiedStatus('copied');
      setTimeout(() => setCopiedStatus('idle'), 3000);
    } catch {
      setCopiedStatus('error');
      setTimeout(() => setCopiedStatus('idle'), 3000);
    }
  };

  const handleExportReproduction = () => {
    setExportErrorMsg(null);
    try {
      const selectedList =
        selectedFeatures.length > 0
          ? selectedFeatures
          : selectedFeature
            ? [selectedFeature]
            : [];

      const pkg = buildReproductionPackage({
        report: {
          title: reproForm.title || 'OSM Renderer Defect Repro',
          description: reproForm.description,
          expectedBehavior: reproForm.expectedBehavior,
          severity: reproForm.severity,
          category: reproForm.category,
          createdAt: new Date().toISOString(),
        },
        selectedFeature,
        selectedFeatures: selectedList,
        focusedFeatureId,
        mapData,
        fullRawGeoJson: currentRawGeoJson,
        infrastructureRenderOptions,
        railwayPrototypeMode: 'production',
        cameraPose: currentCameraPose,
        spatialBoxMeters: selectedBoxMeters ?? undefined,
        roadWidthMultiplier,
        heightMultiplier,
        themeId,
        wireframe,
      });

      const jsonStr = JSON.stringify(pkg, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const cleanTitle = (reproForm.title || 'osm-repro')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .replace(/-+/g, '-');
      link.download = `repro-${cleanTitle}-${new Date().toISOString().slice(0, 10)}.json`;
      link.href = url;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setExportSuccessMsg(
        `Exported ${pkg.geoJson.features.length} context features (${selectedList.length} selected)`
      );
      setTimeout(() => setExportSuccessMsg(null), 4000);
    } catch (err: any) {
      setExportErrorMsg(`Export failed: ${err?.message || String(err)}`);
    }
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportErrorMsg(null);

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const parsed = JSON.parse(text);
        const { valid, error, package: validatedPkg } = validateReproductionPackage(parsed);
        if (!valid || !validatedPkg) {
          setImportErrorMsg(error || 'Invalid reproduction package file');
          return;
        }

        onChangeReproForm({
          title: validatedPkg.report.title,
          description: validatedPkg.report.description,
          expectedBehavior: validatedPkg.report.expectedBehavior,
          severity: validatedPkg.report.severity ?? 'medium',
          category: validatedPkg.report.category ?? 'junction',
        });

        onImportReproductionPackage(validatedPkg);
        setExportSuccessMsg(`Imported reproduction: "${validatedPkg.report.title}"`);
        setTimeout(() => setExportSuccessMsg(null), 4000);
      } catch (err: any) {
        setImportErrorMsg(`Parse error: ${err.message}`);
      }
    };
    reader.readAsText(file);
    if (e.target) e.target.value = '';
  };

  return (
    <div data-testid="panel-diagnostics" className="space-y-3.5">
      {/* 1. Diagnostic Overlays */}
      <section className="bg-slate-900/60 border border-slate-800 rounded-md p-3 space-y-2">
        <div className="text-xs font-semibold text-slate-200">Diagnostic Overlays</div>

        <div className="space-y-1.5">
          <button
            type="button"
            data-testid="diag-toggle-wireframe"
            aria-pressed={wireframe}
            onClick={onToggleWireframe}
            className={`w-full px-2.5 py-2 rounded-md border text-xs font-medium flex items-center justify-between transition cursor-pointer ${
              wireframe
                ? 'bg-cyan-500/15 border-cyan-500/45 text-cyan-200'
                : 'bg-slate-950 border-slate-800 text-slate-300 hover:bg-slate-900'
            }`}
          >
            <span>Wireframe Overlay</span>
            <span className="text-[10px] font-mono">{wireframe ? 'ON' : 'OFF'}</span>
          </button>

          {showTileGridToggle && (
            <button
              type="button"
              data-testid="diag-toggle-tile-grid"
              aria-pressed={tileGridActive}
              onClick={onToggleTileGrid}
              className={`w-full px-2.5 py-2 rounded-md border text-xs font-medium flex items-center justify-between transition cursor-pointer ${
                tileGridActive
                  ? 'bg-emerald-500/15 border-emerald-500/45 text-emerald-200'
                  : 'bg-slate-950 border-slate-800 text-slate-300 hover:bg-slate-900'
              }`}
            >
              <span>
                {tileSizeMeters ? `${tileSizeMeters}m Tile Grid Boundaries` : 'Tile Grid Boundaries'}
              </span>
              <span className="text-[10px] font-mono">{tileGridActive ? 'ON' : 'OFF'}</span>
            </button>
          )}

          <button
            type="button"
            data-testid="diag-toggle-graph-overlay"
            disabled={isBakedTileMode}
            aria-pressed={!isBakedTileMode && showGraphOverlay}
            onClick={onToggleGraphOverlay}
            className={`w-full px-2.5 py-2 rounded-md border text-xs font-medium flex items-center justify-between transition ${
              isBakedTileMode
                ? 'bg-slate-950/60 border-slate-800/70 text-slate-500 cursor-not-allowed'
                : showGraphOverlay
                  ? 'bg-cyan-500/15 border-cyan-500/45 text-cyan-200 cursor-pointer'
                  : 'bg-slate-950 border-slate-800 text-slate-300 hover:bg-slate-900 cursor-pointer'
            }`}
          >
            <span className="flex items-center gap-1.5">
              {isBakedTileMode && <Lock className="w-3 h-3 text-slate-500" />}
              <span>Topology Graph Nodes</span>
            </span>
            <span className="text-[10px] font-mono">
              {isBakedTileMode ? 'UNBAKED ONLY' : showGraphOverlay ? 'ON' : 'OFF'}
            </span>
          </button>
        </div>
      </section>

      {/* 1b. Runtime Foliage LOD & Culling (TKT-036) */}
      <section
        data-testid="diag-foliage-lod-section"
        className="bg-slate-900/60 border border-slate-800 rounded-md p-3 space-y-2.5"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-200">
            Foliage LOD &amp; Culling
          </span>
          <span
            data-testid="diag-foliage-active-lod"
            className="text-[10px] font-mono uppercase text-emerald-400"
          >
            {liveWebGLSnapshot?.foliageTelemetry
              ? `${liveWebGLSnapshot.foliageTelemetry.activeLod}${
                  liveWebGLSnapshot.foliageTelemetry.trunksVisible ? '' : ' · no trunks'
                }`
              : foliageConfig.enabled
                ? foliageConfig.lodMode
                : 'disabled'}
          </span>
        </div>

        <div className="space-y-1.5">
          <button
            type="button"
            data-testid="diag-toggle-foliage-opt"
            aria-pressed={foliageConfig.enabled}
            onClick={() => onChangeFoliageConfig({ enabled: !foliageConfig.enabled })}
            className={`w-full px-2.5 py-1.5 rounded-md border text-xs font-medium flex items-center justify-between transition cursor-pointer ${
              foliageConfig.enabled
                ? 'bg-emerald-500/15 border-emerald-500/45 text-emerald-200'
                : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-900'
            }`}
          >
            <span>Foliage Optimization</span>
            <span className="text-[10px] font-mono">
              {foliageConfig.enabled ? 'ON' : 'OFF (LOD0)'}
            </span>
          </button>

          <div className="grid grid-cols-4 gap-1">
            {(['auto', 'lod0', 'lod1', 'lod2'] as FoliageLodMode[]).map((mode) => {
              const active = foliageConfig.enabled && foliageConfig.lodMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  data-testid={`diag-foliage-lod-${mode}`}
                  disabled={!foliageConfig.enabled}
                  aria-pressed={active}
                  onClick={() => onChangeFoliageConfig({ lodMode: mode })}
                  className={`py-1 px-1.5 rounded border text-[10px] font-mono uppercase transition ${
                    !foliageConfig.enabled
                      ? 'bg-slate-950/50 border-slate-800/60 text-slate-600 cursor-not-allowed'
                      : active
                        ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-200 cursor-pointer'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-900 cursor-pointer'
                  }`}
                >
                  {mode}
                </button>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              data-testid="diag-toggle-foliage-trunks"
              disabled={!foliageConfig.enabled}
              aria-pressed={foliageConfig.enabled && foliageConfig.trunkSuppressionEnabled}
              onClick={() =>
                onChangeFoliageConfig({
                  trunkSuppressionEnabled: !foliageConfig.trunkSuppressionEnabled,
                })
              }
              className={`px-2 py-1.5 rounded-md border text-[11px] font-medium flex items-center justify-between transition ${
                !foliageConfig.enabled
                  ? 'bg-slate-950/50 border-slate-800/60 text-slate-600 cursor-not-allowed'
                  : foliageConfig.trunkSuppressionEnabled
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200 cursor-pointer'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-900 cursor-pointer'
              }`}
            >
              <span>Trunk Suppress</span>
              <span className="text-[10px] font-mono">
                {foliageConfig.trunkSuppressionEnabled ? 'ON' : 'OFF'}
              </span>
            </button>

            <button
              type="button"
              data-testid="diag-toggle-foliage-cull"
              disabled={!foliageConfig.enabled}
              aria-pressed={foliageConfig.enabled && foliageConfig.frustumCullingEnabled}
              onClick={() =>
                onChangeFoliageConfig({
                  frustumCullingEnabled: !foliageConfig.frustumCullingEnabled,
                })
              }
              className={`px-2 py-1.5 rounded-md border text-[11px] font-medium flex items-center justify-between transition ${
                !foliageConfig.enabled
                  ? 'bg-slate-950/50 border-slate-800/60 text-slate-600 cursor-not-allowed'
                  : foliageConfig.frustumCullingEnabled
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200 cursor-pointer'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-900 cursor-pointer'
              }`}
            >
              <span>Frustum Cull</span>
              <span className="text-[10px] font-mono">
                {foliageConfig.frustumCullingEnabled ? 'ON' : 'OFF'}
              </span>
            </button>
          </div>
        </div>

        {liveWebGLSnapshot?.foliageTelemetry && (
          <div className="bg-slate-950 border border-slate-800 rounded p-2 text-[10px] font-mono tabular-nums text-slate-400 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span>
                Trees Sub / Res:{' '}
                <strong className="text-slate-200">
                  {liveWebGLSnapshot.foliageTelemetry.submittedTreeInstances.toLocaleString()}
                </strong>
                /{liveWebGLSnapshot.foliageTelemetry.residentTreeInstances.toLocaleString()}
              </span>
              <span>
                Culled:{' '}
                <strong className="text-amber-300">
                  {liveWebGLSnapshot.foliageTelemetry.frustumCulledBatches}
                </strong>
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>
                Tris Sub:{' '}
                <strong className="text-cyan-300">
                  {liveWebGLSnapshot.foliageTelemetry.submittedTriangles.toLocaleString()}
                </strong>
              </span>
              <span className="text-emerald-300">
                -{liveWebGLSnapshot.foliageTelemetry.triangleReductionVsLod0Pct}% vs LOD0
              </span>
            </div>
          </div>
        )}

        {onChangeInstancedPickingMode && (
          <div className="pt-1 border-t border-slate-800/80 space-y-1.5">
            <button
              type="button"
              data-testid="diag-toggle-instanced-picking"
              aria-pressed={instancedPickingMode === 'accelerated'}
              onClick={() =>
                onChangeInstancedPickingMode(
                  instancedPickingMode === 'accelerated' ? 'unaccelerated' : 'accelerated'
                )
              }
              className={`w-full px-2.5 py-1.5 rounded-md border text-xs font-medium flex items-center justify-between transition cursor-pointer ${
                instancedPickingMode === 'accelerated'
                  ? 'bg-emerald-500/15 border-emerald-500/45 text-emerald-200'
                  : 'bg-amber-500/15 border-amber-500/45 text-amber-200'
              }`}
            >
              <span>Instanced Picking BVH</span>
              <span className="text-[10px] font-mono">
                {instancedPickingMode === 'accelerated' ? 'BVH (ON)' : 'LINEAR (REF)'}
              </span>
            </button>

            {liveWebGLSnapshot?.instancedPickingTelemetry && (
              <div
                data-testid="diag-instanced-picking-stats"
                className="bg-slate-950 border border-slate-800 rounded p-2 text-[10px] font-mono tabular-nums text-slate-400 space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span>
                    Index:{' '}
                    <strong className="text-slate-200">
                      {(
                        liveWebGLSnapshot.instancedPickingTelemetry.indexStats
                          .totalIndexMemoryBytes /
                        (1024 * 1024)
                      ).toFixed(2)}{' '}
                      MB
                    </strong>{' '}
                    ({liveWebGLSnapshot.instancedPickingTelemetry.indexStats.indexedBatchCount}{' '}
                    batches)
                  </span>
                  <span>
                    Build:{' '}
                    <strong className="text-cyan-300">
                      {liveWebGLSnapshot.instancedPickingTelemetry.indexStats.totalBuildTimeMs.toFixed(
                        1
                      )}
                      ms
                    </strong>
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>
                    Cand / Exact:{' '}
                    <strong className="text-emerald-300">
                      {liveWebGLSnapshot.instancedPickingTelemetry.lastRaycast.candidateInstances}/
                      {liveWebGLSnapshot.instancedPickingTelemetry.lastRaycast.exactInstanceTests}
                    </strong>
                  </span>
                  <span>
                    Batch Inst:{' '}
                    <strong className="text-slate-200">
                      {liveWebGLSnapshot.instancedPickingTelemetry.lastRaycast.totalInstancesInQueriedBatches.toLocaleString()}
                    </strong>
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
        {onToggleStreamingProfiler && (
          <div className="pt-1 border-t border-slate-800/80 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                data-testid="diag-toggle-streaming-profiler"
                aria-pressed={streamingProfilerEnabled}
                onClick={onToggleStreamingProfiler}
                className={`flex-1 px-2.5 py-1.5 rounded-md border text-xs font-medium flex items-center justify-between transition cursor-pointer ${
                  streamingProfilerEnabled
                    ? 'bg-cyan-500/15 border-cyan-500/45 text-cyan-200'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:bg-slate-900'
                }`}
              >
                <span>Streaming Fluidity Profiler</span>
                <span className="text-[10px] font-mono">
                  {streamingProfilerEnabled ? 'REC ON' : 'OFF'}
                </span>
              </button>
              {onExportStreamingProfile && (
                <button
                  type="button"
                  data-testid="diag-export-streaming-profile"
                  onClick={onExportStreamingProfile}
                  title="Download captured streaming & frame profile JSON"
                  className="px-2 py-1.5 rounded-md border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-200 text-[10px] font-mono flex items-center gap-1 cursor-pointer"
                >
                  <Download className="w-3 h-3" />
                  <span>JSON</span>
                </button>
              )}
            </div>
            {streamingProfilerSummary && (
              <div className="text-[10px] font-mono tabular-nums text-slate-400 flex items-center justify-between px-1">
                <span>Frames: {streamingProfilerSummary.totalFrames}</span>
                <span>Events: {streamingProfilerSummary.totalEvents}</span>
                <span>LoAF: {streamingProfilerSummary.loafs}</span>
              </div>
            )}
            {onChangeTilePreparationVariant && (
              <div className="pt-1.5 space-y-1">
                <div className="flex items-center justify-between gap-2 text-[10px] text-slate-400">
                  <span>Tile Prep Mode</span>
                  <select
                    data-testid="diag-tile-prep-variant"
                    value={tilePreparationVariant}
                    onChange={(e) => {
                      const val = e.target.value as TilePreparationVariantId;
                      if (
                        val === 'baseline' ||
                        val === 'transfer_only' ||
                        val === 'compact_transport' ||
                        val === 'worker_bvh' ||
                        val === 'combined'
                      ) {
                        onChangeTilePreparationVariant(val);
                      }
                    }}
                    className="bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[10px] font-mono text-slate-200 cursor-pointer"
                  >
                    <option value="combined">combined (default)</option>
                    <option value="worker_bvh">worker_bvh</option>
                    <option value="compact_transport">compact_transport</option>
                    <option value="transfer_only">transfer_only</option>
                    <option value="baseline">baseline (TKT-039)</option>
                  </select>
                </div>
                {tilePreparationStats && (
                  <div
                    data-testid="diag-tile-prep-stats"
                    className="text-[10px] font-mono tabular-nums text-slate-400 flex items-center justify-between px-1"
                  >
                    <span>
                      Worker BVH:{' '}
                      <strong className="text-emerald-300">
                        {tilePreparationStats.workerBvhAdoptedTotal}
                      </strong>
                    </span>
                    <span>
                      Sync Fallback:{' '}
                      <strong
                        className={
                          tilePreparationStats.syncBvhFallbackTotal > 0
                            ? 'text-amber-300'
                            : 'text-slate-300'
                        }
                      >
                        {tilePreparationStats.syncBvhFallbackTotal}
                      </strong>
                    </span>
                    <span>
                      Ready:{' '}
                      {(tilePreparationStats.pendingReadyTileBytes / (1024 * 1024)).toFixed(1)} MB
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {/* 1c. Hierarchical Tile Streaming (TKT-041) */}
      {hierarchicalDiagnostics?.enabled && (
        <section
          data-testid="diag-hierarchical-streaming-section"
          className="bg-slate-900/60 border border-slate-800 rounded-md p-3 space-y-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-200">
              Hierarchical Tile Streaming
            </span>
            <span
              data-testid="diag-hierarchical-active-res"
              className="text-[10px] font-mono uppercase text-cyan-300"
            >
              {hierarchicalDiagnostics.activeResolutionMeters}m ·{' '}
              {hierarchicalDiagnostics.transitionState}
            </span>
          </div>

          {onChangeHierarchicalPolicy && hierarchicalPolicy && (
            <div className="space-y-1.5">
              <div className="grid grid-cols-4 gap-1">
                {(
                  [
                    { id: 'auto', label: 'AUTO' },
                    { id: 'force_1024', label: '1024m' },
                    { id: 'force_2048', label: '2048m' },
                    { id: 'force_4096', label: '4096m' },
                  ] as Array<{ id: HierarchicalResolutionMode; label: string }>
                ).map((item) => {
                  const active = hierarchicalPolicy.mode === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-testid={`diag-hierarchical-mode-${item.id}`}
                      aria-pressed={active}
                      onClick={() =>
                        onChangeHierarchicalPolicy({ mode: item.id })
                      }
                      className={`py-1 px-1.5 rounded border text-[10px] font-mono transition cursor-pointer ${
                        active
                          ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-200'
                          : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-900'
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>

              {hierarchicalPolicy.bands.length >= 2 && (
                <div className="bg-slate-950 border border-slate-800 rounded p-2 space-y-1.5 text-[10px] font-mono text-slate-400">
                  <div className="text-slate-300 font-semibold">
                    Hysteresis Bands (px/m)
                  </div>
                  {hierarchicalPolicy.bands.map((band, idx) => (
                    <div
                      key={`${band.fineResolutionMeters}-${band.coarseResolutionMeters}`}
                      className="flex items-center justify-between gap-1.5"
                    >
                      <span className="text-slate-400 shrink-0">
                        {band.fineResolutionMeters}↔{band.coarseResolutionMeters}
                      </span>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          step="0.02"
                          min="0.05"
                          max="10"
                          aria-label={`${band.fineResolutionMeters} to ${band.coarseResolutionMeters} zoom-out threshold`}
                          value={band.zoomOutThreshold}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            if (!Number.isFinite(val) || val <= 0) return;
                            const nextBands = hierarchicalPolicy.bands.map((b, i) =>
                              i === idx
                                ? {
                                    ...b,
                                    zoomOutThreshold: val,
                                    zoomInThreshold: Math.max(val, b.zoomInThreshold),
                                  }
                                : b
                            );
                            onChangeHierarchicalPolicy({ bands: nextBands });
                          }}
                          className="w-12 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200 text-right"
                        />
                        <span>/</span>
                        <input
                          type="number"
                          step="0.02"
                          min="0.05"
                          max="10"
                          aria-label={`${band.fineResolutionMeters} to ${band.coarseResolutionMeters} zoom-in threshold`}
                          value={band.zoomInThreshold}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            if (!Number.isFinite(val) || val <= 0) return;
                            const nextBands = hierarchicalPolicy.bands.map((b, i) =>
                              i === idx
                                ? {
                                    ...b,
                                    zoomInThreshold: Math.max(b.zoomOutThreshold, val),
                                  }
                                : b
                            );
                            onChangeHierarchicalPolicy({ bands: nextBands });
                          }}
                          className="w-12 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200 text-right"
                        />
                      </div>
                    </div>
                  ))}
                  {onChangeHierarchicalBudget && hierarchicalBudget && (
                    <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-800/80">
                      <span>Total Budget (MiB)</span>
                      <input
                        type="number"
                        step="32"
                        min="16"
                        max="8192"
                        aria-label="Hierarchical total memory budget MiB"
                        value={Math.round(
                          hierarchicalBudget.totalMemoryBudgetBytes / (1024 * 1024)
                        )}
                        onChange={(e) => {
                          const mb = Number(e.target.value);
                          if (!Number.isFinite(mb) || mb < 1) return;
                          onChangeHierarchicalBudget({
                            totalMemoryBudgetBytes: Math.round(mb * 1024 * 1024),
                          });
                        }}
                        className="w-16 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200 text-right"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {hierarchicalDiagnostics.budgetDeferralReason && (
            <div
              data-testid="diag-hierarchical-budget-deferral"
              className="p-2 rounded bg-amber-500/10 border border-amber-500/30 text-amber-200 text-[10px] leading-snug"
            >
              {hierarchicalDiagnostics.budgetDeferralReason}
            </div>
          )}

          <div
            data-testid="diag-hierarchical-stats"
            className="bg-slate-950 border border-slate-800 rounded p-2 text-[10px] font-mono tabular-nums text-slate-400 space-y-1"
          >
            <div className="flex items-center justify-between gap-2">
              <span>
                Active / Desired:{' '}
                <strong className="text-slate-200">
                  {hierarchicalDiagnostics.activeResolutionMeters}m
                </strong>{' '}
                /{' '}
                <strong className="text-cyan-300">
                  {hierarchicalDiagnostics.desiredResolutionMeters}m
                </strong>
              </span>
              <span>
                Pending:{' '}
                <strong className="text-amber-300">
                  {hierarchicalDiagnostics.pendingResolutionMeters
                    ? `${hierarchicalDiagnostics.pendingResolutionMeters}m`
                    : '—'}
                </strong>
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>
                Zoom / Eff Scale:{' '}
                <strong className="text-slate-200">
                  {hierarchicalDiagnostics.rawCameraZoom.toFixed(2)}
                </strong>{' '}
                /{' '}
                <strong className="text-emerald-300">
                  {hierarchicalDiagnostics.effectiveScalePxPerMeter.toFixed(2)}
                </strong>
              </span>
              <span>
                Dest:{' '}
                <strong className="text-slate-200">
                  {hierarchicalDiagnostics.readyDestinationTiles}/
                  {hierarchicalDiagnostics.requiredDestinationTiles}
                </strong>
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>
                Trans (S/C/X/D):{' '}
                <strong className="text-slate-200">
                  {hierarchicalDiagnostics.counters.transitionsStarted}/
                  {hierarchicalDiagnostics.counters.transitionsCompleted}/
                  {hierarchicalDiagnostics.counters.transitionsCancelled}/
                  {hierarchicalDiagnostics.counters.transitionsDeferredBudget}
                </strong>
              </span>
              <span>
                Swap:{' '}
                <strong className="text-cyan-300">
                  {hierarchicalDiagnostics.timings.lastActivationSwapMs.toFixed(2)}ms
                </strong>
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>
                Cache Hit/Evict:{' '}
                <strong className="text-emerald-300">
                  {hierarchicalDiagnostics.counters.cacheHits}
                </strong>
                /{hierarchicalDiagnostics.counters.cacheEvictions}
              </span>
              <span>
                Pending Q/F/D/R:{' '}
                {hierarchicalDiagnostics.pendingQueues.queued}/
                {hierarchicalDiagnostics.pendingQueues.fetching}/
                {hierarchicalDiagnostics.pendingQueues.decoding}/
                {hierarchicalDiagnostics.pendingQueues.readyToCommit}
              </span>
            </div>
            <div className="pt-1 border-t border-slate-800/80 space-y-0.5">
              <div className="flex items-center justify-between">
                <span>
                  Measured CPU/BVH:{' '}
                  <strong className="text-slate-200">
                    {formatDiagMb(
                      hierarchicalDiagnostics.resources.totalMeasuredBytes
                    )}
                  </strong>
                </span>
                <span>
                  Est. GPU:{' '}
                  <strong className="text-slate-300">
                    {formatDiagMb(
                      hierarchicalDiagnostics.resources.totalEstimatedGpuBytes
                    )}
                  </strong>
                </span>
              </div>
              <div className="flex items-center justify-between text-slate-500">
                <span>
                  Cache:{' '}
                  {formatDiagMb(
                    hierarchicalDiagnostics.resources.retainedInactiveTilesBytes
                  )}
                </span>
                <span>
                  Queued:{' '}
                  {formatDiagMb(
                    hierarchicalDiagnostics.resources.queuedDecodedPayloadBytes
                  )}
                </span>
              </div>
              {hierarchicalDiagnostics.resources.byResolution.map((r) => (
                <div
                  key={r.tileSizeMeters}
                  className="flex items-center justify-between text-[9px] text-slate-400"
                >
                  <span>
                    {r.tileSizeMeters}m (A:{r.attachedActiveTiles} P:
                    {r.preparedPendingTiles} C:{r.cachedInactiveTiles} D:
                    {r.pendingDisposalTiles})
                  </span>
                  <span>
                    {formatDiagMb(
                      r.measuredCpuGeometryBytes +
                        r.measuredStaticBvhBytes +
                        r.measuredInstancedIndexBytes +
                        r.measuredQueuedDecodedBytes +
                        r.measuredPendingDisposalBytes
                    )}{' '}
                    / est {formatDiagMb(r.estimatedGpuBytes)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* TKT-041-F1: Frame-Budgeted Streaming & Section 12 Transition Diagnostics */}
          {onChangeStreamingFrameBudget && streamingFrameBudget && (
            <div
              data-testid="diag-f1-controls"
              className="bg-slate-950 border border-slate-800 rounded p-2 space-y-1.5 text-[10px] font-mono text-slate-400"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-300 font-semibold">
                  Frame-Budget Preset
                </span>
                <select
                  data-testid="diag-f1-variant-select"
                  value={identifyStreamingF1Variant(streamingFrameBudget)}
                  onChange={(e) => {
                    const val = e.target.value as StreamingF1VariantId;
                    if (val !== ('custom' as unknown)) {
                      onChangeStreamingFrameBudget(val);
                    }
                  }}
                  className="bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-[10px] text-slate-200 cursor-pointer"
                >
                  <option value="combined">combined (F1 default)</option>
                  <option value="combined_prewarm">combined_prewarm</option>
                  <option value="tkt041_baseline">tkt041_baseline</option>
                  <option value="scheduler_only">scheduler_only</option>
                  <option value="incremental_gpu_only">incremental_gpu_only</option>
                  <option value="deferred_disposal_only">deferred_disposal_only</option>
                  <option value="debounce_reuse_only">debounce_reuse_only</option>
                  <option value="custom" disabled>
                    custom
                  </option>
                </select>
              </div>

              <div className="flex items-center justify-between gap-1.5">
                <span>Frame Budget</span>
                <div className="flex items-center gap-1">
                  {[1, 2, 4].map((ms) => {
                    const active =
                      streamingFrameBudget.sharedSchedulerEnabled &&
                      Math.abs(streamingFrameBudget.frameStreamingBudgetMs - ms) < 0.05;
                    return (
                      <button
                        key={ms}
                        type="button"
                        data-testid={`diag-f1-budget-${ms}ms`}
                        onClick={() =>
                          onChangeStreamingFrameBudget({
                            sharedSchedulerEnabled: true,
                            frameStreamingBudgetMs: ms,
                          })
                        }
                        className={`px-1.5 py-0.5 rounded border cursor-pointer ${
                          active
                            ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-200'
                            : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {ms}ms
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center justify-between gap-1.5">
                <span>Debounce</span>
                <div className="flex items-center gap-1">
                  {[0, 100, 150, 250].map((ms) => {
                    const active = streamingFrameBudget.transitionDebounceMs === ms;
                    return (
                      <button
                        key={ms}
                        type="button"
                        data-testid={`diag-f1-debounce-${ms}ms`}
                        onClick={() =>
                          onChangeStreamingFrameBudget({
                            transitionDebounceMs: ms,
                          })
                        }
                        className={`px-1.5 py-0.5 rounded border cursor-pointer ${
                          active
                            ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-200'
                            : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {ms}ms
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-1 pt-0.5">
                <button
                  type="button"
                  data-testid="diag-f1-toggle-gpu-prep"
                  aria-pressed={streamingFrameBudget.incrementalGpuPrepEnabled}
                  onClick={() =>
                    onChangeStreamingFrameBudget({
                      incrementalGpuPrepEnabled:
                        !streamingFrameBudget.incrementalGpuPrepEnabled,
                    })
                  }
                  className={`px-1.5 py-1 rounded border text-[9px] cursor-pointer ${
                    streamingFrameBudget.incrementalGpuPrepEnabled
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'
                      : 'bg-slate-900 border-slate-700 text-slate-400'
                  }`}
                >
                  GPU Prep {streamingFrameBudget.incrementalGpuPrepEnabled ? 'ON' : 'OFF'}
                </button>
                <button
                  type="button"
                  data-testid="diag-f1-toggle-deferred-dispose"
                  aria-pressed={streamingFrameBudget.deferredDisposalEnabled}
                  onClick={() =>
                    onChangeStreamingFrameBudget({
                      deferredDisposalEnabled:
                        !streamingFrameBudget.deferredDisposalEnabled,
                    })
                  }
                  className={`px-1.5 py-1 rounded border text-[9px] cursor-pointer ${
                    streamingFrameBudget.deferredDisposalEnabled
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'
                      : 'bg-slate-900 border-slate-700 text-slate-400'
                  }`}
                >
                  Def Disp {streamingFrameBudget.deferredDisposalEnabled ? 'ON' : 'OFF'}
                </button>
                <button
                  type="button"
                  data-testid="diag-f1-toggle-prewarm"
                  aria-pressed={streamingFrameBudget.predictivePrewarmEnabled}
                  onClick={() =>
                    onChangeStreamingFrameBudget({
                      predictivePrewarmEnabled:
                        !streamingFrameBudget.predictivePrewarmEnabled,
                    })
                  }
                  className={`px-1.5 py-1 rounded border text-[9px] cursor-pointer ${
                    streamingFrameBudget.predictivePrewarmEnabled
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'
                      : 'bg-slate-900 border-slate-700 text-slate-400'
                  }`}
                >
                  Prewarm {streamingFrameBudget.predictivePrewarmEnabled ? 'ON' : 'OFF'}
                </button>
              </div>
            </div>
          )}

          {/* Live Transition Blocker & Critical Path (TKT-041-F1 Section 12) */}
          <div
            data-testid="diag-transition-blocker-section"
            className="bg-slate-950 border border-slate-800 rounded p-2 text-[10px] font-mono tabular-nums text-slate-400 space-y-1.5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-300 font-semibold">
                Transition Blocker
              </span>
              <span
                data-testid="diag-transition-blocker-category"
                className={
                  hierarchicalDiagnostics.currentTransitionBlocker.active
                    ? 'text-amber-300'
                    : 'text-emerald-300'
                }
              >
                {hierarchicalDiagnostics.currentTransitionBlocker.blockerCategory}
              </span>
            </div>

            {hierarchicalDiagnostics.currentTransitionBlocker.active ? (
              <div className="space-y-1">
                <div className="text-[9px] text-amber-200/90 leading-snug">
                  {hierarchicalDiagnostics.currentTransitionBlocker.blockerReason}
                </div>
                <div className="flex items-center justify-between text-[9px]">
                  <span>
                    Target:{' '}
                    <strong className="text-slate-200">
                      {hierarchicalDiagnostics.currentTransitionBlocker.fromResolutionMeters}m→
                      {hierarchicalDiagnostics.currentTransitionBlocker.toResolutionMeters}m
                    </strong>
                  </span>
                  <span>
                    Pending:{' '}
                    <strong className="text-amber-300">
                      {formatDiagMs(
                        hierarchicalDiagnostics.currentTransitionBlocker.elapsedMs
                      )}
                    </strong>
                  </span>
                </div>
                <div className="flex items-center justify-between text-[9px] text-slate-400">
                  <span>
                    Q/F/D/R/G:{' '}
                    {hierarchicalDiagnostics.currentTransitionBlocker.queuedCount}/
                    {hierarchicalDiagnostics.currentTransitionBlocker.fetchingCount}/
                    {hierarchicalDiagnostics.currentTransitionBlocker.decodingCount}/
                    {hierarchicalDiagnostics.currentTransitionBlocker.reconstructWaitingCount}/
                    {hierarchicalDiagnostics.currentTransitionBlocker.gpuPrepWaitingCount}
                  </span>
                  <span>
                    Slots:{' '}
                    {hierarchicalDiagnostics.currentTransitionBlocker.contention.fetchSlotsUsed}/
                    {hierarchicalDiagnostics.currentTransitionBlocker.contention.fetchSlotsMax}{' '}
                    (pre:{hierarchicalDiagnostics.currentTransitionBlocker.contention.activePreloadInFlightCount})
                  </span>
                </div>

                {hierarchicalDiagnostics.currentTransitionBlocker.slowestOutstandingTile && (
                  <div
                    data-testid="diag-transition-slowest-tile"
                    className="p-1.5 rounded bg-slate-900/90 border border-slate-800 text-[9px] space-y-0.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-slate-300 truncate">
                        Slowest:{' '}
                        <strong className="text-cyan-300">
                          {
                            hierarchicalDiagnostics.currentTransitionBlocker
                              .slowestOutstandingTile.tileKey
                          }
                        </strong>
                      </span>
                      <span className="text-amber-300 shrink-0 ml-1">
                        {
                          hierarchicalDiagnostics.currentTransitionBlocker
                            .slowestOutstandingTile.currentStage
                        }{' '}
                        (
                        {formatDiagMs(
                          hierarchicalDiagnostics.currentTransitionBlocker
                            .slowestOutstandingTile.currentStageElapsedMs
                        )}
                        )
                      </span>
                    </div>
                    <div className="text-slate-400">
                      fq:{' '}
                      {hierarchicalDiagnostics.currentTransitionBlocker.slowestOutstandingTile.fetchQueueWaitMs.toFixed(0)}
                      ms · net:{' '}
                      {hierarchicalDiagnostics.currentTransitionBlocker.slowestOutstandingTile.payloadRetrievalMs.toFixed(0)}
                      ms · wq:{' '}
                      {hierarchicalDiagnostics.currentTransitionBlocker.slowestOutstandingTile.workerQueueWaitMs.toFixed(0)}
                      ms · dec:{' '}
                      {hierarchicalDiagnostics.currentTransitionBlocker.slowestOutstandingTile.workerDecodeAndBvhMs.toFixed(0)}
                      ms · rec:{' '}
                      {hierarchicalDiagnostics.currentTransitionBlocker.slowestOutstandingTile.mainThreadReconstructWaitMs.toFixed(0)}
                      ms · gpu:{' '}
                      {hierarchicalDiagnostics.currentTransitionBlocker.slowestOutstandingTile.gpuPrepWaitMs.toFixed(0)}
                      ms
                      {hierarchicalDiagnostics.currentTransitionBlocker.slowestOutstandingTile
                        .gpuPrepRemainingUnits > 0
                        ? ` (${hierarchicalDiagnostics.currentTransitionBlocker.slowestOutstandingTile.gpuPrepRemainingUnits}u left)`
                        : ''}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[9px] text-slate-500">
                No active transition blocker.
                {hierarchicalDiagnostics.prewarmTargetResolutionMeters
                  ? ` Pre-warming ${hierarchicalDiagnostics.prewarmTargetResolutionMeters}m.`
                  : ''}
              </div>
            )}

            {hierarchicalDiagnostics.lastCompletedTransition && (
              <div
                data-testid="diag-last-transition-critical-path"
                className="pt-1 border-t border-slate-800/80 text-[9px] space-y-0.5"
              >
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">
                    Last ({hierarchicalDiagnostics.lastCompletedTransition.fromResolutionMeters}→
                    {hierarchicalDiagnostics.lastCompletedTransition.toResolutionMeters}m ·{' '}
                    {hierarchicalDiagnostics.lastCompletedTransition.outcome})
                  </span>
                  <strong className="text-cyan-300">
                    {formatDiagMs(
                      hierarchicalDiagnostics.lastCompletedTransition.totalDurationMs
                    )}
                  </strong>
                </div>
                <div className="text-slate-400">
                  Blocker:{' '}
                  <strong className="text-slate-200">
                    {hierarchicalDiagnostics.lastCompletedTransition.dominantBlockerCategory}
                  </strong>
                  {hierarchicalDiagnostics.lastCompletedTransition.criticalPathTileKey
                    ? ` · ${hierarchicalDiagnostics.lastCompletedTransition.criticalPathTileKey}`
                    : ''}
                </div>
                <div className="text-slate-500">
                  fq:{hierarchicalDiagnostics.lastCompletedTransition.stagesMs.fetchQueueWaitMs.toFixed(0)} ·
                  net:{hierarchicalDiagnostics.lastCompletedTransition.stagesMs.payloadRetrievalMs.toFixed(0)} ·
                  wq:{hierarchicalDiagnostics.lastCompletedTransition.stagesMs.workerQueueWaitMs.toFixed(0)} ·
                  dec:{hierarchicalDiagnostics.lastCompletedTransition.stagesMs.workerDecodeAndBvhMs.toFixed(0)} ·
                  rw:{hierarchicalDiagnostics.lastCompletedTransition.stagesMs.mainThreadReconstructWaitMs.toFixed(0)} ·
                  gpu:{hierarchicalDiagnostics.lastCompletedTransition.stagesMs.gpuPrepTotalMs.toFixed(0)} ·
                  tail:{hierarchicalDiagnostics.lastCompletedTransition.stagesMs.remainingCoverageWaitMs.toFixed(0)}ms
                </div>
              </div>
            )}

            {(frameBudgetDiagnostics ?? hierarchicalDiagnostics.frameBudget) && (
              <div className="pt-1 border-t border-slate-800/80 text-[9px] text-slate-400 space-y-0.5">
                {(() => {
                  const fb = frameBudgetDiagnostics ?? hierarchicalDiagnostics.frameBudget;
                  return (
                    <>
                      <div className="flex items-center justify-between">
                        <span>
                          Def Disp:{' '}
                          <strong className="text-slate-200">
                            {fb.deferredDisposal.pendingTiles}
                          </strong>{' '}
                          ({formatDiagMb(fb.deferredDisposal.pendingBytes)})
                        </span>
                        <span>
                          GPU Prep:{' '}
                          <strong className="text-cyan-300">
                            {fb.gpuPreparer.totalUnitsUploaded}u
                          </strong>{' '}
                          ({formatDiagMb(fb.gpuPreparer.totalEstimatedBytesUploaded)})
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>
                          Sched Overruns:{' '}
                          <strong className="text-amber-300">
                            {fb.scheduler.totalIndivisibleOverruns}
                          </strong>
                        </span>
                        <span>
                          Deb/Reuse/Pre:{' '}
                          {fb.transitionsDebouncedAvoided}/{fb.destinationPrepReused}/
                          {hierarchicalDiagnostics.counters.prewarmReusedOnTransition}
                        </span>
                      </div>
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 2. Production Engine & Road Geometry Telemetry */}
      <section className="bg-slate-900/60 border border-slate-800 rounded-md p-3 space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-200">
            Production Engine (E2+ / R+)
          </span>
          <span className="text-[10px] font-mono text-emerald-400">
            {infrastructureRenderOptions.roads} / {infrastructureRenderOptions.railways}
          </span>
        </div>

        {isBakedTileMode && !roadRenderStats ? (
          <p className="text-[11px] text-slate-400 leading-relaxed">
            Streaming pre-baked E2+ roads and R+ railways from <code className="text-slate-200">OSMTILE1</code> payloads. Runtime road-build counters apply to unbaked GeoJSON/fixture builds.
          </p>
        ) : (
          roadRenderStats && (
            <div className="space-y-2 text-[10px] font-mono tabular-nums">
              <div className="grid grid-cols-2 gap-1.5 bg-slate-950 border border-slate-800 rounded p-2">
                <div className="text-slate-400">
                  Graph:{' '}
                  <span className="text-slate-200">
                    {infrastructurePreviewTiming
                      ? `${infrastructurePreviewTiming.graphBuildTimeMs.toFixed(1)}ms`
                      : '—'}
                  </span>
                </div>
                <div className="text-slate-400">
                  Adapter:{' '}
                  <span className="text-slate-200">
                    {infrastructurePreviewTiming
                      ? `${infrastructurePreviewTiming.adapterBuildTimeMs.toFixed(1)}ms`
                      : '—'}
                  </span>
                </div>
                <div className="text-slate-400">
                  Road Geom:{' '}
                  <span className="text-cyan-300">
                    {roadRenderTiming
                      ? `${roadRenderTiming.totalRoadGenerationTimeMs.toFixed(1)}ms`
                      : '—'}
                  </span>
                </div>
                <div className="text-slate-400">
                  Scene:{' '}
                  <span className="text-slate-200">
                    {typeof cpuBuildTimeMs === 'number' ? `${cpuBuildTimeMs}ms` : '—'}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-slate-400 px-0.5">
                <div>
                  Edges:{' '}
                  <span className="text-slate-200">
                    {roadRenderStats.inputRoadEdgeCount}/{roadRenderStats.atGradeRoadEdgeCount}
                  </span>
                </div>
                <div>
                  Triangles:{' '}
                  <span className="text-cyan-300">
                    {roadRenderStats.outputTriangleCount.toLocaleString()}
                  </span>
                </div>
                <div>
                  Unions/Diffs:{' '}
                  <span className="text-slate-200">
                    {roadRenderStats.polygonUnionOperationCount}/
                    {roadRenderStats.polygonDifferenceOperationCount}
                  </span>
                </div>
                <div>
                  Polys/Holes:{' '}
                  <span className="text-slate-200">
                    {roadRenderStats.outputPolygonCount}/{roadRenderStats.outputHoleRingCount}
                  </span>
                </div>
              </div>
            </div>
          )
        )}
      </section>

      {/* 3. End-to-End Load Diagnostics */}
      <section
        data-testid="e2e-load-diagnostics-section"
        className="bg-slate-900/60 border border-slate-800 rounded-md p-3 space-y-2.5"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span className="text-xs font-semibold text-slate-200">
              Load Timing Diagnostics
            </span>
          </div>
          <button
            type="button"
            data-testid="btn-copy-load-diagnostics"
            disabled={!lastLoadDiagnostics}
            onClick={handleCopyLoadDiagnostics}
            className="px-2 py-1 rounded bg-cyan-500/15 hover:bg-cyan-500/25 disabled:opacity-40 border border-cyan-500/40 text-cyan-200 text-[10px] font-semibold flex items-center gap-1 transition cursor-pointer"
          >
            {copiedStatus === 'copied' ? (
              <>
                <Check className="w-3 h-3 text-emerald-300" />
                <span className="text-emerald-300">Copied</span>
              </>
            ) : copiedStatus === 'error' ? (
              <span>Failed</span>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                <span>Copy JSON</span>
              </>
            )}
          </button>
        </div>

        {!lastLoadDiagnostics ? (
          <p className="text-[11px] text-slate-400">
            Waiting for scene load completion...
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-[10px] font-mono bg-slate-950 border border-slate-800 rounded px-2 py-1.5">
              <span className="text-slate-200 truncate" title={lastLoadDiagnostics.locationName}>
                {lastLoadDiagnostics.locationName}
              </span>
              <span className="text-cyan-300 uppercase shrink-0">
                {lastLoadDiagnostics.status}
              </span>
            </div>

            <div className="flex items-baseline justify-between bg-slate-950 border border-cyan-500/30 rounded px-2.5 py-1.5 font-mono tabular-nums">
              <span className="text-[11px] text-slate-300">Request → 1st Frame</span>
              <span
                data-testid="e2e-total-loading-ms"
                className="text-xs font-bold text-cyan-300"
              >
                {formatDiagMs(lastLoadDiagnostics.timings.totalLoadingMs)}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-1.5 text-[10px] font-mono tabular-nums bg-slate-950 border border-slate-800 rounded p-2">
              <div className="text-slate-400">
                Transfer:{' '}
                <span className="text-slate-200">
                  {formatDiagMs(lastLoadDiagnostics.timings.responseTransferMs)}
                </span>
              </div>
              <div className="text-slate-400">
                GeoJSON:{' '}
                <span className="text-slate-200">
                  {formatDiagMs(lastLoadDiagnostics.timings.geoJsonProcessingMs)}
                </span>
              </div>
              <div className="text-slate-400">
                Scene Init:{' '}
                <span className="text-cyan-300">
                  {formatDiagMs(lastLoadDiagnostics.timings.sceneGeometryMs)}
                </span>
              </div>
              <div className="text-slate-400">
                1st Frame:{' '}
                <span className="text-emerald-300">
                  {formatDiagMs(lastLoadDiagnostics.timings.scenePresentationMs)}
                </span>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* 4. Defect Reproduction Export & Import */}
      <section className="bg-slate-900/60 border border-slate-800 rounded-md p-3 space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-200">
            Defect Reproduction
          </span>
          <span className="text-[10px] font-mono text-slate-400">JSON v1.0</span>
        </div>

        {isBakedTileMode && !currentRawGeoJson && (
          <p className="text-[11px] text-slate-400 bg-slate-950 border border-slate-800 rounded p-2 leading-relaxed">
            Baked <code className="text-slate-200">OSMTILE1</code> scenes stream compiled tile payloads rather than raw GeoJSON; exported packages include camera pose &amp; selection metadata without full raw GeoJSON source ways.
          </p>
        )}

        <div className="space-y-2">
          <div>
            <label className="text-[11px] font-medium text-slate-300 block mb-1">
              Issue Title
            </label>
            <input
              type="text"
              data-testid="repro-title-input"
              value={reproForm.title}
              onChange={(e) =>
                onChangeReproForm((prev) => ({ ...prev, title: e.target.value }))
              }
              placeholder="Describe junction or geometry defect..."
              className="w-full bg-slate-950 border border-slate-800 rounded-md px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] font-medium text-slate-300 block mb-1">
                Category
              </label>
              <select
                value={reproForm.category}
                onChange={(e) =>
                  onChangeReproForm((prev) => ({
                    ...prev,
                    category: e.target.value as ReproFormSessionState['category'],
                  }))
                }
                className="w-full bg-slate-950 border border-slate-800 rounded-md px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
              >
                <option value="junction">Junction Geometry</option>
                <option value="width">Width Inference</option>
                <option value="alignment">Polyline Alignment</option>
                <option value="railway">Railway System</option>
                <option value="elevation">Grade Separation</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div>
              <label className="text-[11px] font-medium text-slate-300 block mb-1">
                Severity
              </label>
              <select
                value={reproForm.severity}
                onChange={(e) =>
                  onChangeReproForm((prev) => ({
                    ...prev,
                    severity: e.target.value as ReproFormSessionState['severity'],
                  }))
                }
                className="w-full bg-slate-950 border border-slate-800 rounded-md px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
              >
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-[11px] font-medium text-slate-300 block mb-1">
              Observed Behavior
            </label>
            <textarea
              rows={2}
              value={reproForm.description}
              onChange={(e) =>
                onChangeReproForm((prev) => ({
                  ...prev,
                  description: e.target.value,
                }))
              }
              placeholder="Observed defect details..."
              className="w-full bg-slate-950 border border-slate-800 rounded-md px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div>
            <label className="text-[11px] font-medium text-slate-300 block mb-1">
              Expected Behavior
            </label>
            <textarea
              rows={2}
              value={reproForm.expectedBehavior}
              onChange={(e) =>
                onChangeReproForm((prev) => ({
                  ...prev,
                  expectedBehavior: e.target.value,
                }))
              }
              placeholder="Expected geometric behavior..."
              className="w-full bg-slate-950 border border-slate-800 rounded-md px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500"
            />
          </div>
        </div>

        {exportSuccessMsg && (
          <div className="p-2 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-[11px] flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            <span>{exportSuccessMsg}</span>
          </div>
        )}

        {exportErrorMsg && (
          <div
            role="alert"
            className="p-2 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 text-[11px] flex items-center justify-between gap-2"
          >
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{exportErrorMsg}</span>
            </div>
            <button
              type="button"
              onClick={() => setExportErrorMsg(null)}
              className="text-rose-300 hover:text-white font-semibold px-1 cursor-pointer"
              aria-label="Dismiss export error"
            >
              ×
            </button>
          </div>
        )}

        {importErrorMsg && (
          <div className="p-2 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 text-[11px] flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>{importErrorMsg}</span>
          </div>
        )}

        <input
          ref={importFileInputRef}
          type="file"
          accept=".json,application/json"
          onChange={handleImportFile}
          className="hidden"
          aria-label="Import reproduction package JSON"
        />

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            data-testid="btn-export-repro"
            onClick={handleExportReproduction}
            className="py-2 px-2.5 rounded-md bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-200 font-semibold text-[11px] flex items-center justify-center gap-1.5 transition cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Repro</span>
          </button>

          <button
            type="button"
            data-testid="btn-import-repro"
            onClick={() => importFileInputRef.current?.click()}
            className="py-2 px-2.5 rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-semibold text-[11px] flex items-center justify-center gap-1.5 transition cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5 text-slate-400" />
            <span>Import Repro</span>
          </button>
        </div>
      </section>
    </div>
  );
};
