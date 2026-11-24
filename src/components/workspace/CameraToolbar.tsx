import React from 'react';
import {
  Compass,
  EyeOff,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  RotateCw,
} from 'lucide-react';

export interface CameraToolbarProps {
  visible: boolean;
  currentZoom: number;
  minZoom: number;
  maxZoom: number;
  azimuthDeg: number;
  onRotateLeft: () => void;
  onRotateRight: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetCamera: () => void;
  onFrameWorld: () => void;
  onHideToolbar: () => void;
}

export const CameraToolbar: React.FC<CameraToolbarProps> = ({
  visible,
  currentZoom,
  minZoom,
  maxZoom,
  azimuthDeg,
  onRotateLeft,
  onRotateRight,
  onZoomIn,
  onZoomOut,
  onResetCamera,
  onFrameWorld,
  onHideToolbar,
}) => {
  if (!visible) return null;

  const canZoomOut = currentZoom > minZoom + 0.002;
  const canZoomIn = currentZoom < maxZoom - 0.002;
  const stopCanvasLeak = (e: React.SyntheticEvent) => {
    e.stopPropagation();
  };

  return (
    <div
      data-testid="viewport-camera-toolbar"
      role="toolbar"
      aria-label="Viewport camera controls"
      onPointerDown={stopCanvasLeak}
      onPointerUp={stopCanvasLeak}
      onWheel={stopCanvasLeak}
      onClick={stopCanvasLeak}
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 pointer-events-auto flex items-center gap-1 bg-slate-950/92 border border-slate-800 rounded-lg px-2 py-1.5 shadow-2xl backdrop-blur-md max-w-[calc(100%-1.5rem)] overflow-x-auto"
    >
      {/* Rotation + Live Compass */}
      <button
        type="button"
        data-testid="btn-camera-rotate-left"
        onClick={onRotateLeft}
        title="Rotate Left 45°"
        aria-label="Rotate camera counter-clockwise 45 degrees"
        className="p-1.5 rounded text-slate-300 hover:text-cyan-300 hover:bg-slate-800/80 transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 cursor-pointer shrink-0"
      >
        <RotateCcw className="w-3.5 h-3.5" />
      </button>

      <div
        data-testid="camera-compass-indicator"
        title={`Camera viewing azimuth: ${azimuthDeg}°`}
        className="flex items-center gap-1.5 px-2 py-1 rounded bg-slate-900 border border-slate-800 text-[11px] font-mono tabular-nums text-slate-200 shrink-0"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          className="shrink-0 text-cyan-400"
          style={{ transform: `rotate(${-azimuthDeg}deg)` }}
          aria-hidden="true"
        >
          <polygon points="8,1.5 10.5,8.5 8,7 5.5,8.5" fill="currentColor" />
          <polygon points="8,14.5 10.5,8.5 8,10 5.5,8.5" fill="#475569" />
        </svg>
        <span>{azimuthDeg}°</span>
      </div>

      <button
        type="button"
        data-testid="btn-camera-rotate-right"
        onClick={onRotateRight}
        title="Rotate Right 45°"
        aria-label="Rotate camera clockwise 45 degrees"
        className="p-1.5 rounded text-slate-300 hover:text-cyan-300 hover:bg-slate-800/80 transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 cursor-pointer shrink-0"
      >
        <RotateCw className="w-3.5 h-3.5" />
      </button>

      <div className="w-px h-4 bg-slate-800 mx-0.5 shrink-0" />

      {/* Zoom Controls + Readout */}
      <button
        type="button"
        data-testid="btn-camera-zoom-out"
        onClick={onZoomOut}
        disabled={!canZoomOut}
        title={`Zoom Out (min ${minZoom}x)`}
        aria-label="Zoom out"
        className="p-1.5 rounded text-slate-300 hover:text-cyan-300 hover:bg-slate-800/80 disabled:opacity-35 disabled:pointer-events-none transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 cursor-pointer shrink-0"
      >
        <Minus className="w-3.5 h-3.5" />
      </button>

      <span
        data-testid="camera-zoom-readout"
        title={`Zoom ${currentZoom.toFixed(2)} px/m (policy range ${minZoom}–${maxZoom}x)`}
        className="px-2 py-0.5 text-[11px] font-mono tabular-nums text-cyan-300 min-w-[52px] text-center shrink-0"
      >
        {currentZoom.toFixed(2)}x
      </span>

      <button
        type="button"
        data-testid="btn-camera-zoom-in"
        onClick={onZoomIn}
        disabled={!canZoomIn}
        title={`Zoom In (max ${maxZoom}x)`}
        aria-label="Zoom in"
        className="p-1.5 rounded text-slate-300 hover:text-cyan-300 hover:bg-slate-800/80 disabled:opacity-35 disabled:pointer-events-none transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 cursor-pointer shrink-0"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>

      <div className="w-px h-4 bg-slate-800 mx-0.5 shrink-0" />

      {/* Reset & Frame World */}
      <button
        type="button"
        data-testid="btn-camera-reset"
        onClick={onResetCamera}
        title="Reset camera view to default position"
        aria-label="Reset camera view"
        className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-slate-200 hover:text-cyan-300 hover:bg-slate-800/80 transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 cursor-pointer shrink-0"
      >
        <Compass className="w-3.5 h-3.5 text-cyan-400" />
        <span>Reset</span>
      </button>

      <button
        type="button"
        data-testid="btn-camera-frame-world"
        onClick={onFrameWorld}
        title="Frame loaded region bounds within zoom policy"
        aria-label="Frame world bounds"
        className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-slate-200 hover:text-cyan-300 hover:bg-slate-800/80 transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 cursor-pointer shrink-0"
      >
        <Maximize2 className="w-3.5 h-3.5 text-cyan-400" />
        <span>Frame World</span>
      </button>

      <div className="w-px h-4 bg-slate-800 mx-0.5 shrink-0" />

      <button
        type="button"
        data-testid="btn-camera-toolbar-hide"
        onClick={onHideToolbar}
        title="Hide camera toolbar"
        aria-label="Hide camera toolbar"
        className="p-1.5 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800/80 transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400 cursor-pointer shrink-0"
      >
        <EyeOff className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};
