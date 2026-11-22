#!/usr/bin/env python3
"""Independent OSM corridor vs BGT road-area pilot.

Does NOT import the OSM-Renderer or tune widths to BGT. Model and holdout sites
are frozen in pilot_sites.json. The BGT download requires Internet access.

Usage:
  python bgt_compare.py --preview-only
  python bgt_compare.py                       # GET live current BGT (requires Internet)
  python bgt_compare.py --bgt-dir ./bgt_cache # use previously downloaded raw BGT GeoJSON
"""
from __future__ import annotations
import argparse, collections, datetime as dt, json, math, time
from pathlib import Path
from shapely.geometry import shape, mapping, box, LineString
from shapely.ops import unary_union, transform
from pyproj import Transformer

HERE=Path(__file__).resolve().parent
RD=Transformer.from_crs(4326, 28992, always_xy=True).transform
WGS=Transformer.from_crs(28992, 4326, always_xy=True).transform
BGT_API='https://api.pdok.nl/lv/bgt/ogc/v1/collections/wegdeel/items'
# BGT road functions include more than these; only compare like-with-like
# at-grade motor-vehicle carriageway. Unsupported functions are audited.
VEHICULAR_BGT_FUNCTIONS={
    'rijbaan lokale weg', 'rijbaan regionale weg', 'rijbaan autosnelweg',
    'verbindingsweg', 'rijbaan autoweg',
}
VEHICLE_OSM_CLASSES={
    'motorway','motorway_link','trunk','trunk_link','primary','primary_link',
    'secondary','secondary_link','tertiary','tertiary_link','unclassified',
    'residential','service','living_street',
}
# NON-EMPIRICAL preregistered assumptions, not calibrated to BGT.
DEFAULT_WIDTH={
    'motorway':11.0, 'motorway_link':4.0, 'trunk':8.0, 'trunk_link':4.0,
    'primary':7.0, 'primary_link':4.0, 'secondary':6.5, 'secondary_link':4.0,
    'tertiary':6.0, 'tertiary_link':4.0, 'residential':5.3,
    'unclassified':5.3, 'service':3.5, 'living_street':5.0,
}

def load(path):
    with Path(path).open(encoding='utf-8') as f:return json.load(f)

def inferred_width(props):
    raw=props.get('width')
    if raw is not None:
        try:
            x=float(str(raw).strip().lower().replace('m','').replace(',','.'))
            if 1.5<=x<=40: return x,'explicit_width'
        except (ValueError,TypeError):pass
    lanes=props.get('lanes')
    if lanes is not None:
        try:
            n=int(str(lanes))
            if 1<=n<=8: return n*3.2,'lane_count_times_3.2m'
        except (ValueError,TypeError):pass
    return DEFAULT_WIDTH[props['highway']],'unobserved_class_prior'

def clean_geom(g):
    if g.is_empty:return g
    if not g.is_valid:g=g.buffer(0)
    return g

def corridor_union(roads, clip, factor):
    geometries=[]; audit=collections.Counter(); widths=[]; src=[]
    querybox=clip.buffer(25)
    for f,geo in roads:
        if not geo.intersects(querybox):continue
        p=f.get('properties') or {}
        if p.get('highway') not in VEHICLE_OSM_CLASSES:continue
        if str(p.get('layer','0')) not in ('0','0.0'):continue
        if p.get('bridge') in ('yes','viaduct') or p.get('tunnel') in ('yes','building_passage'):continue
        width,method=inferred_width(p)
        # The symmetric ribbon is ONLY a deliberately simple null hypothesis.
        # Flat end caps, miter joins; union means no invented inside curbs.
        c=geo.buffer(width*factor/2,cap_style='flat',join_style='mitre',mitre_limit=2.0)
        c=clean_geom(c.intersection(clip))
        if not c.is_empty:
            audit[method]+=1
            if p.get('placement'):audit['placement_tag_present']+=1
            if not p.get('lanes') and not p.get('width'):audit['unknown_lanes_and_width']+=1
            geometries.append(c);widths.append(width*factor);src.append(f.get('id'))
    u=clean_geom(unary_union(geometries)) if geometries else clip.intersection(box(0,0,0,0))
    return u,dict(audit),widths,src

def classify_bgt(features,clip):
    valid=[]; audit=collections.Counter(); used=[]
    ids=set()
    for f in features:
        p=f.get('properties') or {}
        audit['all_features']+=1
        # The service includes historical records! Never merge historic versions.
        if p.get('eind_registratie') not in (None,''):
            audit['history_registration_ended']+=1;continue
        if p.get('termination_date') not in (None,''):
            audit['history_terminated']+=1;continue
        if p.get('status') not in (None,'bestaand'):
            audit['wrong_status']+=1;continue
        if str(p.get('relatieve_hoogteligging',0)) not in ('0','0.0'):
            audit['not_ground_level']+=1;continue
        functie=str(p.get('functie') or '')
        audit['function:'+functie]+=1
        if functie not in VEHICULAR_BGT_FUNCTIONS:continue
        key=p.get('lokaal_id') or f.get('id')
        if key in ids:
            audit['duplicate_active_id']+=1;continue
        ids.add(key)
        try:g=transform(RD,shape(f['geometry']))
        except Exception:
            audit['invalid_geometry']+=1;continue
        if g.is_empty:continue
        part=clean_geom(g.intersection(clip))
        if part.is_empty:continue
        valid.append(part); used.append(str(key));audit['accepted_polygons']+=1
    if audit['duplicate_active_id']:
        raise RuntimeError('Multiple current BGT versions for the same loka(a)l_id: explicit temporal resolution required')
    return clean_geom(unary_union(valid)) if valid else None, dict(audit),used

def percentile(values,q):
    if not values:return None
    values.sort()
    return values[min(len(values)-1, round((len(values)-1)*q))]

def boundary_error(geom,other,clip,spacing=1.0):
    if geom.is_empty or other.is_empty:return None
    # Ignore the artificial edges created when the sample is clipped to 80m.
    lines=geom.boundary.intersection(clip.buffer(-1.5))
    if lines.is_empty:return None
    if lines.geom_type=='LineString':segments=[lines]
    elif hasattr(lines,'geoms'):segments=[x for x in lines.geoms if x.geom_type=='LineString']
    else:segments=[]
    distances=[]
    for seg in segments:
        n=max(1, math.ceil(seg.length/spacing))
        distances.extend(seg.interpolate(i/n,normalized=True).distance(other.boundary) for i in range(n+1))
    return {'median_m':round(percentile(distances,0.5),3),'p90_m':round(percentile(distances,0.9),3),'sample_count':len(distances)} if distances else None

def metrics(pred,true,clip):
    overlap=pred.intersection(true).area
    extra=pred.difference(true).area
    missing=true.difference(pred).area
    return {'intersection_over_union':round(overlap/(overlap+extra+missing),4) if overlap+extra+missing>0 else None,
            'carriageway_precision':round(overlap/pred.area,4) if pred.area else None,
            'carriageway_recall':round(overlap/true.area,4) if true.area else None,
            'modeled_m2':round(pred.area,2),'BGT_carriageway_m2':round(true.area,2),
            'false_road_m2':round(extra,2),'missed_road_m2':round(missing,2),
            'prediction_to_BGT_boundary':boundary_error(pred,true,clip),
            'BGT_to_prediction_boundary':boundary_error(true,pred,clip)}

def fetch_bgt(site,outdir,asof='2026-11-07T12:00:00Z'):
    import requests
    outdir.mkdir(parents=True,exist_ok=True)
    path=outdir/(site['site']+'.geojson')
    if path.exists():return load(path)
    bbox=site['bbox_geo_query'];url=BGT_API
    params={'bbox':','.join(str(x) for x in bbox),'limit':1000,
            'datetime':asof,'f':'json'}
    fs=[]
    for page in range(20):
        r=requests.get(url,params=params,timeout=25,headers={'Accept':'application/geo+json'})
        r.raise_for_status();js=r.json()
        if js.get('type')!='FeatureCollection':raise ValueError('Not a BGT feature collection')
        fs.extend(js.get('features',[]))
        nxt=next((link.get('href') for link in js.get('links',[]) if link.get('rel')=='next'),None)
        if not nxt:break
        url=nxt;params=None
    else:raise RuntimeError('Too many pages; narrow bbox')
    if not fs:raise RuntimeError('No BGT road polygons. Check API or bounding box.')
    result={'type':'FeatureCollection','name':site['site']+' BGT current-asof '+asof,
            'source_url':BGT_API,'asof_requested':asof,'features':fs}
    path.write_text(json.dumps(result,ensure_ascii=False))
    return result

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--preview-only',action='store_true',help='OSM null model only; do NOT report validation scores')
    ap.add_argument('--bgt-dir',type=Path,default=HERE/'bgt_cache')
    ap.add_argument('--out',type=Path,default=HERE/'results')
    args=ap.parse_args()
    sites=load(HERE/'pilot_sites.json')['sites']
    roads=[]
    for f in load(HERE/'pilot_osm.geojson')['features']:
        try:roads.append((f,transform(RD,shape(f['geometry']))))
        except Exception:pass
    args.out.mkdir(exist_ok=True,parents=True)
    allresults=[];base_geo=[]
    for site in sites:
        x,y=site['center_rd'];clip=box(x-40,y-40,x+40,y+40)
        pred,audit,widths,ids=corridor_union(roads,clip,1.0)
        if not pred.is_empty:
            base_geo.append({'type':'Feature','properties':{'site':site['site'],'model':'symmetric-width-null','source':'OSM only, NOT BGT validated'},'geometry':mapping(transform(WGS,pred))})
        row={'site':site['site'],'label':site['label'],'node':site['node'],'source_way_count':len(ids),
             'width_evidence':audit,'modeled_area_m2':round(pred.area,2),'status':'UNVALIDATED_OSM_ONLY'}
        if not args.preview_only:
            bgt=fetch_bgt(site,args.bgt_dir)
            truth,meta,used=classify_bgt(bgt['features'],clip)
            row.update({'bgt_filter_audit':meta,'bgt_ids':used})
            if truth is None:
                row['status']='UNSCORABLE_NO_COMPARABLE_BGT_POLYGONS'
            else:
                row['status']='BGT_COMPARED'
                row['metrics']=metrics(pred,truth,clip)
                row['width_sensitivity']={str(factor):metrics(corridor_union(roads,clip,factor)[0],truth,clip)['intersection_over_union'] for factor in [0.8,1.0,1.2]}
        allresults.append(row)
    (args.out/'pilot_results.json').write_text(json.dumps({'method':'OSM null corridor model, without any production renderer use','bgt_retrieved':not args.preview_only,'sites':allresults},indent=2))
    (args.out/'osm_null_surfaces.geojson').write_text(json.dumps({'type':'FeatureCollection','features':base_geo}))
    print('Recorded',len(allresults),'sites. BGT validated?',not args.preview_only)
    for row in allresults:print(row['site'],row['source_way_count'],'OSM source ways, area',row['modeled_area_m2'],'m2,',row['status'])
if __name__=='__main__':main()
