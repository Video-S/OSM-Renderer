# Independent road-reconstruction validation pilot

> **Historical Pilot Archive Note (2026-11-08)**:  
> This sub-archive contains the initial frozen null-baseline pilot assets (2026-11-07).  
> The tentative preliminary notes below have been **superseded** by the completed end-to-end BGT evaluation across the 6 Amsterdam development sites (`A01`–`A06`) and 6 multi-city holdout sites (`H01`–`H06`).  
> See `../REPORT.md` and `../README.md` for the final benchmark results, ablation analysis, and the owner's decision (**Closed — Not Adopted**).

**Research freeze:** 2026-11-07. **No OSM-Renderer E2 implementation used.**

## Purpose

Test whether a deliberately simple, symmetric road-corridor model reconstructs independently mapped *at-grade vehicle carriageways*. This is a null model. A low agreement with BGT can mean bad inferred widths, centerline placement, missing OSM ways, filtering differences or junction geometry; inspect individual features before attributing a failure to any one cause.

## Files

- `pilot_sites.json`: six **preselected and untouched** Amsterdam junctions, explicit OSM node IDs, evaluation boxes in EPSG:28992, source provenance.
- `pilot_osm.geojson`: unmodified original OSM way features intersecting at least one site context box, including OSM tags and per-vertex node IDs.
- `bgt_compare.py`: neutral symmetric-buffer model, BGT download, effective-date/history audit, apples-to-apples carriageway filtering, scores, width sensitivity.
- `results/pilot_results.json`: **OSM-only preliminary footprint report; BGT not yet downloaded or validated**.
- `results/osm_null_surfaces.geojson`: OSM-only symmetric corridors; **not verified against physical surfaces**.
- `osm_baseline_preview.png`: six-site preliminary visualization.
- `plot_osm_baselines.py`: reproduce the plot.
- `PRELIMINARY_FINDINGS.md`: interpretation and stop conditions.

## To run with live independent reference data

```bash
python -m pip install shapely pyproj requests matplotlib
python bgt_compare.py
```

This requires network access to PDOK's `wegdeel` OGC API. It downloads BGT feature results for the six fixed boxes to `bgt_cache/A01.geojson`, etc. It then writes measured IoU, false-road area, missing-road area, bidirectional boundary distances, and ±20% width sensitivity to `results/pilot_results.json`.

To re-run from the cached BGT files with no network:

```bash
python bgt_compare.py --bgt-dir bgt_cache
```

To reproduce the baseline **without BGT**, never call it evidence of accuracy:

```bash
python bgt_compare.py --preview-only
python plot_osm_baselines.py
```

BGT access could **not** be completed in the assistant's runtime. The BGT scoring path and temporal queries are written but **have not been end-to-end validated** against a live service response. In particular, the output must be inspected for historical-version selection, object classification and projection/feature alignment before drawing accuracy conclusions. An HTTP failure is a blocker, not zero error.

## Frozen reconstruction assumptions (not measured facts)

1. All qualifying OSM `way` LineStrings are interpreted as road reference lines. Level-separated roads are excluded where tagged.
2. Each section is buffered symmetrically, with a flat endpoint and mitered corners. The local model is the geometric union. No sophisticated junction geometry is added.
3. `width=*` is used when parseable; otherwise `lanes=* × 3.2 m`; otherwise a fixed highway-class prior, explicitly enumerated in `bgt_compare.py`.
4. The expected BGT target consists only of suitable ground-level `wegdeel` functions for motor-vehicle roadways (`rijbaan lokale weg`, `rijbaan regionale weg`, `rijbaan autosnelweg`, etc.). It excludes separate cycle tracks, sidewalks, parking areas and verges. These classes may not perfectly coincide with OSM semantics.
5. Each evaluation box is **80×80 m** in the Dutch RD New metric CRS. All geometry is clipped to that box, and reference surfaces are queried with additional context.
6. BGT data must be requested for a specific date; end-registration and termination flags must be audited, and duplicate active `lokaal_id` must cause failure rather than arbitrary selection.

## Model-selection discipline

**Do not adjust priors, geometry construction, sample locations, or BGT feature classes after seeing the comparison results and then score on these same six sites.** Any changes must be evaluated on new untouched sites, with the alteration and reason documented first. This pilot is for failure analysis, not a claim of statistical representativeness of the Netherlands.

## Attribution

OSM input: © OpenStreetMap contributors; ODbL, https://www.openstreetmap.org/copyright .
BGT source: Kadaster / PDOK, CC0, https://api.pdok.nl/lv/bgt/ogc/v1/ .

Relevant research: Vitalis, Labetski, Ledoux & Stoter (2022), *From road centrelines to carriageways—A reconstruction algorithm*, https://doi.org/10.1371/journal.pone.0262801 .
