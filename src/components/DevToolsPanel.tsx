import React, { useState, useRef } from 'react';
import {
  Wrench,
  X,
  Play,
  RotateCcw,
  Bug,
  Download,
  Upload,
  Layers,
  MapPin,
  Eye,
  CheckCircle2,
  AlertTriangle,
  FileCode,
  Info,
  Maximize2,
  Compass,
  CornerDownRight,
  ShieldCheck,
  MousePointer,
  Crosshair,
} from 'lucide-react';
import {
  InfrastructureRenderOptions,
  RoadInfrastructureRenderSource,
  RailwayInfrastructureRenderSource,
} from '../world/infrastructure/rendering/InfrastructureRenderAdapter';
import { RailwayPrototypeMode } from '../world/prototype/RailwayPrototypeBuilder';
import {
  RAILWAY_PROTOTYPE_ZONE_PRESETS,
  RailwayPrototypeZoneId,
} from '../world/prototype/RailwayTestFixtures';
import {
  DeveloperReproductionPackage,
  DefectIssueReportMeta,
  buildReproductionPackage,
  validateReproductionPackage,
} from '../world/dev/ReproductionReport';
import { InspectableFeatureInfo, ProcessedMapData } from '../types/MapFeature';
import { SerializedCameraPose } from '../world/dev/ReproductionReport';

export interface DevToolsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  // Rendering controls
  infrastructureRenderOptions: InfrastructureRenderOptions;
  onChangeInfrastructureRenderOptions: (opts: Partial<InfrastructureRenderOptions>) => void;
  railwayPrototypeMode: RailwayPrototypeMode;
  onChangeRailwayPrototypeMode: (mode: RailwayPrototypeMode) => void;
  wireframe: boolean;
  onToggleWireframe: () => void;
  showGraphOverlay?: boolean;
  onToggleGraphOverlay?: () => void;
  // Spatial selection mode
  isSpatialSelectActive: boolean;
  onToggleSpatialSelect: () => void;
  selectedBoxMeters: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
  onClearSpatialBox: () => void;
  // Selected feature inspection & multi-selection
  selectedFeature: InspectableFeatureInfo | null;
  onSelectFeature: (feature: InspectableFeatureInfo | null) => void;
  selectedFeatures?: InspectableFeatureInfo[];
  focusedFeatureId?: string | null;
  onFocusFeature?: (id: string) => void;
  onRemoveSelectedFeature?: (id: string) => void;
  onClearAllSelectedFeatures?: () => void;
  // Fixture loaders
  onLoadSwitchyard: (zone: RailwayPrototypeZoneId) => void;
  onLoadPrinsFork: () => void;
  onLoadHengelo: () => void;
  onLoadAmsterdam: () => void;
  // Active context for reproduction
  mapData: ProcessedMapData | null;
  currentRawGeoJson: any;
  currentCameraPose: SerializedCameraPose;
  onApplyCameraPose: (pose: SerializedCameraPose) => void;
  onImportReproductionPackage: (pkg: DeveloperReproductionPackage) => void;
  roadWidthMultiplier: number;
  heightMultiplier: number;
  themeId: string;
}

export const DevToolsPanel: React.FC<DevToolsPanelProps> = ({
  isOpen,
  onClose,
  infrastructureRenderOptions,
  onChangeInfrastructureRenderOptions,
  railwayPrototypeMode,
  onChangeRailwayPrototypeMode,
  wireframe,
  onToggleWireframe,
  showGraphOverlay = false,
  onToggleGraphOverlay,
  isSpatialSelectActive,
  onToggleSpatialSelect,
  selectedBoxMeters,
  onClearSpatialBox,
  selectedFeature,
  onSelectFeature,
  selectedFeatures = [],
  focusedFeatureId = null,
  onFocusFeature,
  onRemoveSelectedFeature,
  onClearAllSelectedFeatures,
  onLoadSwitchyard,
  onLoadPrinsFork,
  onLoadHengelo,
  onLoadAmsterdam,
  mapData,
  currentRawGeoJson,
  currentCameraPose,
  onApplyCameraPose,
  onImportReproductionPackage,
  roadWidthMultiplier,
  heightMultiplier,
  themeId,
}) => {
  const [activeDevTab, setActiveDevTab] = useState<'rendering' | 'inspection' | 'reporting' | 'fixtures'>('rendering');

  // Issue reporting form state
  const [reportTitle, setReportTitle] = useState('');
  const [reportDescription, setReportDescription] = useState('');
  const [reportExpected, setReportExpected] = useState('');
  const [reportSeverity, setReportSeverity] = useState<'critical' | 'high' | 'medium' | 'low'>('medium');
  const [reportCategory, setReportCategory] = useState<'junction' | 'width' | 'alignment' | 'railway' | 'elevation' | 'other'>('junction');
  const [exportSuccessMsg, setExportSuccessMsg] = useState<string | null>(null);
  const [importErrorMsg, setImportErrorMsg] = useState<string | null>(null);

  const importFileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleExportReproduction = () => {
    try {
      const selectedList =
        selectedFeatures && selectedFeatures.length > 0
          ? selectedFeatures
          : selectedFeature
          ? [selectedFeature]
          : [];

      const pkg = buildReproductionPackage({
        report: {
          title: reportTitle || 'OSM Renderer Defect Repro',
          description: reportDescription,
          expectedBehavior: reportExpected,
          severity: reportSeverity,
          category: reportCategory,
          createdAt: new Date().toISOString(),
        },
        selectedFeature,
        selectedFeatures: selectedList,
        focusedFeatureId,
        mapData,
        fullRawGeoJson: currentRawGeoJson,
        infrastructureRenderOptions,
        railwayPrototypeMode,
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
      const cleanTitle = (reportTitle || 'osm-repro')
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
        `Exported reproduction package (${pkg.geoJson.features.length} connected OSM features, ${selectedList.length} selected objects)`
      );
      setTimeout(() => setExportSuccessMsg(null), 4000);
    } catch (err: any) {
      console.error('Failed to export reproduction package:', err);
      alert(`Export failed: ${err.message}`);
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

        // Populate reporting fields with imported notes
        setReportTitle(validatedPkg.report.title);
        setReportDescription(validatedPkg.report.description);
        setReportExpected(validatedPkg.report.expectedBehavior);
        setReportSeverity(validatedPkg.report.severity ?? 'medium');
        setReportCategory(validatedPkg.report.category ?? 'junction');

        onImportReproductionPackage(validatedPkg);
        setExportSuccessMsg(`Successfully imported reproduction: "${validatedPkg.report.title}"`);
        setTimeout(() => setExportSuccessMsg(null), 4000);
      } catch (err: any) {
        setImportErrorMsg(`Parse error: ${err.message}`);
      }
    };
    reader.readAsText(file);
    if (e.target) e.target.value = '';
  };

  return (
    <div
      role="dialog"
      aria-labelledby="dev-tools-heading"
      className="fixed inset-y-0 right-0 z-50 w-full max-w-lg bg-slate-950/95 border-l border-cyan-500/30 shadow-2xl backdrop-blur-xl flex flex-col font-sans text-slate-200"
    >
      {/* Top Header */}
      <header className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/60">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
            <Wrench className="w-4 h-4" />
          </div>
          <div>
            <h2 id="dev-tools-heading" className="text-sm font-bold text-slate-100 flex items-center gap-2">
              Developer Tools
              <span className="px-1.5 py-0.5 text-[10px] uppercase font-mono font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 rounded">
                E2 Active
              </span>
            </h2>
            <p className="text-[11px] text-slate-400">
              Runtime renderer switching, inspection & reproduction export
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close Developer Tools"
          className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 rounded-lg transition cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </header>

      {/* Tabs */}
      <nav aria-label="Developer tools sections" className="grid grid-cols-4 border-b border-slate-800 text-xs font-semibold bg-slate-900/40">
        <button
          type="button"
          onClick={() => setActiveDevTab('rendering')}
          className={`py-2.5 px-2 text-center transition border-b-2 cursor-pointer ${
            activeDevTab === 'rendering'
              ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
              : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
          }`}
        >
          Rendering
        </button>
        <button
          type="button"
          onClick={() => setActiveDevTab('inspection')}
          className={`py-2.5 px-2 text-center transition border-b-2 cursor-pointer ${
            activeDevTab === 'inspection'
              ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
              : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
          }`}
        >
          Inspect & Select
        </button>
        <button
          type="button"
          onClick={() => setActiveDevTab('reporting')}
          className={`py-2.5 px-2 text-center transition border-b-2 cursor-pointer ${
            activeDevTab === 'reporting'
              ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
              : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
          }`}
        >
          Issue Repro
        </button>
        <button
          type="button"
          onClick={() => setActiveDevTab('fixtures')}
          className={`py-2.5 px-2 text-center transition border-b-2 cursor-pointer ${
            activeDevTab === 'fixtures'
              ? 'border-cyan-400 text-cyan-300 bg-cyan-500/10'
              : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
          }`}
        >
          Fixtures
        </button>
      </nav>

      {/* Scrollable Content Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* TAB 1: RENDERING CONTROLS */}
        {activeDevTab === 'rendering' && (
          <div className="space-y-4">
            {/* Road Renderer Selector */}
            <section className="bg-slate-900/70 border border-slate-800 rounded-xl p-3.5 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-200">Road Infrastructure Engine</span>
                <span className="text-[10px] font-mono text-cyan-400">
                  Active: {infrastructureRenderOptions.roads}
                </span>
              </div>
              <p className="text-[11px] text-slate-400">
                Switch road technology in-memory without reloading the page.
              </p>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onChangeInfrastructureRenderOptions({ roads: 'legacy' })}
                  className={`p-2.5 rounded-lg border text-left transition cursor-pointer ${
                    infrastructureRenderOptions.roads === 'legacy'
                      ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200 font-bold shadow-sm'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                  }`}
                >
                  <div className="text-xs">Legacy</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">Stage 6A–C centerline ribbons</div>
                </button>

                <button
                  type="button"
                  onClick={() => onChangeInfrastructureRenderOptions({ roads: 'graph' })}
                  className={`p-2.5 rounded-lg border text-left transition cursor-pointer ${
                    infrastructureRenderOptions.roads === 'graph'
                      ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200 font-bold shadow-sm'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                  }`}
                >
                  <div className="text-xs flex items-center justify-between">
                    <span>Graph (E2)</span>
                    <span className="text-[9px] px-1 py-0.2 bg-emerald-500/20 text-emerald-300 rounded">New</span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">Boundary-derived junctions & miters</div>
                </button>

                <button
                  type="button"
                  onClick={() => onChangeInfrastructureRenderOptions({ roads: 'graph-surface' })}
                  className={`p-2.5 rounded-lg border text-left transition cursor-pointer ${
                    infrastructureRenderOptions.roads === 'graph-surface'
                      ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200 font-bold shadow-sm'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                  }`}
                >
                  <div className="text-xs flex items-center gap-2">
                    <span>Graph (E2+)</span>
                    <span className="text-[9px] text-amber-300">Experimental</span>
                  </div>
                  <div className="text-[10px] text-slate-400 mt-0.5">Rounded footprints · no junction patches</div>
                </button>

                <button
                  type="button"
                  onClick={() => onChangeInfrastructureRenderOptions({ roads: 'graph-preview' })}
                  className={`p-2.5 rounded-lg border text-left transition cursor-pointer ${
                    infrastructureRenderOptions.roads === 'graph-preview'
                      ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200 font-bold shadow-sm'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                  }`}
                >
                  <div className="text-xs">Preview (E1)</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">Adapter validation alongside legacy</div>
                </button>
              </div>
            </section>

            {/* Railway Renderer Selector */}
            <section className="bg-slate-900/70 border border-slate-800 rounded-xl p-3.5 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-200">Railway Infrastructure Engine</span>
                <span className="text-[10px] font-mono text-cyan-400">
                  Mode: {railwayPrototypeMode} · Adapter: {infrastructureRenderOptions.railways}
                </span>
              </div>
              <p className="text-[11px] text-slate-400">
                M2.2 production implements Candidate B. Graph-driven railway rendering remains deferred to Stage E3.
              </p>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onChangeRailwayPrototypeMode('production');
                    onChangeInfrastructureRenderOptions({ railways: 'legacy' });
                  }}
                  className={`p-2 rounded-lg border text-left transition cursor-pointer ${
                    railwayPrototypeMode === 'production' && infrastructureRenderOptions.railways === 'legacy'
                      ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200 font-bold'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="text-xs">Production (Candidate B)</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">3D sleepers & procedural ballast</div>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    onChangeRailwayPrototypeMode('production');
                    onChangeInfrastructureRenderOptions({ railways: 'graph-preview' });
                  }}
                  className={`p-2 rounded-lg border text-left transition cursor-pointer ${
                    infrastructureRenderOptions.railways === 'graph-preview'
                      ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200 font-bold'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="text-xs">Graph Topology Preview</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">Stage E1 adapter descriptor validation</div>
                </button>

                <button
                  type="button"
                  onClick={() => onChangeRailwayPrototypeMode('candidateA')}
                  className={`p-2 rounded-lg border text-left transition cursor-pointer ${
                    railwayPrototypeMode === 'candidateA'
                      ? 'bg-amber-500/20 border-amber-400 text-amber-200 font-bold'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="text-xs">Prototype Candidate A</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">Continuous UV ribbon prototype</div>
                </button>

                <button
                  type="button"
                  onClick={() => onChangeRailwayPrototypeMode('disabled')}
                  className={`p-2 rounded-lg border text-left transition cursor-pointer ${
                    railwayPrototypeMode === 'disabled'
                      ? 'bg-rose-500/20 border-rose-400 text-rose-200 font-bold'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="text-xs">Disabled (Isolate Map)</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">Zero railway geometry</div>
                </button>
              </div>
            </section>

            {/* Diagnostic Overlays */}
            <section className="bg-slate-900/70 border border-slate-800 rounded-xl p-3.5 space-y-2">
              <div className="text-xs font-bold text-slate-200">Diagnostic Overlays</div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={onToggleWireframe}
                  className={`p-2 rounded-lg border text-xs font-medium flex items-center justify-between transition cursor-pointer ${
                    wireframe
                      ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200 font-bold'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <span>Wireframe</span>
                  <span className="text-[10px] font-mono">{wireframe ? 'ON' : 'OFF'}</span>
                </button>

                {onToggleGraphOverlay && (
                  <button
                    type="button"
                    onClick={onToggleGraphOverlay}
                    className={`p-2 rounded-lg border text-xs font-medium flex items-center justify-between transition cursor-pointer ${
                      showGraphOverlay
                        ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200 font-bold'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <span>Topology Graph Nodes</span>
                    <span className="text-[10px] font-mono">{showGraphOverlay ? 'ON' : 'OFF'}</span>
                  </button>
                )}
              </div>
            </section>
          </div>
        )}

        {/* TAB 2: GEOMETRY INSPECTION & SPATIAL SELECTION */}
        {activeDevTab === 'inspection' && (() => {
          const selectedList =
            selectedFeatures && selectedFeatures.length > 0
              ? selectedFeatures
              : selectedFeature
              ? [selectedFeature]
              : [];
          const activeFocusedId = focusedFeatureId || selectedList[0]?.id;
          const focusedFeature = selectedList.find((f) => f.id === activeFocusedId) || selectedFeature;

          return (
            <div className="space-y-4">
              {/* Spatial Selection Tool */}
              <section className="bg-slate-900/70 border border-slate-800 rounded-xl p-3.5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-200">
                    <Crosshair className="w-4 h-4 text-cyan-400" />
                    <span>Geographic Area Selection</span>
                  </div>
                  {selectedBoxMeters && (
                    <button
                      type="button"
                      onClick={onClearSpatialBox}
                      className="text-[10px] text-rose-400 hover:underline cursor-pointer"
                    >
                      Clear Box
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-slate-400">
                  Activate area tool, then drag on the ground. The area frames the defect; underlying roads and junctions remain fully clickable.
                </p>

                <button
                  type="button"
                  onClick={onToggleSpatialSelect}
                  className={`w-full py-2 px-3 rounded-lg border text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer ${
                    isSpatialSelectActive
                      ? 'bg-amber-500/20 border-amber-400 text-amber-200 animate-pulse'
                      : 'bg-cyan-500/20 border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/30'
                  }`}
                >
                  <MousePointer className="w-3.5 h-3.5" />
                  <span>
                    {isSpatialSelectActive
                      ? 'Area Drag Active (Click & Drag in Scene)'
                      : 'Activate Area Selection Tool'}
                  </span>
                </button>

                {selectedBoxMeters && (
                  <div className="bg-slate-950 border border-slate-800 rounded p-2 text-[11px] font-mono text-slate-300 space-y-1">
                    <div>
                      X: [{selectedBoxMeters.minX.toFixed(1)}m, {selectedBoxMeters.maxX.toFixed(1)}m] (
                      {(selectedBoxMeters.maxX - selectedBoxMeters.minX).toFixed(1)}m)
                    </div>
                    <div>
                      Z: [{selectedBoxMeters.minZ.toFixed(1)}m, {selectedBoxMeters.maxZ.toFixed(1)}m] (
                      {(selectedBoxMeters.maxZ - selectedBoxMeters.minZ).toFixed(1)}m)
                    </div>
                  </div>
                )}
              </section>

              {/* Explicitly Selected Objects List */}
              <section className="bg-slate-900/70 border border-slate-800 rounded-xl p-3.5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-200">
                    <Layers className="w-4 h-4 text-cyan-400" />
                    <span>Explicitly Selected Objects ({selectedList.length})</span>
                  </div>
                  {selectedList.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        if (onClearAllSelectedFeatures) {
                          onClearAllSelectedFeatures();
                        } else {
                          onSelectFeature(null);
                        }
                      }}
                      className="text-[10px] text-rose-400 hover:underline cursor-pointer"
                    >
                      Clear All
                    </button>
                  )}
                </div>

                {selectedList.length === 0 ? (
                  <div className="p-3 text-center text-slate-500 text-xs bg-slate-950/60 rounded-lg border border-slate-900">
                    Click any road, railway, junction, or building to select. Multiple objects can be selected together.
                  </div>
                ) : (
                  <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
                    {selectedList.map((feat) => {
                      const isFocused = feat.id === activeFocusedId;
                      const osmId = feat.sourceFeatureId || feat.id;
                      return (
                        <div
                          key={feat.id}
                          onClick={() => {
                            if (onFocusFeature) onFocusFeature(feat.id);
                            else onSelectFeature(feat);
                          }}
                          className={`p-2 rounded-lg border text-xs cursor-pointer transition flex items-center justify-between gap-2 ${
                            isFocused
                              ? 'border-l-4 border-l-cyan-400 border-slate-700 bg-cyan-950/40 text-slate-100 shadow-sm'
                              : 'border-l-2 border-l-slate-700 border-slate-800/90 bg-slate-950/70 text-slate-300 hover:bg-slate-900/80'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono font-bold text-cyan-300 truncate">
                                {osmId}
                              </span>
                              <span className="px-1.5 py-0.2 text-[9px] font-mono rounded bg-slate-800 text-slate-300 border border-slate-700 shrink-0">
                                {feat.category}
                              </span>
                            </div>
                            <div className="text-[10px] text-slate-400 truncate mt-0.5">
                              {feat.subtype || feat.primaryTag || feat.cartoLabel}
                              {typeof feat.width === 'number' ? ` · ${feat.width.toFixed(1)}m` : ''}
                              {feat.name ? ` · ${feat.name}` : ''}
                            </div>
                          </div>

                          <button
                            type="button"
                            title="Remove object from selection"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              if (onRemoveSelectedFeature) {
                                onRemoveSelectedFeature(feat.id);
                              } else {
                                onSelectFeature(null);
                              }
                            }}
                            className="p-1 rounded text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer shrink-0"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Context distinction notice */}
                <div className="p-2 rounded-lg bg-slate-950/80 border border-slate-800/80 text-[10px] text-slate-400 flex items-start gap-1.5">
                  <Info className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
                  <span>
                    <strong>Connected Context:</strong> Reproduction export automatically includes the full source ways of incident roads sharing junction nodes within the area, without pulling in unrelated bus routes.
                  </span>
                </div>
              </section>

              {/* Focused Feature Inspector */}
              <section className="bg-slate-900/70 border border-slate-800 rounded-xl p-3.5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-200">
                    Inspected Object Details {focusedFeature ? `(${focusedFeature.sourceFeatureId || focusedFeature.id})` : ''}
                  </span>
                  {focusedFeature && (
                    <button
                      type="button"
                      onClick={() => {
                        if (onRemoveSelectedFeature) onRemoveSelectedFeature(focusedFeature.id);
                        else onSelectFeature(null);
                      }}
                      className="text-[10px] text-slate-400 hover:text-slate-200 cursor-pointer"
                    >
                      Deselect
                    </button>
                  )}
                </div>

                {!focusedFeature ? (
                  <div className="p-4 text-center text-slate-500 text-xs">
                    Select an object above or click in the 3D map to view detailed OSM tags and graph provenance.
                  </div>
                ) : (
                  <div className="space-y-2 text-xs">
                    <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800 space-y-1.5">
                      <div className="text-[11px] font-mono text-cyan-400 font-bold truncate">
                        {focusedFeature.cartoLabel} · {focusedFeature.id}
                      </div>
                      {focusedFeature.name && (
                        <div className="text-sm font-bold text-slate-100">{focusedFeature.name}</div>
                      )}
                      <div className="grid grid-cols-2 gap-1 text-[11px] font-mono text-slate-400">
                        <div>
                          Primary Tag: <strong className="text-slate-200">{focusedFeature.primaryTag}</strong>
                        </div>
                        <div>
                          Subtype: <strong className="text-slate-200">{focusedFeature.subtype}</strong>
                        </div>
                        <div>
                          Source Feature: <strong className="text-slate-200">{focusedFeature.sourceFeatureId}</strong>
                        </div>
                        {typeof focusedFeature.width === 'number' && (
                          <div>
                            Inferred Width: <strong className="text-cyan-300">{focusedFeature.width.toFixed(2)}m</strong>
                          </div>
                        )}
                        {typeof focusedFeature.elevation === 'number' && (
                          <div>
                            Elevation: <strong className="text-slate-200">{focusedFeature.elevation.toFixed(3)}m</strong>
                          </div>
                        )}
                        {focusedFeature.isBridge && <div className="text-amber-300 font-bold">Bridge deck</div>}
                        {focusedFeature.isTunnel && <div className="text-indigo-300 font-bold">Tunnel / Subterranean</div>}
                      </div>

                      {/* Constituent Source Provenance */}
                      {focusedFeature.sourceFeatureIds && focusedFeature.sourceFeatureIds.length > 1 && (
                        <div className="pt-1 border-t border-slate-800/80">
                          <span className="text-[10px] font-semibold text-slate-400">
                            Constituent Source Ways ({focusedFeature.sourceFeatureIds.length}):
                          </span>
                          <div className="text-[10px] font-mono text-cyan-300/90 truncate">
                            {focusedFeature.sourceFeatureIds.join(', ')}
                          </div>
                        </div>
                      )}

                      {/* Junction Portal Connections */}
                      {focusedFeature.portalConnections && focusedFeature.portalConnections.length > 0 && (
                        <div className="pt-1 border-t border-slate-800/80 space-y-1">
                          <span className="text-[10px] font-semibold text-slate-400">
                            Junction Portals ({focusedFeature.portalConnections.length} incident arms):
                          </span>
                          <div className="space-y-0.5 text-[10px] font-mono text-slate-300">
                            {focusedFeature.portalConnections.map((pc, idx) => (
                              <div key={idx} className="flex items-center justify-between gap-1 text-slate-400">
                                <span className="text-cyan-300 truncate">
                                  {pc.sourceFeatureId} ({pc.endpoint})
                                </span>
                                <span className="text-slate-500">
                                  L:[{pc.left[0].toFixed(1)},{pc.left[1].toFixed(1)}] R:[
                                  {pc.right[0].toFixed(1)},{pc.right[1].toFixed(1)}]
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* OSM Tags Table */}
                    <div className="space-y-1">
                      <div className="text-[11px] font-bold text-slate-300">
                        Raw OSM Tags ({Object.keys(focusedFeature.osmTags || {}).length}):
                      </div>
                      <div className="max-h-36 overflow-y-auto bg-slate-950 p-2 rounded border border-slate-800/80 text-[10px] font-mono space-y-0.5">
                        {Object.entries(focusedFeature.osmTags || {}).map(([k, v]) => (
                          <div
                            key={k}
                            className="flex items-baseline justify-between gap-2 border-b border-slate-900 py-0.5"
                          >
                            <span className="text-slate-400 shrink-0">{k}</span>
                            <span className="text-cyan-300 truncate" title={String(v)}>
                              {String(v)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </section>
            </div>
          );
        })()}

        {/* TAB 3: ISSUE REPRODUCTION EXPORT / IMPORT */}
        {activeDevTab === 'reporting' && (
          <div className="space-y-3.5">
            <section className="bg-slate-900/70 border border-slate-800 rounded-xl p-3.5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-200">Capture Self-Contained Reproduction</span>
                <span className="text-[10px] text-cyan-400">No URL parameters required</span>
              </div>
              <p className="text-[11px] text-slate-400">
                Exports the selected feature, its incident connected OSM ways, full tags, active engine configuration, and camera pose as an importable JSON package.
              </p>

              <div className="space-y-2">
                <div>
                  <label className="text-[11px] font-semibold text-slate-300 block mb-1">Issue Title</label>
                  <input
                    type="text"
                    value={reportTitle}
                    onChange={(e) => setReportTitle(e.target.value)}
                    placeholder="e.g. Acute cycleway fork leaves square shoulder at node/6387677253"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[11px] font-semibold text-slate-300 block mb-1">Category</label>
                    <select
                      value={reportCategory}
                      onChange={(e: any) => setReportCategory(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
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
                    <label className="text-[11px] font-semibold text-slate-300 block mb-1">Severity</label>
                    <select
                      value={reportSeverity}
                      onChange={(e: any) => setReportSeverity(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
                    >
                      <option value="critical">Critical (Crash/Break)</option>
                      <option value="high">High (Severe Visual Artifact)</option>
                      <option value="medium">Medium (Defect)</option>
                      <option value="low">Low (Cosmetic/Polish)</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-slate-300 block mb-1">Observed Behavior & Description</label>
                  <textarea
                    rows={2}
                    value={reportDescription}
                    onChange={(e) => setReportDescription(e.target.value)}
                    placeholder="Describe the geometric error, missing geometry, or discrepancy..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-semibold text-slate-300 block mb-1">Expected Behavior</label>
                  <textarea
                    rows={2}
                    value={reportExpected}
                    onChange={(e) => setReportExpected(e.target.value)}
                    placeholder="Describe how the junction or geometry should be meshed instead..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500"
                  />
                </div>
              </div>

              {exportSuccessMsg && (
                <div className="p-2 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  <span>{exportSuccessMsg}</span>
                </div>
              )}

              <button
                type="button"
                onClick={handleExportReproduction}
                className="w-full py-2 px-3 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400 text-cyan-200 font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export Self-Contained Repro (.json)</span>
              </button>
            </section>

            {/* Import Package */}
            <section className="bg-slate-900/70 border border-slate-800 rounded-xl p-3.5 space-y-2">
              <span className="text-xs font-bold text-slate-200 block">Import Reproduction Package</span>
              <p className="text-[11px] text-slate-400">
                Load a previously exported .json package to faithfully recreate the exact scene, camera pose, and renderer settings.
              </p>

              <input
                ref={importFileInputRef}
                type="file"
                accept=".json,application/json"
                onChange={handleImportFile}
                className="hidden"
              />

              {importErrorMsg && (
                <div className="p-2 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>{importErrorMsg}</span>
                </div>
              )}

              <button
                type="button"
                onClick={() => importFileInputRef.current?.click()}
                className="w-full py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-semibold text-xs flex items-center justify-center gap-2 transition cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5 text-slate-400" />
                <span>Import Repro Package (.json)</span>
              </button>
            </section>
          </div>
        )}

        {/* TAB 4: EXISTING FIXTURES */}
        {activeDevTab === 'fixtures' && (
          <div className="space-y-3">
            <p className="text-[11px] text-slate-400">
              Load canonical development fixtures with one click instead of editing URL query parameters.
            </p>

            {/* M2.3 Prins Hendrikkade Acute Fork */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-200">Prins Hendrikkade Southern Fork</span>
                <span className="text-[10px] font-mono text-cyan-400">node/6387677253</span>
              </div>
              <p className="text-[11px] text-slate-400">
                Source OSM fixture: 3 cycleways meeting at 17° acute angle with equal 2.4m widths.
              </p>
              <button
                type="button"
                onClick={onLoadPrinsFork}
                className="w-full py-1.5 px-3 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-200 text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                <span>Load Acute Fork Fixture</span>
              </button>
            </div>

            {/* M2.1 Switchyard Benchmark */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-200">M2.1 Railway Switchyard Benchmark</span>
                <span className="text-[10px] font-mono text-amber-400">4 Zones</span>
              </div>
              <p className="text-[11px] text-slate-400">
                Turnouts, crossovers, chained short ways, and 6-track station throat.
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {(Object.keys(RAILWAY_PROTOTYPE_ZONE_PRESETS) as RailwayPrototypeZoneId[]).map((zoneId) => (
                  <button
                    key={zoneId}
                    type="button"
                    onClick={() => onLoadSwitchyard(zoneId)}
                    className="py-1.5 px-2 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded text-[11px] text-left text-slate-300 transition cursor-pointer truncate"
                  >
                    {RAILWAY_PROTOTYPE_ZONE_PRESETS[zoneId].label}
                  </button>
                ))}
              </div>
            </div>

            {/* Real OSM Presets */}
            <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3 space-y-2">
              <span className="text-xs font-bold text-slate-200 block">Real OSM Region Presets</span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={onLoadHengelo}
                  className="p-2 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg text-xs font-semibold text-slate-200 text-left transition cursor-pointer"
                >
                  <div>Station Hengelo</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">Overijssel (400m)</div>
                </button>
                <button
                  type="button"
                  onClick={onLoadAmsterdam}
                  className="p-2 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg text-xs font-semibold text-slate-200 text-left transition cursor-pointer"
                >
                  <div>Amsterdam Centraal</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">Railways & canals (420m)</div>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer Info */}
      <footer className="p-3 border-t border-slate-800/80 bg-slate-900/60 text-[10px] font-mono text-slate-400 flex items-center justify-between">
        <span>DevTools v1.0 · TKT-009</span>
        <span>Cam: zoom {currentCameraPose.zoom.toFixed(1)}x · az {currentCameraPose.azimuthDeg ?? 45}°</span>
      </footer>
    </div>
  );
};
