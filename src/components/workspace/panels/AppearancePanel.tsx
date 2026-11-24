import React from 'react';
import { Lock } from 'lucide-react';
import { MAP_THEMES } from '../../../styles/mapThemes';

export interface AppearancePanelProps {
  selectedThemeId: string;
  onSelectTheme: (themeId: string) => void;
  isBakedTileMode: boolean;
  heightMultiplier: number;
  roadWidthMultiplier: number;
  bevelEnabled: boolean;
  onChangeHeightMultiplier: (val: number) => void;
  onChangeRoadWidthMultiplier: (val: number) => void;
  onChangeBevelEnabled: (enabled: boolean) => void;
}

export const AppearancePanel: React.FC<AppearancePanelProps> = ({
  selectedThemeId,
  onSelectTheme,
  isBakedTileMode,
  heightMultiplier,
  roadWidthMultiplier,
  bevelEnabled,
  onChangeHeightMultiplier,
  onChangeRoadWidthMultiplier,
  onChangeBevelEnabled,
}) => {
  return (
    <div data-testid="panel-appearance" className="space-y-4">
      {/* Live Visual Themes */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-slate-200">Visual Theme</h3>
          <span className="text-[10px] font-mono text-emerald-400">
            Live Shader / Material
          </span>
        </div>

        <div className="grid grid-cols-1 gap-1.5">
          {Object.values(MAP_THEMES).map((theme) => {
            const active = selectedThemeId === theme.id;
            return (
              <button
                key={theme.id}
                type="button"
                data-testid={`theme-option-${theme.id}`}
                aria-pressed={active}
                onClick={() => onSelectTheme(theme.id)}
                className={`w-full px-3 py-2 rounded-md border text-left flex items-center justify-between gap-2 transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 cursor-pointer ${
                  active
                    ? 'bg-cyan-500/15 border-cyan-500/45 text-cyan-200'
                    : 'bg-slate-900/60 border-slate-800 text-slate-300 hover:bg-slate-900'
                }`}
              >
                <div className="min-w-0">
                  <div className="text-xs font-semibold truncate">{theme.name}</div>
                  <div className="text-[10px] text-slate-400 font-mono truncate">
                    {theme.id}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0" aria-hidden="true">
                  <span
                    className="w-3.5 h-3.5 rounded-sm border border-slate-700"
                    style={{ backgroundColor: theme.groundColor }}
                  />
                  <span
                    className="w-3.5 h-3.5 rounded-sm border border-slate-700"
                    style={{ backgroundColor: theme.buildingWallColor }}
                  />
                  <span
                    className="w-3.5 h-3.5 rounded-sm border border-slate-700"
                    style={{
                      backgroundColor:
                        theme.roadColors.primary ?? theme.roadColors.residential,
                    }}
                  />
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* Geometry Rebuild Parameters */}
      <section className="space-y-2.5 border-t border-slate-800 pt-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-slate-200">
            Geometry Scale &amp; Extrusion
          </h3>
          {isBakedTileMode && (
            <span className="inline-flex items-center gap-1 text-[10px] font-mono text-amber-300">
              <Lock className="w-3 h-3" />
              <span>Baked Tiles</span>
            </span>
          )}
        </div>

        {isBakedTileMode && (
          <p
            data-testid="appearance-baked-geometry-notice"
            className="text-[11px] text-slate-400 bg-slate-900/70 border border-slate-800 rounded-md p-2.5 leading-relaxed"
          >
            Height scale, road width multiplier, and edge beveling are pre-baked inside offline{' '}
            <code className="text-slate-200">OSMTILE1</code> geometry payloads and cannot be adjusted at runtime without re-baking.
          </p>
        )}

        <div className={`space-y-3 ${isBakedTileMode ? 'opacity-50' : ''}`}>
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-300">Building Height</span>
              <span className="font-mono tabular-nums text-cyan-300">
                {heightMultiplier.toFixed(1)}x
              </span>
            </div>
            <input
              type="range"
              min="0.5"
              max="2.5"
              step="0.1"
              disabled={isBakedTileMode}
              value={heightMultiplier}
              onChange={(e) => onChangeHeightMultiplier(parseFloat(e.target.value))}
              aria-label="Building height multiplier"
              className="w-full accent-cyan-400 disabled:cursor-not-allowed cursor-pointer"
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-300">Road Width</span>
              <span className="font-mono tabular-nums text-cyan-300">
                {roadWidthMultiplier.toFixed(1)}x
              </span>
            </div>
            <input
              type="range"
              min="0.6"
              max="2.0"
              step="0.1"
              disabled={isBakedTileMode}
              value={roadWidthMultiplier}
              onChange={(e) => onChangeRoadWidthMultiplier(parseFloat(e.target.value))}
              aria-label="Road width multiplier"
              className="w-full accent-cyan-400 disabled:cursor-not-allowed cursor-pointer"
            />
          </div>

          <label
            className={`flex items-center justify-between px-2.5 py-2 rounded-md border border-slate-800 bg-slate-900/50 text-xs ${
              isBakedTileMode ? 'cursor-not-allowed' : 'cursor-pointer'
            }`}
          >
            <span className="text-slate-300">Beveled Building Edges</span>
            <input
              type="checkbox"
              disabled={isBakedTileMode}
              checked={bevelEnabled}
              onChange={(e) => onChangeBevelEnabled(e.target.checked)}
              className="rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-0"
            />
          </label>
        </div>
      </section>
    </div>
  );
};
