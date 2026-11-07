import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractConnectedOsmFeatures,
  buildReproductionPackage,
  validateReproductionPackage,
  DeveloperReproductionPackage,
} from './dev/ReproductionReport';
import {
  DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS,
  normalizeInfrastructureRenderOptions,
  parseInfrastructureRenderOptionsFromSearch,
} from './GeometryBuilder';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { buildRoadNetwork } from './infrastructure/topology/RoadNetworkBuilder';
import { InspectableFeatureInfo } from '../types/MapFeature';
import prinsHendrikkadeForkFixture from './prototype/PrinsHendrikkadeForkFixture.json';

describe('Developer Tools & Reproduction Reporting (TKT-009)', () => {
  describe('1. Configuration & Mode Switching', () => {
    it('normalizes partial and default infrastructure render options cleanly', () => {
      const defaultOpts = normalizeInfrastructureRenderOptions(DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS);
      assert.equal(defaultOpts.roads, 'legacy');
      assert.equal(defaultOpts.railways, 'legacy');

      const graphOpts = normalizeInfrastructureRenderOptions({ roads: 'graph' });
      assert.equal(graphOpts.roads, 'graph');
      assert.equal(graphOpts.railways, 'legacy');

      const previewOpts = normalizeInfrastructureRenderOptions({ roads: 'graph-preview', railways: 'graph-preview' });
      assert.equal(previewOpts.roads, 'graph-preview');
      assert.equal(previewOpts.railways, 'graph-preview');
    });

    it('parses legacy URL query parameters for backwards compatibility', () => {
      const opts1 = parseInfrastructureRenderOptionsFromSearch('?topologyRoads=graph&topologyRailways=graph-preview');
      assert.equal(opts1.roads, 'graph');
      assert.equal(opts1.railways, 'graph-preview');

      const opts2 = parseInfrastructureRenderOptionsFromSearch('?topologyRoads=graph-preview');
      assert.equal(opts2.roads, 'graph-preview');
      assert.equal(opts2.railways, 'legacy');

      const emptyOpts = parseInfrastructureRenderOptionsFromSearch('');
      assert.equal(emptyOpts.roads, 'legacy');
      assert.equal(emptyOpts.railways, 'legacy');
    });
  });

  describe('2. Connected OSM Feature Extraction', () => {
    const provider = new LocalGeoJsonProvider();
    const mapData = provider.parseGeoJson(
      prinsHendrikkadeForkFixture,
      'Prins Hendrikkade Fork',
      [4.8979247, 52.3773823],
      60
    );

    it('extracts selected road feature and directly connected incident ways by shared node ID', () => {
      // Find the bidirectional southern cycleway way/682105412
      const selectedRoad = mapData.roads.find((r) => r.id.includes('682105412'));
      assert.ok(selectedRoad, 'Expected road 682105412 in Prins Hendrikkade fixture');

      const extracted = extractConnectedOsmFeatures(
        ['way/682105412'],
        prinsHendrikkadeForkFixture,
        {
          includeConnectedRoads: true,
          centerLonLat: mapData.centerLonLat,
        }
      );

      assert.ok(Array.isArray(extracted), 'Expected array of extracted features');
      assert.ok(extracted.length >= 2, `Expected at least 2 connected features, got ${extracted.length}`);

      // Verify selected feature is present
      const primary = extracted.find((f: any) => String(f.id ?? f.properties?.id) === 'way/682105412');
      assert.ok(primary, 'Primary feature must be included');

      // Verify original OSM node IDs are preserved on properties._nodeIds
      assert.ok(Array.isArray(primary.properties?._nodeIds), 'Expected properties._nodeIds on extracted feature');
      assert.ok(primary.properties._nodeIds.includes('6387677253'), 'Expected junction node 6387677253 preserved');

      // Verify connected ways sharing node 6387677253 are also included
      const connectedWay = extracted.find((f: any) => String(f.id ?? f.properties?.id) === 'way/682105414');
      assert.ok(connectedWay, 'Expected adjoining one-way cycleway 682105414 to be included in connected context');
    });

    it('extracts features intersecting a spatial bounding box in local meter coordinates', () => {
      // A bounding box around the center [0, 0]
      const box = {
        minX: -30,
        maxX: 30,
        minZ: -30,
        maxZ: 30,
      };

      const extracted = extractConnectedOsmFeatures(
        [],
        prinsHendrikkadeForkFixture,
        {
          spatialBoxMeters: box,
          centerLonLat: mapData.centerLonLat,
        }
      );

      assert.ok(Array.isArray(extracted), 'Expected array of features');
      assert.ok(extracted.length >= 1, 'Expected spatial extraction to find features intersecting the box');

      // Verify every extracted feature has geometry and valid coordinates
      for (const feat of extracted) {
        assert.ok(feat.geometry, 'Feature must have geometry');
        assert.ok(Array.isArray(feat.geometry.coordinates), 'Feature must have coordinates');
      }
    });

    it('extracts all map features when neither feature nor box is selected as complete fallback', () => {
      const extracted = extractConnectedOsmFeatures(
        [],
        prinsHendrikkadeForkFixture
      );
      assert.equal(extracted.length, prinsHendrikkadeForkFixture.features.length);
    });
  });

  describe('3. Reproduction Package Bundling and Validation', () => {
    it('builds a valid reproduction package with complete metadata', () => {
      const provider = new LocalGeoJsonProvider();
      const mapData = provider.parseGeoJson(
        prinsHendrikkadeForkFixture,
        'Prins Hendrikkade Test',
        [4.8979247, 52.3773823],
        60
      );

      const pkg = buildReproductionPackage(
        {
          title: 'Acute cycleway junction glitch',
          description: 'Two cycleways form an acute angle at node 6387677253 causing miter spike',
          expectedBehavior: 'Junction cap or chamfer should cleanly truncate the acute angle',
          category: 'junction',
          severity: 'high',
        },
        mapData,
        prinsHendrikkadeForkFixture,
        null,
        null,
        {
          infrastructureRenderOptions: { roads: 'graph', railways: 'legacy' },
          railwayPrototypeMode: 'production',
          themeId: 'tactical',
          roadWidthMultiplier: 1.0,
          wireframe: false,
        },
        {
          target: [0, 0, 0],
          zoom: 8.0,
          azimuthDeg: 45,
        }
      );

      assert.equal(pkg.formatVersion, '1.0');
      assert.equal(pkg.report.title, 'Acute cycleway junction glitch');
      assert.equal(pkg.report.severity, 'high');
      assert.equal(pkg.configuration.infrastructureRenderOptions.roads, 'graph');
      assert.equal(pkg.camera.zoom, 8.0);
      assert.equal(pkg.geoJson.type, 'FeatureCollection');
      assert.ok(pkg.geoJson.features.length > 0);

      // Validate package
      const validation = validateReproductionPackage(pkg);
      assert.equal(validation.valid, true);
      assert.equal(validation.errors.length, 0);
    });

    it('rejects invalid or corrupted reproduction packages', () => {
      const invalidPkg1: any = { formatVersion: '1.0.0' };
      const res1 = validateReproductionPackage(invalidPkg1);
      assert.equal(res1.valid, false);
      assert.ok(res1.errors.some((e) => e.includes('report')));

      const invalidPkg2: any = {
        formatVersion: '1.0.0',
        report: { title: 'Test' },
        geoJson: { type: 'Invalid' },
      };
      const res2 = validateReproductionPackage(invalidPkg2);
      assert.equal(res2.valid, false);
      assert.ok(res2.errors.some((e) => e.includes('FeatureCollection')));
    });
  });

  describe('4. Full Round-Trip Reproduction & Graph Consistency', () => {
    it('imports an exported reproduction package and constructs identical road network topology', () => {
      const provider = new LocalGeoJsonProvider();
      const originalMapData = provider.parseGeoJson(
        prinsHendrikkadeForkFixture,
        'Original Prins Hendrikkade',
        [4.8979247, 52.3773823],
        60
      );

      // Build baseline graph from original
      const originalResult = buildRoadNetwork(originalMapData);
      const originalGraph = originalResult.roads;

      // Export reproduction package
      const pkg = buildReproductionPackage(
        {
          title: 'Roundtrip test scenario',
          description: 'Testing export and re-import of junction topology',
          expectedBehavior: 'Identical graph nodes and edges after import',
          category: 'junction',
          severity: 'low',
        },
        originalMapData,
        prinsHendrikkadeForkFixture,
        null,
        null,
        {
          infrastructureRenderOptions: { roads: 'graph', railways: 'legacy' },
          railwayPrototypeMode: 'production',
          themeId: 'tactical',
          roadWidthMultiplier: 1.0,
          wireframe: false,
        },
        {
          target: [0, 0, 0],
          zoom: 8.0,
          azimuthDeg: 45,
        }
      );

      // Simulate re-importing the JSON reproduction package
      const jsonString = JSON.stringify(pkg);
      const importedPkg: DeveloperReproductionPackage = JSON.parse(jsonString);

      const validation = validateReproductionPackage(importedPkg);
      assert.equal(validation.valid, true, 'Imported package must be valid');

      // Parse the imported GeoJSON into ProcessedMapData
      const importedMapData = provider.parseGeoJson(
        importedPkg.geoJson,
        importedPkg.report.title,
        [4.8979247, 52.3773823],
        60
      );

      // Build graph from imported data
      const importedResult = buildRoadNetwork(importedMapData);
      const importedGraph = importedResult.roads;

      // Assert topology consistency: node counts, edge counts, and junction identification
      assert.equal(
        importedGraph.nodes.size,
        originalGraph.nodes.size,
        'Imported graph must have identical node count'
      );
      assert.equal(
        importedGraph.edges.size,
        originalGraph.edges.size,
        'Imported graph must have identical edge count'
      );

      // Node 6387677253 must exist in both graphs and have the exact same degree
      const originalJunctionNode = Array.from(originalGraph.nodes.values()).find(
        (n) => n.rawOsmNodeId === '6387677253'
      );
      const importedJunctionNode = Array.from(importedGraph.nodes.values()).find(
        (n) => n.rawOsmNodeId === '6387677253'
      );

      assert.ok(originalJunctionNode, 'Original junction node must exist');
      assert.ok(importedJunctionNode, 'Imported junction node must exist');
      assert.equal(originalJunctionNode.degree, 3, 'Original junction node must have degree 3');
      assert.equal(importedJunctionNode.degree, 3, 'Imported junction node must have degree 3');
      assert.ok(originalJunctionNode.roles.includes('junction'));
      assert.ok(importedJunctionNode.roles.includes('junction'));
      assert.equal(
        importedJunctionNode.incidentHalfEdges.length,
        originalJunctionNode.incidentHalfEdges.length,
        'Junction incident edges degree must match exactly'
      );
    });
  });
});
