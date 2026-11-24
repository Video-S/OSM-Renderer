import React from 'react';
import { Crosshair, Info, Layers, MousePointer, X } from 'lucide-react';
import type { InspectableFeatureInfo } from '../../../types/MapFeature';

export interface InspectorPanelProps {
  selectedFeature: InspectableFeatureInfo | null;
  selectedFeatures: InspectableFeatureInfo[];
  focusedFeatureId: string | null;
  isSpatialSelectActive: boolean;
  selectedBoxMeters: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
  onToggleSpatialSelect: () => void;
  onClearSpatialBox: () => void;
  onSelectFeature: (feature: InspectableFeatureInfo | null) => void;
  onFocusFeature: (id: string) => void;
  onRemoveSelectedFeature: (id: string) => void;
  onClearAllSelectedFeatures: () => void;
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
  selectedFeature,
  selectedFeatures,
  focusedFeatureId,
  isSpatialSelectActive,
  selectedBoxMeters,
  onToggleSpatialSelect,
  onClearSpatialBox,
  onSelectFeature,
  onFocusFeature,
  onRemoveSelectedFeature,
  onClearAllSelectedFeatures,
}) => {
  const selectedList =
    selectedFeatures.length > 0
      ? selectedFeatures
      : selectedFeature
        ? [selectedFeature]
        : [];
  const activeFocusedId = focusedFeatureId || selectedList[0]?.id || null;
  const focusedFeature =
    selectedList.find((f) => f.id === activeFocusedId) || selectedFeature;

  return (
    <div data-testid="panel-inspector" className="space-y-3.5">
      {/* Spatial Area Selection Tool */}
      <section className="bg-slate-900/60 border border-slate-800 rounded-md p-3 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
            <Crosshair className="w-3.5 h-3.5 text-cyan-400" />
            <span>Spatial Area Selection</span>
          </div>
          {selectedBoxMeters && (
            <button
              type="button"
              onClick={onClearSpatialBox}
              className="text-[11px] text-rose-400 hover:underline cursor-pointer"
            >
              Clear Box
            </button>
          )}
        </div>
        <p className="text-[11px] text-slate-400 leading-relaxed">
          Drag a rectangular region on the ground plane while keeping underlying roads and buildings clickable.
        </p>

        <button
          type="button"
          data-testid="btn-toggle-spatial-select"
          aria-pressed={isSpatialSelectActive}
          onClick={onToggleSpatialSelect}
          className={`w-full py-2 px-3 rounded-md border text-xs font-semibold flex items-center justify-center gap-2 transition cursor-pointer ${
            isSpatialSelectActive
              ? 'bg-amber-500/20 border-amber-400/70 text-amber-200'
              : 'bg-cyan-500/15 border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/25'
          }`}
        >
          <MousePointer className="w-3.5 h-3.5" />
          <span>
            {isSpatialSelectActive
              ? 'Area Drag Active (Drag in Scene)'
              : 'Activate Area Selection Tool'}
          </span>
        </button>

        {selectedBoxMeters && (
          <div className="bg-slate-950 border border-slate-800 rounded p-2 text-[11px] font-mono tabular-nums text-slate-300 space-y-0.5">
            <div>
              X: [{selectedBoxMeters.minX.toFixed(1)}, {selectedBoxMeters.maxX.toFixed(1)}] m (
              {(selectedBoxMeters.maxX - selectedBoxMeters.minX).toFixed(1)} m)
            </div>
            <div>
              Z: [{selectedBoxMeters.minZ.toFixed(1)}, {selectedBoxMeters.maxZ.toFixed(1)}] m (
              {(selectedBoxMeters.maxZ - selectedBoxMeters.minZ).toFixed(1)} m)
            </div>
          </div>
        )}
      </section>

      {/* Multi-Selection List */}
      <section className="bg-slate-900/60 border border-slate-800 rounded-md p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
            <Layers className="w-3.5 h-3.5 text-cyan-400" />
            <span>Selected Features ({selectedList.length})</span>
          </div>
          {selectedList.length > 0 && (
            <button
              type="button"
              onClick={onClearAllSelectedFeatures}
              className="text-[11px] text-rose-400 hover:underline cursor-pointer"
            >
              Clear All
            </button>
          )}
        </div>

        {selectedList.length === 0 ? (
          <div className="p-3 text-center text-slate-500 text-[11px] bg-slate-950/70 rounded border border-slate-800/80">
            Click any building, road, railway, park, or waterway in the 3D viewport to inspect its attributes and OSM tags.
          </div>
        ) : (
          <div className="max-h-44 overflow-y-auto space-y-1.5">
            {selectedList.map((feat) => {
              const isFocused = feat.id === activeFocusedId;
              const osmId = feat.sourceFeatureId || feat.id;
              return (
                <div
                  key={feat.id}
                  onClick={() => onFocusFeature(feat.id)}
                  className={`p-2 rounded-md border text-xs cursor-pointer transition flex items-center justify-between gap-2 ${
                    isFocused
                      ? 'border-cyan-500/50 bg-cyan-500/12 text-slate-100'
                      : 'border-slate-800 bg-slate-950/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono font-semibold text-cyan-300 truncate">
                        {osmId}
                      </span>
                      <span className="px-1.5 py-0.5 text-[9px] font-mono rounded bg-slate-900 text-slate-300 border border-slate-800 shrink-0">
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
                    title="Remove from selection"
                    aria-label={`Remove ${osmId} from selection`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onRemoveSelectedFeature(feat.id);
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
      </section>

      {/* Focused Object Details */}
      <section className="bg-slate-900/60 border border-slate-800 rounded-md p-3 space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-200">
            Focused Object Details
          </span>
          {focusedFeature && (
            <button
              type="button"
              onClick={() => {
                if (selectedList.length > 1) {
                  onRemoveSelectedFeature(focusedFeature.id);
                } else {
                  onSelectFeature(null);
                }
              }}
              className="text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              Deselect
            </button>
          )}
        </div>

        {!focusedFeature ? (
          <div className="p-3 text-center text-slate-500 text-[11px] flex items-center justify-center gap-1.5">
            <Info className="w-3.5 h-3.5 shrink-0" />
            <span>No active selection focused.</span>
          </div>
        ) : (
          <div className="space-y-2.5 text-xs">
            <div className="bg-slate-950 p-2.5 rounded-md border border-slate-800 space-y-1.5">
              <div className="text-[11px] font-mono text-cyan-400 font-semibold truncate">
                {focusedFeature.cartoLabel} · {focusedFeature.id}
              </div>
              {focusedFeature.name && (
                <div className="text-sm font-semibold text-slate-100">
                  {focusedFeature.name}
                </div>
              )}
              <div className="grid grid-cols-2 gap-1 text-[11px] font-mono tabular-nums text-slate-400">
                <div>
                  Tag: <strong className="text-slate-200">{focusedFeature.primaryTag}</strong>
                </div>
                <div>
                  Subtype: <strong className="text-slate-200">{focusedFeature.subtype}</strong>
                </div>
                <div>
                  Source:{' '}
                  <strong className="text-slate-200">
                    {focusedFeature.sourceFeatureId}
                  </strong>
                </div>
                {typeof focusedFeature.height === 'number' && (
                  <div>
                    Height:{' '}
                    <strong className="text-cyan-300">
                      {focusedFeature.height.toFixed(1)}m
                    </strong>
                  </div>
                )}
                {typeof focusedFeature.width === 'number' && (
                  <div>
                    Width:{' '}
                    <strong className="text-cyan-300">
                      {focusedFeature.width.toFixed(2)}m
                    </strong>
                  </div>
                )}
                {typeof focusedFeature.elevation === 'number' && (
                  <div>
                    Elevation:{' '}
                    <strong className="text-slate-200">
                      {focusedFeature.elevation.toFixed(3)}m
                    </strong>
                  </div>
                )}
                {typeof focusedFeature.layer === 'number' && (
                  <div>
                    Layer: <strong className="text-slate-200">{focusedFeature.layer}</strong>
                  </div>
                )}
                {focusedFeature.isBridge && (
                  <div className="text-amber-300 font-semibold">Bridge Deck</div>
                )}
                {focusedFeature.isTunnel && (
                  <div className="text-indigo-300 font-semibold">Tunnel</div>
                )}
              </div>

              {focusedFeature.sourceFeatureIds &&
                focusedFeature.sourceFeatureIds.length > 1 && (
                  <div className="pt-1.5 border-t border-slate-800">
                    <span className="text-[10px] font-medium text-slate-400">
                      Constituent Source Ways ({focusedFeature.sourceFeatureIds.length}):
                    </span>
                    <div className="text-[10px] font-mono text-cyan-300/90 break-all">
                      {focusedFeature.sourceFeatureIds.join(', ')}
                    </div>
                  </div>
                )}

              {focusedFeature.portalConnections &&
                focusedFeature.portalConnections.length > 0 && (
                  <div className="pt-1.5 border-t border-slate-800 space-y-1">
                    <span className="text-[10px] font-medium text-slate-400">
                      Junction Portals ({focusedFeature.portalConnections.length} arms):
                    </span>
                    <div className="space-y-0.5 text-[10px] font-mono tabular-nums text-slate-300">
                      {focusedFeature.portalConnections.map((pc, idx) => (
                        <div key={idx} className="flex items-center justify-between gap-1">
                          <span className="text-cyan-300 truncate">
                            {pc.sourceFeatureId} ({pc.endpoint})
                          </span>
                          <span className="text-slate-500 shrink-0">
                            L:[{pc.left[0].toFixed(1)},{pc.left[1].toFixed(1)}] R:[
                            {pc.right[0].toFixed(1)},{pc.right[1].toFixed(1)}]
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
            </div>

            <div className="space-y-1">
              <div className="text-[11px] font-semibold text-slate-300">
                Raw OSM Tags ({Object.keys(focusedFeature.osmTags || {}).length})
              </div>
              <div className="max-h-48 overflow-y-auto bg-slate-950 p-2 rounded-md border border-slate-800 text-[10px] font-mono space-y-0.5">
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
};
