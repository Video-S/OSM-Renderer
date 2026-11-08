# Independent Road-Surface & Junction Reconstruction Prototype

This directory (`research/road-surface-reconstruction/`) contains a standalone, mathematically documented research prototype for reconstructing physical motor-vehicle road surfaces and junction geometry from OpenStreetMap (OSM) data, evaluated against independent Dutch **BGT** (*Basisregistratie Grootschalige Topografie*) road-surface polygons.

> **Isolation Guarantee**: This implementation is completely independent of the production TypeScript renderer and Stage E2 (`src/world/infrastructure/roads/GraphRoadGeometryBuilder.ts`). It does not import, modify, or target any production renderer code or fixtures.

---

## Directory Structure

- `reconstruct.py` — Standalone reconstruction engine implementing reference curves, independent left/right lateral offset profiles $(w_L(s), w_R(s))$, hierarchical OSM width/lane/cycleway/placement inference, topological continuation propagation, tangent quadratic Bézier junction curb fillets, `placement=transition` taper flares, physical traffic island preservation, and explicit constraint/fallback recording.
- `evaluate.py` — Reproducible evaluation benchmark comparing four predictive OSM-only modes (`baseline_null`, `width_asymmetric_only`, `junction_only`, `full_reconstruction`) and one clearly labeled data-leakage diagnostic (`bgt_oracle_width_diagnostic`) across the 6 Amsterdam development sites (`A01`–`A06`) and 6 unseen multi-city Dutch holdout sites (`H01`–`H06`).
- `fetch_holdout_data.py` — Script that fetches and freezes the 6 unseen holdout intersections (`H01`–`H06`: Utrecht, Rotterdam, Den Haag, Haarlem, Delft, Hengelo) from the live OSM v0.6 API and PDOK BGT OGC API.
- `plot_comparisons.py` — Generates side-by-side visual diagnostic overlays (`figures/dev_sites_comparison.png` and `figures/holdout_sites_comparison.png`).
- `tests/test_reconstruction.py` — Automated `pytest` suite testing polygon validity, finite coordinates, permutation determinism, asymmetric `placement=*` offsets, topological continuation, corner curb fillets, splitter island preservation, and degenerate fallback handling.
- `MODEL.md` — Mathematical formulation, offset equations, junction construction rules, documented tolerances, and fallback hierarchy.
- `REPORT.md` — Full quantitative evaluation report on development (`A01`–`A06`) and unseen holdout (`H01`–`H06`) splits, ablation analysis, failure cases, and engineering recommendation.
- `baseline_archive/` — Extracted pilot archive (`pilot_sites.json`, `pilot_osm.geojson`, `bgt_compare.py`, `PRELIMINARY_FINDINGS.md`, and cached BGT reference polygons for `A01`–`A06`).
- `holdout_data/` — Frozen unseen holdout dataset (`holdout_sites.json`, `holdout_osm.geojson`, and `bgt_cache/H01.geojson`..`H06.geojson`).
- `outputs/` — Quantitative evaluation JSON (`evaluation_results.json`) and reconstructed GeoJSON FeatureCollections (`reconstructed_geojson/`) in `EPSG:28992`.
- `figures/` — Visual comparison plots (`dev_sites_comparison.png`, `holdout_sites_comparison.png`, `baseline_vs_bgt_dev.png`).

---

## GeoJSON Input / Output Contract

- **Input**: GeoJSON `FeatureCollection` of OSM `LineString` ways in `EPSG:4326` (default) or `EPSG:28992` carrying standard OSM tags (`highway`, `oneway`, `lanes`, `lanes:forward`, `lanes:backward`, `turn:lanes`, `width`, `width:carriageway`, `placement`, `placement:start`, `placement:end`, `cycleway*`, `layer`, `bridge`, `tunnel`).
- **Output**: GeoJSON `FeatureCollection` in metric projected coordinates (`EPSG:28992`, Amersfoort / RD New meters) containing:
  1. `feature_kind = "reconstructed_surface"`: The unified physical road surface (`Polygon` or `MultiPolygon`) with area and summary `ReconstructionDiagnostics`.
  2. `feature_kind = "road_corridor"`: Individual reconstructed road segments with explicit left/right start/end offsets (`width_left_start_m`, `width_right_start_m`, `width_left_end_m`, `width_right_end_m`), `width_source`, `placement_source`, `inferred_lanes`, `uncertainty_m`, `assumptions`, and `fallback_used`.
  3. `feature_kind = "junction_surface"`: Individual reconstructed junction polygons with `node_id`, `degree`, `incident_edges`, `fillet_count`, `transition_flare_count`, and `fallback_reasons`.

---

## Reproducing Results & Running Tests

Using the Python 3.10+ virtual environment (`shapely`, `pyproj`, `matplotlib`, `numpy`, `scipy`, `pytest`, `requests`):

```bash
# 1. Run automated unit and regression tests
/tmp/pyvenv/bin/pytest research/road-surface-reconstruction/tests/ -v

# 2. Run full quantitative evaluation on Development (A01-A06) and Holdout (H01-H06) splits
/tmp/pyvenv/bin/python research/road-surface-reconstruction/evaluate.py

# 3. Regenerate visual comparison figures
/tmp/pyvenv/bin/python research/road-surface-reconstruction/plot_comparisons.py

# 4. Run standalone CLI reconstruction on any OSM GeoJSON file
/tmp/pyvenv/bin/python research/road-surface-reconstruction/reconstruct.py \
  --input research/road-surface-reconstruction/baseline_archive/pilot_osm.geojson \
  --output /tmp/a03_reconstructed.geojson \
  --site-id A03 \
  --mode full_reconstruction
```
