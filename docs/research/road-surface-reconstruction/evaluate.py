#!/usr/bin/env python3
"""
Independent Road-Surface Reconstruction Evaluation against Dutch BGT Reference Geometry.

Evaluates predictive OSM-only variants:
  1. `baseline_null`: Constant highway-class widths + flat/miter polygon union (exact pilot reproduction).
  2. `width_asymmetric_only`: Hierarchical OSM width/lane inference, topological continuation,
     on-road cycleway lanes, and asymmetric `placement=*` offsets without junction fillets.
  3. `junction_only`: Constant highway-class widths + general junction corner fillets.
  4. `full_reconstruction`: Full model combining asymmetric width/placement profiles and
     general junction surface reconstruction.

Also computes a clearly labeled non-predictive diagnostic:
  5. `bgt_oracle_width_diagnostic` (DATA LEAKAGE - NOT A PREDICTIVE MODEL):
     Measures each OSM segment's median local BGT cross-sectional width solely to isolate
     how much residual error comes from missing OSM width tags vs. junction/alignment geometry.
"""

from __future__ import annotations

import json
import math
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from pyproj import Transformer
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box, shape
from shapely.ops import transform, unary_union

from reconstruct import (
    SOURCE_CRS,
    TARGET_CRS,
    ReconstructionResult,
    export_reconstruction_geojson,
    reconstruct_road_surface,
    vertex_unit_normals,
)

RD_TRANSFORM = Transformer.from_crs(4326, 28992, always_xy=True).transform

VEHICULAR_BGT_FUNCTIONS = {
    "rijbaan lokale weg",
    "rijbaan regionale weg",
    "rijbaan autosnelweg",
    "verbindingsweg",
    "rijbaan autoweg",
}


def clean_geom(g: Any) -> Any:
    if g.is_empty:
        return g
    if not g.is_valid:
        g = g.buffer(0)
    return g


def classify_bgt(
    features: List[Dict[str, Any]], clip: Polygon
) -> Tuple[Optional[Polygon | MultiPolygon], Dict[str, int], List[str]]:
    """Exact BGT ground-level carriageway extraction matching `bgt_compare.py`."""
    valid: List[Any] = []
    audit: Dict[str, int] = {}
    used: List[str] = []
    ids = set()

    for f in features:
        p = f.get("properties") or {}
        audit["all_features"] = audit.get("all_features", 0) + 1
        if p.get("eind_registratie") not in (None, "") or p.get("eindRegistratie") not in (
            None,
            "",
        ):
            audit["history_registration_ended"] = (
                audit.get("history_registration_ended", 0) + 1
            )
            continue
        if p.get("termination_date") not in (None, ""):
            audit["history_terminated"] = audit.get("history_terminated", 0) + 1
            continue
        if p.get("status") not in (None, "bestaand"):
            audit["wrong_status"] = audit.get("wrong_status", 0) + 1
            continue
        rel_h = p.get("relatieve_hoogteligging", p.get("relatieveHoogteligging", 0))
        if str(rel_h) not in ("0", "0.0"):
            audit["not_ground_level"] = audit.get("not_ground_level", 0) + 1
            continue
        functie = str(p.get("functie") or "")
        audit[f"function:{functie}"] = audit.get(f"function:{functie}", 0) + 1
        if functie not in VEHICULAR_BGT_FUNCTIONS:
            continue
        key = p.get("lokaal_id") or p.get("lokaalId") or f.get("id")
        if key in ids:
            continue
        ids.add(key)
        try:
            g = shape(f["geometry"])
            # BGT OGC API returns EPSG:4326 lon/lat; detect if coordinates are lon/lat (< 180)
            bx0, by0, _, _ = g.bounds
            if abs(bx0) <= 180.0 and abs(by0) <= 90.0:
                g = transform(RD_TRANSFORM, g)
        except Exception:
            continue
        if g.is_empty:
            continue
        part = clean_geom(g.intersection(clip))
        if part.is_empty:
            continue
        valid.append(part)
        used.append(str(key))
        audit["accepted_polygons"] = audit.get("accepted_polygons", 0) + 1

    return clean_geom(unary_union(valid)) if valid else None, audit, used


def percentile(values: List[float], q: float) -> Optional[float]:
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, round((len(s) - 1) * q))]


def boundary_error(
    geom: Polygon | MultiPolygon,
    other: Polygon | MultiPolygon,
    clip: Polygon,
    spacing: float = 1.0,
) -> Optional[Dict[str, Any]]:
    """Exact interior boundary distance metric from `bgt_compare.py`."""
    if geom.is_empty or other.is_empty:
        return None
    lines = geom.boundary.intersection(clip.buffer(-1.5))
    if lines.is_empty:
        return None
    if lines.geom_type == "LineString":
        segments = [lines]
    elif hasattr(lines, "geoms"):
        segments = [x for x in lines.geoms if x.geom_type == "LineString"]
    else:
        segments = []
    distances: List[float] = []
    for seg in segments:
        n = max(1, math.ceil(seg.length / spacing))
        distances.extend(
            seg.interpolate(i / n, normalized=True).distance(other.boundary)
            for i in range(n + 1)
        )
    if not distances:
        return None
    return {
        "median_m": round(percentile(distances, 0.5), 3),
        "p90_m": round(percentile(distances, 0.9), 3),
        "sample_count": len(distances),
    }


def compute_surface_metrics(
    pred_raw: Polygon | MultiPolygon,
    ref_surface: Polygon | MultiPolygon,
    clip_poly: Polygon,
    junction_zone: Optional[Polygon | MultiPolygon] = None,
) -> Dict[str, Any]:
    """Compute area IoU, precision, recall, boundary errors, and junction/corridor zone IoU."""
    pred = clean_geom(pred_raw.intersection(clip_poly))
    true = clean_geom(ref_surface.intersection(clip_poly))

    overlap = pred.intersection(true).area
    extra = pred.difference(true).area
    missing = true.difference(pred).area
    union_area = overlap + extra + missing

    iou = round(overlap / union_area, 4) if union_area > 0 else 0.0
    prec = round(overlap / pred.area, 4) if pred.area > 0 else 0.0
    rec = round(overlap / true.area, 4) if true.area > 0 else 0.0

    b_p2t = boundary_error(pred, true, clip_poly)
    b_t2p = boundary_error(true, pred, clip_poly)

    junc_iou: Optional[float] = None
    corr_iou: Optional[float] = None
    if junction_zone is not None and not junction_zone.is_empty:
        jz = clean_geom(junction_zone.intersection(clip_poly))
        cz = clean_geom(clip_poly.difference(jz))
        if not jz.is_empty:
            pj = pred.intersection(jz)
            tj = true.intersection(jz)
            uj = pj.union(tj).area
            junc_iou = round(pj.intersection(tj).area / uj, 4) if uj > 0 else None
        if not cz.is_empty:
            pc = pred.intersection(cz)
            tc = true.intersection(cz)
            uc = pc.union(tc).area
            corr_iou = round(pc.intersection(tc).area / uc, 4) if uc > 0 else None

    return {
        "iou": iou,
        "precision": prec,
        "recall": rec,
        "pred_area_m2": round(pred.area, 2),
        "bgt_area_m2": round(true.area, 2),
        "false_road_m2": round(extra, 2),
        "missed_road_m2": round(missing, 2),
        "boundary_pred_to_bgt_median_m": b_p2t["median_m"] if b_p2t else None,
        "boundary_pred_to_bgt_p90_m": b_p2t["p90_m"] if b_p2t else None,
        "boundary_bgt_to_pred_median_m": b_t2p["median_m"] if b_t2p else None,
        "boundary_bgt_to_pred_p90_m": b_t2p["p90_m"] if b_t2p else None,
        "junction_zone_iou": junc_iou,
        "corridor_zone_iou": corr_iou,
    }


def build_junction_evaluation_zone(
    res: ReconstructionResult, radius_m: float = 14.0
) -> Polygon | MultiPolygon:
    disks = [
        Point(j.node_xy).buffer(radius_m)
        for j in res.junctions
        if j.degree >= 3 or j.fillet_count > 0 or j.transition_flare_count > 0
    ]
    return unary_union(disks) if disks else Polygon()


def compute_bgt_oracle_width_surface(
    res_full: ReconstructionResult,
    bgt_surface: Polygon | MultiPolygon,
) -> Polygon | MultiPolygon:
    """
    DATA-LEAKAGE ORACLE DIAGNOSTIC (NOT A PREDICTIVE ALGORITHM):
    Measures each OSM segment's median local left and right BGT curb distances along
    cross-sectional transects to isolate width error from junction/alignment error.
    """
    polys: List[Polygon] = []
    for edge in res_full.edges:
        line = LineString(edge.coords_rd)
        if line.length < 1.0:
            continue
        left_samples: List[float] = []
        right_samples: List[float] = []
        n_probes = max(3, int(min(15, round(line.length / 4.0))))
        for i in range(1, n_probes):
            s = (i / float(n_probes)) * line.length
            pt = line.interpolate(s)
            if not bgt_surface.contains(pt):
                continue
            s0 = max(0.0, s - 0.5)
            s1 = min(line.length, s + 0.5)
            p0 = line.interpolate(s0)
            p1 = line.interpolate(s1)
            dx, dy = p1.x - p0.x, p1.y - p0.y
            norm = math.hypot(dx, dy)
            if norm < 1e-6:
                continue
            nx, ny = -dy / norm, dx / norm
            ray_l = LineString([(pt.x, pt.y), (pt.x + 14.0 * nx, pt.y + 14.0 * ny)])
            ray_r = LineString([(pt.x, pt.y), (pt.x - 14.0 * nx, pt.y - 14.0 * ny)])
            seg_l = ray_l.intersection(bgt_surface)
            seg_r = ray_r.intersection(bgt_surface)
            if seg_l.geom_type == "LineString" and seg_l.length > 0.5:
                left_samples.append(float(seg_l.length))
            elif hasattr(seg_l, "geoms"):
                for g in seg_l.geoms:
                    if g.geom_type == "LineString" and g.distance(pt) < 0.2:
                        left_samples.append(float(g.length))
                        break
            if seg_r.geom_type == "LineString" and seg_r.length > 0.5:
                right_samples.append(float(seg_r.length))
            elif hasattr(seg_r, "geoms"):
                for g in seg_r.geoms:
                    if g.geom_type == "LineString" and g.distance(pt) < 0.2:
                        right_samples.append(float(g.length))
                        break

        wl = (
            percentile(left_samples, 0.5)
            if left_samples
            else edge.station_offsets[0].width_left
        )
        wr = (
            percentile(right_samples, 0.5)
            if right_samples
            else edge.station_offsets[0].width_right
        )
        wl = max(1.2, min(12.0, wl))
        wr = max(1.2, min(12.0, wr))

        pts = edge.coords_rd
        normals = vertex_unit_normals(pts)
        l_pts = [(x + nx * wl, y + ny * wl) for (x, y), (nx, ny) in zip(pts, normals)]
        r_pts = [(x - nx * wr, y - ny * wr) for (x, y), (nx, ny) in zip(pts, normals)]
        ring = l_pts + list(reversed(r_pts)) + [l_pts[0]]
        p = clean_geom(Polygon(ring))
        if not p.is_empty:
            polys.append(p)

    return unary_union([*polys, res_full.junction_union]) if polys else Polygon()


def evaluate_site_collection(
    sites_meta: List[Dict[str, Any]],
    osm_features: List[Dict[str, Any]],
    bgt_cache_dir: Path,
    output_dir: Path,
    split_name: str,
) -> Dict[str, Any]:
    predictive_modes = [
        "baseline_null",
        "width_asymmetric_only",
        "junction_only",
        "full_reconstruction",
    ]
    site_reports: Dict[str, Any] = {}
    geojson_out_dir = output_dir / "reconstructed_geojson" / split_name
    geojson_out_dir.mkdir(parents=True, exist_ok=True)

    for site in sites_meta:
        sid = site.get("site") or site.get("site_id") or site["id"]
        cx, cy = site["center_rd"]
        half_w = float(site.get("eval_half_size_m", 40.0))
        clip_poly = box(cx - half_w, cy - half_w, cx + half_w, cy + half_w)

        bgt_path = bgt_cache_dir / f"{sid}.geojson"
        bgt_fc = json.loads(bgt_path.read_text(encoding="utf-8"))
        bgt_surface, bgt_audit, _ = classify_bgt(bgt_fc.get("features", []), clip_poly)
        if bgt_surface is None:
            bgt_surface = Polygon()

        mode_results: Dict[str, ReconstructionResult] = {}
        for mode in predictive_modes:
            res = reconstruct_road_surface(
                osm_features,
                site_id=sid,
                mode=mode,
                center_rd=(cx, cy),
                eval_half_size_m=half_w,
                context_margin_m=25.0,
            )
            mode_results[mode] = res
            if mode == "full_reconstruction":
                export_reconstruction_geojson(res, geojson_out_dir / f"{sid}_full.geojson")
            elif mode == "baseline_null":
                export_reconstruction_geojson(res, geojson_out_dir / f"{sid}_baseline.geojson")

        junc_zone = build_junction_evaluation_zone(mode_results["full_reconstruction"])

        metrics_by_mode: Dict[str, Any] = {}
        for mode in predictive_modes:
            res = mode_results[mode]
            m = compute_surface_metrics(
                res.surface_polygon, bgt_surface, clip_poly, junction_zone=junc_zone
            )
            m["diagnostics"] = asdict(res.diagnostics)
            metrics_by_mode[mode] = m

        oracle_poly = compute_bgt_oracle_width_surface(
            mode_results["full_reconstruction"], bgt_surface
        )
        oracle_metrics = compute_surface_metrics(
            oracle_poly, bgt_surface, clip_poly, junction_zone=junc_zone
        )
        oracle_metrics["DATA_LEAKAGE_WARNING"] = (
            "Uses BGT cross-sectional widths; diagnostic upper bound only, NOT predictive."
        )
        metrics_by_mode["bgt_oracle_width_diagnostic"] = oracle_metrics

        delta_iou = round(
            metrics_by_mode["full_reconstruction"]["iou"]
            - metrics_by_mode["baseline_null"]["iou"],
            4,
        )
        site_reports[sid] = {
            "id": sid,
            "label": site.get("label") or site.get("name", sid),
            "archetype": site.get("archetype", ""),
            "split": split_name,
            "center_rd": [cx, cy],
            "bgt_filter_audit": bgt_audit,
            "delta_iou_full_vs_baseline": delta_iou,
            "modes": metrics_by_mode,
        }

    summary_by_mode: Dict[str, Any] = {}
    all_mode_keys = [*predictive_modes, "bgt_oracle_width_diagnostic"]
    site_ids = [s.get("site") or s.get("site_id") or s["id"] for s in sites_meta]
    for mode in all_mode_keys:
        ious = [site_reports[sid]["modes"][mode]["iou"] for sid in site_ids]
        precs = [site_reports[sid]["modes"][mode]["precision"] for sid in site_ids]
        recs = [site_reports[sid]["modes"][mode]["recall"] for sid in site_ids]
        false_m2 = [site_reports[sid]["modes"][mode]["false_road_m2"] for sid in site_ids]
        missed_m2 = [site_reports[sid]["modes"][mode]["missed_road_m2"] for sid in site_ids]
        b_med = [
            site_reports[sid]["modes"][mode]["boundary_pred_to_bgt_median_m"]
            for sid in site_ids
            if site_reports[sid]["modes"][mode]["boundary_pred_to_bgt_median_m"] is not None
        ]
        j_ious = [
            site_reports[sid]["modes"][mode]["junction_zone_iou"]
            for sid in site_ids
            if site_reports[sid]["modes"][mode]["junction_zone_iou"] is not None
        ]
        c_ious = [
            site_reports[sid]["modes"][mode]["corridor_zone_iou"]
            for sid in site_ids
            if site_reports[sid]["modes"][mode]["corridor_zone_iou"] is not None
        ]

        summary_by_mode[mode] = {
            "is_predictive_osm_only": mode != "bgt_oracle_width_diagnostic",
            "site_count": len(site_ids),
            "mean_iou": round(sum(ious) / len(ious), 4),
            "min_iou": round(min(ious), 4),
            "max_iou": round(max(ious), 4),
            "mean_precision": round(sum(precs) / len(precs), 4),
            "mean_recall": round(sum(recs) / len(recs), 4),
            "total_false_road_m2": round(sum(false_m2), 2),
            "total_missed_road_m2": round(sum(missed_m2), 2),
            "mean_boundary_pred_to_bgt_median_m": (
                round(sum(b_med) / len(b_med), 3) if b_med else None
            ),
            "mean_junction_zone_iou": round(sum(j_ious) / len(j_ious), 4) if j_ious else None,
            "mean_corridor_zone_iou": round(sum(c_ious) / len(c_ious), 4) if c_ious else None,
        }

    return {
        "split": split_name,
        "summary_by_mode": summary_by_mode,
        "sites": site_reports,
    }


def print_evaluation_table(eval_report: Dict[str, Any]) -> None:
    split = eval_report["split"]
    print(f"\n=== Evaluation Split: {split.upper()} ===")
    header = (
        f"{'Site':<6} | {'Base IoU':>8} | {'WidthOnly':>9} | {'JuncOnly':>8} | "
        f"{'Full IoU':>8} | {'Delta':>7} | {'BaseBnd(m)':>10} | {'FullBnd(m)':>10} | {'Oracle*':>8}"
    )
    print(header)
    print("-" * len(header))
    for sid, sdata in eval_report["sites"].items():
        m = sdata["modes"]
        b_iou = m["baseline_null"]["iou"]
        w_iou = m["width_asymmetric_only"]["iou"]
        j_iou = m["junction_only"]["iou"]
        f_iou = m["full_reconstruction"]["iou"]
        delta = sdata["delta_iou_full_vs_baseline"]
        b_bnd = m["baseline_null"]["boundary_pred_to_bgt_median_m"] or 0.0
        f_bnd = m["full_reconstruction"]["boundary_pred_to_bgt_median_m"] or 0.0
        o_iou = m["bgt_oracle_width_diagnostic"]["iou"]
        print(
            f"{sid:<6} | {b_iou:8.4f} | {w_iou:9.4f} | {j_iou:8.4f} | "
            f"{f_iou:8.4f} | {delta:+7.4f} | {b_bnd:10.3f} | {f_bnd:10.3f} | {o_iou:8.4f}"
        )
    print("-" * len(header))
    s = eval_report["summary_by_mode"]
    mean_delta = s["full_reconstruction"]["mean_iou"] - s["baseline_null"]["mean_iou"]
    print(
        f"{'MEAN':<6} | {s['baseline_null']['mean_iou']:8.4f} | "
        f"{s['width_asymmetric_only']['mean_iou']:9.4f} | "
        f"{s['junction_only']['mean_iou']:8.4f} | "
        f"{s['full_reconstruction']['mean_iou']:8.4f} | "
        f"{mean_delta:+7.4f} | "
        f"{s['baseline_null']['mean_boundary_pred_to_bgt_median_m']:10.3f} | "
        f"{s['full_reconstruction']['mean_boundary_pred_to_bgt_median_m']:10.3f} | "
        f"{s['bgt_oracle_width_diagnostic']['mean_iou']:8.4f}"
    )
    print("*Oracle uses BGT cross-sectional widths (DATA LEAKAGE diagnostic only).\n")


if __name__ == "__main__":
    base_dir = Path(__file__).resolve().parent
    archive_dir = base_dir / "baseline_archive"
    output_dir = base_dir / "outputs"
    output_dir.mkdir(parents=True, exist_ok=True)

    dev_sites = json.loads((archive_dir / "pilot_sites.json").read_text(encoding="utf-8"))["sites"]
    dev_osm = json.loads((archive_dir / "pilot_osm.geojson").read_text(encoding="utf-8"))[
        "features"
    ]
    dev_bgt_cache = archive_dir / "bgt_cache"

    dev_report = evaluate_site_collection(
        dev_sites, dev_osm, dev_bgt_cache, output_dir, split_name="development_amsterdam"
    )
    print_evaluation_table(dev_report)

    holdout_dir = base_dir / "holdout_data"
    holdout_sites_path = holdout_dir / "holdout_sites.json"
    holdout_osm_path = holdout_dir / "holdout_osm.geojson"
    holdout_bgt_cache = holdout_dir / "bgt_cache"

    combined_report: Dict[str, Any] = {"development": dev_report}
    if holdout_sites_path.exists() and holdout_osm_path.exists():
        h_sites = json.loads(holdout_sites_path.read_text(encoding="utf-8"))["sites"]
        h_osm = json.loads(holdout_osm_path.read_text(encoding="utf-8"))["features"]
        holdout_report = evaluate_site_collection(
            h_sites, h_osm, holdout_bgt_cache, output_dir, split_name="holdout_unseen"
        )
        print_evaluation_table(holdout_report)
        combined_report["holdout"] = holdout_report

    (output_dir / "evaluation_results.json").write_text(
        json.dumps(combined_report, indent=2), encoding="utf-8"
    )
