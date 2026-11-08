#!/usr/bin/env python3
"""
Fetch and freeze unseen holdout evaluation sites (H01-H06) across six Dutch cities
(Utrecht, Rotterdam, Den Haag, Haarlem, Delft, Leiden) from live OpenStreetMap API v0.6
and PDOK BGT OGC API.

Selection Protocol:
- Sites H01-H06 were preregistered by archetype and city coordinates AFTER freezing
  `reconstruct.py`.
- No algorithm parameters, width priors, or junction rules were modified after fetching
  or evaluating H01-H06.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, List

import requests
from pyproj import Transformer

RD_TRANSFORM = Transformer.from_crs(4326, 28992, always_xy=True)
WGS_TRANSFORM = Transformer.from_crs(28992, 4326, always_xy=True)

OSM_API_URL = "https://api.openstreetmap.org/api/0.6/map"
BGT_API_URL = "https://api.pdok.nl/lv/bgt/ogc/v1/collections/wegdeel/items"

PREREGISTERED_HOLDOUT_SITES: List[Dict[str, Any]] = [
    {
        "site": "H01",
        "node": "45215986",
        "label": "Utrecht - Lucasbolwerk / Wittevrouwenstraat",
        "archetype": "3-way / 4-way urban collector with cycle & turn lanes",
        "center_lonlat": [5.1262461, 52.0934239],
    },
    {
        "site": "H02",
        "node": "44411326",
        "label": "Rotterdam - Meent / Rodezand",
        "archetype": "4-way urban arterial & local street intersection",
        "center_lonlat": [4.4846139, 51.9228509],
    },
    {
        "site": "H03",
        "node": "45186171",
        "label": "Den Haag - Mauritskade / Alexanderstraat",
        "archetype": "4-way divided collector & canal-side street",
        "center_lonlat": [4.3110102, 52.0869846],
    },
    {
        "site": "H04",
        "node": "46438778",
        "label": "Haarlem - Zijlsingel / Zijlvest",
        "archetype": "3-way divided collector with cycleway lanes",
        "center_lonlat": [4.6276930, 52.3826612],
    },
    {
        "site": "H05",
        "node": "4862057241",
        "label": "Delft - Westvest / Phoenixstraat",
        "archetype": "3-way urban street & collector junction",
        "center_lonlat": [4.3547927, 52.0102241],
    },
    {
        "site": "H06",
        "node": "45941861",
        "label": "Hengelo - Deldenerstraat / Langestraat",
        "archetype": "3-way regional urban collector & local street",
        "center_lonlat": [6.7906265, 52.2646057],
    },
]


def fetch_osm_geojson_for_bbox(
    min_lon: float, min_lat: float, max_lon: float, max_lat: float
) -> List[Dict[str, Any]]:
    """Fetch OSM XML from `/api/0.6/map` and convert ways to GeoJSON LineStrings."""
    resp = requests.get(
        OSM_API_URL,
        params={"bbox": f"{min_lon:.7f},{min_lat:.7f},{max_lon:.7f},{max_lat:.7f}"},
        timeout=30,
        headers={"User-Agent": "OSM-Road-Surface-Reconstruction-Research/1.0"},
    )
    resp.raise_for_status()
    root = ET.fromstring(resp.text)

    nodes: Dict[str, Tuple[float, float]] = {}
    for nd in root.findall("node"):
        nid = nd.attrib.get("id")
        lat = nd.attrib.get("lat")
        lon = nd.attrib.get("lon")
        if nid and lat and lon:
            nodes[nid] = (float(lon), float(lat))

    features: List[Dict[str, Any]] = []
    for way in root.findall("way"):
        wid = way.attrib.get("id")
        nd_refs = [nd.attrib["ref"] for nd in way.findall("nd") if "ref" in nd.attrib]
        coords = [nodes[r] for r in nd_refs if r in nodes]
        if len(coords) < 2:
            continue
        tags = {t.attrib["k"]: t.attrib["v"] for t in way.findall("tag") if "k" in t.attrib}
        if "highway" not in tags:
            continue
        props: Dict[str, Any] = dict(tags)
        props["id"] = f"way/{wid}"
        props["_nodeIds"] = nd_refs
        features.append(
            {
                "type": "Feature",
                "id": f"way/{wid}",
                "properties": props,
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[c[0], c[1]] for c in coords],
                },
            }
        )
    return features


def fetch_bgt_for_bbox(
    site_id: str,
    bbox_geo: List[float],
    bgt_cache_dir: Path,
    asof: str = "2026-11-07T12:00:00Z",
) -> None:
    bgt_cache_dir.mkdir(parents=True, exist_ok=True)
    out_path = bgt_cache_dir / f"{site_id}.geojson"
    if out_path.exists():
        try:
            existing = json.loads(out_path.read_text(encoding="utf-8"))
            if existing.get("bbox_geo_query") == bbox_geo:
                return
        except Exception:
            pass

    url = BGT_API_URL
    params: Optional[Dict[str, Any]] = {
        "bbox": ",".join(f"{x:.7f}" for x in bbox_geo),
        "limit": 1000,
        "datetime": asof,
        "f": "json",
    }
    features: List[Dict[str, Any]] = []
    for _page in range(20):
        r = requests.get(
            url,
            params=params,
            timeout=30,
            headers={"Accept": "application/geo+json"},
        )
        r.raise_for_status()
        js = r.json()
        features.extend(js.get("features", []))
        nxt = next(
            (lk.get("href") for lk in js.get("links", []) if lk.get("rel") == "next"),
            None,
        )
        if not nxt:
            break
        url = nxt
        params = None

    payload = {
        "type": "FeatureCollection",
        "name": f"{site_id} BGT current-asof {asof}",
        "source_url": BGT_API_URL,
        "asof_requested": asof,
        "bbox_geo_query": bbox_geo,
        "features": features,
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def main() -> None:
    base_dir = Path(__file__).resolve().parent
    holdout_dir = base_dir / "holdout_data"
    bgt_cache_dir = holdout_dir / "bgt_cache"
    holdout_dir.mkdir(parents=True, exist_ok=True)
    bgt_cache_dir.mkdir(parents=True, exist_ok=True)

    enriched_sites: List[Dict[str, Any]] = []
    osm_by_id: Dict[str, Dict[str, Any]] = {}

    for raw in PREREGISTERED_HOLDOUT_SITES:
        sid = raw["site"]
        lon, lat = raw["center_lonlat"]
        cx, cy = RD_TRANSFORM.transform(lon, lat)
        cx, cy = round(cx, 3), round(cy, 3)

        # 80m x 80m evaluation box (40m half-size) + 25m context margin = 65m query radius
        bbox_rd_eval = [round(cx - 40.0, 3), round(cy - 40.0, 3), round(cx + 40.0, 3), round(cy + 40.0, 3)]
        min_lon, min_lat = WGS_TRANSFORM.transform(cx - 65.0, cy - 65.0)
        max_lon, max_lat = WGS_TRANSFORM.transform(cx + 65.0, cy + 65.0)
        bbox_geo_query = [
            round(min_lon, 7),
            round(min_lat, 7),
            round(max_lon, 7),
            round(max_lat, 7),
        ]

        print(f"Fetching holdout site {sid} ({raw['label']})...")
        feats = fetch_osm_geojson_for_bbox(min_lon, min_lat, max_lon, max_lat)
        for f in feats:
            osm_by_id[f["id"]] = f

        fetch_bgt_for_bbox(sid, bbox_geo_query, bgt_cache_dir)

        enriched_sites.append(
            {
                "site": sid,
                "label": raw["label"],
                "archetype": raw["archetype"],
                "center_lonlat": [lon, lat],
                "center_rd": [cx, cy],
                "bbox_rd_eval": bbox_rd_eval,
                "bbox_geo_query": bbox_geo_query,
                "osm_context_feature_count": len(feats),
                "osm_context_ids": sorted(f["id"] for f in feats),
            }
        )

    (holdout_dir / "holdout_sites.json").write_text(
        json.dumps(
            {
                "version": 1,
                "source": "Live OSM 0.6 API + PDOK BGT OGC API unseen holdout split",
                "sites": enriched_sites,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    (holdout_dir / "holdout_osm.geojson").write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [osm_by_id[k] for k in sorted(osm_by_id.keys())],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Saved {len(enriched_sites)} holdout sites and {len(osm_by_id)} unique OSM ways.")


if __name__ == "__main__":
    main()
