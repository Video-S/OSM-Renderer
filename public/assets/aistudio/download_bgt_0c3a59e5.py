#!/usr/bin/env python3
"""Fetch raw PDOK BGT wegdeel polygons for six frozen Amsterdam pilot sites.

Standard Python 3 library only. Does not import or modify the road renderer.
The downloaded BGT features are independent reference data, not training data.

Usage:
    python download_bgt.py
    python download_bgt.py --site A01  # optional connectivity check

Outputs bgt_reference_data.zip ready for upload to the research assistant.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.request import Request, urlopen
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parent
API_BASE = "https://api.pdok.nl/lv/bgt/ogc/v1/collections/wegdeel/items"
SITE_SPEC = ROOT / "pilot_sites.json"
CACHE = ROOT / "bgt_cache"
PACKAGE = ROOT / "bgt_reference_data.zip"
MAX_PAGES = 30


def get_json(url: str) -> dict:
    # Only follow pagination URLs published under PDOK's HTTPS host.
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != "api.pdok.nl":
        raise RuntimeError("Unexpected pagination destination (not PDOK HTTPS): " + url)
    request = Request(url, headers={
        "Accept": "application/geo+json, application/json;q=0.9",
        "User-Agent": "IndependentRoadReconstructionPilot/1.0 (BGT public research)",
    })
    for attempt in range(3):
        try:
            with urlopen(request, timeout=40) as response:
                payload = response.read(30_000_000)
                try:
                    value = json.loads(payload)
                except (UnicodeDecodeError, json.JSONDecodeError) as e:
                    raise RuntimeError(f"PDOK returned non-JSON data at {url}: {e}") from e
                if not isinstance(value, dict):
                    raise RuntimeError("Unexpected PDOK JSON (not an object)")
                return value
        except HTTPError as exc:
            body = exc.read(800).decode("utf-8", "replace")
            if exc.code in (429, 500, 502, 503, 504) and attempt < 2:
                print(f"  HTTP {exc.code}; retrying...", flush=True)
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f"PDOK HTTP {exc.code} at {url}: {body}") from exc
        except (TimeoutError, URLError, OSError) as exc:
            if attempt < 2:
                print(f"  Network problem ({exc}); retrying...", flush=True)
                time.sleep(2 * (attempt + 1))
                continue
            raise RuntimeError(f"Cannot connect to PDOK: {exc}") from exc
    raise AssertionError("Unreachable")


def validate_collection(doc: dict, site: str) -> None:
    if doc.get("type") != "FeatureCollection":
        raise RuntimeError(f"{site}: expected GeoJSON FeatureCollection, got {doc.get('type')!r}")
    items = doc.get("features")
    if not isinstance(items, list) or not items:
        raise RuntimeError(f"{site}: no BGT wegdeel features returned")
    for f in items:
        if f.get("type") != "Feature" or not isinstance(f.get("properties"), dict):
            raise RuntimeError(f"{site}: malformed BGT feature")
        geom = f.get("geometry")
        if not isinstance(geom, dict) or geom.get("type") not in ("Polygon", "MultiPolygon"):
            raise RuntimeError(f"{site}: expected polygon geometry")
        if "functie" not in f["properties"]:
            raise RuntimeError(f"{site}: missing BGT 'functie' classification")


def fetch_site(site: dict) -> dict:
    name = site["site"]
    destination = CACHE / (name + ".geojson")
    if destination.exists():
        doc = json.loads(destination.read_text(encoding="utf-8"))
        validate_collection(doc, name)
        print(f"{name}: using existing verified cache ({len(doc['features'])} features)")
        return doc

    params = urlencode({
        "bbox": ",".join(str(x) for x in site["bbox_geo_query"]),
        "limit": 1000,
        "f": "json",
    })
    url = API_BASE + "?" + params
    visited = set()
    features = []
    for page in range(1, MAX_PAGES + 1):
        if url in visited:
            raise RuntimeError(f"{name}: PDOK pagination loop detected")
        visited.add(url)
        print(f"{name}: requesting page {page} ...", flush=True)
        data = get_json(url)
        if data.get("type") != "FeatureCollection" or not isinstance(data.get("features"), list):
            raise RuntimeError(f"{name}: unexpected API response, expected GeoJSON FeatureCollection")
        features.extend(data["features"])
        next_url = next((link.get("href") for link in data.get("links", [])
                         if isinstance(link, dict) and link.get("rel") == "next"), None)
        if not next_url:
            break
        url = urljoin(url, next_url)
    else:
        raise RuntimeError(f"{name}: reached {MAX_PAGES} pages; refusing incomplete download")

    now = dt.datetime.now(dt.timezone.utc).isoformat()
    doc = {
        "type": "FeatureCollection",
        "name": f"{name} raw PDOK BGT wegdeel",
        "source_url": API_BASE,
        "retrieved_utc": now,
        "query_bbox_crs": "OGC:CRS84 (longitude,latitude)",
        "bbox_requested": site["bbox_geo_query"],
        "data_note": "Raw BGT; historical records may be present; select active versions for scoring",
        "features": features,
    }
    validate_collection(doc, name)
    CACHE.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{name}: saved {len(features)} raw polygons")
    return doc


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", help="Download just one of the six site IDs (e.g., A01)")
    args = parser.parse_args()

    manifest = json.loads(SITE_SPEC.read_text(encoding="utf-8"))
    sites = manifest["sites"]
    if args.site:
        sites = [s for s in sites if s["site"] == args.site.upper()]
        if not sites:
            parser.error("Unknown site: " + args.site)
    try:
        for site in sites:
            fetch_site(site)
        selected = [CACHE / (s["site"] + ".geojson") for s in sites]
        audits = []
        for filename in selected:
            payload = filename.read_bytes()
            doc = json.loads(payload)
            audits.append({"site": filename.stem,
                           "feature_count": len(doc["features"]),
                           "sha256": hashlib.sha256(payload).hexdigest(),
                           "bytes": len(payload)})
        report = {
            "source": API_BASE,
            "research_pilot": "independent OSM corridor reconstruction / six frozen Amsterdam locations",
            "selected_sites": [s["site"] for s in sites],
            "files": audits,
            "note": "Raw BGT geometries only; no quality metrics have been calculated",
        }
        with ZipFile(PACKAGE, "w", compression=ZIP_DEFLATED, compresslevel=7) as zf:
            for filename in selected:
                zf.write(filename, "bgt_cache/" + filename.name)
            zf.writestr("bgt_download_manifest.json", json.dumps(report, indent=2))
            zf.write(SITE_SPEC, SITE_SPEC.name)
        print(f"\nSuccess: {len(selected)} site(s), {sum(x['feature_count'] for x in audits)} raw BGT polygons")
        print(f"Upload this file: {PACKAGE}")
        return 0
    except (RuntimeError, ValueError, KeyError, HTTPError, URLError) as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        print("If this fails, copy the error text to ChatGPT. Do not upload incomplete data.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
