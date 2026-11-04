import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  ProcessedMapData,
  MapStyleTheme,
  BuildingFeature,
} from '../types/MapFeature';
import { AlertTriangle, RefreshCw, HelpCircle, Layers } from 'lucide-react';

export interface Fallback2DMapProps {
  mapData: ProcessedMapData;
  theme: MapStyleTheme;
  showBuildings?: boolean;
  showRoads?: boolean;
  showWater?: boolean;
  showParks?: boolean;
  heightMultiplier?: number;
  roadWidthMultiplier?: number;
  resetSignal?: number;
  onHoverBuilding?: (building: Record<string, unknown> | null) => void;
  onClickBuilding?: (building: Record<string, unknown> | null) => void;
  onRetryWebGL?: () => void;
}

export const Fallback2DMap: React.FC<Fallback2DMapProps> = ({
  mapData,
  theme,
  showBuildings = true,
  showRoads = true,
  showWater = true,
  showParks = true,
  heightMultiplier = 1.0,
  roadWidthMultiplier = 1.0,
  resetSignal = 0,
  onHoverBuilding,
  onClickBuilding,
  onRetryWebGL,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Camera viewport in 2D local meters
  const [camera, setCamera] = useState({
    x: 0,
    z: 0,
    zoom: 0.85, // pixels per meter
  });

  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, camX: 0, camZ: 0 });
  const [showTroubleshooting, setShowTroubleshooting] = useState(false);

  // Reset camera view
  useEffect(() => {
    if (resetSignal > 0) {
      setCamera({ x: 0, z: 0, zoom: 0.85 });
    }
  }, [resetSignal]);

  // Main 2D Canvas Render Loop
  const drawScene = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Clear background
    ctx.fillStyle = theme.groundColor;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    // Center at viewport
    ctx.translate(width / 2, height / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.z);

    // 1. Draw subtle tactical grid
    ctx.strokeStyle = theme.gridColor;
    ctx.lineWidth = 1 / camera.zoom;
    ctx.beginPath();
    const gridStep = 100; // 100m grid
    const minGridX = Math.floor((camera.x - width / (2 * camera.zoom)) / gridStep) * gridStep;
    const maxGridX = Math.ceil((camera.x + width / (2 * camera.zoom)) / gridStep) * gridStep;
    const minGridZ = Math.floor((camera.z - height / (2 * camera.zoom)) / gridStep) * gridStep;
    const maxGridZ = Math.ceil((camera.z + height / (2 * camera.zoom)) / gridStep) * gridStep;

    for (let gx = minGridX; gx <= maxGridX; gx += gridStep) {
      ctx.moveTo(gx, minGridZ);
      ctx.lineTo(gx, maxGridZ);
    }
    for (let gz = minGridZ; gz <= maxGridZ; gz += gridStep) {
      ctx.moveTo(minGridX, gz);
      ctx.lineTo(maxGridX, gz);
    }
    ctx.stroke();

    // 2. Draw Water Polygons
    if (showWater) {
      ctx.fillStyle = theme.waterColor;
      for (const w of mapData.water) {
        if (!w.polygon || w.polygon.length === 0) continue;
        ctx.beginPath();
        for (let r = 0; r < w.polygon.length; r++) {
          const ring = w.polygon[r];
          if (ring.length < 3) continue;
          ctx.moveTo(ring[0][0], ring[0][1]);
          for (let p = 1; p < ring.length; p++) {
            ctx.lineTo(ring[p][0], ring[p][1]);
          }
          ctx.closePath();
        }
        ctx.fill();
      }
    }

    // 3. Draw Parks & Plazas
    if (showParks) {
      ctx.fillStyle = theme.parkColor;
      for (const park of mapData.parks) {
        if (!park.polygon || park.polygon.length === 0) continue;
        ctx.beginPath();
        for (let r = 0; r < park.polygon.length; r++) {
          const ring = park.polygon[r];
          if (ring.length < 3) continue;
          ctx.moveTo(ring[0][0], ring[0][1]);
          for (let p = 1; p < ring.length; p++) {
            ctx.lineTo(ring[p][0], ring[p][1]);
          }
          ctx.closePath();
        }
        ctx.fill();
      }
    }

    // 4. Draw Roads (polylines with metric widths)
    if (showRoads) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (const road of mapData.roads) {
        if (!road.points || road.points.length < 2) continue;
        const color = theme.roadColors[road.roadClass] || '#64748b';
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.5, road.width * roadWidthMultiplier);

        ctx.beginPath();
        ctx.moveTo(road.points[0][0], road.points[0][1]);
        for (let i = 1; i < road.points.length; i++) {
          ctx.lineTo(road.points[i][0], road.points[i][1]);
        }
        ctx.stroke();
      }
    }

    // 4B. Draw Railways (ballast bed, cross-ties, and twin rails)
    if (mapData.railways && mapData.railways.length > 0) {
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'round';

      for (const rail of mapData.railways) {
        if (!rail.points || rail.points.length < 2 || rail.isTunnel || rail.layer < 0) continue;

        // Ballast bed
        ctx.strokeStyle = theme.railwayColors.ballast;
        ctx.lineWidth = Math.min(rail.width, 3.6);
        ctx.beginPath();
        ctx.moveTo(rail.points[0][0], rail.points[0][1]);
        for (let i = 1; i < rail.points.length; i++) {
          ctx.lineTo(rail.points[i][0], rail.points[i][1]);
        }
        ctx.stroke();

        // Cross-ties / sleepers
        ctx.strokeStyle = theme.railwayColors.sleeper || '#64748b';
        ctx.lineWidth = 0.35;
        ctx.beginPath();
        for (let i = 0; i < rail.points.length - 1; i++) {
          const p0 = rail.points[i];
          const p1 = rail.points[i + 1];
          const dx = p1[0] - p0[0];
          const dz = p1[1] - p0[1];
          const len = Math.hypot(dx, dz);
          if (len < 0.5) continue;
          const nx = (-dz / len) * 1.15;
          const nz = (dx / len) * 1.15;
          for (let d = 0.75; d < len; d += 1.5) {
            const t = d / len;
            const cx = p0[0] + dx * t;
            const cz = p0[1] + dz * t;
            ctx.moveTo(cx - nx, cz - nz);
            ctx.lineTo(cx + nx, cz + nz);
          }
        }
        ctx.stroke();

        // Center/twin rail highlight
        ctx.strokeStyle = theme.railwayColors.rail;
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(rail.points[0][0], rail.points[0][1]);
        for (let i = 1; i < rail.points.length; i++) {
          ctx.lineTo(rail.points[i][0], rail.points[i][1]);
        }
        ctx.stroke();
      }
    }

    // 5. Draw 2.5D Extruded Buildings (Pseudo-isometric shadows and roof caps)
    if (showBuildings) {
      // Sort buildings from North to South (ascending Z) for proper depth ordering
      const sortedBuildings = [...mapData.buildings].sort((a, b) => {
        const aZ = a.footprint[0]?.[0]?.[1] || 0;
        const bZ = b.footprint[0]?.[0]?.[1] || 0;
        return aZ - bZ;
      });

      for (const b of sortedBuildings) {
        if (!b.footprint || b.footprint.length === 0) continue;
        const outer = b.footprint[0];
        if (outer.length < 3) continue;

        const isLandmark =
          b.buildingType === 'cathedral' ||
          b.buildingType === 'chapel' ||
          b.buildingType === 'tower' ||
          b.height > 35;

        // Pseudo-isometric offset based on height
        const h = Math.max(3, b.height * heightMultiplier);
        const isoX = h * 0.35;
        const isoZ = -h * 0.35;

        // Wall Extrusions (connect base to roof)
        ctx.fillStyle = isLandmark
          ? theme.id === 'tactical'
            ? '#d97706'
            : '#facc15'
          : theme.buildingWallColor;
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 0.5 / camera.zoom;

        for (let i = 0; i < outer.length - 1; i++) {
          const p1 = outer[i];
          const p2 = outer[i + 1];

          ctx.beginPath();
          ctx.moveTo(p1[0], p1[1]);
          ctx.lineTo(p2[0], p2[1]);
          ctx.lineTo(p2[0] + isoX, p2[1] + isoZ);
          ctx.lineTo(p1[0] + isoX, p1[1] + isoZ);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }

        // Roof Top Polygon
        ctx.fillStyle = isLandmark
          ? theme.id === 'tactical'
            ? '#f59e0b'
            : '#fef08a'
          : theme.buildingRoofColor;

        ctx.beginPath();
        for (let r = 0; r < b.footprint.length; r++) {
          const ring = b.footprint[r];
          if (ring.length < 3) continue;
          ctx.moveTo(ring[0][0] + isoX, ring[0][1] + isoZ);
          for (let p = 1; p < ring.length; p++) {
            ctx.lineTo(ring[p][0] + isoX, ring[p][1] + isoZ);
          }
          ctx.closePath();
        }
        ctx.fill();
        ctx.stroke();
      }
    }

    ctx.restore();
  }, [
    mapData,
    theme,
    camera,
    showBuildings,
    showRoads,
    showWater,
    showParks,
    heightMultiplier,
    roadWidthMultiplier,
  ]);

  // Handle window resizing
  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current) {
        canvasRef.current.width = window.innerWidth;
        canvasRef.current.height = window.innerHeight;
        drawScene();
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [drawScene]);

  // Redraw when camera or options update
  useEffect(() => {
    drawScene();
  }, [drawScene]);

  // Mouse pan and zoom handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      camX: camera.x,
      camZ: camera.z,
    };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      const dx = (e.clientX - dragStartRef.current.x) / camera.zoom;
      const dz = (e.clientY - dragStartRef.current.y) / camera.zoom;
      setCamera((prev) => ({
        ...prev,
        x: dragStartRef.current.camX - dx,
        z: dragStartRef.current.camZ - dz,
      }));
    } else {
      // Raycast building hover in 2D
      const canvas = canvasRef.current;
      if (!canvas || !onHoverBuilding) return;
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Transform mouse to local world meters
      const worldX = (mouseX - canvas.width / 2) / camera.zoom + camera.x;
      const worldZ = (mouseY - canvas.height / 2) / camera.zoom + camera.z;

      // Check buildings
      let found: BuildingFeature | null = null;
      for (const b of mapData.buildings) {
        if (pointInPolygon([worldX, worldZ], b.footprint[0])) {
          found = b;
          break;
        }
      }

      if (found) {
        onHoverBuilding({
          id: found.id,
          name: found.name || 'Building',
          height: found.height,
          levels: found.levels,
          type: found.buildingType,
        });
      } else {
        onHoverBuilding(null);
      }
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.85;
    setCamera((prev) => ({
      ...prev,
      zoom: Math.min(5.0, Math.max(0.2, prev.zoom * factor)),
    }));
  };

  return (
    <div className="relative w-full h-full select-none overflow-hidden">
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        className="w-full h-full cursor-grab active:cursor-grabbing block"
      />

      {/* WebGL Disabled Informational Banner */}
      <div className="absolute top-20 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-4 py-2 bg-slate-900/95 border border-amber-500/40 text-amber-200 text-xs rounded-xl shadow-2xl backdrop-blur-md">
        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
        <span>
          <strong>2D Canvas Fallback Mode:</strong> WebGL is currently disabled or unavailable in this browser.
        </span>
        <button
          type="button"
          onClick={() => setShowTroubleshooting((v) => !v)}
          className="flex items-center gap-1 underline text-amber-400 hover:text-amber-300 font-medium cursor-pointer ml-1"
        >
          <HelpCircle className="w-3.5 h-3.5" />
          <span>Troubleshoot</span>
        </button>
        {onRetryWebGL && (
          <button
            type="button"
            onClick={onRetryWebGL}
            className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 rounded-lg text-xs font-semibold cursor-pointer ml-1 transition"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Retry WebGL</span>
          </button>
        )}
      </div>

      {/* Troubleshooting Modal */}
      {showTroubleshooting && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 max-w-md w-full rounded-2xl p-6 shadow-2xl text-slate-200 text-sm space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="font-bold text-base text-slate-100 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-amber-400" />
                How to Enable WebGL in Your Browser
              </h3>
              <button
                type="button"
                onClick={() => setShowTroubleshooting(false)}
                className="text-slate-400 hover:text-slate-100 p-1"
              >
                ✕
              </button>
            </div>

            <div className="space-y-2 text-xs text-slate-300 leading-relaxed">
              <p>
                The 3D renderer requires WebGL support from your browser. In the meantime, this 2D canvas map viewer displays all real-world features smoothly.
              </p>
              <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700/80 space-y-2">
                <p className="font-semibold text-slate-100">Chrome / Edge / Brave:</p>
                <ol className="list-decimal list-inside space-y-1 text-slate-400">
                  <li>Open <code>chrome://settings/system</code></li>
                  <li>Enable <strong>"Use graphics acceleration when available"</strong></li>
                  <li>Relaunch browser and click <strong>Retry WebGL</strong></li>
                </ol>
              </div>

              <div className="bg-slate-800/80 p-3 rounded-xl border border-slate-700/80 space-y-2">
                <p className="font-semibold text-slate-100">Safari (macOS / iOS):</p>
                <p className="text-slate-400">
                  Go to Safari &gt; Settings &gt; Advanced &gt; Feature Flags &gt; ensure WebGL 2.0 is checked.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setShowTroubleshooting(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-medium cursor-pointer"
              >
                Continue in 2D Mode
              </button>
              {onRetryWebGL && (
                <button
                  type="button"
                  onClick={() => {
                    setShowTroubleshooting(false);
                    onRetryWebGL();
                  }}
                  className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl text-xs font-semibold cursor-pointer"
                >
                  Retry WebGL Context
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Point-in-polygon raycasting helper
function pointInPolygon(point: [number, number], vs: [number, number][]): boolean {
  if (!vs || vs.length < 3) return false;
  const x = point[0];
  const y = point[1];
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i][0];
    const yi = vs[i][1];
    const xj = vs[j][0];
    const yj = vs[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
