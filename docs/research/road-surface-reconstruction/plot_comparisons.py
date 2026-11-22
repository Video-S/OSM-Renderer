#!/usr/bin/env python3
"""
Generate visual comparison figures overlaying BGT reference road polygons,
the Null Baseline (`baseline_null`), and the Full Reconstruction (`full_reconstruction`)
for both the Amsterdam development sites (A01-A06) and unseen holdout sites (H01-H06).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import matplotlib.patches as mpatches
import matplotlib.pyplot as plt
from shapely.geometry import LineString, MultiPolygon, Polygon, box

from evaluate import classify_bgt, clean_geom
from reconstruct import reconstruct_road_surface


def plot_shapely_poly(
    ax: plt.Axes,
    geom: Polygon | MultiPolygon,
    facecolor: str,
    edgecolor: str = "none",
    alpha: float = 0.6,
    lw: float = 0.8,
    zorder: int = 2,
) -> None:
    if geom is None or geom.is_empty:
        return
    polys = [geom] if isinstance(geom, Polygon) else list(getattr(geom, "geoms", []))
    for poly in polys:
        if poly.is_empty:
            continue
        x, y = poly.exterior.xy
        ax.fill(x, y, facecolor=facecolor, edgecolor=edgecolor, alpha=alpha, linewidth=lw, zorder=zorder)
        for ring in poly.interiors:
            ix, iy = ring.xy
            ax.fill(ix, iy, facecolor="#f8fafc", edgecolor=edgecolor, alpha=1.0, linewidth=lw, zorder=zorder + 1)


def render_split_comparison_grid(
    sites_meta: List[Dict[str, Any]],
    osm_features: List[Dict[str, Any]],
    bgt_cache_dir: Path,
    eval_sites_report: Dict[str, Any],
    output_path: Path,
    title: str,
) -> None:
    n_sites = len(sites_meta)
    fig, axes = plt.subplots(n_sites, 2, figsize=(13, 3.6 * n_sites), dpi=140)
    if n_sites == 1:
        axes = [axes]

    fig.suptitle(title, fontsize=14, fontweight="bold", y=0.992)

    for row_idx, site in enumerate(sites_meta):
        sid = site.get("site") or site.get("site_id") or site["id"]
        cx, cy = site["center_rd"]
        half_w = float(site.get("eval_half_size_m", 40.0))
        clip_poly = box(cx - half_w, cy - half_w, cx + half_w, cy + half_w)

        bgt_path = bgt_cache_dir / f"{sid}.geojson"
        bgt_fc = json.loads(bgt_path.read_text(encoding="utf-8"))
        bgt_surface, _, _ = classify_bgt(bgt_fc.get("features", []), clip_poly)
        if bgt_surface is None:
            bgt_surface = Polygon()

        res_base = reconstruct_road_surface(
            osm_features, site_id=sid, mode="baseline_null", center_rd=(cx, cy), eval_half_size_m=half_w
        )
        res_full = reconstruct_road_surface(
            osm_features, site_id=sid, mode="full_reconstruction", center_rd=(cx, cy), eval_half_size_m=half_w
        )

        m_base = eval_sites_report[sid]["modes"]["baseline_null"]
        m_full = eval_sites_report[sid]["modes"]["full_reconstruction"]

        for col_idx, (mode_label, res, metrics) in enumerate(
            [
                ("Null Baseline (Symmetric Class Prior)", res_base, m_base),
                ("New Reconstruction (Asymmetric + Junctions)", res_full, m_full),
            ]
        ):
            ax = axes[row_idx][col_idx]
            ax.set_facecolor("#f8fafc")

            pred = clean_geom(res.surface_polygon.intersection(clip_poly))
            true = clean_geom(bgt_surface.intersection(clip_poly))

            overlap = clean_geom(pred.intersection(true))
            false_rd = clean_geom(pred.difference(true))
            missed_rd = clean_geom(true.difference(pred))

            plot_shapely_poly(ax, overlap, facecolor="#22c55e", edgecolor="#15803d", alpha=0.65, lw=0.5, zorder=2)
            plot_shapely_poly(ax, missed_rd, facecolor="#3b82f6", edgecolor="#1d4ed8", alpha=0.65, lw=0.5, zorder=3)
            plot_shapely_poly(ax, false_rd, facecolor="#ef4444", edgecolor="#b91c1c", alpha=0.70, lw=0.5, zorder=4)

            # Plot OSM centerlines
            for edge in res.edges:
                line = LineString(edge.coords_rd).intersection(clip_poly)
                if not line.is_empty:
                    segs = [line] if isinstance(line, LineString) else [g for g in getattr(line, "geoms", []) if isinstance(g, LineString)]
                    for seg in segs:
                        lx, ly = seg.xy
                        ax.plot(lx, ly, color="#0f172a", linestyle="--", linewidth=0.9, alpha=0.8, zorder=6)

            ax.set_xlim(cx - half_w, cx + half_w)
            ax.set_ylim(cy - half_w, cy + half_w)
            ax.set_aspect("equal")
            ax.set_xticks([])
            ax.set_yticks([])

            bnd_med = metrics.get("boundary_pred_to_bgt_median_m")
            bnd_str = f"{bnd_med:.2f}m" if bnd_med is not None else "n/a"
            ax.set_title(
                f"{sid} ({site.get('label', sid)}) — {mode_label}\n"
                f"IoU: {metrics['iou']:.4f} | Prec: {metrics['precision']:.3f} | Rec: {metrics['recall']:.3f} | "
                f"False: {metrics['false_road_m2']:.0f}m² | Missed: {metrics['missed_road_m2']:.0f}m² | MedBnd: {bnd_str}",
                fontsize=8.5,
            )

    legend_handles = [
        mpatches.Patch(color="#22c55e", alpha=0.7, label="Agreement (Pred ∩ BGT)"),
        mpatches.Patch(color="#3b82f6", alpha=0.7, label="Missed Road (BGT \\ Pred)"),
        mpatches.Patch(color="#ef4444", alpha=0.7, label="False Road (Pred \\ BGT)"),
    ]
    fig.legend(handles=legend_handles, loc="lower center", ncol=3, fontsize=9.5, frameon=True)
    plt.tight_layout(rect=[0.0, 0.025, 1.0, 0.985])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    plt.savefig(output_path, dpi=140)
    plt.close(fig)


def main() -> None:
    base_dir = Path(__file__).resolve().parent
    archive_dir = base_dir / "baseline_archive"
    holdout_dir = base_dir / "holdout_data"
    figures_dir = base_dir / "figures"
    eval_path = base_dir / "outputs" / "evaluation_results.json"

    eval_data = json.loads(eval_path.read_text(encoding="utf-8"))

    dev_sites = json.loads((archive_dir / "pilot_sites.json").read_text(encoding="utf-8"))["sites"]
    dev_osm = json.loads((archive_dir / "pilot_osm.geojson").read_text(encoding="utf-8"))["features"]
    render_split_comparison_grid(
        dev_sites,
        dev_osm,
        archive_dir / "bgt_cache",
        eval_data["development"]["sites"],
        figures_dir / "dev_sites_comparison.png",
        "Development Sites (A01–A06 Amsterdam): Null Baseline vs. New Reconstruction vs. BGT",
    )

    if "holdout" in eval_data and (holdout_dir / "holdout_sites.json").exists():
        h_sites = json.loads((holdout_dir / "holdout_sites.json").read_text(encoding="utf-8"))["sites"]
        h_osm = json.loads((holdout_dir / "holdout_osm.geojson").read_text(encoding="utf-8"))["features"]
        render_split_comparison_grid(
            h_sites,
            h_osm,
            holdout_dir / "bgt_cache",
            eval_data["holdout"]["sites"],
            figures_dir / "holdout_sites_comparison.png",
            "Unseen Holdout Sites (H01–H06 Multi-City NL): Null Baseline vs. New Reconstruction vs. BGT",
        )


if __name__ == "__main__":
    main()
