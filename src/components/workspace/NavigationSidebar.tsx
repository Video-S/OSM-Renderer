import React from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Compass,
  EyeOff,
  Gauge,
  Globe,
  Layers,
  MousePointerClick,
  Palette,
  PanelLeftClose,
  Search,
  Wrench,
} from 'lucide-react';
import type { NavSidebarMode, WorkspacePanelId } from './workspaceTypes';

export interface NavigationSidebarProps {
  mode: NavSidebarMode;
  activePanel: WorkspacePanelId | null;
  selectedFeatureCount: number;
  hideCameraToolbar: boolean;
  onSelectPanel: (panelId: WorkspacePanelId) => void;
  onChangeMode: (mode: NavSidebarMode) => void;
  onToggleImmersiveMode: () => void;
  onToggleCameraToolbar: () => void;
}

interface NavItemDef {
  id: WorkspacePanelId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: readonly NavItemDef[] = [
  { id: 'search', label: 'Search', icon: Search },
  { id: 'layers', label: 'Layers', icon: Layers },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'inspector', label: 'Inspector', icon: MousePointerClick },
  { id: 'performance', label: 'Performance', icon: Gauge },
  { id: 'diagnostics', label: 'Diagnostics', icon: Wrench },
  { id: 'world', label: 'World', icon: Globe },
];

export const NavigationSidebar: React.FC<NavigationSidebarProps> = ({
  mode,
  activePanel,
  selectedFeatureCount,
  hideCameraToolbar,
  onSelectPanel,
  onChangeMode,
  onToggleImmersiveMode,
  onToggleCameraToolbar,
}) => {
  if (mode === 'hidden') return null;

  const isCompact = mode === 'compact';

  return (
    <aside
      data-testid="workspace-nav-sidebar"
      data-nav-mode={mode}
      aria-label="Workspace tools navigation"
      className={`shrink-0 h-full bg-slate-950 border-r border-slate-800 flex flex-col justify-between select-none ${
        isCompact ? 'w-12' : 'w-[200px]'
      }`}
    >
      {/* Top header */}
      <div className="flex flex-col min-h-0 flex-1">
        <div
          className={`h-12 border-b border-slate-800 flex items-center shrink-0 ${
            isCompact ? 'justify-center px-1.5' : 'justify-between px-3'
          }`}
        >
          {!isCompact && (
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-6 h-6 rounded bg-cyan-500/15 border border-cyan-500/35 flex items-center justify-center text-cyan-400 shrink-0">
                <Compass className="w-3.5 h-3.5" />
              </div>
              <span className="text-xs font-semibold tracking-tight text-slate-100 truncate">
                OSM Workspace
              </span>
            </div>
          )}
          <button
            type="button"
            data-testid="btn-nav-toggle-compact"
            onClick={() => onChangeMode(isCompact ? 'expanded' : 'compact')}
            title={isCompact ? 'Expand navigation sidebar' : 'Collapse to icon rail'}
            aria-label={isCompact ? 'Expand navigation sidebar' : 'Collapse to icon rail'}
            className="p-1.5 rounded text-slate-400 hover:text-slate-100 hover:bg-slate-800/80 transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 cursor-pointer"
          >
            {isCompact ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </button>
        </div>

        {/* Navigation Items */}
        <nav className="flex-1 overflow-y-auto py-2 px-1.5 space-y-0.5" aria-label="Tool sections">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activePanel === item.id;
            const badgeCount =
              item.id === 'inspector' && selectedFeatureCount > 0
                ? selectedFeatureCount
                : null;

            return (
              <button
                key={item.id}
                type="button"
                data-testid={`nav-item-${item.id}`}
                aria-pressed={isActive}
                title={isCompact ? item.label : undefined}
                aria-label={item.label}
                onClick={() => onSelectPanel(item.id)}
                className={`relative w-full flex items-center rounded-md border text-xs font-medium transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 cursor-pointer ${
                  isCompact ? 'justify-center py-2 px-1' : 'justify-between px-2.5 py-2'
                } ${
                  isActive
                    ? 'bg-cyan-500/15 border-cyan-500/35 text-cyan-200'
                    : 'bg-transparent border-transparent text-slate-400 hover:text-slate-100 hover:bg-slate-900'
                }`}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <Icon
                    className={`w-4 h-4 shrink-0 ${
                      isActive ? 'text-cyan-300' : 'text-slate-400'
                    }`}
                  />
                  {!isCompact && <span className="truncate">{item.label}</span>}
                </span>

                {!isCompact && badgeCount !== null && (
                  <span className="text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-cyan-300">
                    {badgeCount}
                  </span>
                )}
                {isCompact && badgeCount !== null && (
                  <span
                    className="absolute top-1 right-1 w-1.5 h-1.5 rounded-sm bg-cyan-400"
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Bottom Visibility / Immersive Controls */}
      <div className="border-t border-slate-800 p-1.5 space-y-1 shrink-0">
        <button
          type="button"
          data-testid="btn-toggle-camera-toolbar"
          onClick={onToggleCameraToolbar}
          title={hideCameraToolbar ? 'Show viewport camera toolbar' : 'Hide viewport camera toolbar'}
          aria-label={hideCameraToolbar ? 'Show viewport camera toolbar' : 'Hide viewport camera toolbar'}
          className={`w-full flex items-center rounded-md text-[11px] font-medium transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 cursor-pointer ${
            isCompact ? 'justify-center py-1.5 px-1' : 'gap-2 px-2.5 py-1.5'
          } ${
            hideCameraToolbar
              ? 'text-amber-300 bg-amber-500/10 hover:bg-amber-500/20'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
          }`}
        >
          <Compass className="w-3.5 h-3.5 shrink-0" />
          {!isCompact && (
            <span className="truncate">
              {hideCameraToolbar ? 'Show Camera Bar' : 'Hide Camera Bar'}
            </span>
          )}
        </button>

        <button
          type="button"
          data-testid="btn-nav-hide-sidebar"
          onClick={() => onChangeMode('hidden')}
          title="Hide navigation sidebar"
          aria-label="Hide navigation sidebar"
          className={`w-full flex items-center rounded-md text-[11px] font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-900 transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 cursor-pointer ${
            isCompact ? 'justify-center py-1.5 px-1' : 'gap-2 px-2.5 py-1.5'
          }`}
        >
          <PanelLeftClose className="w-3.5 h-3.5 shrink-0" />
          {!isCompact && <span className="truncate">Hide Sidebar</span>}
        </button>

        <button
          type="button"
          data-testid="btn-enter-immersive-mode"
          onClick={onToggleImmersiveMode}
          title="Hide all workspace panels & camera bar (Immersive View)"
          aria-label="Hide all workspace panels and camera bar"
          className={`w-full flex items-center rounded-md text-[11px] font-medium text-slate-400 hover:text-slate-100 hover:bg-slate-900 transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 cursor-pointer ${
            isCompact ? 'justify-center py-1.5 px-1' : 'gap-2 px-2.5 py-1.5'
          }`}
        >
          <EyeOff className="w-3.5 h-3.5 shrink-0" />
          {!isCompact && <span className="truncate">Hide All UI</span>}
        </button>
      </div>
    </aside>
  );
};
