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
}

function formatDiagMs(val: number | null | undefined): string {
  if (typeof val !== 'number' || !Number.isFinite(val)) return '—';
  return `${val.toFixed(1)} ms`;
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
