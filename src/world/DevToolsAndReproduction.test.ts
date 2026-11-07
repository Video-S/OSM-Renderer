import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractConnectedOsmFeatures,
  buildReproductionPackage,
  validateReproductionPackage,
  DeveloperReproductionPackage,
} from './dev/ReproductionReport';
import * as THREE from 'three';
import {
  DEFAULT_INFRASTRUCTURE_RENDER_OPTIONS,
  GeometryBuilder,
  normalizeInfrastructureRenderOptions,
  parseInfrastructureRenderOptionsFromSearch,
  resolveInspectedFeature,
} from './GeometryBuilder';
import { LocalGeoJsonProvider } from './LocalGeoJsonProvider';
import { buildRoadNetwork } from './infrastructure/topology/RoadNetworkBuilder';
import { InspectableFeatureInfo } from '../types/MapFeature';
import { MAP_THEMES } from '../styles/mapThemes';
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

  describe('5. Hengelo Junction Real-World Feedback Regressions (TKT-009 Follow-up)', () => {
    // Representative Hengelo junction fixture based on project-owner test report:
    // Central road: way/230163945
    // Connecting branches: way/230163947 and way/532064931
    // Junction nodes: node/45928009 and node/45929045
    // Plus unrelated geographically extensive bus routes and distant streets that previously bloated exports to ~230 features.
    const hengeloCenter: [number, number] = [6.7925, 52.2655];
    const hengeloFixture = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'way/230163945',
          properties: {
            id: 'way/230163945',
            highway: 'secondary',
            name: 'Deldenerstraat',
            lanes: '2',
            surface: 'asphalt',
            _nodeIds: ['45928001', '45928009', '45929045', '45929099'],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [6.7920, 52.2655],
              [6.7924, 52.2655], // node/45928009
              [6.7926, 52.2655], // node/45929045
              [6.7932, 52.2655],
            ],
          },
        },
        {
          type: 'Feature',
          id: 'way/230163947',
          properties: {
            id: 'way/230163947',
            highway: 'tertiary',
            name: 'Geerdinksweg',
            oneway: 'yes',
            width: '4.5',
            _nodeIds: ['45928009', '45928111', '45928222'],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [6.7924, 52.2655], // shares node/45928009
              [6.7925, 52.2652],
              [6.7927, 52.2648],
            ],
          },
        },
        {
          type: 'Feature',
          id: 'way/532064931',
          properties: {
            id: 'way/532064931',
            highway: 'tertiary',
            name: 'Geerdinksweg Noord',
            oneway: 'yes',
            _nodeIds: ['45928222', '45928333', '45929045'],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [6.7927, 52.2648],
              [6.79265, 52.2652],
              [6.7926, 52.2655], // shares node/45929045
            ],
          },
        },
        // Unrelated city-wide bus route relation touching the junction nodes
        {
          type: 'Feature',
          id: 'relation/1948271',
          properties: {
            id: 'relation/1948271',
            type: 'route',
            route: 'bus',
            ref: 'Line 9',
            name: 'Hengelo Centraal - Enschede',
            _nodeIds: ['45928009', '45929045', '99990001', '99990002'],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [6.7924, 52.2655],
              [6.7926, 52.2655],
              [6.8500, 52.2200],
              [6.8900, 52.2100],
            ],
          },
        },
        // Unrelated bicycle network route relation
        {
          type: 'Feature',
          id: 'relation/2847192',
          properties: {
            id: 'relation/2847192',
            type: 'route',
            route: 'bicycle',
            network: 'rcn',
            _nodeIds: ['45928009', '88880001'],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [6.7924, 52.2655],
              [6.8100, 52.2800],
            ],
          },
        },
        // Unrelated distant street connected only via the bus route relation's far nodes
        {
          type: 'Feature',
          id: 'way/777777777',
          properties: {
            id: 'way/777777777',
            highway: 'residential',
            name: 'Distant Enschede Street',
            _nodeIds: ['99990001', '99990002'],
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [6.8500, 52.2200],
              [6.8900, 52.2100],
            ],
          },
        },
      ],
    };

    it('excludes unrelated bus/bicycle transit routes and distant ways while preserving the Hengelo junction ways and shared nodes', () => {
      const extracted = extractConnectedOsmFeatures(
        ['way/230163945'],
        hengeloFixture,
        {
          includeConnectedRoads: true,
          spatialBoxMeters: { minX: -25, maxX: 25, minZ: -25, maxZ: 25 },
          centerLonLat: hengeloCenter,
        }
      );

      const extractedIds = extracted.map((f: any) => String(f.id ?? f.properties?.id));

      // Must include central road and both connecting branches
      assert.ok(extractedIds.includes('way/230163945'), 'Central road way/230163945 must be included');
      assert.ok(extractedIds.includes('way/230163947'), 'Connecting branch way/230163947 must be included');
      assert.ok(extractedIds.includes('way/532064931'), 'Connecting branch way/532064931 must be included');

      // Must NOT include bus route or bicycle route relations or distant streets
      assert.equal(extractedIds.includes('relation/1948271'), false, 'Bus route relation must be excluded');
      assert.equal(extractedIds.includes('relation/2847192'), false, 'Bicycle route relation must be excluded');
      assert.equal(extractedIds.includes('way/777777777'), false, 'Distant unconnected street must be excluded');
      assert.equal(extracted.length, 3, 'Exactly the 3 relevant Hengelo junction ways should be extracted');

      // Verify junction node identities node/45928009 and node/45929045 are preserved
      const central = extracted.find((f: any) => f.id === 'way/230163945');
      assert.ok(central.properties._nodeIds.includes('45928009'), 'Junction node 45928009 must be preserved');
      assert.ok(central.properties._nodeIds.includes('45929045'), 'Junction node 45929045 must be preserved');
    });

    it('supports multiple selected objects (ways and junction nodes), selection-list synchronization, and round-trip export/import', () => {
      const provider = new LocalGeoJsonProvider();
      const mapData = provider.parseGeoJson(
        hengeloFixture,
        'Hengelo Junction',
        hengeloCenter,
        60
      );

      // Simulate selecting inside an existing spatial area selection:
      // 1. User draws spatial box
      const selectedBox = { minX: -25, maxX: 25, minZ: -25, maxZ: 25 };

      // 2. User clicks multiple objects inside the spatial box (road ways + junction node)
      const selectedFeaturesList: InspectableFeatureInfo[] = [
        {
          id: 'way/230163945',
          sourceFeatureId: 'way/230163945',
          category: 'Road',
          cartoLabel: 'Secondary Road',
          primaryTag: 'highway=secondary',
          name: 'Deldenerstraat',
          subtype: 'secondary',
          width: 7.0,
          osmTags: { highway: 'secondary', name: 'Deldenerstraat', lanes: '2' },
        },
        {
          id: 'way/230163947',
          sourceFeatureId: 'way/230163947',
          category: 'Road',
          cartoLabel: 'Tertiary Road',
          primaryTag: 'highway=tertiary',
          name: 'Geerdinksweg',
          subtype: 'tertiary',
          width: 4.5,
          osmTags: { highway: 'tertiary', name: 'Geerdinksweg', oneway: 'yes', width: '4.5' },
        },
        {
          id: 'road_node:osm:45928009',
          sourceFeatureId: 'node/45928009',
          category: 'Junction',
          cartoLabel: 'Junction (junction)',
          primaryTag: 'highway=junction',
          subtype: 'junction',
          osmTags: { 'osm:id': '45928009', role: 'junction', degree: 3 },
        },
      ];

      // Verify adding and removing individual items from selection list
      const withTemporaryExtra = [
        ...selectedFeaturesList,
        {
          id: 'way/532064931',
          sourceFeatureId: 'way/532064931',
          category: 'Road',
          cartoLabel: 'Tertiary Road',
          primaryTag: 'highway=tertiary',
        } as InspectableFeatureInfo,
      ];
      assert.equal(withTemporaryExtra.length, 4);
      const afterIndividualDeselect = withTemporaryExtra.filter((f) => f.id !== 'way/532064931');
      assert.equal(afterIndividualDeselect.length, 3);

      // Build reproduction package with multiple selected objects and spatial area
      // Note: way/532064931 is NOT explicitly selected, so it should be included automatically as connected context!
      const pkg = buildReproductionPackage(
        {
          title: 'Hengelo Deldenerstraat / Geerdinksweg junction shoulder defect',
          description: 'Unnatural geometry shoulder between node/45928009 and node/45929045',
          expectedBehavior: 'Smooth transition along Deldenerstraat across both branch nodes',
          category: 'junction',
          severity: 'high',
        },
        mapData,
        hengeloFixture,
        selectedFeaturesList[0],
        selectedBox,
        {
          infrastructureRenderOptions: { roads: 'graph', railways: 'legacy' },
          railwayPrototypeMode: 'production',
          themeId: 'tactical',
          roadWidthMultiplier: 1.0,
          wireframe: false,
        },
        {
          target: [2.5, 0, -1.2],
          zoom: 12.5,
          azimuthDeg: 30,
        },
        {
          selectedFeatures: afterIndividualDeselect,
          focusedFeatureId: 'way/230163947',
        }
      );

      // Verify explicit selection vs connected context distinction
      assert.ok(pkg.selectedObjects, 'Package must contain selectedObjects');
      assert.equal(pkg.selectedObjects.length, 3, 'Should record 3 explicitly selected objects');
      assert.equal(pkg.focusedFeatureId, 'way/230163947', 'Should preserve focused object ID');
      assert.ok(pkg.selectedArea, 'Should include selectedArea with local and geographic bounds');
      assert.deepEqual(pkg.selectedArea.boundsMeters, selectedBox);

      // Check OSM IDs and explicit vs inferred widths on selectedObjects
      const explicitWay230163947 = pkg.selectedObjects.find((o) => o.osmId === 'way/230163947');
      assert.ok(explicitWay230163947, 'way/230163947 must be in selectedObjects');
      assert.equal(explicitWay230163947.explicitWidthTag, '4.5');
      assert.equal(explicitWay230163947.inferredWidthMeters, 4.5);

      const explicitJunction = pkg.selectedObjects.find((o) => o.osmId === 'node/45928009');
      assert.ok(explicitJunction, 'node/45928009 must be in selectedObjects');
      assert.equal(explicitJunction.category, 'Junction');

      // Connected context: way/532064931 was not explicitly selected, but is included in geoJson.features
      const exportedGeoJsonIds = pkg.geoJson.features.map((f: any) => String(f.id ?? f.properties?.id));
      assert.ok(
        exportedGeoJsonIds.includes('way/532064931'),
        'way/532064931 must be automatically included as connected context'
      );
      assert.equal(
        pkg.connectedContextFeatureCount,
        1,
        'Should report 1 automatically included connected context feature (3 ways total - 2 explicitly selected ways)'
      );

      // Verify graphContext contains the Hengelo junction nodes 45928009 and 45929045
      assert.ok(pkg.graphContext, 'Package must include graphContext');
      const graphOsmNodes = pkg.graphContext.nodes.map((n) => n.osmNodeId);
      assert.ok(graphOsmNodes.includes('45928009'), 'graphContext must contain node 45928009');
      assert.ok(graphOsmNodes.includes('45929045'), 'graphContext must contain node 45929045');

      // Round-trip serialization and validation
      const roundTripPkg: DeveloperReproductionPackage = JSON.parse(JSON.stringify(pkg));
      const validation = validateReproductionPackage(roundTripPkg);
      assert.equal(validation.valid, true, 'Round-tripped Hengelo package must validate cleanly');
      assert.equal(roundTripPkg.selectedObjects?.length, 3);
      assert.equal(roundTripPkg.focusedFeatureId, 'way/230163947');
      assert.deepEqual(roundTripPkg.selectedArea?.boundsMeters, selectedBox);
      assert.equal(roundTripPkg.camera.zoom, 12.5);
      assert.equal(roundTripPkg.configuration.infrastructureRenderOptions.roads, 'graph');
    });

    it('allows clicking and picking underlying road objects inside an active spatial selection rectangle without raycast interception', () => {
      const provider = new LocalGeoJsonProvider();
      const mapData = provider.parseGeoJson(
        hengeloFixture,
        'Hengelo Raycast Test',
        hengeloCenter,
        60
      );

      const builder = new GeometryBuilder({
        roadWidthMultiplier: 1.0,
        infrastructureRenderOptions: { roads: 'graph', railways: 'legacy' },
      });
      const builtScene = builder.buildScene(mapData, MAP_THEMES.tactical);

      try {
        // Construct a root scene group mirroring MapScene with both the spatial selection box
        // at Y = 0.08 (with raycast = () => null) and the built roadsGroup at Y = 0.05
        const rootGroup = new THREE.Group();
        rootGroup.add(builtScene.roadsGroup);

        const spatialSelectionBoxGroup = new THREE.Group();
        spatialSelectionBoxGroup.name = 'DevTools_SpatialSelectionBox';
        spatialSelectionBoxGroup.position.set(0, 0.08, 0);

        const overlayPlane = new THREE.Mesh(
          new THREE.PlaneGeometry(50, 50),
          new THREE.MeshBasicMaterial({ color: '#06b6d4', transparent: true, opacity: 0.22 })
        );
        overlayPlane.rotation.set(-Math.PI / 2, 0, 0);
        // Mirror MapScene's raycast={() => null}
        overlayPlane.raycast = () => {};

        const overlayEdges = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.PlaneGeometry(50, 50)),
          new THREE.LineBasicMaterial({ color: '#22d3ee' })
        );
        overlayEdges.rotation.set(-Math.PI / 2, 0, 0);
        overlayEdges.raycast = () => {};

        spatialSelectionBoxGroup.add(overlayPlane);
        spatialSelectionBoxGroup.add(overlayEdges);
        rootGroup.add(spatialSelectionBoxGroup);
        rootGroup.updateMatrixWorld(true);

        // Cast vertical ray downward inside the selection rectangle onto central road way/230163945 at (0, 0)
        const raycaster = new THREE.Raycaster(
          new THREE.Vector3(0, 20, 0),
          new THREE.Vector3(0, -1, 0)
        );
        const hits = raycaster.intersectObjects(rootGroup.children, true);

        assert.ok(hits.length > 0, 'Ray cast inside selection rectangle must hit underlying geometry');
        assert.notEqual(
          hits[0].object,
          overlayPlane,
          'Spatial selection box plane must never intercept the raycast'
        );

        const pickedFeature = resolveInspectedFeature(hits[0]);
        assert.ok(pickedFeature, 'Hit object inside selection rectangle must resolve to an InspectableFeatureInfo');
        assert.equal(
          pickedFeature.sourceFeatureId,
          'way/230163945',
          'Click inside selection rectangle must pick underlying Hengelo road way/230163945'
        );
      } finally {
        builtScene.dispose();
      }
    });
  });
});


