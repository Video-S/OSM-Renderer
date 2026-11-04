#!/usr/bin/env bash
set -e

ASSETS_DIR="public/assets/m2-1-prototype"
mkdir -p "$ASSETS_DIR"

cp -n "$ASSETS_DIR/z1-short-segments-close-candidateB.png" "$ASSETS_DIR/z1-short-segments-close-candidateB-before-fix.png" 2>/dev/null || true
cp -n "$ASSETS_DIR/z2-turnout-close-candidateB.png" "$ASSETS_DIR/z2-turnout-close-candidateB-before-fix.png" 2>/dev/null || true
cp -n "$ASSETS_DIR/z3-scissors-close-candidateB.png" "$ASSETS_DIR/z3-scissors-close-candidateB-before-fix.png" 2>/dev/null || true
cp -n "$ASSETS_DIR/z4-station-throat-close-candidateB.png" "$ASSETS_DIR/z4-station-throat-close-candidateB-before-fix.png" 2>/dev/null || true

playwright-cli open --browser=chromium "http://localhost:3000/?fixture=switchyard&dock=collapsed" 2>/dev/null || true
playwright-cli goto "http://localhost:3000/?fixture=switchyard&dock=collapsed"
sleep 1.5

jump_and_capture() {
  local mode="$1"
  local theme="$2"
  local zone="$3"
  local zoom="$4"
  local out_file="$5"
  local dock_collapsed="${6:-true}"
  local raw_b64
  playwright-cli eval "(window.__M21_LAB__.setMode('$mode'), window.__M21_LAB__.setTheme('$theme'), window.__M21_LAB__.setDockCollapsed($dock_collapsed), window.__M21_LAB__.jumpToZone('$zone', $zoom))" >/dev/null
  sleep 0.5
  raw_b64=$(playwright-cli eval "window.__M21_LAB__.captureCanvasDataUrl()" | grep -o 'data:image/png;base64,[A-Za-z0-9+/=]*' | sed 's/^data:image\/png;base64,//')
  echo "$raw_b64" | base64 -d > "$out_file"
  echo "Saved $out_file ($(wc -c < "$out_file") bytes)"
}

echo "=== 1. Capturing Updated Candidate B & Candidate A Views (8.0x & 16.0x) ==="
playwright-cli eval "window.__M21_LAB__.loadSwitchyard('overview', 8.0)"

# Close zoom (8.0x) updated Candidate B across all 4 zones
for zone_pair in "straight_curved:z1-short-segments-close-candidateB.png" "single_turnout:z2-turnout-close-candidateB.png" "scissors_crossover:z3-scissors-close-candidateB.png" "station_throat:z4-station-throat-close-candidateB.png"; do
  zone="${zone_pair%%:*}"
  fname="${zone_pair##*:}"
  jump_and_capture "candidateB" "tactical" "$zone" 8.0 "$ASSETS_DIR/$fname"
done

# Extreme zoom (16.0x) across all 4 zones for Candidate A and Candidate B
for mode in candidateA candidateB; do
  for zone_pair in "straight_curved:z1-short-zoom16-$mode.png" "single_turnout:z2-turnout-zoom16-$mode.png" "scissors_crossover:z3-scissors-zoom16-$mode.png" "station_throat:z4-throat-zoom16-$mode.png"; do
    zone="${zone_pair%%:*}"
    fname="${zone_pair##*:}"
    jump_and_capture "$mode" "tactical" "$zone" 16.0 "$ASSETS_DIR/$fname"
  done
done

echo "=== 2. Capturing Candidate B Across All 4 Themes (Tactical, Daylight, Dusk, Blueprint) ==="
for theme in tactical daylight dusk blueprint; do
  jump_and_capture "candidateB" "$theme" "station_throat" 8.0 "$ASSETS_DIR/z4-theme-$theme-candidateB.png"
done

# Paired Daylight turnout comparison
jump_and_capture "candidateA" "daylight" "single_turnout" 8.0 "$ASSETS_DIR/z2-turnout-daylight-candidateA.png"
jump_and_capture "candidateB" "daylight" "single_turnout" 8.0 "$ASSETS_DIR/z2-turnout-daylight-candidateB.png"

echo "=== 3. Capturing Continuous LOD Transition Sweep (Zoom 4.3, 4.4, 4.5, 4.6, 4.7) ==="
for z in 4.3 4.4 4.5 4.6 4.7; do
  jump_and_capture "candidateB" "tactical" "single_turnout" "$z" "$ASSETS_DIR/hybrid-lod-zoom${z}.png"
done
cp -f "$ASSETS_DIR/hybrid-lod-zoom4.4.png" "$ASSETS_DIR/hybrid-lod-zoom4.4-ribbon.png"
cp -f "$ASSETS_DIR/hybrid-lod-zoom4.6.png" "$ASSETS_DIR/hybrid-lod-zoom4.6-3d.png"

# Also capture Candidate A at 4.4 and 4.6 so we can subtract normal camera zoom motion!
for z in 4.4 4.6; do
  jump_and_capture "candidateA" "tactical" "single_turnout" "$z" "$ASSETS_DIR/candA-lod-zoom${z}.png"
done

convert "$ASSETS_DIR/hybrid-lod-zoom4.4-ribbon.png" "$ASSETS_DIR/hybrid-lod-zoom4.6-3d.png" -compose difference -composite -colorspace gray -threshold 8% "$ASSETS_DIR/hybrid-lod-diff-mask.png"

echo "=== 4. Extracting 1:1 and 3x Paired Comparison Crops ==="
# Before vs After Candidate B crops (Zone 2 Turnout & Zone 3 Scissors)
convert "$ASSETS_DIR/z2-turnout-close-candidateB-before-fix.png" -crop 260x260+510+230 +repage -scale 300% "$ASSETS_DIR/crop-z2-throat-3x-candB-before-fix.png"
convert "$ASSETS_DIR/z3-scissors-close-candidateB-before-fix.png" -crop 260x260+510+230 +repage -scale 300% "$ASSETS_DIR/crop-z3-frog-3x-candB-before-fix.png"

# Crop 1: Switch Throat Divergence (Turnout Zone 2, close zoom 8.0x)
convert "$ASSETS_DIR/z2-turnout-close-candidateA.png" -crop 260x260+510+230 +repage "$ASSETS_DIR/crop-z2-throat-1x-candA.png"
convert "$ASSETS_DIR/z2-turnout-close-candidateB.png" -crop 260x260+510+230 +repage "$ASSETS_DIR/crop-z2-throat-1x-candB.png"
convert "$ASSETS_DIR/crop-z2-throat-1x-candA.png" -scale 300% "$ASSETS_DIR/crop-z2-throat-3x-candA.png"
convert "$ASSETS_DIR/crop-z2-throat-1x-candB.png" -scale 300% "$ASSETS_DIR/crop-z2-throat-3x-candB.png"

# Crop 2: Diamond Frog Crossing (Scissors Zone 3, close zoom 8.0x)
convert "$ASSETS_DIR/z3-scissors-close-candidateA.png" -crop 260x260+510+230 +repage "$ASSETS_DIR/crop-z3-frog-1x-candA.png"
convert "$ASSETS_DIR/z3-scissors-close-candidateB.png" -crop 260x260+510+230 +repage "$ASSETS_DIR/crop-z3-frog-1x-candB.png"
convert "$ASSETS_DIR/crop-z3-frog-1x-candA.png" -scale 300% "$ASSETS_DIR/crop-z3-frog-3x-candA.png"
convert "$ASSETS_DIR/crop-z3-frog-1x-candB.png" -scale 300% "$ASSETS_DIR/crop-z3-frog-3x-candB.png"

# Crop 3: Sleeper Definition & Short Chained Segments (Zone 1, close zoom 8.0x)
convert "$ASSETS_DIR/z1-short-segments-close-candidateA.png" -crop 260x260+510+230 +repage "$ASSETS_DIR/crop-z1-sleeper-1x-candA.png"
convert "$ASSETS_DIR/z1-short-segments-close-candidateB.png" -crop 260x260+510+230 +repage "$ASSETS_DIR/crop-z1-sleeper-1x-candB.png"
convert "$ASSETS_DIR/crop-z1-sleeper-1x-candA.png" -scale 300% "$ASSETS_DIR/crop-z1-sleeper-3x-candA.png"
convert "$ASSETS_DIR/crop-z1-sleeper-1x-candB.png" -scale 300% "$ASSETS_DIR/crop-z1-sleeper-3x-candB.png"

# Crop 4: Station Throat Multi-Track Fan (Zone 4, close zoom 8.0x)
convert "$ASSETS_DIR/z4-station-throat-close-candidateA.png" -crop 260x260+510+230 +repage "$ASSETS_DIR/crop-z4-throat-1x-candA.png"
convert "$ASSETS_DIR/z4-station-throat-close-candidateB.png" -crop 260x260+510+230 +repage "$ASSETS_DIR/crop-z4-throat-1x-candB.png"
convert "$ASSETS_DIR/crop-z4-throat-1x-candA.png" -scale 300% "$ASSETS_DIR/crop-z4-throat-3x-candA.png"
convert "$ASSETS_DIR/crop-z4-throat-1x-candB.png" -scale 300% "$ASSETS_DIR/crop-z4-throat-3x-candB.png"

# Crop 5: Extreme Close Zoom 16.0x (Turnout Zone 2)
convert "$ASSETS_DIR/z2-turnout-zoom16-candidateA.png" -crop 280x280+500+220 +repage "$ASSETS_DIR/crop-z2-zoom16-1x-candA.png"
convert "$ASSETS_DIR/z2-turnout-zoom16-candidateB.png" -crop 280x280+500+220 +repage "$ASSETS_DIR/crop-z2-zoom16-1x-candB.png"
convert "$ASSETS_DIR/crop-z2-zoom16-1x-candA.png" -scale 300% "$ASSETS_DIR/crop-z2-zoom16-3x-candA.png"
convert "$ASSETS_DIR/crop-z2-zoom16-1x-candB.png" -scale 300% "$ASSETS_DIR/crop-z2-zoom16-3x-candB.png"

echo "=== 5. Capturing Updated 7-Metric Telemetry Dock Screenshot & LOD Diff Stats ==="
jump_and_capture "candidateB" "tactical" "station_throat" 8.0 "$ASSETS_DIR/ui-performance-telemetry-dock-canvas.png" "false"

echo "=== 6. Empirical Camera Frustum & LOD Transition Pixel Diff ==="
playwright-cli eval "JSON.stringify(window.__M21_LAB__.getSnapshot().liveWebGL)"
echo "Candidate B LOD Transition (4.4 ribbon vs 4.6 3D) mean grayscale diff:"
convert "$ASSETS_DIR/hybrid-lod-zoom4.4-ribbon.png" "$ASSETS_DIR/hybrid-lod-zoom4.6-3d.png" -compose difference -composite -colorspace gray -format "mean=%[fx:mean*100]%% max=%[fx:maxima*100]%%\n" info:
echo "Candidate B Threshold Diff Mask (>8% luminance change) active pixel fraction:"
convert "$ASSETS_DIR/hybrid-lod-diff-mask.png" -format "changed_pixels_pct=%[fx:mean*100]%%\n" info:
echo "Candidate A Normal Camera Zoom (4.4 vs 4.6) mean grayscale diff:"
convert "$ASSETS_DIR/candA-lod-zoom4.4.png" "$ASSETS_DIR/candA-lod-zoom4.6.png" -compose difference -composite -colorspace gray -format "mean=%[fx:mean*100]%% max=%[fx:maxima*100]%%\n" info:
convert "$ASSETS_DIR/candA-lod-zoom4.4.png" "$ASSETS_DIR/candA-lod-zoom4.6.png" -compose difference -composite -colorspace gray -threshold 8% -format "candA_changed_pixels_pct=%[fx:mean*100]%%\n" info:
echo "Same-Zoom (4.6) Representation Delta (Candidate A vs Candidate B at zoom 4.6):"
convert "$ASSETS_DIR/candA-lod-zoom4.6.png" "$ASSETS_DIR/hybrid-lod-zoom4.6-3d.png" -compose difference -composite -colorspace gray -format "same_zoom_mean=%[fx:mean*100]%%\n" info:
convert "$ASSETS_DIR/candA-lod-zoom4.6.png" "$ASSETS_DIR/hybrid-lod-zoom4.6-3d.png" -compose difference -composite -colorspace gray -threshold 8% -format "same_zoom_changed_pixels_pct=%[fx:mean*100]%%\n" info:

echo "=== All comparison screenshots and crops captured successfully! ==="

