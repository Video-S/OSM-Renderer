import React from 'react';
import {
  Building2,
  Fence,
  LandPlot,
  Navigation,
  Train,
  TreePine,
  Trees,
  Waves,
} from 'lucide-react';
import type { ProcessedMapData } from '../../../types/MapFeature';
import type { BuiltSceneGeometry } from '../../../world/GeometryBuilder';

export interface LayersPanelProps {
  isBakedTileMode: boolean;
  mapData: ProcessedMapData | null;
  builtGeometry: BuiltSceneGeometry | null;
  showBuildings: boolean;
  showRoads: boolean;
  showRailways: boolean;
  showWater: boolean;
  showParks: boolean;
  showLanduse: boolean;
  showFoliage: boolean;
  showBarriers: boolean;
  onToggleBuildings: () => void;
  onToggleRoads: () => void;
  onToggleRailways: () => void;
  onToggleWater: () => void;
  onToggleParks: () => void;
  onToggleLanduse: () => void;
  onToggleFoliage: () => void;
  onToggleBarriers: () => void;
  onShowAllLayers: () => void;
}

export const LayersPanel: React.FC<LayersPanelProps> = ({
  isBakedTileMode,
  mapData,
  builtGeometry,
  showBuildings,
  showRoads,
  showRailways,
  showWater,
  showParks,
  showLanduse,
  showFoliage,
  showBarriers,
  onToggleBuildings,
  onToggleRoads,
  onToggleRailways,
  onToggleWater,
  onToggleParks,
  onToggleLanduse,
  onToggleFoliage,
  onToggleBarriers,
  onShowAllLayers,
}) => {
  const layers = [
    {
      id: 'buildings',
      label: 'Buildings',
      checked: showBuildings,
      onToggle: onToggleBuildings,
      icon: Building2,
      iconColor: 'text-amber-400',
      count: mapData?.stats.totalBuildings ?? 0,
    },
    {
      id: 'roads',
      label: 'Roads & Paths',
      checked: showRoads,
      onToggle: onToggleRoads,
      icon: Navigation,
      iconColor: 'text-sky-400',
      count: mapData?.stats.totalRoads ?? 0,
    },
    {
      id: 'railways',
      label: 'Railways',
      checked: showRailways,
      onToggle: onToggleRailways,
      icon: Train,
      iconColor: 'text-purple-400',
      count: mapData?.stats.totalRailways ?? 0,
    },
    {
      id: 'water',
      label: 'Waterways & Basins',
      checked: showWater,
      onToggle: onToggleWater,
      icon: Waves,
      iconColor: 'text-cyan-400',
      count:
        (mapData?.stats.totalWaterPolygons ?? 0) +
        (mapData?.stats.totalLinearWaterways ?? 0),
    },
    {
      id: 'parks',
      label: 'Parks & Vegetation',
      checked: showParks,
      onToggle: onToggleParks,
      icon: Trees,
      iconColor: 'text-emerald-400',
      count: mapData?.stats.totalParkPolygons ?? 0,
    },
    {
      id: 'landuse',
      label: 'Landuse & Civic',
      checked: showLanduse,
      onToggle: onToggleLanduse,
      icon: LandPlot,
      iconColor: 'text-indigo-400',
      count: mapData?.stats.totalLandusePolygons ?? 0,
    },
    {
      id: 'foliage',
      label: '3D Foliage & Trees',
      checked: showFoliage,
      onToggle: onToggleFoliage,
      icon: TreePine,
      iconColor: 'text-lime-400',
      count:
        (builtGeometry?.stats.forestTreesCount ?? 0) +
        (mapData?.stats.totalLandmarks ?? 0),
    },
    {
      id: 'barriers',
      label: 'Barriers & Walls',
      checked: showBarriers,
      onToggle: onToggleBarriers,
      icon: Fence,
      iconColor: 'text-amber-300',
      count: mapData?.stats.totalBarriers ?? 0,
    },
  ];

  const allVisible = layers.every((l) => l.checked);

  return (
    <div data-testid="panel-layers" className="space-y-3">
      <div className="flex items-center justify-between text-[11px] text-slate-400">
        <span>
          {isBakedTileMode
            ? 'Per-layer visibility over streamed OSMTILE1 groups'
            : 'Scene layer toggles'}
        </span>
        {!allVisible && (
          <button
            type="button"
            onClick={onShowAllLayers}
            className="text-cyan-400 hover:text-cyan-300 font-medium cursor-pointer"
          >
            Show All
          </button>
        )}
      </div>

      <div className="divide-y divide-slate-800/80 border border-slate-800 rounded-md bg-slate-900/50">
        {layers.map((layer) => {
          const Icon = layer.icon;
          return (
            <button
              key={layer.id}
              type="button"
              role="switch"
              data-testid={`layer-toggle-${layer.id}`}
              aria-checked={layer.checked}
              onClick={layer.onToggle}
              className="w-full px-3 py-2.5 flex items-center justify-between gap-2 text-left hover:bg-slate-900/90 transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 cursor-pointer"
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <Icon
                  className={`w-4 h-4 shrink-0 ${
                    layer.checked ? layer.iconColor : 'text-slate-600'
                  }`}
                />
                <span
                  className={`text-xs font-medium truncate ${
                    layer.checked ? 'text-slate-100' : 'text-slate-500'
                  }`}
                >
                  {layer.label}
                </span>
              </span>

              <span className="flex items-center gap-2.5 shrink-0">
                {!isBakedTileMode && (
                  <span className="text-[11px] font-mono tabular-nums text-slate-500">
                    {layer.count.toLocaleString()}
                  </span>
                )}
                <span
                  className={`w-7 h-4 rounded-sm border flex items-center px-0.5 transition ${
                    layer.checked
                      ? 'bg-cyan-500/25 border-cyan-400/60 justify-end'
                      : 'bg-slate-950 border-slate-700 justify-start'
                  }`}
                >
                  <span
                    className={`w-2.5 h-2.5 rounded-[2px] ${
                      layer.checked ? 'bg-cyan-300' : 'bg-slate-600'
                    }`}
                  />
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
