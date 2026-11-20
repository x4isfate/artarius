// 0.6.0: layers like Azgaar (view parts, presets), hex data fields, cultures and religions from Azgaar, generator climate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { viewOf, isShown, activePreset, BUILTIN_PRESETS, VIEW_PARTS } from "../scripts/data/view.mjs";
import { buildFields, fieldAt, fieldsFit, fieldBox, hasField, rampColor, RAMPS, generatedFields } from "../scripts/data/fields.mjs";
import { buildAzgaarFeatures, mergeTypesAndLayers } from "../scripts/import/azgaar.mjs";
import { generateWorld } from "../scripts/gen/mapgen.mjs";
import HexMath from "../scripts/hex/hexmath.mjs";
import { isRiverLine } from "../scripts/canvas/hex-renderer.mjs";

test("default-off parts turn on when listed, default-on parts turn off", () => {
  assert.equal(isShown("@temp", []), false);
  assert.equal(isShown("@temp", ["@temp"]), true);
  assert.equal(isShown("@marks", []), true);
  assert.equal(isShown("@marks", ["@marks"]), false);
  assert.equal(isShown("politics", ["politics"]), false);
  const v = viewOf([]);
  assert.equal(v.grid, true);
  assert.equal(v.coords, false);
  assert.equal(v.rivers, true);
  for ( const id of ["@heights", "@temp", "@prec", "@pop", "@ice", "@windrose", "@scale", "@coords", "@borders", "@grid", "@rivers"] ) {
    assert.ok(VIEW_PARTS.includes(id), id);
  }
});

test("presets ignore layers the map does not have", () => {
  const known = new Set(["terrain", "politics", "regions", ...VIEW_PARTS]);
  const political = BUILTIN_PRESETS.find(p => p.id === "political");
  // A map without cultures/religions layers: the backend may drop those ids.
  const stored = political.hidden.filter(id => known.has(id));
  assert.equal(activePreset(stored, BUILTIN_PRESETS, known), "political");
  for ( const id of ["borders", "peoples", "religions", "climate"] ) assert.ok(BUILTIN_PRESETS.some(p => p.id === id), id);
  const climate = BUILTIN_PRESETS.find(p => p.id === "climate");
  assert.ok(isShown("@temp", climate.hidden) && isShown("@prec", climate.hidden));
});

test("fields are indexed from the first row and column of the field", () => {
  const cells = [[2, 3], [2, 4], [3, 3], [3, 4]];
  const f = buildFields(cells, ([i, j]) => ({ height: i * 10 + j, temp: -i, prec: null, pop: 1.234 }));
  assert.deepEqual(fieldBox(cells), { i0: 2, j0: 3, cols: 2, rows: 2 });
  assert.equal(fieldAt(f, "height", [3, 4]), 34);
  assert.equal(fieldAt(f, "temp", [2, 3]), -2);
  assert.equal(fieldAt(f, "prec", [2, 3]), null);
  assert.equal(fieldAt(f, "pop", [2, 3]), 1.2);
  assert.equal(fieldAt(f, "height", [9, 9]), null);
  assert.ok(fieldsFit(f, cells));
  assert.ok(!fieldsFit(f, [...cells, [4, 3]]), "after resize the old fields do not fit");
  assert.ok(hasField(f, "height") && !hasField(f, "prec"));
});

test("ramps blend between stops", () => {
  assert.equal(rampColor(RAMPS.temp, -100), RAMPS.temp[0][1]);
  assert.equal(rampColor(RAMPS.temp, 100), RAMPS.temp.at(-1)[1]);
  assert.match(rampColor(RAMPS.prec, 35), /^#[0-9a-f]{6}$/);
});

test("rivers are told apart from routes", () => {
  const types = [{ id: "creek", water: true }, { id: "road" }];
  assert.ok(isRiverLine({ system: { typeId: "river" } }, types));
  assert.ok(isRiverLine({ system: { typeId: "creek" } }, types));
  assert.ok(!isRiverLine({ system: { typeId: "road" } }, types));
});

// Azgaar: 2×2 map of 10 px cells, the left column is one culture and religion.
function azgaar() {
  const W = 2, H = 2, S = 10;
  const cells = [], grid = [];
  for ( let y = 0; y < H; y++ ) for ( let x = 0; x < W; x++ ) {
    const i = (y * W) + x;
    cells.push({ i, g: i, p: [(x * S) + 5, (y * S) + 5], h: 40, biome: 4, state: 0, culture: x === 0 ? 1 : 0, religion: x === 0 ? 2 : 0, pop: 3 + i });
    grid.push({ i, temp: 10 - (y * 20), prec: 50 + x });
  }
  return {
    info: { width: W * S, height: H * S, mapId: 5 },
    grid: { cells: grid },
    pack: {
      cells,
      cultures: [{ i: 0, name: "Wildlands" }, { i: 1, name: "Хвоны", color: "#884488" }],
      religions: [{ i: 0, name: "No religion" }, { i: 1, name: "Пустая" }, { i: 2, name: "Марево", color: "#bbaa22" }]
    }
  };
}

test("Azgaar cultures and religions become zone layers, climate becomes fields", () => {
  const hm = new HexMath({ size: 10, rows: 6, cols: 6 });
  const rect = { x: 0, y: 0, width: hm.width, height: hm.height };
  let n = 0;
  const built = buildAzgaarFeatures(azgaar(), { rect, hexes: hm.allCells(), center: c => hm.center(c), cellAt: p => hm.cellAt(p), newId: () => `id${++n}` });
  assert.equal(built.stats.cultures, 1);
  assert.equal(built.stats.religions, 1);
  const culture = built.features.find(f => f.system.typeId === "culture");
  assert.equal(culture.name, "Хвоны");
  assert.equal(culture.system.layerId, "cultures");
  assert.equal(built.features.find(f => f.system.typeId === "religion").system.layerId, "religions");
  const f = built.fields;
  assert.ok(hasField(f, "temp") && hasField(f, "prec") && hasField(f, "pop") && hasField(f, "height"));
  const temps = hm.allCells().map(c => fieldAt(f, "temp", c));
  assert.ok(temps.includes(10) && temps.includes(-10), "temperature taken from grid cells");
  const merged = mergeTypesAndLayers([], []);
  assert.ok(merged.layers.some(l => l.id === "cultures") && merged.layers.some(l => l.id === "religions"));
  assert.ok(merged.types.some(t => t.id === "culture") && merged.types.some(t => t.id === "religion"));
});

test("generator returns climate: sea is low, poles are cold", () => {
  const hm = new HexMath({ size: 40, rows: 16, cols: 22 });
  const cells = hm.allCells();
  const built = generateWorld({ cells, center: c => hm.center(c), seed: "climate", newId: () => Math.random().toString(36).slice(2) });
  const f = generatedFields({ cells, ...built.climate, terrain: built.terrain, key: c => `${c[0]},${c[1]}` });
  const water = cells.filter(c => built.terrain.get(`${c[0]},${c[1]}`) === "water");
  const land = cells.filter(c => built.terrain.get(`${c[0]},${c[1]}`) !== "water");
  assert.ok(water.every(c => fieldAt(f, "height", c) < 20));
  assert.ok(land.every(c => fieldAt(f, "height", c) >= 20));
  assert.ok(water.every(c => fieldAt(f, "pop", c) === 0));
  const mid = fieldAt(f, "temp", [8, 10]), pole = fieldAt(f, "temp", [0, 10]);
  assert.ok(pole < mid, `pole ${pole} colder than middle ${mid}`);
});
