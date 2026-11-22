import assert from 'node:assert/strict';
import test from 'node:test';
import { MAP_THEMES } from '../styles/mapThemes';

const naturalIds = ['natural_daylight', 'natural_cartographic', 'natural_game'] as const;
const developedLanduse = [
  'residential', 'commercial', 'industrial', 'retail',
  'institutional', 'education', 'healthcare', 'civic', 'religious',
  'military', 'tourism_area',
] as const;
const pavedRoads = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential',
  'living_street', 'service', 'cycleway', 'busway', 'bus_guideway',
  'bridge', 'unclassified',
] as const;

for (const id of naturalIds) {
  test(`${id}: archetypes do not alter building materials`, () => {
    const theme = MAP_THEMES[id];
    assert.equal(theme.id, id);
    assert.ok(theme.buildingArchetypeColors);

    for (const archetype of Object.values(theme.buildingArchetypeColors)) {
      assert.equal(archetype.wall, theme.buildingWallColor);
      assert.equal(archetype.roof, theme.buildingRoofColor);
    }
  });

  test(`${id}: developed land-use categories share the base ground material`, () => {
    const theme = MAP_THEMES[id];

    for (const landuse of developedLanduse) {
      assert.equal(theme.landuseColors[landuse], theme.groundColor, landuse);
    }
    assert.equal(theme.landuseColors.landuse, theme.groundColor);
    assert.equal(theme.terrainColors?.forest, theme.terrainColors?.wood);
    assert.equal(theme.terrainColors?.meadow, theme.terrainColors?.grassland);
  });

  test(`${id}: road hierarchy and cycleways do not introduce category tinting`, () => {
    const theme = MAP_THEMES[id];

    for (const roadClass of pavedRoads) {
      assert.equal(theme.roadColors[roadClass], theme.roadColors.primary, roadClass);
    }
    assert.equal(theme.landuseColors.parking, theme.roadColors.primary);
    assert.equal(theme.landuseColors.parking_space, theme.roadColors.primary);
    assert.notEqual(theme.roadColors.footway, theme.roadColors.primary);
  });

  test(`${id}: palette is complete and contains valid flat material colors`, () => {
    const theme = MAP_THEMES[id];
    const reference = MAP_THEMES.daylight;

    for (const collection of ['roadColors', 'landuseColors', 'terrainColors'] as const) {
      const colors = theme[collection];
      const expected = reference[collection];
      assert.ok(colors);
      assert.ok(expected);
      assert.deepEqual(Object.keys(colors).sort(), Object.keys(expected).sort(), collection);
      for (const value of Object.values(colors)) {
        assert.match(value, /^#[0-9a-f]{6}$/i);
      }
    }
  });
}

test('all three natural variants have different material palettes', () => {
  const themes = naturalIds.map((id) => MAP_THEMES[id]);
  assert.equal(new Set(themes.map((theme) => theme.groundColor)).size, 3);
  assert.equal(new Set(themes.map((theme) => theme.buildingRoofColor)).size, 3);
  assert.equal(new Set(themes.map((theme) => theme.waterColor)).size, 3);
});
