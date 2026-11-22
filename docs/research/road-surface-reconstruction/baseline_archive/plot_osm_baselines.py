#!/usr/bin/env python3
"""OSM-only null-model visual overview (not independent validation)."""
import json,collections
from pathlib import Path
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon as MPLPolygon
from shapely.geometry import shape, box
from shapely.ops import transform
from pyproj import Transformer
from bgt_compare import corridor_union, RD, HERE

sites=json.loads((HERE/'pilot_sites.json').read_text())['sites']
roads=[(f,transform(RD,shape(f['geometry']))) for f in json.loads((HERE/'pilot_osm.geojson').read_text())['features']]
fig,axes=plt.subplots(2,3,figsize=(13,8.3))
for ax,s in zip(axes.flat,sites):
 x,y=s['center_rd']; bounds=box(x-40,y-40,x+40,y+40)
 pred,audit,_,_=corridor_union(roads,bounds,1)
 if pred.geom_type=='Polygon':polys=[pred]
 else:polys=list(pred.geoms) if hasattr(pred,'geoms') else []
 for p in polys:
  if p.geom_type!='Polygon':continue
  xx,yy=p.exterior.xy
  ax.fill([v-x for v in xx],[v-y for v in yy],alpha=.42,color='#566573',zorder=2)
  ax.plot([v-x for v in xx],[v-y for v in yy],color='#283747',linewidth=.65,zorder=3)
  for ring in p.interiors:
   xx,yy=ring.xy
   ax.fill([v-x for v in xx],[v-y for v in yy],color='white',zorder=3)
 for f,line in roads:
  if not line.intersects(bounds):continue
  part=line.intersection(bounds)
  if part.geom_type=='LineString':ls=[part]
  elif hasattr(part,'geoms'):ls=[g for g in part.geoms if g.geom_type=='LineString']
  else:ls=[]
  for g in ls:
   xx,yy=g.xy
   ax.plot([v-x for v in xx],[v-y for v in yy],color='#C06C24',linewidth=1.15,zorder=4)
 ax.scatter([0],[0],marker='+',s=45,color='#cc2222',zorder=5)
 ax.set_title(f"{s['site']} · {s['label']}",fontsize=11)
 ax.set_xlim(-40,40);ax.set_ylim(-40,40);ax.set_aspect('equal')
 ax.set_xticks([-40,-20,0,20,40]);ax.set_yticks([-40,-20,0,20,40]);ax.grid(alpha=.12)
 ax.set_xlabel('RD X offset (m)',fontsize=8);ax.set_ylabel('RD Y offset (m)',fontsize=8)
fig.suptitle('Independent pilot: symmetric OSM corridor null model  ·  NO BGT validation yet',fontsize=14)
fig.text(.5,.015,'Grey = assumed road surface; amber = OSM reference line; red + = preregistered junction. Widths are inferred, not measured.',ha='center',fontsize=9)
fig.tight_layout(rect=(0,.04,1,.96))
out=HERE/'osm_baseline_preview.png';fig.savefig(out,dpi=160);print(out)
