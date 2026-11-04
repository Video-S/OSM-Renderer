import {
  RawGeoJsonProperties,
  RoadClass,
  RailwayType,
  WaterwayType,
  WaterBodyType,
  LanduseType,
  BarrierType,
  LandmarkType,
} from '../types/MapFeature';

export type ClassifiedCategory =
  | 'building'
  | 'road'
  | 'railway'
  | 'water_polygon'
  | 'water_line'
  | 'park'
  | 'landuse'
  | 'barrier'
  | 'landmark'
  | 'unsupported';

export interface ClassificationResult {
  category: ClassifiedCategory;
  primaryTag: string; // e.g. "railway=tram", "waterway=river", "landuse=forest + leaf_type=broadleaved"
  cartoLabel: string; // Human-readable OSM Carto description
  subtype?: string;
  defaultWidth?: number;
  defaultHeight?: number;
  has3DFoliage?: boolean;
  leafType?: 'broadleaved' | 'needleleaved' | 'mixed' | 'leafless';
  buildingArchetype?: 'religious' | 'transit' | 'civic' | 'commercial' | 'industrial' | 'historic' | 'residential';
  isRoofOnly?: boolean;
  isBridge: boolean;
  isTunnel: boolean;
  layer: number;
}

// 1. Explicit Railway & Aerialway Matcher
export const SUPPORTED_RAILWAYS: Record<string, { type: RailwayType; defaultWidth: number; label: string }> = {
  rail: { type: 'rail', defaultWidth: 4.8, label: 'Passenger / Mainline Railway' },
  light_rail: { type: 'light_rail', defaultWidth: 4.0, label: 'Light Rail Line' },
  subway: { type: 'subway', defaultWidth: 4.0, label: 'Subway / Metro Line' },
  tram: { type: 'tram', defaultWidth: 3.2, label: 'Tramway Track' },
  narrow_gauge: { type: 'narrow_gauge', defaultWidth: 3.0, label: 'Narrow Gauge Railway' },
  monorail: { type: 'monorail', defaultWidth: 3.5, label: 'Monorail Track' },
  funicular: { type: 'funicular', defaultWidth: 3.5, label: 'Cable-Driven Inclined Funicular' },
  miniature: { type: 'miniature', defaultWidth: 2.5, label: 'Miniature Railway' },
  construction: { type: 'construction', defaultWidth: 4.4, label: 'Railway Under Construction' },
  disused: { type: 'disused', defaultWidth: 4.0, label: 'Disused Railway' },
  abandoned: { type: 'disused', defaultWidth: 4.0, label: 'Abandoned Railway' },
  preserved: { type: 'rail', defaultWidth: 4.5, label: 'Preserved Heritage Railway' },
  turntable: { type: 'turntable', defaultWidth: 5.0, label: 'Railway Turntable' },
};

export const SUPPORTED_AERIALWAYS: Record<string, { defaultWidth: number; label: string }> = {
  cable_car: { defaultWidth: 3.2, label: 'Aerial Cable Car Run' },
  gondola: { defaultWidth: 3.0, label: 'Gondola Lift' },
  mixed_lift: { defaultWidth: 3.0, label: 'Mixed Aerial Lift' },
  chair_lift: { defaultWidth: 2.6, label: 'Chairlift' },
  drag_lift: { defaultWidth: 2.2, label: 'Drag Surface Lift' },
  't-bar': { defaultWidth: 2.2, label: 'T-Bar Ski Lift' },
  'j-bar': { defaultWidth: 2.2, label: 'J-Bar Ski Lift' },
  platter: { defaultWidth: 2.2, label: 'Platter Ski Lift' },
  rope_tow: { defaultWidth: 2.0, label: 'Rope Tow Lift' },
  zip_line: { defaultWidth: 1.8, label: 'Zip Line' },
  goods: { defaultWidth: 2.5, label: 'Goods Aerial Lift' },
  magic_carpet: { defaultWidth: 2.2, label: 'Ski Magic Carpet' },
};

// 2. Explicit Linear Waterway Matcher
export const SUPPORTED_LINEAR_WATERWAYS: Record<string, { type: WaterwayType; defaultWidth: number; label: string }> = {
  river: { type: 'river', defaultWidth: 18.0, label: 'River' },
  canal: { type: 'canal', defaultWidth: 12.0, label: 'Canal' },
  stream: { type: 'stream', defaultWidth: 5.0, label: 'Stream' },
  drain: { type: 'drain', defaultWidth: 3.0, label: 'Drainage Channel' },
  ditch: { type: 'ditch', defaultWidth: 2.5, label: 'Water Ditch' },
  dock: { type: 'dock', defaultWidth: 20.0, label: 'Waterway Dock' },
  culvert: { type: 'stream', defaultWidth: 4.0, label: 'Underground Culvert' },
  tidal_channel: { type: 'stream', defaultWidth: 8.0, label: 'Tidal Channel' },
  fish_pass: { type: 'stream', defaultWidth: 3.0, label: 'Fish Pass' },
};

// 3. Explicit Polygonal Water Matcher
export const SUPPORTED_WATER_POLYGONS = new Set([
  'water',
  'riverbank',
  'lake',
  'pond',
  'reservoir',
  'basin',
  'dock',
  'canal',
  'ocean',
  'river',
  'oxbow',
  'lagoon',
  'moat',
  'wastewater',
  'reflecting_pool',
  'salt_pond',
  'swimming_pool',
]);

// 4. Explicit Nature, Park & Leisure Terrain Matcher
export const SUPPORTED_NATURE_TERRAIN: Record<string, { subtype: string; label: string; has3DFoliage?: boolean }> = {
  wood: { subtype: 'wood', label: 'Natural Woodland', has3DFoliage: true },
  scrub: { subtype: 'scrub', label: 'Bushes & Small Trees (Scrub)' },
  heath: { subtype: 'heath', label: 'Dwarf Scrubs (Heath)' },
  grassland: { subtype: 'grassland', label: 'Natural Grassland' },
  fell: { subtype: 'grassland', label: 'Alpine Fell Grassland' },
  tundra: { subtype: 'heath', label: 'Tundra' },
  wetland: { subtype: 'wetland', label: 'Wetland' },
  mud: { subtype: 'mud', label: 'Mud Flat' },
  beach: { subtype: 'beach', label: 'Beach' },
  shoal: { subtype: 'shoal', label: 'Sandbank / Shoal' },
  sand: { subtype: 'sand', label: 'Sand Area' },
  dune: { subtype: 'sand', label: 'Coastal Sand Dunes' },
  bare_rock: { subtype: 'bare_rock', label: 'Bare Rock Surface' },
  rock: { subtype: 'bare_rock', label: 'Rock Outcrop' },
  stone: { subtype: 'bare_rock', label: 'Boulder / Stone Field' },
  scree: { subtype: 'scree', label: 'Loose Rock Scree' },
  shingle: { subtype: 'shingle', label: 'Shingle Pebble Beach' },
  glacier: { subtype: 'glacier', label: 'Glacier' },
};

export const SUPPORTED_PARK_LEISURE = new Set([
  'park',
  'garden',
  'common',
  'nature_reserve',
  'playground',
  'fitness_station',
  'fitness_centre',
  'golf_course',
  'miniature_golf',
  'dog_park',
  'pitch',
  'track',
  'sports_centre',
  'stadium',
  'ice_rink',
  'marina',
  'beach_resort',
  'fishing',
  'outdoor_seating',
  'picnic_table',
  'firepit',
  'bird_hide',
  'bowling_alley',
  'dance',
  'amusement_arcade',
  'sauna',
  'slipway',
]);

export const SUPPORTED_PARK_LANDUSE = new Set([
  'grass',
  'village_green',
  'recreation_ground',
  'plaza',
  'meadow',
  'forest',
  'orchard',
  'vineyard',
  'plant_nursery',
  'flowerbed',
]);

// 5. Explicit Landuse Matcher
export const SUPPORTED_LANDUSE_TYPES: Record<string, { type: LanduseType; label: string }> = {
  residential: { type: 'residential', label: 'Residential Area' },
  commercial: { type: 'commercial', label: 'Commercial & Office Area' },
  industrial: { type: 'industrial', label: 'Industrial Area' },
  retail: { type: 'retail', label: 'Retail & Shopping Zone' },
  construction: { type: 'construction', label: 'Construction Yard' },
  brownfield: { type: 'brownfield', label: 'Brownfield Redevelopment Site' },
  landfill: { type: 'landfill', label: 'Landfill Site' },
  cemetery: { type: 'cemetery', label: 'Cemetery' },
  allotments: { type: 'allotments', label: 'Community Allotments' },
  institutional: { type: 'institutional', label: 'Institutional Grounds' },
  education: { type: 'education', label: 'Educational Campus' },
  religious: { type: 'religious', label: 'Religious Grounds' },
  military: { type: 'military', label: 'Military Zone' },
  farmland: { type: 'farmland', label: 'Agricultural Farmland' },
  greenhouse_horticulture: { type: 'farmland', label: 'Greenhouse Horticulture Area' },
  farmyard: { type: 'farmyard', label: 'Farmyard' },
  quarry: { type: 'quarry', label: 'Surface Mineral Quarry' },
  railway: { type: 'railway', label: 'Railway Corridor / Yard' },
  garages: { type: 'garages', label: 'Garages Area' },
  depot: { type: 'industrial', label: 'Transport / Industrial Depot' },
  port: { type: 'industrial', label: 'Port Terminal Area' },
  aquaculture: { type: 'farmland', label: 'Aquaculture Facility' },
};

// 6. Explicit Road Hierarchy Matcher (harmonized realistic two-way widths in meters)
export const ROAD_CLASS_WIDTHS: Record<RoadClass, number> = {
  motorway: 11.0,
  trunk: 9.5,
  primary: 8.5,
  secondary: 7.2,
  tertiary: 6.2,
  residential: 5.4,
  living_street: 4.8,
  unclassified: 4.8,
  service: 3.6,
  pedestrian: 4.2,
  footway: 2.2,
  cycleway: 2.4,
  bridleway: 2.6,
  steps: 2.2,
  path: 1.8,
  track: 3.2,
  runway: 28.0,
  taxiway: 14.0,
  platform: 4.2,
  pier: 3.8,
  raceway: 9.0,
  bus_guideway: 4.5,
  construction: 5.0,
  bridge: 7.5,
};

export const ROAD_CLASS_MAP: Record<string, { roadClass: RoadClass; label: string }> = {
  motorway: { roadClass: 'motorway', label: 'Motorway / Freeway' },
  motorway_link: { roadClass: 'motorway', label: 'Motorway Sliproad / Ramp' },
  trunk: { roadClass: 'trunk', label: 'Trunk Highway' },
  trunk_link: { roadClass: 'trunk', label: 'Trunk Highway Sliproad' },
  primary: { roadClass: 'primary', label: 'Primary Road' },
  primary_link: { roadClass: 'primary', label: 'Primary Road Sliproad' },
  secondary: { roadClass: 'secondary', label: 'Secondary Road' },
  secondary_link: { roadClass: 'secondary', label: 'Secondary Road Sliproad' },
  tertiary: { roadClass: 'tertiary', label: 'Tertiary Road' },
  tertiary_link: { roadClass: 'tertiary', label: 'Tertiary Road Sliproad' },
  unclassified: { roadClass: 'unclassified', label: 'Quaternary / Unclassified Road' },
  residential: { roadClass: 'residential', label: 'Residential Street' },
  living_street: { roadClass: 'living_street', label: 'Living Street (Shared Priority)' },
  service: { roadClass: 'service', label: 'Access / Service Road' },
  pedestrian: { roadClass: 'pedestrian', label: 'Pedestrian Street / Zone' },
  footway: { roadClass: 'footway', label: 'Footway / Sidewalk' },
  cycleway: { roadClass: 'cycleway', label: 'Cycleway' },
  bridleway: { roadClass: 'bridleway', label: 'Bridleway (Equestrian)' },
  steps: { roadClass: 'steps', label: 'Pedestrian Steps / Stairway' },
  path: { roadClass: 'path', label: 'Multi-Use Path' },
  track: { roadClass: 'track', label: 'Agricultural / Forestry Track' },
  corridor: { roadClass: 'pedestrian', label: 'Indoor / Covered Corridor' },
  bus_guideway: { roadClass: 'bus_guideway', label: 'Guided Busway' },
  raceway: { roadClass: 'raceway', label: 'Motorsport Raceway' },
  road: { roadClass: 'unclassified', label: 'Road (Unclassified Survey)' },
  escape: { roadClass: 'service', label: 'Emergency Runaway Truck Ramp' },
  platform: { roadClass: 'platform', label: 'Transit Boarding Platform' },
  construction: { roadClass: 'construction', label: 'Road Under Construction' },
  bridge: { roadClass: 'bridge', label: 'Bridge Deck' },
};

function parseLeafType(props: RawGeoJsonProperties): 'broadleaved' | 'needleleaved' | 'mixed' | 'leafless' {
  const lt = String(props.leaf_type || '').toLowerCase();
  if (lt === 'needleleaved') return 'needleleaved';
  if (lt === 'mixed') return 'mixed';
  if (lt === 'leafless') return 'leafless';
  return 'broadleaved';
}

function formatTitleCase(raw: string): string {
  return raw
    .replace(/[_:]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Classifies any raw GeoJSON feature into an explicit OSM Carto category with rich human-readable descriptions.
 * Strictly checks both OSM tags AND geometry type (LineString vs Point vs Polygon)
 * to prevent point infrastructure or overhead wires from being misclassified as 3D surface alignments.
 */
export function classifyGeoJsonFeature(
  props: RawGeoJsonProperties,
  geometryType: string
): ClassificationResult {
  const isPolygon = geometryType === 'Polygon' || geometryType === 'MultiPolygon';
  const isLine = geometryType === 'LineString' || geometryType === 'MultiLineString';
  const isPoint = geometryType === 'Point' || geometryType === 'MultiPoint';

  const layer =
    typeof props.layer === 'number'
      ? props.layer
      : parseInt(String(props.layer || '0'), 10) || 0;
  const isBridge = Boolean(props.bridge && props.bridge !== 'no');
  const isTunnel = Boolean(
    (props.tunnel && props.tunnel !== 'no') ||
    (props.covered && props.covered !== 'no') ||
    props.culvert === 'yes' ||
    props.waterway === 'culvert' ||
    layer < 0
  );

  // Skip linear OSM collection relations (e.g. type=waterway, type=route) whose constituent
  // member ways are already present as individual LineString features with accurate per-segment tags.
  if (
    isLine &&
    (String(props.id || '').startsWith('relation/') ||
      props.type === 'waterway' ||
      props.type === 'route' ||
      props.type === 'superroute' ||
      props.type === 'network')
  ) {
    return {
      category: 'unsupported',
      primaryTag: `relation:${String(props.type || 'line')}`,
      cartoLabel: 'OSM Collection Relation',
      isBridge,
      isTunnel,
      layer,
    };
  }

  // ============================================================================
  // A. BUILDINGS & 3D ARCHITECTURAL STRUCTURES (Polygonal)
  // ============================================================================
  if (
    (props.building && props.building !== 'no') ||
    (isPolygon &&
      (props.amenity === 'shelter' ||
        props.aeroway === 'terminal' ||
        props.aeroway === 'hangar' ||
        props.historic === 'castle' ||
        props.historic === 'fort' ||
        props.historic === 'manor' ||
        props.historic === 'city_gate' ||
        props.military === 'bunker' ||
        props.man_made === 'storage_tank' ||
        props.man_made === 'silo' ||
        props.man_made === 'tower' ||
        props.man_made === 'water_tower' ||
        props.man_made === 'communications_tower' ||
        props.man_made === 'windmill' ||
        props.man_made === 'lighthouse' ||
        props.man_made === 'chimney' ||
        props.man_made === 'obelisk'))
  ) {
    if (!isPolygon) {
      return {
        category: 'unsupported',
        primaryTag: `building:${geometryType.toLowerCase()}`,
        cartoLabel: 'Point Building Tag',
        isBridge,
        isTunnel,
        layer,
      };
    }

    const bVal = props.building && props.building !== 'no' ? String(props.building).toLowerCase() : '';
    const amenity = props.amenity ? String(props.amenity).toLowerCase() : '';
    const religion = props.religion ? String(props.religion).toLowerCase() : '';
    const historic = props.historic ? String(props.historic).toLowerCase() : '';
    const aeroway = props.aeroway ? String(props.aeroway).toLowerCase() : '';
    const manMade = props.man_made ? String(props.man_made).toLowerCase() : '';
    const tourism = props.tourism ? String(props.tourism).toLowerCase() : '';
    const shop = props.shop ? String(props.shop).toLowerCase() : '';

    let archetype: ClassificationResult['buildingArchetype'] = 'residential';
    let cartoLabel = bVal && bVal !== 'yes' ? `${formatTitleCase(bVal)} Building` : 'Building';
    let primaryTag = bVal ? `building=${bVal}` : 'building=yes';

    if (
      amenity === 'place_of_worship' ||
      ['church', 'cathedral', 'chapel', 'mosque', 'synagogue', 'temple', 'shrine', 'monastery', 'religious'].includes(bVal)
    ) {
      archetype = 'religious';
      const relLabel = religion ? ` (${formatTitleCase(religion)})` : '';
      cartoLabel =
        bVal && bVal !== 'yes'
          ? `${formatTitleCase(bVal)}${relLabel}`
          : `Place of Worship${relLabel}`;
      primaryTag = amenity === 'place_of_worship'
        ? `amenity=place_of_worship${religion ? ` + religion=${religion}` : ''}`
        : `building=${bVal}`;
    } else if (
      aeroway === 'terminal' ||
      aeroway === 'hangar' ||
      props.public_transport === 'station' ||
      props.aerialway === 'station' ||
      ['train_station', 'transportation', 'hangar'].includes(bVal)
    ) {
      archetype = 'transit';
      cartoLabel =
        aeroway === 'terminal'
          ? 'Airport Terminal Building'
          : bVal === 'train_station'
          ? 'Railway Station Building'
          : props.aerialway === 'station'
          ? 'Aerialway Station Building'
          : 'Public Transport Station Building';
      primaryTag = aeroway ? `aeroway=${aeroway} + building=*` : `building=${bVal || 'train_station'}`;
    } else if (
      historic === 'castle' ||
      historic === 'fort' ||
      historic === 'manor' ||
      historic === 'city_gate' ||
      props.military === 'bunker' ||
      ['castle', 'palace', 'fort', 'bunker'].includes(bVal)
    ) {
      archetype = 'historic';
      const cType = props.castle_type ? String(props.castle_type).toLowerCase() : '';
      cartoLabel =
        cType === 'palace' || cType === 'stately'
          ? 'Palace / Stately Home'
          : cType
          ? `Historic Castle (${formatTitleCase(cType)})`
          : historic
          ? `Historic ${formatTitleCase(historic)}`
          : `Historic ${formatTitleCase(bVal)}`;
      primaryTag = historic
        ? `historic=${historic}${cType ? ` + castle_type=${cType}` : ''}`
        : `building=${bVal}`;
    } else if (
      ['hospital', 'clinic', 'doctors', 'university', 'college', 'school', 'kindergarten', 'townhall', 'courthouse', 'police', 'fire_station', 'prison', 'library', 'community_centre', 'arts_centre', 'public', 'civic', 'government'].includes(bVal) ||
      ['hospital', 'clinic', 'university', 'college', 'school', 'kindergarten', 'townhall', 'courthouse', 'police', 'fire_station', 'prison', 'library', 'community_centre'].includes(amenity)
    ) {
      archetype = 'civic';
      const civicType = amenity || bVal;
      cartoLabel = `${formatTitleCase(civicType)} Building`;
      primaryTag = amenity ? `amenity=${amenity} + building=*` : `building=${bVal}`;
    } else if (
      ['commercial', 'office', 'retail', 'supermarket', 'kiosk', 'hotel'].includes(bVal) ||
      Boolean(shop) ||
      ['hotel', 'guest_house', 'hostel', 'motel', 'museum', 'gallery'].includes(tourism) ||
      ['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'bank', 'theatre', 'cinema', 'nightclub', 'casino', 'post_office', 'marketplace'].includes(amenity)
    ) {
      archetype = 'commercial';
      if (shop) {
        cartoLabel = `${formatTitleCase(shop)} Shop Building`;
        primaryTag = `shop=${shop} + building=*`;
      } else if (tourism) {
        cartoLabel = `${formatTitleCase(tourism)} Building`;
        primaryTag = `tourism=${tourism} + building=*`;
      } else if (amenity) {
        cartoLabel = `${formatTitleCase(amenity)} Building`;
        primaryTag = `amenity=${amenity} + building=*`;
      } else {
        cartoLabel = `${formatTitleCase(bVal)} Building`;
      }
    } else if (
      ['industrial', 'warehouse', 'manufacture', 'service', 'farm', 'barn', 'farm_auxiliary', 'greenhouse', 'garages', 'garage', 'carport', 'canopy', 'hut', 'shed', 'roof', 'ruins', 'construction'].includes(bVal) ||
      Boolean(manMade)
    ) {
      archetype = 'industrial';
      if (manMade) {
        cartoLabel = `${formatTitleCase(manMade)} Structure`;
        primaryTag = `man_made=${manMade}`;
      } else {
        cartoLabel = `${formatTitleCase(bVal)} Structure`;
      }
    }

    const isRoofOnly =
      bVal === 'roof' ||
      bVal === 'carport' ||
      bVal === 'canopy' ||
      bVal === 'grandstand' ||
      (amenity === 'shelter' && (!bVal || bVal === 'yes' || bVal === 'roof' || bVal === 'shelter'));

    if (isRoofOnly) {
      if (bVal === 'roof') {
        cartoLabel = 'Open-Air Roof Canopy';
        primaryTag = 'building=roof';
      } else if (bVal === 'carport') {
        cartoLabel = 'Open-Air Carport Roof';
        primaryTag = 'building=carport';
      } else if (bVal === 'canopy') {
        cartoLabel = 'Overhead Canopy Structure';
        primaryTag = 'building=canopy';
      } else if (amenity === 'shelter') {
        cartoLabel = 'Open-Air Shelter Roof';
        primaryTag = bVal ? `amenity=shelter + building=${bVal}` : 'amenity=shelter';
      }
    }

    return {
      category: 'building',
      primaryTag,
      cartoLabel,
      subtype: bVal || (amenity === 'shelter' ? 'roof' : '') || manMade || historic || aeroway || 'yes',
      buildingArchetype: archetype,
      isRoofOnly,
      isBridge,
      isTunnel,
      layer,
    };
  }

  // ============================================================================
  // B. RAILWAYS & AERIAL LIFTS (Linear)
  // ============================================================================
  if (props.railway && props.railway !== 'no') {
    const rType = String(props.railway).toLowerCase();

    // Railway platforms and stations mapped as polygons are handled under Landuse/Transport Areas
    if (isPolygon && (rType === 'platform' || rType === 'station')) {
      return {
        category: 'landuse',
        primaryTag: `railway=${rType}`,
        cartoLabel: rType === 'platform' ? 'Railway Platform Area' : 'Railway Station Area',
        subtype: rType === 'platform' ? 'platform_area' : 'railway',
        isBridge,
        isTunnel,
        layer,
      };
    }

    // Linear railway platform
    if (isLine && rType === 'platform') {
      return {
        category: 'road',
        primaryTag: 'railway=platform',
        cartoLabel: 'Railway Boarding Platform',
        subtype: 'platform',
        defaultWidth: 4.2,
        isBridge,
        isTunnel,
        layer,
      };
    }

    // Point railway stations / stops -> 3D Landmark / Transit Stop
    if (isPoint && (rType === 'station' || rType === 'halt' || rType === 'tram_stop' || rType === 'subway_entrance')) {
      const labels: Record<string, string> = {
        station: 'Railway Station',
        halt: 'Railway Stop / Halt',
        tram_stop: 'Tram Stop',
        subway_entrance: 'Subway Entrance',
      };
      return {
        category: 'landmark',
        primaryTag: `railway=${rType}`,
        cartoLabel: labels[rType] || 'Railway Station',
        subtype: 'transit_stop',
        defaultHeight: 4.5,
        isBridge,
        isTunnel,
        layer,
      };
    }

    // Active railway track alignments MUST be LineString / MultiLineString
    if (!isLine) {
      return {
        category: 'unsupported',
        primaryTag: `railway=${rType}:${geometryType.toLowerCase()}`,
        cartoLabel: `Railway (${rType})`,
        isBridge,
        isTunnel,
        layer,
      };
    }

    const matched = SUPPORTED_RAILWAYS[rType];
    if (matched) {
      const customWidth = props.width ? parseFloat(String(props.width)) : undefined;
      const service = props.service ? String(props.service).toLowerCase() : '';
      const label =
        rType === 'rail' && (service === 'siding' || service === 'yard' || service === 'spur')
          ? `Railway Service Track (${formatTitleCase(service)})`
          : matched.label;
      return {
        category: 'railway',
        primaryTag: service ? `railway=${rType} + service=${service}` : `railway=${rType}`,
        cartoLabel: label,
        subtype: matched.type,
        defaultWidth: customWidth && !isNaN(customWidth) ? customWidth : matched.defaultWidth,
        isBridge,
        isTunnel,
        layer,
      };
    }

    return {
      category: 'unsupported',
      primaryTag: `railway=${rType}`,
      cartoLabel: `Unsupported Railway (${rType})`,
      isBridge,
      isTunnel,
      layer,
    };
  }

  // Roller coaster tracks & Aerial lifts
  if (isLine && props.roller_coaster === 'track') {
    return {
      category: 'railway',
      primaryTag: 'roller_coaster=track',
      cartoLabel: 'Roller Coaster Track',
      subtype: 'roller_coaster',
      defaultWidth: 2.8,
      isBridge,
      isTunnel,
      layer,
    };
  }

  if (isLine && props.aerialway && props.aerialway !== 'no') {
    const aType = String(props.aerialway).toLowerCase();
    const matched = SUPPORTED_AERIALWAYS[aType];
    if (matched) {
      return {
        category: 'railway',
        primaryTag: `aerialway=${aType}`,
        cartoLabel: matched.label,
        subtype: 'aerialway',
        defaultWidth: matched.defaultWidth,
        isBridge: true, // Aerialways are elevated above ground
        isTunnel: false,
        layer: Math.max(layer, 1),
      };
    }
  }

  // ============================================================================
  // C. WATERWAYS & WATER BODIES (Polygonal & Linear)
  // ============================================================================
  if (
    props.natural === 'water' ||
    props.natural === 'reef' ||
    props.water ||
    props.waterway ||
    props.landuse === 'basin' ||
    props.landuse === 'reservoir' ||
    props.landuse === 'salt_pond' ||
    props.leisure === 'swimming_pool' ||
    props.leisure === 'swimming_area' ||
    props.leisure === 'water_park' ||
    props.attraction === 'water_slide'
  ) {
    const waterwayTag = props.waterway ? String(props.waterway).toLowerCase() : undefined;
    const waterTag = props.water ? String(props.water).toLowerCase() : undefined;
    const naturalTag = props.natural ? String(props.natural).toLowerCase() : undefined;
    const landuseTag = props.landuse ? String(props.landuse).toLowerCase() : undefined;
    const leisureTag = props.leisure ? String(props.leisure).toLowerCase() : undefined;
    const isIntermittent = Boolean(props.intermittent && props.intermittent !== 'no') || Boolean(props.seasonal && props.seasonal !== 'no');

    // Dam / Weir / Lock Gate as Barrier or Structure
    if (waterwayTag === 'dam' || waterwayTag === 'weir' || waterwayTag === 'lock_gate') {
      if (isLine) {
        return {
          category: 'barrier',
          primaryTag: `waterway=${waterwayTag}`,
          cartoLabel: waterwayTag === 'dam' ? 'Dam Wall' : waterwayTag === 'weir' ? 'Waterway Weir' : 'Lock Gate',
          subtype: waterwayTag === 'weir' ? 'weir' : 'dam',
          defaultWidth: waterwayTag === 'dam' ? 4.5 : 2.5,
          defaultHeight: waterwayTag === 'dam' ? 3.5 : 1.2,
          isBridge,
          isTunnel,
          layer,
        };
      }
      if (isPolygon) {
        return {
          category: 'landuse',
          primaryTag: `waterway=${waterwayTag}`,
          cartoLabel: 'Dam Structure Area',
          subtype: 'water_works',
          isBridge,
          isTunnel,
          layer,
        };
      }
      if (isPoint) {
        return {
          category: 'landmark',
          primaryTag: `waterway=${waterwayTag}`,
          cartoLabel: formatTitleCase(waterwayTag),
          subtype: 'poi',
          defaultHeight: 3.0,
          isBridge,
          isTunnel,
          layer,
        };
      }
    }

    if (waterwayTag === 'waterfall' && isPoint) {
      return {
        category: 'landmark',
        primaryTag: 'waterway=waterfall',
        cartoLabel: 'Waterfall',
        subtype: 'peak',
        defaultHeight: 5.0,
        isBridge,
        isTunnel,
        layer,
      };
    }

    // Water slide (linear)
    if (isLine && props.attraction === 'water_slide') {
      return {
        category: 'water_line',
        primaryTag: 'attraction=water_slide',
        cartoLabel: 'Water Slide',
        subtype: 'water_slide',
        defaultWidth: 2.0,
        isBridge,
        isTunnel,
        layer,
      };
    }

    // Linear waterway (LineString)
    if (isLine && waterwayTag && SUPPORTED_LINEAR_WATERWAYS[waterwayTag]) {
      const matched = SUPPORTED_LINEAR_WATERWAYS[waterwayTag];
      const customWidth = props.width ? parseFloat(String(props.width)) : undefined;
      const prefix = isIntermittent ? 'Intermittent / Seasonal ' : isTunnel ? 'Underground ' : '';

      return {
        category: 'water_line',
        primaryTag: `waterway=${waterwayTag}${isIntermittent ? ' + intermittent=yes' : ''}${isTunnel ? ' + tunnel=yes' : ''}`,
        cartoLabel: `${prefix}${matched.label}`,
        subtype: matched.type,
        defaultWidth: customWidth && !isNaN(customWidth) ? customWidth : matched.defaultWidth,
        isBridge,
        isTunnel,
        layer,
      };
    }

    // Polygonal water (Polygon / MultiPolygon)
    if (
      isPolygon &&
      (naturalTag === 'water' ||
        naturalTag === 'reef' ||
        (waterTag && SUPPORTED_WATER_POLYGONS.has(waterTag)) ||
        waterwayTag === 'riverbank' ||
        waterwayTag === 'dock' ||
        waterwayTag === 'basin' ||
        waterwayTag === 'boatyard' ||
        landuseTag === 'basin' ||
        landuseTag === 'reservoir' ||
        landuseTag === 'salt_pond' ||
        leisureTag === 'swimming_pool' ||
        leisureTag === 'swimming_area' ||
        leisureTag === 'water_park')
    ) {
      let subtype = waterTag || waterwayTag || landuseTag || leisureTag || naturalTag || 'water';
      let label = 'Body of Water';
      if (leisureTag === 'swimming_pool' || leisureTag === 'swimming_area' || leisureTag === 'water_park') {
        label = formatTitleCase(leisureTag);
        subtype = 'swimming_pool';
      } else if (landuseTag === 'salt_pond') {
        label = 'Salt Evaporation Pond';
      } else if (landuseTag === 'basin') {
        const bType = props.basin ? ` (${formatTitleCase(String(props.basin))})` : '';
        label = `Artificial Basin${bType}`;
      } else if (landuseTag === 'reservoir') {
        label = 'Artificial Reservoir';
      } else if (naturalTag === 'reef') {
        label = 'Marine Reef';
      } else if (waterwayTag === 'riverbank') {
        label = 'Riverbank Water Area';
      } else if (waterwayTag === 'dock') {
        label = 'Water Dock';
      } else if (waterTag) {
        label = `${formatTitleCase(waterTag)} Water Body`;
      }
      if (isIntermittent) label = `${label} (Intermittent / Seasonal)`;

      return {
        category: 'water_polygon',
        primaryTag: waterTag
          ? `water=${waterTag}`
          : waterwayTag
          ? `waterway=${waterwayTag}`
          : landuseTag
          ? `landuse=${landuseTag}`
          : leisureTag
          ? `leisure=${leisureTag}`
          : `natural=${naturalTag || 'water'}`,
        cartoLabel: label,
        subtype,
        isBridge,
        isTunnel,
        layer,
      };
    }

    return {
      category: 'unsupported',
      primaryTag: waterwayTag ? `waterway=${waterwayTag}` : `water=${waterTag || 'unknown'}`,
      cartoLabel: 'Unsupported Water Feature',
      isBridge,
      isTunnel,
      layer,
    };
  }

  // ============================================================================
  // D. ROADS, WAYS & AVIATION / TRANSIT LINES
  // ============================================================================
  if (props.highway) {
    const hwTag = String(props.highway).toLowerCase();

    // Polygonal highway areas (e.g. highway=pedestrian + area=yes, highway=services, highway=rest_area, highway=platform)
    if (isPolygon) {
      if (hwTag === 'services' || hwTag === 'rest_area' || hwTag === 'platform' || props.area === 'yes') {
        const labels: Record<string, string> = {
          services: 'Highway Service Station Area',
          rest_area: 'Highway Rest Area',
          platform: 'Transit Platform Area',
          pedestrian: 'Pedestrian Plaza Area',
          living_street: 'Living Street Routable Area',
          service: 'Service Highway Area',
          footway: 'Footway Paved Area',
        };
        return {
          category: 'landuse',
          primaryTag: props.area === 'yes' ? `highway=${hwTag} + area=yes` : `highway=${hwTag}`,
          cartoLabel: labels[hwTag] || `${formatTitleCase(hwTag)} Area`,
          subtype: hwTag === 'platform' ? 'platform_area' : 'pedestrian_area',
          isBridge,
          isTunnel,
          layer,
        };
      }
    }

    // Point street lamps are rendered as 3D street furniture landmarks
    if (isPoint && hwTag === 'street_lamp') {
      return {
        category: 'landmark',
        primaryTag: 'highway=street_lamp',
        cartoLabel: 'Street Lamp Post',
        subtype: 'street_lamp',
        defaultHeight: 5.2,
        isBridge,
        isTunnel,
        layer,
      };
    }

    // Road alignments MUST be LineString / MultiLineString
    // Point-based features (e.g. highway=traffic_signals, bus_stop, crossing) remain unsupported infrastructure
    if (!isLine) {
      return {
        category: 'unsupported',
        primaryTag: `highway=${hwTag}:${geometryType.toLowerCase()}`,
        cartoLabel: `Highway Point (${hwTag})`,
        isBridge,
        isTunnel,
        layer,
      };
    }

    // Special handling for highway=construction + construction=*
    if (hwTag === 'construction') {
      const cTarget = props.construction ? String(props.construction).toLowerCase() : 'road';
      return {
        category: 'road',
        primaryTag: props.construction
          ? `highway=construction + construction=${cTarget}`
          : 'highway=construction',
        cartoLabel: `${formatTitleCase(cTarget)} Under Construction`,
        subtype: 'construction',
        isBridge,
        isTunnel,
        layer,
      };
    }

    // Special handling for highway=track + tracktype=grade1..grade5
    if (hwTag === 'track') {
      const grade = props.tracktype ? String(props.tracktype).toLowerCase() : '';
      const gradeDescriptions: Record<string, string> = {
        grade1: 'Track — Solid Paved Surface (Grade 1)',
        grade2: 'Track — Mostly Solid Surface (Grade 2)',
        grade3: 'Track — Mixed Solid & Soft Surface (Grade 3)',
        grade4: 'Track — Mostly Soft Surface (Grade 4)',
        grade5: 'Track — Soft Unimproved Surface (Grade 5)',
      };
      return {
        category: 'road',
        primaryTag: grade ? `highway=track + tracktype=${grade}` : 'highway=track',
        cartoLabel: gradeDescriptions[grade] || 'Agricultural / Forestry Track',
        subtype: 'track',
        isBridge,
        isTunnel,
        layer,
      };
    }

    // Special handling for highway=path with designated horse or bicycle
    if (hwTag === 'path') {
      if (props.horse === 'designated') {
        return {
          category: 'road',
          primaryTag: 'highway=path + horse=designated',
          cartoLabel: 'Designated Bridleway Path',
          subtype: 'bridleway',
          isBridge,
          isTunnel,
          layer,
        };
      }
      if (props.bicycle === 'designated') {
        return {
          category: 'road',
          primaryTag: 'highway=path + bicycle=designated',
          cartoLabel: 'Designated Cycleway Path',
          subtype: 'cycleway',
          isBridge,
          isTunnel,
          layer,
        };
      }
    }

    const mapped = ROAD_CLASS_MAP[hwTag];
    if (mapped) {
      let label = mapped.label;
      let primaryTag = `highway=${hwTag}`;
      if (hwTag === 'service' && props.service) {
        const sType = String(props.service).toLowerCase();
        label = `Service Way (${formatTitleCase(sType)})`;
        primaryTag = `highway=service + service=${sType}`;
      } else if (hwTag === 'residential' && props.access) {
        const acc = String(props.access).toLowerCase();
        if (acc === 'private' || acc === 'no') {
          label = 'Residential Road (Private Access)';
          primaryTag = `highway=residential + access=${acc}`;
        } else if (acc === 'destination') {
          label = 'Residential Road (Local Traffic Only)';
          primaryTag = 'highway=residential + access=destination';
        }
      }

      return {
        category: 'road',
        primaryTag,
        cartoLabel: label,
        subtype: mapped.roadClass,
        isBridge,
        isTunnel,
        layer,
      };
    }

    return {
      category: 'unsupported',
      primaryTag: `highway=${hwTag}`,
      cartoLabel: `Unsupported Highway (${hwTag})`,
      isBridge,
      isTunnel,
      layer,
    };
  }

  // Aviation Runways, Taxiways, Aprons, Helipads & Aerodromes
  if (props.aeroway) {
    const aero = String(props.aeroway).toLowerCase();
    if (isLine && (aero === 'runway' || aero === 'taxiway')) {
      return {
        category: 'road',
        primaryTag: `aeroway=${aero}`,
        cartoLabel: aero === 'runway' ? 'Airport Runway' : 'Airport Taxiway',
        subtype: aero === 'runway' ? 'runway' : 'taxiway',
        defaultWidth: aero === 'runway' ? 28.0 : 14.0,
        isBridge,
        isTunnel,
        layer,
      };
    }
    if (isPolygon && (aero === 'aerodrome' || aero === 'apron' || aero === 'helipad' || aero === 'runway' || aero === 'taxiway')) {
      const labels: Record<string, string> = {
        aerodrome: 'Airport / Aerodrome Grounds',
        apron: 'Aircraft Parking Apron',
        helipad: 'Helipad Landing Area',
        runway: 'Airport Runway Area',
        taxiway: 'Airport Taxiway Area',
      };
      return {
        category: 'landuse',
        primaryTag: `aeroway=${aero}`,
        cartoLabel: labels[aero] || `Aeroway ${formatTitleCase(aero)}`,
        subtype: aero === 'aerodrome' ? 'aerodrome' : 'apron',
        isBridge,
        isTunnel,
        layer,
      };
    }
    if (isPoint && (aero === 'helipad' || aero === 'aerodrome')) {
      return {
        category: 'landmark',
        primaryTag: `aeroway=${aero}`,
        cartoLabel: aero === 'helipad' ? 'Helipad' : 'Airport / Aerodrome',
        subtype: 'transit_stop',
        defaultHeight: 3.0,
        isBridge,
        isTunnel,
        layer,
      };
    }
  }

  // Ferry Routes & Linear Piers / Leisure Tracks
  if (isLine && props.route === 'ferry') {
    return {
      category: 'road',
      primaryTag: 'route=ferry',
      cartoLabel: 'Ferry Route',
      subtype: 'path',
      defaultWidth: 3.0,
      isBridge,
      isTunnel,
      layer,
    };
  }

  if (isLine && props.man_made === 'pier') {
    return {
      category: 'road',
      primaryTag: 'man_made=pier',
      cartoLabel: 'Pier / Landing Stage',
      subtype: 'pier',
      defaultWidth: 3.8,
      isBridge: true,
      isTunnel: false,
      layer,
    };
  }

  if (isLine && props.leisure === 'track') {
    return {
      category: 'road',
      primaryTag: 'leisure=track',
      cartoLabel: 'Non-Motorized Sports Running / Cycling Track',
      subtype: 'track',
      defaultWidth: 4.0,
      isBridge,
      isTunnel,
      layer,
    };
  }

  // ============================================================================
  // E. LINEAR BARRIERS, WALLS, HEDGES, TREE ROWS & TOPOGRAPHIC LINES
  // ============================================================================
  if (isLine) {
    const barrierTag = props.barrier ? String(props.barrier).toLowerCase() : '';
    const manMadeTag = props.man_made ? String(props.man_made).toLowerCase() : '';
    const naturalTag = props.natural ? String(props.natural).toLowerCase() : '';

    if (barrierTag === 'city_wall' || props.historic === 'citywalls') {
      return {
        category: 'barrier',
        primaryTag: barrierTag ? 'barrier=city_wall' : 'historic=citywalls',
        cartoLabel: 'Historic City Wall',
        subtype: 'city_wall',
        defaultWidth: 1.6,
        defaultHeight: 4.5,
        isBridge,
        isTunnel,
        layer,
      };
    }

    if (barrierTag === 'hedge' || barrierTag === 'hedge_bank') {
      return {
        category: 'barrier',
        primaryTag: `barrier=${barrierTag}`,
        cartoLabel: 'Hedge Barrier',
        subtype: 'hedge',
        defaultWidth: 0.9,
        defaultHeight: 1.5,
        isBridge,
        isTunnel,
        layer,
      };
    }

    if (
      ['wall', 'retaining_wall', 'fence', 'chain', 'guard_rail', 'handrail', 'ditch', 'jersey_barrier'].includes(
        barrierTag
      )
    ) {
      const isFence = barrierTag === 'fence' || barrierTag === 'chain' || barrierTag === 'guard_rail' || barrierTag === 'handrail';
      return {
        category: 'barrier',
        primaryTag: `barrier=${barrierTag}`,
        cartoLabel: `${formatTitleCase(barrierTag)} Barrier`,
        subtype: isFence ? 'fence' : barrierTag === 'retaining_wall' ? 'retaining_wall' : 'wall',
        defaultWidth: isFence ? 0.25 : 0.45,
        defaultHeight: isFence ? 1.2 : 1.8,
        isBridge,
        isTunnel,
        layer,
      };
    }

    if (manMadeTag === 'breakwater' || manMadeTag === 'groyne' || manMadeTag === 'embankment' || manMadeTag === 'dyke') {
      return {
        category: 'barrier',
        primaryTag: `man_made=${manMadeTag}`,
        cartoLabel: formatTitleCase(manMadeTag),
        subtype: manMadeTag === 'groyne' ? 'groyne' : manMadeTag === 'breakwater' ? 'breakwater' : 'embankment',
        defaultWidth: 2.2,
        defaultHeight: 1.6,
        isBridge,
        isTunnel,
        layer,
      };
    }

    if (manMadeTag === 'pipeline' && (props.location === 'overground' || props.location === 'overhead')) {
      const sub = props.substance ? ` (${formatTitleCase(String(props.substance))})` : '';
      return {
        category: 'barrier',
        primaryTag: `man_made=pipeline + location=${props.location}`,
        cartoLabel: `Overground Pipeline${sub}`,
        subtype: 'wall',
        defaultWidth: 0.8,
        defaultHeight: 1.2,
        isBridge,
        isTunnel,
        layer,
      };
    }

    if (manMadeTag === 'goods_conveyor' || manMadeTag === 'cutline') {
      return {
        category: 'road',
        primaryTag: `man_made=${manMadeTag}`,
        cartoLabel: manMadeTag === 'goods_conveyor' ? 'Materials Conveyor System' : 'Forest Cutline',
        subtype: 'path',
        defaultWidth: 2.4,
        isBridge,
        isTunnel,
        layer,
      };
    }

    if (naturalTag === 'tree_row') {
      const leafType = parseLeafType(props);
      return {
        category: 'barrier',
        primaryTag: 'natural=tree_row',
        cartoLabel: 'Line of Trees (Tree Row)',
        subtype: 'tree_row',
        defaultWidth: 1.2,
        defaultHeight: 1.0,
        has3DFoliage: true,
        leafType,
        isBridge,
        isTunnel,
        layer,
      };
    }

    if (naturalTag === 'cliff' || naturalTag === 'arete' || naturalTag === 'ridge') {
      return {
        category: 'barrier',
        primaryTag: `natural=${naturalTag}`,
        cartoLabel: `Natural ${formatTitleCase(naturalTag)}`,
        subtype: 'cliff',
        defaultWidth: 1.8,
        defaultHeight: 2.8,
        isBridge,
        isTunnel,
        layer,
      };
    }
  }

  // ============================================================================
  // F. NATURE, FORESTS, WETLANDS, PARKS & SPORTS AREAS (Polygonal)
  // ============================================================================
  const naturalTag = props.natural ? String(props.natural).toLowerCase() : undefined;
  const leisureTag = props.leisure ? String(props.leisure).toLowerCase() : undefined;
  const landuseTag = props.landuse ? String(props.landuse).toLowerCase() : undefined;
  const golfTag = props.golf ? String(props.golf).toLowerCase() : undefined;
  const boundaryTag = props.boundary ? String(props.boundary).toLowerCase() : undefined;
  const tourismTag = props.tourism ? String(props.tourism).toLowerCase() : undefined;

  if (isPolygon) {
    // 1. Forests & Woodlands (landuse=forest or natural=wood) -> Procedural 3D Forest!
    if (landuseTag === 'forest' || naturalTag === 'wood') {
      const leafType = parseLeafType(props);
      const leafLabels: Record<string, string> = {
        broadleaved: 'Broadleaved',
        needleleaved: 'Needleleaved (Coniferous)',
        mixed: 'Mixed',
        leafless: 'Leafless',
      };
      const baseLabel = landuseTag === 'forest' ? 'Managed Forest' : 'Natural Woodland';
      const fullLabel = props.leaf_type ? `${leafLabels[leafType]} ${baseLabel}` : baseLabel;
      const baseTag = landuseTag === 'forest' ? 'landuse=forest' : 'natural=wood';

      return {
        category: 'park',
        primaryTag: props.leaf_type ? `${baseTag} + leaf_type=${leafType}` : baseTag,
        cartoLabel: fullLabel,
        subtype: landuseTag === 'forest' ? 'forest' : 'wood',
        has3DFoliage: true,
        leafType,
        isBridge,
        isTunnel,
        layer,
      };
    }

    // 2. Natural Terrain Polygons (wetlands, beaches, sand, scrub, heath, bare rock, glacier)
    if (naturalTag && SUPPORTED_NATURE_TERRAIN[naturalTag]) {
      const matched = SUPPORTED_NATURE_TERRAIN[naturalTag];
      let subtype = matched.subtype;
      let label = matched.label;
      let primaryTag = `natural=${naturalTag}`;

      if (naturalTag === 'wetland' && props.wetland) {
        const wSub = String(props.wetland).toLowerCase();
        const wetlandLabels: Record<string, string> = {
          marsh: 'Wetland — Marsh',
          wet_meadow: 'Wetland — Semi-Wetland Meadow',
          fen: 'Wetland — Fen',
          reedbed: 'Wetland — Reedbed',
          saltmarsh: 'Wetland — Salt Marsh',
          swamp: 'Wetland — Swamp',
          mangrove: 'Wetland — Mangrove',
          bog: 'Wetland — Bog',
          string_bog: 'Wetland — String Bog',
          tidalflat: 'Wetland — Tidal / Mudflat',
        };
        label = wetlandLabels[wSub] || `Wetland (${formatTitleCase(wSub)})`;
        primaryTag = `natural=wetland + wetland=${wSub}`;
        if (['marsh', 'reedbed', 'swamp', 'mangrove', 'bog', 'tidalflat'].includes(wSub)) {
          subtype = wSub;
        }
      } else if ((naturalTag === 'beach' || naturalTag === 'shoal') && props.surface) {
        const surf = String(props.surface).toLowerCase();
        label = `${matched.label} (${formatTitleCase(surf)} Surface)`;
        primaryTag = `natural=${naturalTag} + surface=${surf}`;
      }

      return {
        category: 'park',
        primaryTag,
        cartoLabel: label,
        subtype,
        has3DFoliage: matched.has3DFoliage,
        isBridge,
        isTunnel,
        layer,
      };
    }

    // 3. Golf Course Features
    if (golfTag && ['tee', 'fairway', 'driving_range', 'rough', 'green', 'bunker'].includes(golfTag)) {
      const golfLabels: Record<string, string> = {
        tee: 'Golf Teeing Ground',
        fairway: 'Golf Fairway',
        driving_range: 'Golf Driving Range',
        rough: 'Golf Rough',
        green: 'Golf Putting Green',
        bunker: 'Golf Sand Bunker',
      };
      return {
        category: 'park',
        primaryTag: `golf=${golfTag}`,
        cartoLabel: golfLabels[golfTag] || `Golf ${formatTitleCase(golfTag)}`,
        subtype: golfTag === 'bunker' ? 'sand' : 'golf_course',
        isBridge,
        isTunnel,
        layer,
      };
    }

    // 4. Parks, Leisure & Sports Polygons
    if (
      (leisureTag && SUPPORTED_PARK_LEISURE.has(leisureTag)) ||
      (landuseTag && SUPPORTED_PARK_LANDUSE.has(landuseTag)) ||
      boundaryTag === 'national_park' ||
      boundaryTag === 'protected_area' ||
      boundaryTag === 'aboriginal_lands' ||
      tourismTag === 'camp_site' ||
      tourismTag === 'caravan_site' ||
      tourismTag === 'picnic_site' ||
      tourismTag === 'zoo' ||
      tourismTag === 'theme_park'
    ) {
      const rawSub = leisureTag || landuseTag || boundaryTag || tourismTag || 'park';
      const sportSuffix = props.sport ? ` (${formatTitleCase(String(props.sport))})` : '';
      const label =
        boundaryTag === 'national_park'
          ? 'National Park'
          : boundaryTag === 'aboriginal_lands'
          ? 'Protected Sovereign / Aboriginal Lands'
          : `${formatTitleCase(rawSub)}${sportSuffix}`;
      const primaryTag = leisureTag
        ? `leisure=${leisureTag}${props.sport ? ` + sport=${props.sport}` : ''}`
        : landuseTag
        ? `landuse=${landuseTag}`
        : boundaryTag
        ? `boundary=${boundaryTag}`
        : `tourism=${tourismTag}`;

      return {
        category: 'park',
        primaryTag,
        cartoLabel: label,
        subtype: rawSub,
        has3DFoliage: rawSub === 'orchard' || rawSub === 'nature_reserve',
        leafType: 'broadleaved',
        isBridge,
        isTunnel,
        layer,
      };
    }

    // 5. Explicit Landuse Zoning & Agricultural Areas
    if (landuseTag && SUPPORTED_LANDUSE_TYPES[landuseTag]) {
      const matched = SUPPORTED_LANDUSE_TYPES[landuseTag];
      const relSuffix =
        landuseTag === 'cemetery' && props.religion
          ? ` (${formatTitleCase(String(props.religion))})`
          : '';
      return {
        category: 'landuse',
        primaryTag:
          landuseTag === 'cemetery' && props.religion
            ? `landuse=cemetery + religion=${props.religion}`
            : `landuse=${landuseTag}`,
        cartoLabel: `${matched.label}${relSuffix}`,
        subtype: matched.type,
        isBridge,
        isTunnel,
        layer,
      };
    }

    // 6. Institutional, Civic, Commercial, Transportation & Utility Areas (Polygonal)
    const amenityTag = props.amenity ? String(props.amenity).toLowerCase() : '';
    const manMadeTag = props.man_made ? String(props.man_made).toLowerCase() : '';
    const powerTag = props.power ? String(props.power).toLowerCase() : '';
    const militaryTag = props.military ? String(props.military).toLowerCase() : '';

    if (amenityTag) {
      if (['kindergarten', 'school', 'college', 'university', 'driving_school'].includes(amenityTag)) {
        return {
          category: 'landuse',
          primaryTag: `amenity=${amenityTag}`,
          cartoLabel: `${formatTitleCase(amenityTag)} Campus / Grounds`,
          subtype: 'education',
          isBridge,
          isTunnel,
          layer,
        };
      }
      if (['hospital', 'clinic', 'doctors', 'dentist', 'veterinary', 'pharmacy', 'nursing_home', 'childcare'].includes(amenityTag)) {
        return {
          category: 'landuse',
          primaryTag: `amenity=${amenityTag}`,
          cartoLabel: `${formatTitleCase(amenityTag)} Grounds`,
          subtype: 'healthcare',
          isBridge,
          isTunnel,
          layer,
        };
      }
      if (['grave_yard'].includes(amenityTag)) {
        const rel = props.religion ? ` (${formatTitleCase(String(props.religion))})` : '';
        return {
          category: 'landuse',
          primaryTag: props.religion ? `amenity=grave_yard + religion=${props.religion}` : 'amenity=grave_yard',
          cartoLabel: `Grave Yard${rel}`,
          subtype: 'cemetery',
          isBridge,
          isTunnel,
          layer,
        };
      }
      if (amenityTag === 'parking_space') {
        const pSpaceType = props.parking_space ? ` (${formatTitleCase(String(props.parking_space))})` : '';
        return {
          category: 'landuse',
          primaryTag: props.parking_space
            ? `amenity=parking_space + parking_space=${props.parking_space}`
            : 'amenity=parking_space',
          cartoLabel: `Individual Parking Space${pSpaceType}`,
          subtype: 'parking_space',
          isBridge,
          isTunnel,
          layer,
        };
      }
      if (['parking', 'bicycle_parking', 'motorcycle_parking', 'taxi', 'bus_station', 'ferry_terminal', 'fuel', 'charging_station', 'car_rental', 'bicycle_rental', 'car_wash', 'vehicle_inspection'].includes(amenityTag)) {
        const pSub = props.parking ? ` (${formatTitleCase(String(props.parking))})` : '';
        return {
          category: 'landuse',
          primaryTag: props.parking ? `amenity=${amenityTag} + parking=${props.parking}` : `amenity=${amenityTag}`,
          cartoLabel: `${formatTitleCase(amenityTag)} Area${pSub}`,
          subtype: 'parking',
          isBridge,
          isTunnel,
          layer,
        };
      }
      if (['place_of_worship'].includes(amenityTag)) {
        return {
          category: 'landuse',
          primaryTag: 'amenity=place_of_worship',
          cartoLabel: 'Place of Worship Grounds',
          subtype: 'religious',
          isBridge,
          isTunnel,
          layer,
        };
      }
      if (['marketplace'].includes(amenityTag)) {
        return {
          category: 'landuse',
          primaryTag: 'amenity=marketplace',
          cartoLabel: 'Regulated Marketplace Area',
          subtype: 'retail',
          isBridge,
          isTunnel,
          layer,
        };
      }
      // All other civic / community / commercial amenity polygons
      return {
        category: 'landuse',
        primaryTag: `amenity=${amenityTag}`,
        cartoLabel: `${formatTitleCase(amenityTag)} Area`,
        subtype: 'civic',
        isBridge,
        isTunnel,
        layer,
      };
    }

    if (props.shop === 'mall') {
      return {
        category: 'landuse',
        primaryTag: 'shop=mall',
        cartoLabel: 'Shopping Mall Area',
        subtype: 'retail',
        isBridge,
        isTunnel,
        layer,
      };
    }

    if (powerTag && ['generator', 'substation', 'plant', 'switchgear', 'compensator'].includes(powerTag)) {
      return {
        category: 'landuse',
        primaryTag: `power=${powerTag}`,
        cartoLabel: `Electrical ${formatTitleCase(powerTag)} Area`,
        subtype: 'power',
        isBridge,
        isTunnel,
        layer,
      };
    }

    if (manMadeTag && ['water_works', 'wastewater_plant', 'works', 'bridge', 'pier', 'breakwater', 'groyne'].includes(manMadeTag)) {
      return {
        category: 'landuse',
        primaryTag: `man_made=${manMadeTag}`,
        cartoLabel: `${formatTitleCase(manMadeTag)} Area`,
        subtype: manMadeTag === 'water_works' || manMadeTag === 'wastewater_plant' ? 'water_works' : manMadeTag === 'works' ? 'industrial' : 'platform_area',
        isBridge: manMadeTag === 'bridge',
        isTunnel,
        layer,
      };
    }

    if (militaryTag) {
      return {
        category: 'landuse',
        primaryTag: `military=${militaryTag}`,
        cartoLabel: `Military ${formatTitleCase(militaryTag)} Area`,
        subtype: 'military',
        isBridge,
        isTunnel,
        layer,
      };
    }
  }

  // ============================================================================
  // G. 3D POINT LANDMARKS, TREES, TOWERS & POIs (Points)
  // ============================================================================
  if (isPoint) {
    // 1. Individual 3D Trees
    if (naturalTag === 'tree') {
      const leafType = parseLeafType(props);
      return {
        category: 'landmark',
        primaryTag: props.leaf_type ? `natural=tree + leaf_type=${leafType}` : 'natural=tree',
        cartoLabel: `Tree (${formatTitleCase(leafType)})`,
        subtype: 'tree',
        defaultHeight: 8.5,
        has3DFoliage: true,
        leafType,
        isBridge,
        isTunnel,
        layer,
      };
    }

    // 2. Natural Peaks, Volcanoes, Springs, Caves, Saddles
    if (naturalTag && ['peak', 'volcano', 'saddle', 'spring', 'cave_entrance'].includes(naturalTag)) {
      const ele = props.ele ? ` (${props.ele}m)` : '';
      return {
        category: 'landmark',
        primaryTag: `natural=${naturalTag}`,
        cartoLabel: `${formatTitleCase(naturalTag)}${ele}`,
        subtype: naturalTag === 'volcano' ? 'volcano' : 'peak',
        defaultHeight: 4.0,
        isBridge,
        isTunnel,
        layer,
      };
    }

    // 3. Towers, Masts, Windmills, Lighthouses, Cranes, Chimneys, Storage Tanks, Obelisks
    const manMade = props.man_made ? String(props.man_made).toLowerCase() : '';
    if (manMade) {
      const tType = props['tower:type'] ? String(props['tower:type']).toLowerCase() : '';
      const tConst = props['tower:construction'] ? String(props['tower:construction']).toLowerCase() : '';

      if (manMade === 'tower' || manMade === 'communications_tower' || manMade === 'mast') {
        let subtype: LandmarkType = manMade === 'mast' ? 'mast' : 'tower';
        let label = manMade === 'communications_tower' ? 'Huge Communications Tower' : manMade === 'mast' ? 'Transmission Mast' : 'Tower';
        let height = manMade === 'communications_tower' ? 45.0 : manMade === 'mast' ? 22.0 : 28.0;

        if (tType === 'communication') {
          subtype = 'communication_tower';
          label = tConst ? `Communication Tower (${formatTitleCase(tConst)})` : 'Communication Tower';
          height = 34.0;
        } else if (tType === 'observation' || tType === 'watchtower') {
          subtype = 'observation_tower';
          label = 'Observation / Watch Tower';
          height = 26.0;
        } else if (tType === 'bell_tower') {
          subtype = 'bell_tower';
          label = 'Bell Tower';
          height = 24.0;
        } else if (tType === 'cooling') {
          subtype = 'cooling_tower';
          label = 'Industrial Cooling Tower';
          height = 38.0;
        } else if (tType === 'lighting') {
          label = 'High-Mast Lighting Tower';
          height = 18.0;
        } else if (tType === 'defensive') {
          label = 'Fortified Defensive Tower';
          height = 20.0;
        }

        return {
          category: 'landmark',
          primaryTag: `man_made=${manMade}${tType ? ` + tower:type=${tType}` : ''}${tConst ? ` + tower:construction=${tConst}` : ''}`,
          cartoLabel: label,
          subtype,
          defaultHeight: height,
          isBridge,
          isTunnel,
          layer,
        };
      }

      const manMadeLandmarks: Record<string, { subtype: LandmarkType; label: string; height: number }> = {
        water_tower: { subtype: 'water_tower', label: 'Water Tower', height: 26.0 },
        windmill: { subtype: 'windmill', label: 'Traditional Windmill', height: 20.0 },
        lighthouse: { subtype: 'lighthouse', label: 'Coastal Lighthouse', height: 28.0 },
        chimney: { subtype: 'chimney', label: 'Industrial Chimney', height: 32.0 },
        crane: { subtype: 'crane', label: 'Stationary Crane', height: 28.0 },
        storage_tank: { subtype: 'storage_tank', label: 'Storage Tank', height: 12.0 },
        silo: { subtype: 'storage_tank', label: 'Agricultural / Industrial Silo', height: 16.0 },
        obelisk: { subtype: 'obelisk', label: 'Monumental Obelisk', height: 15.0 },
        cross: { subtype: 'monument', label: 'Summit / Wayside Cross', height: 6.0 },
        telescope: { subtype: 'communication_tower', label: `${formatTitleCase(String(props['telescope:type'] || ''))} Telescope`.trim(), height: 18.0 },
      };

      if (manMadeLandmarks[manMade]) {
        const m = manMadeLandmarks[manMade];
        return {
          category: 'landmark',
          primaryTag: `man_made=${manMade}`,
          cartoLabel: m.label,
          subtype: m.subtype,
          defaultHeight: m.height,
          isBridge,
          isTunnel,
          layer,
        };
      }
    }

    // 4. Wind Turbines & Electricity Pylons / Poles
    const power = props.power ? String(props.power).toLowerCase() : '';
    if (power === 'generator' && (props['generator:source'] === 'wind' || props['generator:method'] === 'wind_turbine')) {
      return {
        category: 'landmark',
        primaryTag: 'power=generator + generator:source=wind',
        cartoLabel: 'Wind Turbine Generator',
        subtype: 'wind_turbine',
        defaultHeight: 42.0,
        isBridge,
        isTunnel,
        layer,
      };
    }
    if (power === 'tower' || power === 'pole') {
      return {
        category: 'landmark',
        primaryTag: `power=${power}`,
        cartoLabel: power === 'tower' ? 'High-Voltage Electricity Pylon' : 'Low-Voltage Electricity Pole',
        subtype: power === 'tower' ? 'power_tower' : 'power_pole',
        defaultHeight: power === 'tower' ? 24.0 : 9.0,
        isBridge,
        isTunnel,
        layer,
      };
    }

    // 5. Historic Objects (Monuments, Memorials, Castles, Forts, Shrines)
    const historic = props.historic ? String(props.historic).toLowerCase() : '';
    if (historic) {
      const memType = props.memorial ? ` (${formatTitleCase(String(props.memorial))})` : '';
      return {
        category: 'landmark',
        primaryTag: props.memorial ? `historic=${historic} + memorial=${props.memorial}` : `historic=${historic}`,
        cartoLabel: `Historic ${formatTitleCase(historic)}${memType}`,
        subtype: historic === 'monument' ? 'monument' : 'memorial',
        defaultHeight: historic === 'monument' ? 10.0 : 4.5,
        isBridge,
        isTunnel,
        layer,
      };
    }

    // 6. Street Furniture & Micro-Amenities (Benches, Waste Bins, Street Lamps, Bike Racks, Fountains, Shelters)
    const ptAmenity = props.amenity ? String(props.amenity).toLowerCase() : '';
    const ptLeisure = props.leisure ? String(props.leisure).toLowerCase() : '';

    if (ptAmenity === 'bench' || ptLeisure === 'picnic_table') {
      const backrest = props.backrest === 'yes' ? ' (With Backrest)' : props.backrest === 'no' ? ' (Backless)' : '';
      return {
        category: 'landmark',
        primaryTag: ptAmenity === 'bench' ? 'amenity=bench' : 'leisure=picnic_table',
        cartoLabel: ptAmenity === 'bench' ? `Public Bench${backrest}` : 'Picnic Table & Benches',
        subtype: 'bench',
        defaultHeight: 0.85,
        isBridge,
        isTunnel,
        layer,
      };
    }

    if (ptAmenity === 'waste_basket' || ptAmenity === 'recycling' || ptAmenity === 'waste_disposal') {
      return {
        category: 'landmark',
        primaryTag: `amenity=${ptAmenity}`,
        cartoLabel:
          ptAmenity === 'recycling'
            ? 'Recycling Container'
            : ptAmenity === 'waste_disposal'
              ? 'Waste Disposal Container'
              : 'Street Waste Bin',
        subtype: 'waste_basket',
        defaultHeight: 1.05,
        isBridge,
        isTunnel,
        layer,
      };
    }

    if (manMade === 'street_lamp') {
      return {
        category: 'landmark',
        primaryTag: 'man_made=street_lamp',
        cartoLabel: 'Street Lamp Post',
        subtype: 'street_lamp',
        defaultHeight: 5.2,
        isBridge,
        isTunnel,
        layer,
      };
    }

    if (ptAmenity === 'bicycle_parking' || ptAmenity === 'bicycle_rental') {
      return {
        category: 'landmark',
        primaryTag: `amenity=${ptAmenity}`,
        cartoLabel: ptAmenity === 'bicycle_rental' ? 'Bicycle Rental Docking Station' : 'Bicycle Parking Stand',
        subtype: 'bicycle_parking',
        defaultHeight: 0.9,
        isBridge,
        isTunnel,
        layer,
      };
    }

    if (ptAmenity === 'fountain' || ptAmenity === 'drinking_water') {
      return {
        category: 'landmark',
        primaryTag: `amenity=${ptAmenity}`,
        cartoLabel: ptAmenity === 'fountain' ? 'Ornamental Fountain' : 'Drinking Water Fountain',
        subtype: 'fountain',
        defaultHeight: 1.6,
        isBridge,
        isTunnel,
        layer,
      };
    }

    if (ptAmenity === 'shelter') {
      return {
        category: 'landmark',
        primaryTag: 'amenity=shelter',
        cartoLabel: 'Weather / Transit Shelter',
        subtype: 'shelter',
        defaultHeight: 2.4,
        isBridge,
        isTunnel,
        layer,
      };
    }

    if (
      ptAmenity === 'post_box' ||
      ptAmenity === 'vending_machine' ||
      ptAmenity === 'parcel_locker' ||
      ptAmenity === 'telephone'
    ) {
      return {
        category: 'landmark',
        primaryTag: `amenity=${ptAmenity}`,
        cartoLabel: `${formatTitleCase(ptAmenity)} Kiosk`,
        subtype: 'post_box',
        defaultHeight: 1.45,
        isBridge,
        isTunnel,
        layer,
      };
    }

    // 7. OSM Carto POI Symbols (Gastronomy, Culture, Shops, Healthcare, Finance, Tourism, Leisure, Civic)
    const poiKeys = ['amenity', 'shop', 'tourism', 'leisure', 'office', 'emergency', 'aerialway', 'place'] as const;
    for (const k of poiKeys) {
      if (props[k] && props[k] !== 'no') {
        const val = String(props[k]).toLowerCase();
        return {
          category: 'landmark',
          primaryTag: `${k}=${val}`,
          cartoLabel: `${formatTitleCase(val)} (${formatTitleCase(k)})`,
          subtype: 'poi',
          defaultHeight: 3.2,
          isBridge,
          isTunnel,
          layer,
        };
      }
    }
  }

  // ============================================================================
  // H. UNSUPPORTED TAG DETECTION (Diagnostics Accounting)
  // ============================================================================
  let identifyingTag = 'untagged';
  const candidateKeys = [
    'barrier',
    'power',
    'amenity',
    'historic',
    'man_made',
    'shop',
    'office',
    'tourism',
    'boundary',
    'place',
    'aeroway',
    'aerialway',
    'military',
  ];

  for (const k of candidateKeys) {
    if (props[k]) {
      identifyingTag = `${k}=${props[k]}`;
      break;
    }
  }

  if (identifyingTag === 'untagged') {
    if (props.natural) identifyingTag = `natural=${props.natural}`;
    else if (props.landuse) identifyingTag = `landuse=${props.landuse}`;
    else if (props.leisure) identifyingTag = `leisure=${props.leisure}`;
  }

  return {
    category: 'unsupported',
    primaryTag: identifyingTag,
    cartoLabel: `Unsupported (${identifyingTag})`,
    isBridge,
    isTunnel,
    layer,
  };
}
