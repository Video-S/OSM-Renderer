# Independent road-surface model: preregistered pilot results

> **Historical Document Notice (2026-11-08)**:  
> This preliminary document recorded the unvalidated pilot baseline before live BGT data download and full model implementation.  
> It has been **superseded** by the full evaluation report in `../REPORT.md` (which evaluated the new model against BGT on 6 Amsterdam and 6 multi-city holdout sites) and the owner's final closure decision (**Closed — Not Adopted**).

**Date:** 2026-11-07

## Status

**OSM-only pilot complete; independent BGT comparison blocked by live-feature download access in the current execution environment.** No measured agreement with physical road polygons exists yet. No production renderer, E2 algorithm, or renderer fixture is imported.

The null model and six holdout locations were fixed before any BGT road polygons were inspected. The selection uses original OSM node IDs from an uploaded, untuned Amsterdam extract; it avoids the previously corrected southern Prins Hendrikkade fork. The source is urban-only and biased to the coverage of that extract; this is exploratory, not a random national sample.

## Sample

| Site | OSM node | Map context | Contributing ways | Predicted area (m²) |
|---|---|---|---:|---:|
| A01 | 46423905 | Droogbak / Singel, urban 3-way | 25 | 1,624.82 |
| A02 | 46426685 | Nieuwe Westerdokstraat, 3-way | 16 | 1,740.28 |
| A03 | 11762209393 | Geldersekade, 3-way | 13 | 1,087.61 |
| A04 | 1565648183 | Oosterdoksstraat, 3-way | 10 | 592.95 |
| A05 | 46416772 | De Ruijterkade, four-way | 15 | 1,555.82 |
| A06 | 46438541 | Buiksloterweg, three-way | 8 | 828.95 |

These surface areas are **predictions under our hypothetical width priors**, not observed carriageway areas.

## Finding 1 — Physical width is poorly identified

Across 87 contributing road-way observations (some original OSM ways can be used in multiple sites):

- **8** (9%) specify explicit `width=*`.
- **42** (48%) specify `lanes=*` but still require an assumed width per lane.
- **37** (43%) specify neither and fall back entirely to highway-class priors.
- **11** additionally have `placement=*`, so the OSM polyline may not represent the true road-surface center even when a lane count is known.

Thus the corridor polygon is substantially underdetermined before any intersection smoothing is attempted. The 3.2 m lane assumption is an illustrative hypothesis, not a proven Dutch road width. This is the central research result of this stage.

## Finding 2 — Reasonable polygon topology does not imply physical accuracy

The six polygon maps can be generated reproducibly from OSM and the frozen neutral model. They include distinct parallel corridors and unfilled spaces. That does **not** establish that the spaces correspond to real medians or that inferred road widths match BGT. A polygon engine can be completely valid while producing the wrong physical footprint.

## Necessary independent checks

1. Obtain road polygons from PDOK BGT `wegdeel`, with a correct as-of date, ground-level filtering, status and historical-version audit, and vehicle-carriageway function mapping.
2. Verify the projected OSM/BGT overlay visually for systematic source misalignment. Report function distributions, missing properties and temporal ambiguities.
3. Only then compute IoU, false-road/missing-road areas, and two-way boundary displacement **for each location separately**. Check sensitivity to ±20% width changes, without tuning widths to the measured BGT sample.
4. Investigate failures by cause: source width/placement, coverage, cartographic class mismatch, separated carriageways, islands or junction surface.
5. Preselect new locations for confirmation before proposing a better model. Do not add arbitrary transitions merely to improve these six scores.

## Engineering decision

**No model upgrade is justified yet.** We have evidence of substantial missing source measurements, but **not** quantitative evidence that symmetric-buffer construction, explicit junction types, or variable-width offsets outperform the alternative on real road polygons. Those remain competing hypotheses until independent comparison is possible.

## Limitations and source provenance

Pilot uses OSM data from user-supplied Amsterdam extract. BGT API capabilities and history issue were confirmed from PDOK's published documentation, but the actual feature extraction did not succeed because network access to live PDOK bbox item responses is blocked in this environment. The script's BGT ingestion path is therefore **not verified end-to-end**. No accuracy numbers have been fabricated.

References: https://www.pdok.nl/ogc-apis/-/article/basisregistratie-grootschalige-topografie-bgt-, https://api.pdok.nl/lv/bgt/ogc/v1/, https://doi.org/10.1371/journal.pone.0262801 .
