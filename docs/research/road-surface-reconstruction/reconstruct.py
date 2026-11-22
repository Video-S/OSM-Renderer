#!/usr/bin/env python3
"""
Independent Road-Surface and Junction Reconstruction Algorithm from OpenStreetMap.

Mathematical Formulation:
1. Reference Curves & Asymmetric Cross-Section Profiles:
   Each drivable OSM way segment e is represented by a piecewise-linear reference curve
   gamma_e(s) parameterized by arc length s in [0, L_e] in a metric projected CRS (EPSG:28992).
   At each station s, the physical road surface is bounded by independently defined left and
   right lateral offsets (w_L(s), w_R(s)) >= 0 measured along the unit left normal n_e(s):
       partial_L_e(s) = gamma_e(s) + w_L(s) * n_e(s)
       partial_R_e(s) = gamma_e(s) - w_R(s) * n_e(s)

2. Hierarchical Evidence Model for Width & Lateral Placement:
   - Tier 1: Explicit physical width tags (`width:carriageway`, `width`, `est_width`).
   - Tier 2: Explicit directional lane counts (`lanes`, `lanes:forward`, `lanes:backward`,
     `turn:lanes`, `turn:lanes:forward`, `turn:lanes:backward`) combined with class-conditioned
     per-lane widths and explicit on-road cycleway lane offsets (`cycleway`, `cycleway:left`,
     `cycleway:right`, `cycleway:both` = `lane`).
   - Tier 3: Topological collinear continuation propagation across degree-2 and Y-split nodes
     when untagged segments connect directly to lane-tagged segments of the same highway class.
   - Tier 4: Conservative highway-class priors when no explicit width, lane, or continuation
     evidence exists.
   - Asymmetric Placement (`placement`, `placement:start`, `placement:end`):
     Parses `left_of:k`, `middle_of:k`, `right_of:k` (1-indexed from left in travel direction)
     so that the OSM centerline lies on the specified lane line or lane center rather than the
     geometric center of the carriageway. Also infers asymmetric taper offsets at Y-splits where
     `turn:lanes` specifies a branching turn lane while the collinear main line continues.

3. General Junction Surface Construction:
   At each topological node v with degree >= 2:
   - Each incident half-edge h_k is oriented outward from v along arc length s in [0, L_k],
     with outward-left offset w_L^(k)(s) and outward-right offset w_R^(k)(s).
   - Half-edges are sorted counter-clockwise by outward tangent angle theta_k.
   - For each angularly adjacent pair (h_k, h_{k+1}) with turn angle Delta_theta_k in (22 deg, 162 deg):
     We construct the outward-left boundary curve C_L^(k) of h_k and outward-right boundary
     curve C_R^(k+1) of h_{k+1}, trimmed to a localized junction zone s <= min(0.45 * L_k, 9.0 m).
     When C_L^(k) and C_R^(k+1) intersect at p_int, we construct a controlled smooth quadratic
     Bezier curb transition tangent to both boundary segments.
   - Taper Flare Bridging (`placement=transition`):
     When two carriageways split or merge at an acute angle and at least one branch carries
     explicit transition/turn-lane evidence (`placement=transition` or `turn:lanes` split),
     the triangular gore between their inner boundaries is bridged conservatively without filling
     legitimate splitter islands or medians.

4. Explicit Constraint Verification & Fallback Hierarchy:
   Every constructed corridor and junction polygon is checked for:
   - Non-empty, finite coordinates.
   - Simple, valid polygon geometry (`is_valid`, zero self-intersections).
   - Bounded area expansion relative to constituent corridors.
   - Non-intrusion into preserved physical islands.
   Any violation triggers a deterministic, recorded fallback to conservative buffering.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from pyproj import Transformer
from shapely.geometry import (
    LineString,
    MultiPolygon,
    Point,
    Polygon,
    box,
    mapping,
)
from shapely.ops import unary_union

# ---------------------------------------------------------------------------
# Documented Mathematical & Physical Constants (All units in meters / degrees)
# ---------------------------------------------------------------------------

TARGET_CRS = "EPSG:28992"
SOURCE_CRS = "EPSG:4326"

VEHICLE_OSM_CLASSES = {
    "motorway",
    "motorway_link",
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "unclassified",
    "residential",
    "service",
    "living_street",
}

# Exact Null Baseline constants from bgt_compare.py
BASELINE_DEFAULT_WIDTH_M: Dict[str, float] = {
    "motorway": 11.0,
    "motorway_link": 4.0,
    "trunk": 8.0,
    "trunk_link": 4.0,
    "primary": 7.0,
    "primary_link": 4.0,
    "secondary": 6.5,
    "secondary_link": 4.0,
    "tertiary": 6.0,
    "tertiary_link": 4.0,
    "residential": 5.3,
    "unclassified": 5.3,
    "service": 3.5,
    "living_street": 5.0,
}
BASELINE_LANE_WIDTH_M: float = 3.2

# Class-conditioned single-lane width priors (meters per lane) for the new model
LANE_WIDTH_BY_CLASS_M: Dict[str, float] = {
    "motorway": 3.50,
    "motorway_link": 3.40,
    "trunk": 3.35,
    "trunk_link": 3.25,
    "primary": 3.25,
    "primary_link": 3.20,
    "secondary": 3.25,
    "secondary_link": 3.15,
    "tertiary": 3.20,
    "tertiary_link": 3.05,
    "unclassified": 3.00,
    "residential": 2.90,
    "living_street": 2.60,
    "service": 2.75,
}

# Conservative fallback widths when neither explicit width, lane count, nor continuation is known
FALLBACK_TWO_WAY_WIDTH_M: Dict[str, float] = {
    "motorway": 11.0,
    "motorway_link": 4.5,
    "trunk": 8.0,
    "trunk_link": 4.5,
    "primary": 7.0,
    "primary_link": 4.5,
    "secondary": 6.5,
    "secondary_link": 4.5,
    "tertiary": 6.0,
    "tertiary_link": 4.2,
    "unclassified": 5.3,
    "residential": 5.3,
    "living_street": 4.6,
    "service": 3.5,
}

# One-way untagged fallback widths:
# Collector/arterial one-ways in Dutch cities frequently carry a wide single carriageway or
# unmarked advisory lanes, whereas residential/service one-ways are genuinely narrower.
FALLBACK_ONE_WAY_WIDTH_M: Dict[str, float] = {
    "motorway": 7.5,
    "motorway_link": 4.2,
    "trunk": 6.8,
    "trunk_link": 4.2,
    "primary": 6.5,
    "primary_link": 4.2,
    "secondary": 6.2,
    "secondary_link": 4.2,
    "tertiary": 5.8,
    "tertiary_link": 4.0,
    "unclassified": 4.4,
    "residential": 4.1,
    "living_street": 3.8,
    "service": 3.3,
}

# On-road cycleway lane width (`cycleway*=lane`) added to carriageway side
CYCLEWAY_LANE_WIDTH_M: float = 1.55

# Physical bounds on reconstructed road width (meters)
MIN_TOTAL_WIDTH_M: float = 1.80
MAX_TOTAL_WIDTH_M: float = 35.00

# Geometric tolerances
NODE_SNAP_TOLERANCE_M: float = 0.05  # 5 cm coordinate quantization for node matching
COLLINEAR_CONTINUATION_MAX_DEG: float = 28.0  # Max deflection angle for collinear lane propagation
JUNCTION_MIN_TURN_DEG: float = 22.0  # Minimum interior angle between adjacent arms for curb fillet
JUNCTION_MAX_TURN_DEG: float = 162.0  # Maximum interior angle before arms are treated as near-collinear
JUNCTION_ARM_SEARCH_MAX_M: float = 9.0  # Max distance from junction node for curb corner intersection
JUNCTION_FILLET_MAX_AREA_M2: float = 18.0  # Max area of a single corner curb fillet polygon
TRANSITION_GORE_MAX_LENGTH_M: float = 18.0  # Max longitudinal reach for placement=transition gore bridging
TRANSITION_GORE_MAX_AREA_M2: float = 35.0  # Max area of a transition flare triangle
PRESERVED_ISLAND_MIN_AREA_M2: float = 8.0  # Enclosed loops >= 8 m^2 without transition evidence are preserved islands


# ---------------------------------------------------------------------------
# Data Structures
# ---------------------------------------------------------------------------


@dataclass
class StationOffset:
    """Lateral left and right offsets (in meters) at arc-length station s."""

    s: float
    width_left: float
    width_right: float

    @property
    def total_width(self) -> float:
        return self.width_left + self.width_right


@dataclass
class RoadEdgeRecord:
    """Explicit representation of a reconstructed road segment and its provenance."""

    osm_id: str
    highway: str
    is_oneway: bool
    length_m: float
    coords_rd: List[Tuple[float, float]]
    station_offsets: List[StationOffset]
    width_source: str
    placement_source: str
    inferred_lanes: float
    lane_width_m: float
    cycleway_left_m: float
    cycleway_right_m: float
    has_transition_tag: bool
    turn_lanes_tokens: List[str]
    assumptions: List[str] = field(default_factory=list)
    uncertainty_m: float = 1.0
    left_boundary_coords: List[Tuple[float, float]] = field(default_factory=list)
    right_boundary_coords: List[Tuple[float, float]] = field(default_factory=list)
    polygon: Optional[Polygon | MultiPolygon] = None
    fallback_used: Optional[str] = None


@dataclass
class JunctionRecord:
    """Explicit representation of a reconstructed junction surface and its constraints."""

    node_id: str
    node_xy: Tuple[float, float]
    degree: int
    incident_edges: List[str]
    fillet_count: int
    transition_flare_count: int
    polygon: Optional[Polygon | MultiPolygon]
    fallback_reasons: List[str] = field(default_factory=list)


@dataclass
class ReconstructionDiagnostics:
    """Summary diagnostics and explicit audit trail for a reconstructed site."""

    site_id: str
    mode: str
    edge_count: int
    junction_count: int
    width_source_counts: Dict[str, int]
    asymmetric_edge_count: int
    fillet_count: int
    transition_flare_count: int
    preserved_island_count: int
    fallback_count: int
    fallback_reasons: List[str]


@dataclass
class ReconstructionResult:
    """Complete output of road-surface reconstruction for a site."""

    site_id: str
    mode: str
    crs: str
    surface_polygon: Polygon | MultiPolygon
    corridor_union: Polygon | MultiPolygon
    junction_union: Polygon | MultiPolygon
    edges: List[RoadEdgeRecord]
    junctions: List[JunctionRecord]
    diagnostics: ReconstructionDiagnostics


# ---------------------------------------------------------------------------
# Tag Parsing & Filtering Helpers
# ---------------------------------------------------------------------------


def is_drivable_ground_road(props: Dict[str, Any], mode: str = "full_reconstruction") -> bool:
    """Return True if an OSM feature represents an at-grade vehicular carriageway."""
    highway = props.get("highway")
    if highway not in VEHICLE_OSM_CLASSES:
        return False
    if props.get("area") == "yes":
        return False
    if str(props.get("layer", "0")) not in ("0", "0.0"):
        return False
    if props.get("bridge") in ("yes", "viaduct") or props.get("tunnel") in (
        "yes",
        "building_passage",
    ):
        return False
    return True


def baseline_inferred_width(props: Dict[str, Any]) -> Tuple[float, str]:
    """Exact width inference rule from bgt_compare.py for baseline_null reproduction."""
    raw = props.get("width")
    if raw is not None:
        try:
            x = float(str(raw).strip().lower().replace("m", "").replace(",", "."))
            if 1.5 <= x <= 40.0:
                return x, "explicit_width"
        except (ValueError, TypeError):
            pass
    lanes = props.get("lanes")
    if lanes is not None:
        try:
            n = int(str(lanes))
            if 1 <= n <= 8:
                return n * BASELINE_LANE_WIDTH_M, "lane_count_times_3.2m"
        except (ValueError, TypeError):
            pass
    return BASELINE_DEFAULT_WIDTH_M[props["highway"]], "unobserved_class_prior"


def parse_explicit_width_m(raw: Any) -> Optional[float]:
    """Parse an OSM width string (e.g. '6.5', '6.5 m', '6,5') into meters if valid."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        val = float(raw)
        return val if MIN_TOTAL_WIDTH_M <= val <= MAX_TOTAL_WIDTH_M else None
    text = str(raw).strip().lower().replace(",", ".")
    match = re.search(r"^\s*([0-9]+(?:\.[0-9]+)?)\s*(m|meter|meters|metres)?\s*$", text)
    if not match:
        return None
    val = float(match.group(1))
    return val if MIN_TOTAL_WIDTH_M <= val <= MAX_TOTAL_WIDTH_M else None


def parse_positive_float(raw: Any) -> Optional[float]:
    """Parse a positive float from an OSM tag value."""
    if raw is None:
        return None
    try:
        val = float(str(raw).strip().replace(",", "."))
        return val if val > 0 else None
    except ValueError:
        return None


def parse_turn_lane_tokens(props: Dict[str, Any], is_oneway: bool) -> Tuple[List[str], List[str]]:
    """
    Return (forward_tokens, backward_tokens) from `turn:lanes*` tags.
    Each pipe-separated token represents one physical lane at the tagged section.
    """
    fwd_raw = (
        props.get("turn:lanes")
        if is_oneway
        else (props.get("turn:lanes:forward") or props.get("turn:lanes"))
    )
    bwd_raw = None if is_oneway else props.get("turn:lanes:backward")

    def split_lanes(val: Any) -> List[str]:
        if not val or not isinstance(val, str) or "|" not in val:
            return []
        return [tok.strip() for tok in val.split("|")]

    return split_lanes(fwd_raw), split_lanes(bwd_raw)


def parse_cycleway_lane_offsets(
    props: Dict[str, Any], is_oneway: bool
) -> Tuple[float, float, List[str]]:
    """
    Compute additional lateral widths (left_m, right_m) for on-road cycle lanes (`cycleway*=lane`).
    Separately mapped cycle tracks (`cycleway*=track` or `separate`) do not widen the carriageway.
    """
    left_m = 0.0
    right_m = 0.0
    notes: List[str] = []

    cw_both = props.get("cycleway:both") or props.get("cycleway")
    cw_left = props.get("cycleway:left")
    cw_right = props.get("cycleway:right")

    if cw_both in ("lane", "shared_lane"):
        w = CYCLEWAY_LANE_WIDTH_M if cw_both == "lane" else 0.75
        if is_oneway and cw_left is None and cw_right is None and props.get("oneway:bicycle") == "no":
            left_m = w
            right_m = w
            notes.append(f"cycleway={cw_both}+contraflow({w:.2f}m both)")
        elif is_oneway and cw_left is None and cw_right is None:
            right_m = w
            notes.append(f"cycleway={cw_both} oneway({w:.2f}m right)")
        else:
            left_m = w
            right_m = w
            notes.append(f"cycleway={cw_both}({w:.2f}m both)")

    if cw_left in ("lane", "shared_lane", "opposite_lane"):
        w = parse_explicit_width_m(props.get("cycleway:left:width")) or (
            CYCLEWAY_LANE_WIDTH_M if cw_left != "shared_lane" else 0.75
        )
        left_m = max(left_m, w)
        notes.append(f"cycleway:left={cw_left}({w:.2f}m)")

    if cw_right in ("lane", "shared_lane", "opposite_lane"):
        w = parse_explicit_width_m(props.get("cycleway:right:width")) or (
            CYCLEWAY_LANE_WIDTH_M if cw_right != "shared_lane" else 0.75
        )
        right_m = max(right_m, w)
        notes.append(f"cycleway:right={cw_right}({w:.2f}m)")

    return left_m, right_m, notes


def parse_placement_spec(
    spec: Optional[str],
    total_lanes: float,
    lane_width_m: float,
) -> Optional[Tuple[float, float, str]]:
    """
    Parse an OSM `placement` value (`left_of:k`, `middle_of:k`, `right_of:k`, 1-indexed from left)
    into (vehicular_left_m, vehicular_right_m, description).
    Returns None if spec is None, `transition`, or unparseable.
    """
    if not spec or not isinstance(spec, str):
        return None
    spec = spec.strip().lower()
    if spec == "transition":
        return None
    match = re.match(r"^(left_of|middle_of|right_of):([0-9]+)$", spec)
    if not match:
        return None
    rel, idx_str = match.group(1), match.group(2)
    k = int(idx_str)
    if k < 1 or k > max(int(math.ceil(total_lanes)) + 1, 2):
        return None

    if rel == "left_of":
        lanes_to_left = float(k - 1)
    elif rel == "middle_of":
        lanes_to_left = float(k) - 0.5
    else:  # right_of
        lanes_to_left = float(k)

    lanes_to_left = max(0.0, min(total_lanes, lanes_to_left))
    lanes_to_right = max(0.0, total_lanes - lanes_to_left)
    return (
        lanes_to_left * lane_width_m,
        lanes_to_right * lane_width_m,
        f"placement={spec}({lanes_to_left:.1f}L/{lanes_to_right:.1f}R lanes)",
    )


# ---------------------------------------------------------------------------
# Linear Algebra & Polyline Geometry Helpers
# ---------------------------------------------------------------------------


def dedupe_consecutive_pts(
    pts: List[Tuple[float, float]], eps: float = 1e-4
) -> List[Tuple[float, float]]:
    """Remove consecutive duplicate vertices within eps meters."""
    if not pts:
        return []
    out = [pts[0]]
    for p in pts[1:]:
        if math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) > eps:
            out.append(p)
    return out


def snap_node_key(pt: Tuple[float, float], tol: float = NODE_SNAP_TOLERANCE_M) -> Tuple[int, int]:
    """Quantize a 2D point in meters to a deterministic topological node key."""
    return (int(round(pt[0] / tol)), int(round(pt[1] / tol)))


def polyline_arc_lengths(pts: List[Tuple[float, float]]) -> List[float]:
    """Compute cumulative arc length s at each vertex of a polyline."""
    s = [0.0]
    for i in range(1, len(pts)):
        ds = math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
        s.append(s[-1] + ds)
    return s


def unit_vector(dx: float, dy: float) -> Tuple[float, float]:
    """Return normalized 2D vector (ux, uy) or (1.0, 0.0) if degenerate."""
    norm = math.hypot(dx, dy)
    if norm < 1e-9:
        return (1.0, 0.0)
    return (dx / norm, dy / norm)


def vertex_unit_normals(pts: List[Tuple[float, float]]) -> List[Tuple[float, float]]:
    """
    Compute mitered unit left normals at each vertex of a 2D polyline.
    Uses miter limit 2.0 (matching baseline miter behavior) to prevent spikes at sharp bends.
    """
    n_pts = len(pts)
    if n_pts < 2:
        return [(0.0, 1.0)] * n_pts

    seg_normals: List[Tuple[float, float]] = []
    for i in range(n_pts - 1):
        tx, ty = unit_vector(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
        seg_normals.append((-ty, tx))

    vertex_normals: List[Tuple[float, float]] = [seg_normals[0]]
    for i in range(1, n_pts - 1):
        n0x, n0y = seg_normals[i - 1]
        n1x, n1y = seg_normals[i]
        bx, by = n0x + n1x, n0y + n1y
        bnorm = math.hypot(bx, by)
        if bnorm < 1e-6:
            vertex_normals.append(seg_normals[i])
        else:
            bx /= bnorm
            by /= bnorm
            dot = max(0.35, bx * n0x + by * n0y)
            miter_scale = min(2.0, 1.0 / dot)
            vertex_normals.append((bx * miter_scale, by * miter_scale))
    vertex_normals.append(seg_normals[-1])
    return vertex_normals


def angle_diff_ccw(angle_from: float, angle_to: float) -> float:
    """Return counter-clockwise angle from `angle_from` to `angle_to` in (0, 2*pi]."""
    diff = (angle_to - angle_from) % (2.0 * math.pi)
    if diff <= 1e-9:
        diff += 2.0 * math.pi
    return diff


def smallest_angle_diff_deg(a1: float, a2: float) -> float:
    """Return unsigned smallest angle difference in degrees in [0, 180]."""
    d = abs((a1 - a2 + math.pi) % (2.0 * math.pi) - math.pi)
    return math.degrees(d)


# ---------------------------------------------------------------------------
# Stage 1 & 2: Road Edge Cross-Section & Topological Continuation Inference
# ---------------------------------------------------------------------------


def build_initial_edge_record(
    osm_id: str,
    props: Dict[str, Any],
    coords_rd: List[Tuple[float, float]],
    mode: str,
) -> RoadEdgeRecord:
    """
    Construct the initial cross-section width and placement estimate from local OSM tags.
    In `baseline_null` or `junction_only` mode, uses the exact constant-width baseline rules
    from `bgt_compare.py`.
    In `width_asymmetric_only` or `full_reconstruction` mode, uses hierarchical OSM evidence.
    """
    highway = str(props.get("highway", "road"))
    is_oneway = str(props.get("oneway", "")).lower() in ("yes", "1", "true", "-1")
    if str(props.get("oneway", "")) == "-1" and mode not in ("baseline_null", "junction_only"):
        coords_rd = list(reversed(coords_rd))
        is_oneway = True

    s_vals = polyline_arc_lengths(coords_rd)
    total_len = s_vals[-1]

    # Mode 1: Exact Null Baseline or Junction-Only Ablation
    if mode in ("baseline_null", "junction_only"):
        w_total, method = baseline_inferred_width(props)
        half = 0.5 * w_total
        offsets = [StationOffset(s=s, width_left=half, width_right=half) for s in s_vals]
        normals = vertex_unit_normals(coords_rd)
        left_pts = [(x + nx * half, y + ny * half) for (x, y), (nx, ny) in zip(coords_rd, normals)]
        right_pts = [(x - nx * half, y - ny * half) for (x, y), (nx, ny) in zip(coords_rd, normals)]
        return RoadEdgeRecord(
            osm_id=osm_id,
            highway=highway,
            is_oneway=is_oneway,
            length_m=total_len,
            coords_rd=coords_rd,
            station_offsets=offsets,
            width_source=method,
            placement_source="symmetric_centerline",
            inferred_lanes=round(w_total / BASELINE_LANE_WIDTH_M, 1),
            lane_width_m=BASELINE_LANE_WIDTH_M,
            cycleway_left_m=0.0,
            cycleway_right_m=0.0,
            has_transition_tag=False,
            turn_lanes_tokens=[],
            assumptions=[f"baseline_{method}={w_total:.2f}m"],
            uncertainty_m=1.5,
            left_boundary_coords=left_pts,
            right_boundary_coords=right_pts,
        )

    # Mode 2: Hierarchical OSM Evidence (Width + Asymmetric Placement)
    lane_w = LANE_WIDTH_BY_CLASS_M.get(highway, 3.0)
    cw_left, cw_right, cw_notes = parse_cycleway_lane_offsets(props, is_oneway)
    fwd_turns, bwd_turns = parse_turn_lane_tokens(props, is_oneway)
    assumptions: List[str] = list(cw_notes)

    explicit_w = (
        parse_explicit_width_m(props.get("width:carriageway"))
        or parse_explicit_width_m(props.get("width"))
        or parse_explicit_width_m(props.get("est_width"))
    )

    lanes_tag = parse_positive_float(props.get("lanes"))
    lanes_fwd = parse_positive_float(props.get("lanes:forward"))
    lanes_bwd = parse_positive_float(props.get("lanes:backward"))

    turn_lane_count = float(len(fwd_turns) + len(bwd_turns))
    tagged_lane_sum = (lanes_fwd or 0.0) + (lanes_bwd or 0.0)
    has_merge_lane = any("merge_to_" in tok for tok in fwd_turns)

    width_source = "class_fallback"
    uncertainty_m = 1.25

    if explicit_w is not None:
        vehicular_w = max(MIN_TOTAL_WIDTH_M, explicit_w - cw_left - cw_right)
        inferred_lanes = max(1.0, round(vehicular_w / lane_w, 1))
        width_source = "explicit_width_tag"
        uncertainty_m = 0.35
        assumptions.append(f"explicit_width={explicit_w:.2f}m")
    elif has_merge_lane and lanes_tag is not None:
        # When `turn:lanes` marks a merging lane (e.g. `merge_to_right||` with `lanes=2`),
        # the segment starts at `turn_lane_count` lanes and tapers down to `lanes_tag` lanes.
        inferred_lanes = lanes_tag
        vehicular_w = lanes_tag * lane_w
        width_source = "explicit_lanes_tag"
        uncertainty_m = 0.55
        assumptions.append(f"merge_taper_lanes={int(turn_lane_count)}->{int(lanes_tag)}")
    elif turn_lane_count > 0 or lanes_tag is not None or tagged_lane_sum > 0:
        candidates = [
            c for c in (turn_lane_count, lanes_tag, tagged_lane_sum) if c is not None and c > 0
        ]
        inferred_lanes = max(candidates)
        vehicular_w = inferred_lanes * lane_w
        if turn_lane_count > (lanes_tag or 0.0):
            width_source = "explicit_turn_lanes"
            assumptions.append(f"turn_lanes_count={int(turn_lane_count)}")
        else:
            width_source = "explicit_lanes_tag"
            assumptions.append(f"lanes={inferred_lanes:g}*{lane_w:.2f}m")
        uncertainty_m = 0.55
    else:
        if is_oneway:
            vehicular_w = FALLBACK_ONE_WAY_WIDTH_M.get(highway, 4.5)
            inferred_lanes = round(vehicular_w / lane_w, 2)
            assumptions.append(f"fallback_oneway_{highway}={vehicular_w:.2f}m")
        else:
            vehicular_w = FALLBACK_TWO_WAY_WIDTH_M.get(highway, 5.3)
            inferred_lanes = round(vehicular_w / lane_w, 2)
            assumptions.append(f"fallback_twoway_{highway}={vehicular_w:.2f}m")

    placement_mid = props.get("placement") or props.get("placement:forward")
    placement_start = props.get("placement:start") or placement_mid
    placement_end = props.get("placement:end") or placement_mid
    has_transition = any(
        str(p).strip().lower() == "transition"
        for p in (placement_mid, placement_start, placement_end)
        if p is not None
    )

    if not is_oneway and lanes_fwd and lanes_bwd and (lanes_fwd + lanes_bwd > 0):
        default_veh_left = (lanes_bwd / (lanes_fwd + lanes_bwd)) * vehicular_w
        default_veh_right = (lanes_fwd / (lanes_fwd + lanes_bwd)) * vehicular_w
        placement_source = "directional_lane_split"
    else:
        default_veh_left = 0.5 * vehicular_w
        default_veh_right = 0.5 * vehicular_w
        placement_source = "symmetric_centerline"

    eff_lane_w = vehicular_w / max(inferred_lanes, 1.0)
    start_parsed = parse_placement_spec(placement_start, inferred_lanes, eff_lane_w)
    end_parsed = parse_placement_spec(placement_end, inferred_lanes, eff_lane_w)

    if start_parsed and not end_parsed:
        end_parsed = start_parsed
    elif end_parsed and not start_parsed:
        start_parsed = end_parsed

    if start_parsed and end_parsed:
        veh_l0, veh_r0, desc0 = start_parsed
        veh_l1, veh_r1, desc1 = end_parsed
        placement_source = "explicit_placement_tag"
        assumptions.append(desc0 if desc0 == desc1 else f"{desc0}->{desc1}")
    elif has_merge_lane and lanes_tag is not None and turn_lane_count > lanes_tag:
        extra_lanes = turn_lane_count - lanes_tag
        if fwd_turns and "merge_to_right" in fwd_turns[0]:
            veh_l0 = default_veh_left + extra_lanes * eff_lane_w
            veh_r0 = default_veh_right
        elif fwd_turns and "merge_to_left" in fwd_turns[-1]:
            veh_l0 = default_veh_left
            veh_r0 = default_veh_right + extra_lanes * eff_lane_w
        else:
            veh_l0 = default_veh_left + 0.5 * extra_lanes * eff_lane_w
            veh_r0 = default_veh_right + 0.5 * extra_lanes * eff_lane_w
        veh_l1, veh_r1 = default_veh_left, default_veh_right
        placement_source = "merge_lane_taper"
    else:
        veh_l0, veh_r0 = default_veh_left, default_veh_right
        veh_l1, veh_r1 = default_veh_left, default_veh_right
        if has_transition:
            placement_source = "transition_tag"
            assumptions.append("placement=transition")

    station_offsets: List[StationOffset] = []
    taper_len = min(total_len, 18.0) if placement_source == "merge_lane_taper" else total_len
    for s in s_vals:
        t = min(1.0, (s / taper_len)) if taper_len > 1e-6 else 0.0
        wl = (1.0 - t) * veh_l0 + t * veh_l1 + cw_left
        wr = (1.0 - t) * veh_r0 + t * veh_r1 + cw_right
        station_offsets.append(StationOffset(s=s, width_left=wl, width_right=wr))

    return RoadEdgeRecord(
        osm_id=osm_id,
        highway=highway,
        is_oneway=is_oneway,
        length_m=total_len,
        coords_rd=coords_rd,
        station_offsets=station_offsets,
        width_source=width_source,
        placement_source=placement_source,
        inferred_lanes=inferred_lanes,
        lane_width_m=lane_w,
        cycleway_left_m=cw_left,
        cycleway_right_m=cw_right,
        has_transition_tag=has_transition,
        turn_lanes_tokens=fwd_turns,
        assumptions=assumptions,
        uncertainty_m=uncertainty_m,
    )


def propagate_topological_continuity_and_asymmetry(
    edges: List[RoadEdgeRecord],
    mode: str,
) -> None:
    """
    Refine cross-section profiles using network topology:
    1. Collinear Width/Lane Continuation across untagged continuations (up to 2 hops).
    2. Turn-Lane Split Asymmetry at Y-Diverges / Merges (`turn:lanes=left|through|through`).
    """
    if mode in ("baseline_null", "junction_only"):
        return

    node_inc: Dict[Tuple[int, int], List[Tuple[int, bool, float]]] = {}
    for idx, edge in enumerate(edges):
        pts = edge.coords_rd
        if len(pts) < 2:
            continue
        k_start = snap_node_key(pts[0])
        k_end = snap_node_key(pts[-1])
        ang_start = math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0])
        ang_end = math.atan2(pts[-2][1] - pts[-1][1], pts[-2][0] - pts[-1][0])
        node_inc.setdefault(k_start, []).append((idx, True, ang_start))
        node_inc.setdefault(k_end, []).append((idx, False, ang_end))

    # Pass 1: Propagate explicit width/lane count along collinear same-class continuations (2 hops)
    for _hop in range(2):
        updates: List[Tuple[int, float, float, str]] = []
        for _node_key, inc_list in node_inc.items():
            if len(inc_list) < 2:
                continue
            for i, (idx_a, at_start_a, ang_a) in enumerate(inc_list):
                edge_a = edges[idx_a]
                if edge_a.width_source != "class_fallback":
                    continue
                best_match: Optional[Tuple[RoadEdgeRecord, float]] = None
                for j, (idx_b, at_start_b, ang_b) in enumerate(inc_list):
                    if i == j:
                        continue
                    edge_b = edges[idx_b]
                    if edge_b.width_source == "class_fallback":
                        continue
                    if edge_b.highway != edge_a.highway or edge_b.is_oneway != edge_a.is_oneway:
                        continue
                    if edge_a.is_oneway and (at_start_a == at_start_b):
                        continue
                    opposite_ang = (ang_a + math.pi) % (2.0 * math.pi)
                    defl_deg = smallest_angle_diff_deg(opposite_ang, ang_b)
                    if defl_deg <= COLLINEAR_CONTINUATION_MAX_DEG:
                        if best_match is None or defl_deg < best_match[1]:
                            best_match = (edge_b, defl_deg)

                if best_match is not None:
                    donor, _defl_deg = best_match
                    donor_veh_w = (
                        donor.station_offsets[0].total_width
                        - donor.cycleway_left_m
                        - donor.cycleway_right_m
                    )
                    updates.append((idx_a, donor_veh_w, donor.inferred_lanes, donor.osm_id))

        for idx_a, new_veh_w, new_lanes, donor_id in updates:
            edge_a = edges[idx_a]
            if edge_a.width_source != "class_fallback":
                continue
            half_veh = 0.5 * new_veh_w
            for st in edge_a.station_offsets:
                st.width_left = half_veh + edge_a.cycleway_left_m
                st.width_right = half_veh + edge_a.cycleway_right_m
            edge_a.inferred_lanes = new_lanes
            edge_a.width_source = "topological_continuation"
            edge_a.uncertainty_m = 0.75
            edge_a.assumptions.append(f"continued_from={donor_id}(veh_w={new_veh_w:.2f}m)")

    # Pass 2: Infer asymmetric lateral offset at `turn:lanes` splits where placement wasn't tagged
    for _node_key, inc_list in node_inc.items():
        if len(inc_list) < 3:
            continue
        for idx_in, at_start_in, ang_in in inc_list:
            edge_in = edges[idx_in]
            if (
                not edge_in.is_oneway
                or at_start_in
                or edge_in.placement_source != "symmetric_centerline"
                or len(edge_in.turn_lanes_tokens) < 3
            ):
                continue

            tokens = edge_in.turn_lanes_tokens
            left_turns = sum(1 for t in tokens if "left" in t and "through" not in t)
            right_turns = sum(1 for t in tokens if "right" in t and "through" not in t)
            through_lanes = len(tokens) - left_turns - right_turns
            if through_lanes < 1 or (left_turns == 0 and right_turns == 0):
                continue

            outgoing = [item for item in inc_list if item[0] != idx_in and item[1] is True]
            if len(outgoing) < 2:
                continue

            forward_dir = (ang_in + math.pi) % (2.0 * math.pi)
            outgoing_sorted = sorted(
                outgoing,
                key=lambda item: smallest_angle_diff_deg(forward_dir, item[2]),
            )
            _main_idx, _, main_ang = outgoing_sorted[0]
            if smallest_angle_diff_deg(forward_dir, main_ang) > 20.0:
                continue

            veh_w = (
                edge_in.station_offsets[-1].total_width
                - edge_in.cycleway_left_m
                - edge_in.cycleway_right_m
            )
            eff_lw = veh_w / len(tokens)
            lanes_left_of_center = left_turns + 0.5 * through_lanes
            lanes_right_of_center = right_turns + 0.5 * through_lanes
            new_l = lanes_left_of_center * eff_lw + edge_in.cycleway_left_m
            new_r = lanes_right_of_center * eff_lw + edge_in.cycleway_right_m
            for st in edge_in.station_offsets:
                st.width_left = new_l
                st.width_right = new_r
            edge_in.placement_source = "inferred_turn_lane_split"
            edge_in.assumptions.append(
                f"asymmetric_turn_split({lanes_left_of_center:.1f}L/{lanes_right_of_center:.1f}R)"
            )


# ---------------------------------------------------------------------------
# Stage 3: Explicit Left/Right Boundary Curve & Corridor Polygon Construction
# ---------------------------------------------------------------------------


def build_edge_corridor_polygon(edge: RoadEdgeRecord, mode: str) -> Polygon | MultiPolygon:
    """
    Construct the physical road surface polygon for a single edge from its reference centerline
    gamma_e(s) and its independent left/right lateral offset profiles (w_L(s), w_R(s)).
    In `baseline_null` or `junction_only` mode, uses the exact `bgt_compare.py` buffer parameters
    (`cap_style='flat', join_style='mitre', mitre_limit=2.0`).
    """
    pts = edge.coords_rd
    if mode in ("baseline_null", "junction_only"):
        half_w = edge.station_offsets[0].width_left
        poly = LineString(pts).buffer(
            half_w, cap_style="flat", join_style="mitre", mitre_limit=2.0
        )
        if not poly.is_valid:
            poly = poly.buffer(0)
        edge.polygon = poly
        return poly

    normals = vertex_unit_normals(pts)
    left_pts: List[Tuple[float, float]] = []
    right_pts: List[Tuple[float, float]] = []

    for (x, y), (nx, ny), st in zip(pts, normals, edge.station_offsets):
        left_pts.append((x + nx * st.width_left, y + ny * st.width_left))
        right_pts.append((x - nx * st.width_right, y - ny * st.width_right))

    edge.left_boundary_coords = left_pts
    edge.right_boundary_coords = right_pts

    ring_coords = left_pts + list(reversed(right_pts)) + [left_pts[0]]
    raw_poly = Polygon(ring_coords)

    if not raw_poly.is_valid or raw_poly.is_empty or raw_poly.area < 1e-3:
        repaired = raw_poly.buffer(0)
        if repaired.is_valid and not repaired.is_empty and repaired.area >= 0.5 * edge.length_m:
            raw_poly = repaired
            edge.fallback_used = "corridor_self_intersection_repaired_buffer0"
        else:
            avg_half_w = 0.25 * (
                edge.station_offsets[0].total_width + edge.station_offsets[-1].total_width
            )
            raw_poly = LineString(pts).buffer(
                avg_half_w, cap_style="flat", join_style="mitre", mitre_limit=2.0
            )
            edge.fallback_used = "corridor_degenerate_fallback_buffer"

    edge.polygon = raw_poly
    return raw_poly


# ---------------------------------------------------------------------------
# Stage 4: General Junction Surface Construction & Corner Fillets
# ---------------------------------------------------------------------------


@dataclass
class OutwardHalfEdge:
    """
    A road half-edge oriented strictly outward from a shared topological node v.
    """

    edge: RoadEdgeRecord
    outward_pts: List[Tuple[float, float]]
    outward_s: List[float]
    outward_left_w: List[float]
    outward_right_w: List[float]
    outward_angle: float
    outward_left_boundary: List[Tuple[float, float]]
    outward_right_boundary: List[Tuple[float, float]]


def make_outward_half_edge(edge: RoadEdgeRecord, at_start: bool) -> OutwardHalfEdge:
    if at_start:
        pts = list(edge.coords_rd)
        lw = [st.width_left for st in edge.station_offsets]
        rw = [st.width_right for st in edge.station_offsets]
        lb = list(edge.left_boundary_coords)
        rb = list(edge.right_boundary_coords)
    else:
        pts = list(reversed(edge.coords_rd))
        lw = [st.width_right for st in reversed(edge.station_offsets)]
        rw = [st.width_left for st in reversed(edge.station_offsets)]
        lb = list(reversed(edge.right_boundary_coords))
        rb = list(reversed(edge.left_boundary_coords))

    s_vals = polyline_arc_lengths(pts)
    target_idx = 1
    for i in range(1, len(pts)):
        target_idx = i
        if s_vals[i] >= 3.5:
            break
    ang = math.atan2(pts[target_idx][1] - pts[0][1], pts[target_idx][0] - pts[0][0])

    return OutwardHalfEdge(
        edge=edge,
        outward_pts=pts,
        outward_s=s_vals,
        outward_left_w=lw,
        outward_right_w=rw,
        outward_angle=ang,
        outward_left_boundary=lb,
        outward_right_boundary=rb,
    )


def trim_polyline_to_length(
    pts: List[Tuple[float, float]], max_len: float
) -> List[Tuple[float, float]]:
    if len(pts) < 2 or max_len <= 0:
        return pts[:2]
    out = [pts[0]]
    acc = 0.0
    for i in range(1, len(pts)):
        dx = pts[i][0] - pts[i - 1][0]
        dy = pts[i][1] - pts[i - 1][1]
        seg_len = math.hypot(dx, dy)
        if acc + seg_len >= max_len:
            t = (max_len - acc) / max(seg_len, 1e-9)
            out.append((pts[i - 1][0] + t * dx, pts[i - 1][1] + t * dy))
            return out
        out.append(pts[i])
        acc += seg_len
    return out


def build_junction_node_core_polygon(half_edges: List[OutwardHalfEdge]) -> Optional[Polygon]:
    """
    Because individual corridors are constructed with flat end-caps at the topological node,
    consecutive corridors meeting at a bend or intersection leave an open wedge gap between
    their flat end-caps (`outward_left_boundary[0]` and `outward_right_boundary[0]`).
    We close this core junction polygon by connecting the endpoint curb vertices around the node
    together with a compact join disk of radius equal to the median physical half-width.
    """
    if len(half_edges) < 2:
        return None

    ring_pts: List[Tuple[float, float]] = []
    radii: List[float] = []
    for he in half_edges:
        r_pt = he.outward_right_boundary[0]
        l_pt = he.outward_left_boundary[0]
        ring_pts.append(r_pt)
        ring_pts.append(l_pt)
        radii.append(0.5 * math.hypot(l_pt[0] - r_pt[0], l_pt[1] - r_pt[1]))

    polys: List[Polygon] = []
    if len(ring_pts) >= 3:
        core = Polygon([*ring_pts, ring_pts[0]]).convex_hull
        if core.is_valid and not core.is_empty and core.area > 1e-3:
            polys.append(core)

    # Also bridge each half-edge's end-cap midpoint with a compact disk of its own half-width
    for he, rad in zip(half_edges, radii):
        r_pt = he.outward_right_boundary[0]
        l_pt = he.outward_left_boundary[0]
        mx, my = 0.5 * (l_pt[0] + r_pt[0]), 0.5 * (l_pt[1] + r_pt[1])
        polys.append(Point(mx, my).buffer(rad, quad_segs=12))

    if not polys:
        return None
    u = unary_union(polys)
    if not u.is_valid:
        u = u.buffer(0)
    return u if isinstance(u, Polygon) else None


def build_corner_curb_fillet(
    he_a: OutwardHalfEdge,
    he_b: OutwardHalfEdge,
    turn_deg: float,
) -> Optional[Polygon]:
    """
    Construct a controlled corner curb fillet polygon between adjacent half-edges `he_a` and
    `he_b` (where `he_b` is counter-clockwise from `he_a` by `turn_deg` degrees).
    """
    if turn_deg < JUNCTION_MIN_TURN_DEG or turn_deg > JUNCTION_MAX_TURN_DEG:
        return None

    # Do not fillet between opposite carriageways of a divided road median split
    if turn_deg < 42.0 and he_a.edge.is_oneway and he_b.edge.is_oneway:
        if not (he_a.edge.has_transition_tag or he_b.edge.has_transition_tag):
            return None

    max_reach_a = min(0.45 * he_a.edge.length_m, JUNCTION_ARM_SEARCH_MAX_M)
    max_reach_b = min(0.45 * he_b.edge.length_m, JUNCTION_ARM_SEARCH_MAX_M)
    if max_reach_a < 1.5 or max_reach_b < 1.5:
        return None

    curb_a = LineString(trim_polyline_to_length(he_a.outward_left_boundary, max_reach_a))
    curb_b = LineString(trim_polyline_to_length(he_b.outward_right_boundary, max_reach_b))

    if curb_a.length < 1.0 or curb_b.length < 1.0:
        return None

    inter = curb_a.intersection(curb_b)
    if inter.is_empty:
        return None

    if isinstance(inter, Point):
        int_pt = (inter.x, inter.y)
    elif hasattr(inter, "geoms"):
        pts = [g for g in inter.geoms if isinstance(g, Point)]
        if not pts:
            return None
        node_pt = Point(he_a.outward_pts[0])
        pts.sort(key=lambda p: p.distance(node_pt))
        int_pt = (pts[0].x, pts[0].y)
    else:
        return None

    s_int_a = curb_a.project(Point(int_pt))
    s_int_b = curb_b.project(Point(int_pt))

    is_major = any(
        h in ("primary", "secondary", "tertiary")
        for h in (he_a.edge.highway, he_b.edge.highway)
    )
    base_tangent_m = 3.2 if is_major else 2.0
    if 55.0 <= turn_deg <= 125.0:
        tangent_m = base_tangent_m
    else:
        tangent_m = 0.6 * base_tangent_m

    s_tan_a = min(curb_a.length, s_int_a + tangent_m)
    s_tan_b = min(curb_b.length, s_int_b + tangent_m)
    if s_tan_a - s_int_a < 0.4 or s_tan_b - s_int_b < 0.4:
        return None

    pt_tan_a = curb_a.interpolate(s_tan_a)
    pt_tan_b = curb_b.interpolate(s_tan_b)
    pt_int_geom = Point(int_pt)

    arc_pts: List[Tuple[float, float]] = []
    n_steps = 8
    for step in range(n_steps + 1):
        t = step / float(n_steps)
        omt = 1.0 - t
        bx = omt * omt * pt_tan_a.x + 2.0 * omt * t * pt_int_geom.x + t * t * pt_tan_b.x
        by = omt * omt * pt_tan_a.y + 2.0 * omt * t * pt_int_geom.y + t * t * pt_tan_b.y
        arc_pts.append((bx, by))

    ring = [
        (pt_int_geom.x, pt_int_geom.y),
        (pt_tan_a.x, pt_tan_a.y),
        *arc_pts[1:-1],
        (pt_tan_b.x, pt_tan_b.y),
        (pt_int_geom.x, pt_int_geom.y),
    ]
    fillet_poly = Polygon(ring)
    if not fillet_poly.is_valid:
        fillet_poly = fillet_poly.buffer(0)
    if (
        not isinstance(fillet_poly, Polygon)
        or fillet_poly.is_empty
        or fillet_poly.area <= 0.05
        or fillet_poly.area > JUNCTION_FILLET_MAX_AREA_M2
    ):
        return None

    return fillet_poly


def build_transition_flare_polygon(
    he_a: OutwardHalfEdge,
    he_b: OutwardHalfEdge,
    turn_deg: float,
) -> Optional[Polygon]:
    if turn_deg > 50.0 or turn_deg < 8.0:
        return None

    has_flare_evidence = (
        he_a.edge.has_transition_tag
        or he_b.edge.has_transition_tag
        or he_a.edge.placement_source in ("explicit_placement_tag", "inferred_turn_lane_split")
        or he_b.edge.placement_source in ("explicit_placement_tag", "inferred_turn_lane_split")
    )
    if not has_flare_evidence:
        return None

    reach = min(
        0.75 * he_a.edge.length_m,
        0.75 * he_b.edge.length_m,
        TRANSITION_GORE_MAX_LENGTH_M,
    )
    if reach < 2.5:
        return None

    curb_a = LineString(trim_polyline_to_length(he_a.outward_left_boundary, reach))
    curb_b = LineString(trim_polyline_to_length(he_b.outward_right_boundary, reach))

    sample_s = [reach * (i / 10.0) for i in range(1, 11)]
    valid_reach_a = 0.0
    valid_reach_b = 0.0
    for s in sample_s:
        pa = curb_a.interpolate(min(s, curb_a.length))
        pb = curb_b.interpolate(min(s, curb_b.length))
        if pa.distance(pb) <= 4.2:
            valid_reach_a = min(s, curb_a.length)
            valid_reach_b = min(s, curb_b.length)
        else:
            break

    if valid_reach_a < 2.0 or valid_reach_b < 2.0:
        return None

    sub_a = trim_polyline_to_length(he_a.outward_left_boundary, valid_reach_a)
    sub_b = trim_polyline_to_length(he_b.outward_right_boundary, valid_reach_b)
    ring = sub_a + list(reversed(sub_b)) + [sub_a[0]]
    flare_poly = Polygon(ring)
    if not flare_poly.is_valid:
        flare_poly = flare_poly.buffer(0)
    if (
        not isinstance(flare_poly, Polygon)
        or flare_poly.is_empty
        or flare_poly.area > TRANSITION_GORE_MAX_AREA_M2
    ):
        return None
    return flare_poly


def construct_junction_surfaces(
    edges: List[RoadEdgeRecord],
    corridor_union: Polygon | MultiPolygon,
    mode: str,
) -> Tuple[List[JunctionRecord], List[Polygon | MultiPolygon], int]:
    """
    Construct general junction surfaces across all topological nodes of degree >= 2.
    In `baseline_null`, returns empty junction surfaces (exact flat-cap miter union).
    In `width_asymmetric_only`, includes only the minimal node end-cap join disks so bends
    between flat-capped segments do not leave open wedge cracks, without corner fillets.
    In `junction_only` and `full_reconstruction`, constructs full node cores, tangent Bezier
    curb fillets, and `placement=transition` taper flares while preserving splitter islands.
    """
    if mode == "baseline_null":
        return [], [], 0

    node_map: Dict[Tuple[int, int], List[Tuple[RoadEdgeRecord, bool]]] = {}
    for edge in edges:
        if len(edge.coords_rd) < 2:
            continue
        k0 = snap_node_key(edge.coords_rd[0])
        k1 = snap_node_key(edge.coords_rd[-1])
        node_map.setdefault(k0, []).append((edge, True))
        node_map.setdefault(k1, []).append((edge, False))

    junction_records: List[JunctionRecord] = []
    junction_polys: List[Polygon | MultiPolygon] = []

    for node_key in sorted(node_map.keys()):
        inc = node_map[node_key]
        if len(inc) < 2:
            continue

        half_edges = [make_outward_half_edge(edge, at_start) for edge, at_start in inc]
        half_edges.sort(key=lambda he: (he.outward_angle, he.edge.osm_id))

        node_xy = half_edges[0].outward_pts[0]
        node_id = f"node_{node_key[0]}_{node_key[1]}"
        deg = len(half_edges)

        local_polys: List[Polygon] = []
        fallback_reasons: List[str] = []
        fillet_count = 0
        flare_count = 0

        core_poly = build_junction_node_core_polygon(half_edges)
        if core_poly is not None:
            local_polys.append(core_poly)

        if mode in ("junction_only", "full_reconstruction"):
            for k in range(deg):
                he_a = half_edges[k]
                he_b = half_edges[(k + 1) % deg]
                turn_rad = angle_diff_ccw(he_a.outward_angle, he_b.outward_angle)
                turn_deg = math.degrees(turn_rad)

                fillet = build_corner_curb_fillet(he_a, he_b, turn_deg)
                if fillet is not None:
                    local_polys.append(fillet)
                    fillet_count += 1

                if mode == "full_reconstruction":
                    flare = build_transition_flare_polygon(he_a, he_b, turn_deg)
                    if flare is not None:
                        local_polys.append(flare)
                        flare_count += 1

        merged_junc: Optional[Polygon | MultiPolygon] = None
        if local_polys:
            u = unary_union(local_polys)
            if not u.is_valid:
                u = u.buffer(0)
                fallback_reasons.append("junction_union_repaired_buffer0")
            if not u.is_empty:
                junction_polys.append(u)
                merged_junc = u

        junction_records.append(
            JunctionRecord(
                node_id=node_id,
                node_xy=node_xy,
                degree=deg,
                incident_edges=[he.edge.osm_id for he in half_edges],
                fillet_count=fillet_count,
                transition_flare_count=flare_count,
                polygon=merged_junc,
                fallback_reasons=fallback_reasons,
            )
        )

    preserved_islands = 0
    if mode in ("junction_only", "full_reconstruction"):
        transition_lines = [
            LineString(e.coords_rd)
            for e in edges
            if e.has_transition_tag and len(e.coords_rd) >= 2
        ]
        combined_preview = unary_union([corridor_union, *junction_polys])
        polys_to_check = (
            [combined_preview]
            if isinstance(combined_preview, Polygon)
            else list(getattr(combined_preview, "geoms", []))
        )

        for poly in polys_to_check:
            for ring in poly.interiors:
                hole_poly = Polygon(ring)
                if not hole_poly.is_valid:
                    hole_poly = hole_poly.buffer(0)
                hole_area = hole_poly.area
                touches_transition = any(
                    hole_poly.distance(tline) < 4.5 for tline in transition_lines
                )
                if hole_area < PRESERVED_ISLAND_MIN_AREA_M2 or (
                    touches_transition and hole_area < 28.0
                ):
                    junction_polys.append(hole_poly)
                else:
                    preserved_islands += 1

    return junction_records, junction_polys, preserved_islands


# ---------------------------------------------------------------------------
# Top-Level Reconstruction Entry Point & GeoJSON Serialization
# ---------------------------------------------------------------------------


def reconstruct_road_surface(
    osm_features: List[Dict[str, Any]],
    site_id: str = "site",
    mode: str = "full_reconstruction",
    input_crs: str = SOURCE_CRS,
    center_rd: Optional[Tuple[float, float]] = None,
    eval_half_size_m: float = 40.0,
    context_margin_m: float = 25.0,
) -> ReconstructionResult:
    """
    Reconstruct the physical road surface and junction polygons from OSM road features.
    When `center_rd` is provided, filters input features intersecting the spatial query box
    `box(cx - R - margin, cy - R - margin, cx + R + margin, cy + R + margin)` (matching
    `bgt_compare.py`).
    """
    if mode not in (
        "baseline_null",
        "width_asymmetric_only",
        "junction_only",
        "full_reconstruction",
    ):
        raise ValueError(f"Unsupported reconstruction mode: {mode}")

    transformer = (
        Transformer.from_crs(input_crs, TARGET_CRS, always_xy=True)
        if input_crs.upper() != TARGET_CRS
        else None
    )

    query_box = None
    if center_rd is not None:
        cx, cy = center_rd
        r_total = eval_half_size_m + context_margin_m
        query_box = box(cx - r_total, cy - r_total, cx + r_total, cy + r_total)

    filtered_raw: List[Tuple[str, Dict[str, Any], List[Tuple[float, float]]]] = []
    for idx, feat in enumerate(osm_features):
        props = feat.get("properties") or {}
        if not is_drivable_ground_road(props, mode=mode):
            continue
        geom = feat.get("geometry")
        if not geom or geom.get("type") != "LineString":
            continue
        raw_coords = geom.get("coordinates") or []
        if len(raw_coords) < 2:
            continue

        if transformer is not None:
            pts_rd = [transformer.transform(float(c[0]), float(c[1])) for c in raw_coords]
        else:
            pts_rd = [(float(c[0]), float(c[1])) for c in raw_coords]

        pts_rd = dedupe_consecutive_pts(pts_rd)
        if len(pts_rd) < 2:
            continue

        if query_box is not None and not LineString(pts_rd).intersects(query_box):
            continue

        osm_id = str(props.get("osm_id") or feat.get("id") or f"way/{idx}")
        filtered_raw.append((osm_id, props, pts_rd))

    # Deterministic sort independent of input feature ordering
    filtered_raw.sort(
        key=lambda item: (
            item[0],
            round(item[2][0][0], 3),
            round(item[2][0][1], 3),
            round(item[2][-1][0], 3),
            round(item[2][-1][1], 3),
        )
    )

    edges: List[RoadEdgeRecord] = [
        build_initial_edge_record(osm_id, props, pts_rd, mode=mode)
        for osm_id, props, pts_rd in filtered_raw
    ]

    propagate_topological_continuity_and_asymmetry(edges, mode=mode)

    corridor_polys = [build_edge_corridor_polygon(edge, mode=mode) for edge in edges]
    corridor_union = unary_union(corridor_polys) if corridor_polys else Polygon()
    if not corridor_union.is_valid:
        corridor_union = corridor_union.buffer(0)

    junctions, junction_polys, preserved_islands = construct_junction_surfaces(
        edges, corridor_union, mode=mode
    )
    junction_union = unary_union(junction_polys) if junction_polys else Polygon()
    if not junction_union.is_valid:
        junction_union = junction_union.buffer(0)

    surface_polygon = (
        unary_union([corridor_union, junction_union])
        if not junction_union.is_empty
        else corridor_union
    )
    if not surface_polygon.is_valid:
        surface_polygon = surface_polygon.buffer(0)

    width_sources: Dict[str, int] = {}
    asymmetric_count = 0
    fallback_reasons: List[str] = []

    for e in edges:
        width_sources[e.width_source] = width_sources.get(e.width_source, 0) + 1
        if (
            abs(e.station_offsets[0].width_left - e.station_offsets[0].width_right) > 0.05
            or abs(e.station_offsets[-1].width_left - e.station_offsets[-1].width_right) > 0.05
        ):
            asymmetric_count += 1
        if e.fallback_used:
            fallback_reasons.append(f"{e.osm_id}:{e.fallback_used}")

    for j in junctions:
        for r in j.fallback_reasons:
            fallback_reasons.append(f"{j.node_id}:{r}")

    diagnostics = ReconstructionDiagnostics(
        site_id=site_id,
        mode=mode,
        edge_count=len(edges),
        junction_count=len(junctions),
        width_source_counts=width_sources,
        asymmetric_edge_count=asymmetric_count,
        fillet_count=sum(j.fillet_count for j in junctions),
        transition_flare_count=sum(j.transition_flare_count for j in junctions),
        preserved_island_count=preserved_islands,
        fallback_count=len(fallback_reasons),
        fallback_reasons=fallback_reasons,
    )

    return ReconstructionResult(
        site_id=site_id,
        mode=mode,
        crs=TARGET_CRS,
        surface_polygon=surface_polygon,
        corridor_union=corridor_union,
        junction_union=junction_union,
        edges=edges,
        junctions=junctions,
        diagnostics=diagnostics,
    )


def export_reconstruction_geojson(result: ReconstructionResult, output_path: Path) -> None:
    """
    Export the reconstructed road surface, individual road segments with boundary offsets,
    and junction surfaces to a self-contained GeoJSON FeatureCollection in EPSG:28992.
    """
    features: List[Dict[str, Any]] = []

    if not result.surface_polygon.is_empty:
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "feature_kind": "reconstructed_surface",
                    "site_id": result.site_id,
                    "mode": result.mode,
                    "crs": result.crs,
                    "area_m2": round(result.surface_polygon.area, 3),
                    "diagnostics": asdict(result.diagnostics),
                },
                "geometry": mapping(result.surface_polygon),
            }
        )

    for edge in result.edges:
        if edge.polygon is None or edge.polygon.is_empty:
            continue
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "feature_kind": "road_corridor",
                    "site_id": result.site_id,
                    "osm_id": edge.osm_id,
                    "highway": edge.highway,
                    "is_oneway": edge.is_oneway,
                    "length_m": round(edge.length_m, 2),
                    "width_left_start_m": round(edge.station_offsets[0].width_left, 3),
                    "width_right_start_m": round(edge.station_offsets[0].width_right, 3),
                    "width_left_end_m": round(edge.station_offsets[-1].width_left, 3),
                    "width_right_end_m": round(edge.station_offsets[-1].width_right, 3),
                    "total_width_start_m": round(edge.station_offsets[0].total_width, 3),
                    "total_width_end_m": round(edge.station_offsets[-1].total_width, 3),
                    "width_source": edge.width_source,
                    "placement_source": edge.placement_source,
                    "inferred_lanes": edge.inferred_lanes,
                    "uncertainty_m": edge.uncertainty_m,
                    "assumptions": edge.assumptions,
                    "fallback_used": edge.fallback_used,
                },
                "geometry": mapping(edge.polygon),
            }
        )

    for junc in result.junctions:
        if junc.polygon is None or junc.polygon.is_empty:
            continue
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "feature_kind": "junction_surface",
                    "site_id": result.site_id,
                    "node_id": junc.node_id,
                    "degree": junc.degree,
                    "incident_edges": junc.incident_edges,
                    "fillet_count": junc.fillet_count,
                    "transition_flare_count": junc.transition_flare_count,
                    "fallback_reasons": junc.fallback_reasons,
                },
                "geometry": mapping(junc.polygon),
            }
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": result.crs}},
        "features": features,
    }
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
