#!/usr/bin/env python3
"""
Automated unit and regression tests for the independent road-surface and junction
reconstruction algorithm (`reconstruct.py`).
"""

from __future__ import annotations

import json
import math
import random
import sys
from pathlib import Path
from typing import Any, Dict, List

import pytest
from shapely.geometry import LineString, MultiPolygon, Point, Polygon

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from reconstruct import (
    TARGET_CRS,
    export_reconstruction_geojson,
    parse_placement_spec,
    reconstruct_road_surface,
)


def make_osm_way(
    way_id: str,
    coords: List[List[float]],
    highway: str = "tertiary",
    **extra_tags: Any,
) -> Dict[str, Any]:
    props = {"id": way_id, "osm_id": way_id, "highway": highway, **extra_tags}
    return {
        "type": "Feature",
        "id": way_id,
        "properties": props,
        "geometry": {"type": "LineString", "coordinates": coords},
    }


def assert_valid_finite_surface(geom: Polygon | MultiPolygon) -> None:
    assert not geom.is_empty, "Reconstructed surface must not be empty"
    assert geom.is_valid, f"Surface must be topologically valid: {geom}"
    assert geom.area > 0.0, "Surface must have positive area"
    bounds = geom.bounds
    assert all(math.isfinite(v) for v in bounds), f"Non-finite bounds: {bounds}"


def test_asymmetric_placement_middle_of_and_left_of() -> None:
    """
    Verify that `placement=middle_of:1` on a 2-lane one-way road places 0.5 lane on the left
    of the centerline and 1.5 lanes on the right of the centerline (not symmetric 1.0 / 1.0).
    """
    parsed = parse_placement_spec("middle_of:1", total_lanes=2.0, lane_width_m=3.20)
    assert parsed is not None
    wl, wr, desc = parsed
    assert math.isclose(wl, 1.60, abs_tol=1e-6)
    assert math.isclose(wr, 4.80, abs_tol=1e-6)
    assert "0.5L/1.5R" in desc

    way = make_osm_way(
        "way/100",
        [[121500.0, 488000.0], [121560.0, 488000.0]],
        highway="tertiary",
        oneway="yes",
        lanes="2",
        placement="middle_of:1",
    )
    res = reconstruct_road_surface([way], site_id="test_asym", mode="full_reconstruction", input_crs=TARGET_CRS)
    assert_valid_finite_surface(res.surface_polygon)
    edge = res.edges[0]
    assert math.isclose(edge.station_offsets[0].width_left, 1.60, abs_tol=1e-3)
    assert math.isclose(edge.station_offsets[0].width_right, 4.80, abs_tol=1e-3)

    # Check actual polygon bounds along Y: centerline is at Y = 488000.0
    # Left is +Y (488001.6), Right is -Y (487995.2)
    _, miny, _, maxy = res.surface_polygon.bounds
    assert math.isclose(maxy - 488000.0, 1.60, abs_tol=0.05)
    assert math.isclose(488000.0 - miny, 4.80, abs_tol=0.05)


def test_cycleway_lane_widens_only_tagged_side() -> None:
    """Verify that `cycleway:right=lane` adds lateral offset on the right curb only."""
    way = make_osm_way(
        "way/101",
        [[121500.0, 488000.0], [121550.0, 488000.0]],
        highway="secondary",
        oneway="yes",
        lanes="1",
        **{"cycleway:right": "lane"},
    )
    res = reconstruct_road_surface([way], site_id="test_cw", mode="full_reconstruction", input_crs=TARGET_CRS)
    edge = res.edges[0]
    assert edge.station_offsets[0].width_right > edge.station_offsets[0].width_left + 1.4


def test_topological_collinear_continuation_propagation() -> None:
    """
    Verify that an untagged segment collinearly continuing an explicitly lane-tagged segment
    of the same highway class inherits its vehicular width.
    """
    w_tagged = make_osm_way(
        "way/200",
        [[121000.0, 488000.0], [121040.0, 488000.0]],
        highway="tertiary",
        oneway="yes",
        lanes="2",
    )
    w_untagged = make_osm_way(
        "way/201",
        [[121040.0, 488000.0], [121080.0, 488000.0]],
        highway="tertiary",
        oneway="yes",
    )
    res = reconstruct_road_surface(
        [w_tagged, w_untagged], site_id="test_cont", mode="full_reconstruction", input_crs=TARGET_CRS
    )
    by_id = {e.osm_id: e for e in res.edges}
    assert by_id["way/201"].width_source == "topological_continuation"
    assert math.isclose(
        by_id["way/201"].station_offsets[0].total_width,
        by_id["way/200"].station_offsets[0].total_width,
        abs_tol=1e-3,
    )


def test_junction_corner_fillet_adds_controlled_curb_transition() -> None:
    """
    Verify that a 90-degree T-junction constructs valid corner curb fillets in `full_reconstruction`
    with bounded positive area compared to `width_asymmetric_only`.
    """
    w_main_1 = make_osm_way(
        "way/300",
        [[121000.0, 488000.0], [121040.0, 488000.0]],
        highway="tertiary",
        lanes="2",
    )
    w_main_2 = make_osm_way(
        "way/301",
        [[121040.0, 488000.0], [121080.0, 488000.0]],
        highway="tertiary",
        lanes="2",
    )
    w_stem = make_osm_way(
        "way/302",
        [[121040.0, 488000.0], [121040.0, 488040.0]],
        highway="residential",
        lanes="2",
    )
    res_width = reconstruct_road_surface(
        [w_main_1, w_main_2, w_stem],
        site_id="test_tjunc",
        mode="width_asymmetric_only",
        input_crs=TARGET_CRS,
    )
    res_full = reconstruct_road_surface(
        [w_main_1, w_main_2, w_stem],
        site_id="test_tjunc",
        mode="full_reconstruction",
        input_crs=TARGET_CRS,
    )
    assert_valid_finite_surface(res_full.surface_polygon)
    assert res_full.diagnostics.fillet_count == 2
    added_area = res_full.surface_polygon.area - res_width.surface_polygon.area
    assert 0.5 < added_area < 25.0


def test_splitter_island_preserved_vs_transition_flare_bridged() -> None:
    """
    Verify that a large triangular splitter island (>= 8 m^2) between non-transition carriageways
    is preserved as an unpaved interior hole, whereas an acute split tagged `placement=transition`
    bridges the taper gore.
    """
    # Large triangular island (approx 50 m^2 unpaved interior) without transition tags
    island_ways = [
        make_osm_way("way/400", [[121000.0, 488000.0], [121030.0, 488015.0]], highway="residential", oneway="yes", lanes="1"),
        make_osm_way("way/401", [[121000.0, 488000.0], [121030.0, 487985.0]], highway="residential", oneway="yes", lanes="1"),
        make_osm_way("way/402", [[121030.0, 487985.0], [121030.0, 488015.0]], highway="residential", oneway="yes", lanes="1"),
    ]
    res_island = reconstruct_road_surface(
        island_ways, site_id="test_island", mode="full_reconstruction", input_crs=TARGET_CRS
    )
    assert_valid_finite_surface(res_island.surface_polygon)
    assert isinstance(res_island.surface_polygon, Polygon)
    assert len(res_island.surface_polygon.interiors) == 1, "Physical splitter island must be preserved"
    assert res_island.diagnostics.preserved_island_count == 1


def test_permutation_determinism_on_real_site() -> None:
    """
    Verify that shuffling input OSM features produces bit-identical output area and valid geometry.
    """
    osm_path = ROOT_DIR / "baseline_archive" / "pilot_osm.geojson"
    sites_path = ROOT_DIR / "baseline_archive" / "pilot_sites.json"
    osm_features = json.loads(osm_path.read_text(encoding="utf-8"))["features"]
    site_a03 = next(
        s for s in json.loads(sites_path.read_text(encoding="utf-8"))["sites"] if s["site"] == "A03"
    )
    cx, cy = site_a03["center_rd"]

    res_orig = reconstruct_road_surface(
        osm_features, site_id="A03", mode="full_reconstruction", center_rd=(cx, cy)
    )
    assert_valid_finite_surface(res_orig.surface_polygon)

    rng = random.Random(42)
    shuffled = list(osm_features)
    rng.shuffle(shuffled)
    res_shuf = reconstruct_road_surface(
        shuffled, site_id="A03", mode="full_reconstruction", center_rd=(cx, cy)
    )
    assert_valid_finite_surface(res_shuf.surface_polygon)
    assert math.isclose(res_orig.surface_polygon.area, res_shuf.surface_polygon.area, abs_tol=1e-6)
    sym_diff = res_orig.surface_polygon.symmetric_difference(res_shuf.surface_polygon)
    assert sym_diff.area < 1e-6


def test_degenerate_and_self_intersecting_corridor_fallback(tmp_path: Path) -> None:
    """
    Verify that a sharply kinked / self-overlapping wide centerline does not crash or emit
    invalid polygons, records a fallback or repairs cleanly, and exports valid GeoJSON.
    """
    zig_zag = make_osm_way(
        "way/999",
        [
            [121000.0, 488000.0],
            [121003.0, 488000.0],
            [121001.0, 488000.8],
            [121005.0, 488001.2],
        ],
        highway="primary",
        width="16.0",
    )
    res = reconstruct_road_surface(
        [zig_zag], site_id="test_deg", mode="full_reconstruction", input_crs=TARGET_CRS
    )
    assert_valid_finite_surface(res.surface_polygon)

    out_geojson = tmp_path / "test_deg.geojson"
    export_reconstruction_geojson(res, out_geojson)
    loaded = json.loads(out_geojson.read_text(encoding="utf-8"))
    assert loaded["crs"]["properties"]["name"] == TARGET_CRS
    assert len(loaded["features"]) >= 2
