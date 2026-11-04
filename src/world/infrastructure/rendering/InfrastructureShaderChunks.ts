import * as THREE from 'three';
import { MapStyleTheme } from '../../../types/MapFeature';
import { RAILWAY_DIMENSION_SPEC } from '../railways/RailwayTopology';

export interface ProceduralRailwayMaterialControl {
  updateThemeColors: (newTheme: MapStyleTheme) => void;
  updateZoom: (zoom: number) => void;
}

/**
 * Configures a `THREE.MeshStandardMaterial` with the validated procedural sleeper shader:
 * - Derivative-based (`fwidth`) antialiased sleeper pulse along continuous arc-length `u`.
 * - Smooth switch-zone host-bed clipping (`vSwitchAttr.x` vs `uHostClearanceHalfW`).
 * - Nyquist contrast attenuation at far overview zoom (`< 2.4 px` per sleeper period).
 * - Subtle close-zoom 3D timber bevel highlights and theme-reactive color uniforms.
 */
export function configureProceduralSleeperMaterial(
  material: THREE.MeshStandardMaterial,
  theme: MapStyleTheme,
  initialZoom: number
): ProceduralRailwayMaterialControl {
  const uniforms = {
    uSleeperColor: { value: new THREE.Color(theme.railwayColors.sleeper || '#64748b') },
    uBallastColor: { value: new THREE.Color(theme.railwayColors.ballast) },
    uSleeperPeriod: { value: RAILWAY_DIMENSION_SPEC.visualSleeperPeriodMeters },
    uSleeperLength: { value: RAILWAY_DIMENSION_SPEC.visualSleeperLengthMeters },
    uHostClearanceHalfW: { value: RAILWAY_DIMENSION_SPEC.hostSleeperClearanceHalfWidthMeters },
    uCameraZoom: { value: initialZoom },
  };

  material.userData.railwayUniforms = uniforms;
  material.customProgramCacheKey = () => 'railway-prototype-procedural-sleepers-v1';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aSwitchAttr;
varying vec2 vTrackUv;
varying vec2 vSwitchAttr;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vTrackUv = uv;
vSwitchAttr = aSwitchAttr;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uSleeperColor;
uniform vec3 uBallastColor;
uniform float uSleeperPeriod;
uniform float uSleeperLength;
uniform float uHostClearanceHalfW;
uniform float uCameraZoom;
varying vec2 vTrackUv;
varying vec2 vSwitchAttr;`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
// 1. Interpolated per-vertex clearance attribute (vSwitchAttr.x):
//    vSwitchAttr.x is evaluated on the CPU at ribbon vertices via HostTrackSpatialIndex queries.
//    Between vertices (~1.8m densified spacing), this scalar distance is linearly interpolated
//    across ribbon triangles. Note: This is NOT an exact per-fragment Euclidean distance to curved
//    or angled host tracks. Linear interpolation across triangles introduces sagitta curvature error
//    δ ≈ L²/(8R) (e.g. ~2.7mm at R=150m with L=1.8m, up to 83mm if un-densified at L=10m) and
//    causes diagonal clipping skew along the host track sleeper boundary.
float hostBedClip = smoothstep(uHostClearanceHalfW - 0.04, uHostClearanceHalfW + 0.04, vSwitchAttr.x);
if (hostBedClip < 0.05) {
  discard;
}
float uCoord = vTrackUv.x;
float vCoord = vTrackUv.y;
// Screen-space derivative clamped by camera zoom so tilted views do not blur asymmetrically
float rawDu = fwidth(uCoord);
float zoomDu = 1.15 / max(uCameraZoom, 0.15);
float effectiveDu = min(max(rawDu, 0.008), zoomDu * 1.35);
float halfTie = uSleeperLength * 0.5;
float localU = mod(uCoord, uSleeperPeriod) - (uSleeperPeriod * 0.5);
float distFromTieCenter = abs(localU);
// Analytic box-filtered longitudinal tie pulse
float filterHalfW = max(effectiveDu * 0.85, 0.015);
float tiePulse = 1.0 - smoothstep(halfTie - filterHalfW, halfTie + filterHalfW, distFromTieCenter);
// Lateral tie ends filtering
float dv = max(fwidth(vCoord), 0.01);
float tieHalfWidth = 1.24;
float latMask = (1.0 - smoothstep(tieHalfWidth - dv, tieHalfWidth, abs(vCoord))) * hostBedClip;
// Discard inter-tie ballast gap pixels so Sub-Layer 1 (Ballast) shows through cleanly
if (tiePulse * latMask < 0.08) {
  discard;
}
// Nyquist contrast attenuation at far overview zoom (< 2.4 px per sleeper period)
float pixelsPerPeriod = uSleeperPeriod / max(effectiveDu, 1e-4);
float nyquistContrast = smoothstep(1.45, 3.2, pixelsPerPeriod);
// Subtle close-zoom 3D bevel/timber relief along tie edges and rail seat
float edgeDist = halfTie - distFromTieCenter;
float closeZoomFactor = smoothstep(2.5, 5.5, uCameraZoom);
float bevelHighlight = smoothstep(0.06, 0.0, abs(edgeDist - 0.03)) * 0.08 * closeZoomFactor;
float bevelBezel = (1.0 - smoothstep(0.0, 0.045, edgeDist)) * 0.18 * closeZoomFactor;
vec3 tieCol = uSleeperColor * (1.0 + bevelHighlight - bevelBezel);
float finalAlpha = clamp(tiePulse * latMask * nyquistContrast, 0.0, 1.0);
diffuseColor.rgb = mix(uBallastColor, tieCol, finalAlpha);`
      );
  };

  return {
    updateThemeColors: (newTheme: MapStyleTheme) => {
      uniforms.uSleeperColor.value.set(newTheme.railwayColors.sleeper || '#64748b');
      uniforms.uBallastColor.value.set(newTheme.railwayColors.ballast);
    },
    updateZoom: (zoom: number) => {
      uniforms.uCameraZoom.value = zoom;
    },
  };
}

/**
 * Configures a `THREE.MeshStandardMaterial` with the validated procedural rail shader:
 * - Switch-blade taper (`vSwitchAttr.y` in `[0.25, 1.0]`) narrowing the diverging inner rail at turnout toes.
 * - Derivative-based (`fwidth`) lateral edge antialiasing.
 * - Energy-conserving sub-pixel luminance normalization at medium/far zoom so dense station throats
 *   never bloom into a bright white band.
 */
export function configureProceduralRailMaterial(
  material: THREE.MeshStandardMaterial,
  theme: MapStyleTheme,
  initialZoom: number
): ProceduralRailwayMaterialControl {
  const uniforms = {
    uRailColor: { value: new THREE.Color(theme.railwayColors.rail) },
    uBallastColor: { value: new THREE.Color(theme.railwayColors.ballast) },
    uRailHalfWidth: { value: RAILWAY_DIMENSION_SPEC.visualRailWidthMeters * 0.5 },
    uCameraZoom: { value: initialZoom },
  };

  material.userData.railwayUniforms = uniforms;
  material.customProgramCacheKey = () => 'railway-prototype-procedural-rails-v1';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aSwitchAttr;
varying vec2 vTrackUv;
varying vec2 vSwitchAttr;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vTrackUv = uv;
vSwitchAttr = aSwitchAttr;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uRailColor;
uniform vec3 uBallastColor;
uniform float uRailHalfWidth;
uniform float uCameraZoom;
varying vec2 vTrackUv;
varying vec2 vSwitchAttr;`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float vCoord = vTrackUv.y;
// Switch-blade taper factor in [0.25, 1.0] narrows the diverging inner rail at the switch toe
float taper = clamp(vSwitchAttr.y, 0.25, 1.0);
float effectiveHalfW = uRailHalfWidth * taper;
float dv = max(fwidth(vCoord), 0.006);
float railEdgeAlpha = 1.0 - smoothstep(effectiveHalfW - dv * 0.65, effectiveHalfW + dv * 0.65, abs(vCoord));
if (railEdgeAlpha < 0.05) {
  discard;
}
// Crown profile highlight along the center of the rail head at close zoom
float normV = abs(vCoord) / max(effectiveHalfW, 1e-3);
float closeZoomFactor = smoothstep(2.5, 6.0, uCameraZoom);
float crownShade = (1.0 - 0.16 * normV * normV) * closeZoomFactor + (1.0 - closeZoomFactor);
// Energy-conserving sub-pixel luminance normalization so 12 rails in a station throat
// never bloom into a solid white band at medium/overview zoom
float railWidthPx = (effectiveHalfW * 2.0) * uCameraZoom;
float energyFactor = clamp(pow(railWidthPx / 1.15, 0.42), 0.42, 1.0);
vec3 shadedRail = uRailColor * crownShade;
diffuseColor.rgb = mix(uBallastColor, shadedRail, clamp(energyFactor * railEdgeAlpha, 0.0, 1.0));`
      );
  };

  return {
    updateThemeColors: (newTheme: MapStyleTheme) => {
      uniforms.uRailColor.value.set(newTheme.railwayColors.rail);
      uniforms.uBallastColor.value.set(newTheme.railwayColors.ballast);
    },
    updateZoom: (zoom: number) => {
      uniforms.uCameraZoom.value = zoom;
    },
  };
}
