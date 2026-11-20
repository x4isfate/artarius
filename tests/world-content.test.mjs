// World content (0.8): type folders, emoji, label font, new biomes and phenomena, piece generator, curved labels.
import { test } from "node:test";
import assert from "node:assert/strict";
import Studio from "../scripts/studio.mjs";
import MemoryBackend from "./harness/memory-backend.mjs";
import HexMath from "../scripts/hex/hexmath.mjs";
import { STARTER_TYPES, STARTER_LAYERS, PHENOMENA_TYPES } from "../scripts/constants.mjs";
import { ICON_LIBRARY } from "../scripts/data/icons.mjs";
import { generateWorld, generateTerrainData, biomeOf, hexDist, withNeutralTypes, RECIPES } from "../scripts/gen/mapgen.mjs";
import { NEUTRAL_OBJECTS, NEUTRAL_TYPES, layoutRecipe, piecesHeight, PIECES } from "../scripts/gen/pieces.mjs";
import { largestComponent, labelPath, placeLetters, pointAt, fitFontSize } from "../scripts/geometry/label-path.mjs";
import { seededRandom } from "../scripts/geometry/geometry.mjs";
import fs from "node:fs";

const setup = () => {
  const backend = new MemoryBackend();
  const studio = new Studio(backend);
  return { backend, studio };
};
const hm = new HexMath({ size: 60, rows: 30, cols: 44 });
const cells = hm.allCells();
const center = c => hm.center(c);
const ids = () => { let n = 0; return () => `w${++n}`; };
const k = ([i, j]) => `${i},${j}`;

test("mark type keeps folder, emoji and label font; folders list puts no-folder first", async () => {
  const { studio } = setup();
  studio.openTypeForm("object");
  Object.assign(studio.typeForm, { name: "Дракон", emoji: "🐉", labelFont: "Amiri", folder: "Чудовища" });
  await studio.saveTypeForm();
  const t = studio.typesOf("object").find(x => x.name === "Дракон");
  assert.equal(t.style.emoji, "🐉");
  assert.equal(t.style.labelFont, "Amiri");
  assert.equal(t.folder, "Чудовища");
  assert.deepEqual(studio.typeFolders("object"), ["", "Чудовища"]);
  studio.openTypeForm("object", t.id);
  assert.equal(studio.typeForm.emoji, "🐉");
  Object.assign(studio.typeForm, { emoji: "", folder: "" });
  await studio.saveTypeForm();
  const again = studio.typeById(t.id);
  assert.equal(again.style.emoji, undefined);
  assert.equal(again.folder, undefined);
});

test("area type and a single zone can set curved / straight / hidden label and its size", async () => {
  const { studio } = setup();
  studio.openTypeForm("area", "realm");
  Object.assign(studio.typeForm, { labelMode: "straight", labelScale: 1.5 });
  await studio.saveTypeForm();
  assert.equal(studio.typeById("realm").style.labelMode, "straight");
  assert.equal(studio.typeById("realm").style.labelScale, 1.5);
  studio.setTool("zone", { toggle: false });
  studio.zone.typeId = "realm";
  await studio.attach([[3, 3], [3, 4]]);
  const z = [...studio.states.values()].find(s => s.system.typeId === "realm");
  await studio.setField(z.id, "labelMode", "curved");
  await studio.setField(z.id, "labelScale", 9);
  assert.equal(studio.stateOf(z.id).system.style.labelMode, "curved");
  assert.equal(studio.stateOf(z.id).system.style.labelScale, 3, "clamped");
  await studio.setField(z.id, "labelMode", "");
  assert.equal(studio.stateOf(z.id).system.style.labelMode, undefined, "back to type");
});

test("five new biomes and a phenomena layer with disasters", () => {
  for ( const id of ["savanna", "jungle", "taiga", "tundra", "mangrove"] ) {
    assert.equal(STARTER_TYPES.find(t => t.id === id)?.layerId, "terrain", id);
  }
  const layer = STARTER_LAYERS.find(l => l.id === "phenomena");
  assert.ok(layer && !layer.exclusive);
  assert.ok(STARTER_LAYERS.indexOf(layer) < STARTER_LAYERS.findIndex(l => l.id === "overlay"), "под «Прочим»");
  assert.ok(PHENOMENA_TYPES.length >= 6);
  for ( const t of PHENOMENA_TYPES ) {
    assert.equal(t.layerId, "phenomena");
    assert.ok(t.style.pattern && t.style.pattern !== "none");
  }
  for ( const n of ["Ураган", "Шаткие скалы", "Горящий лес"] ) assert.ok(PHENOMENA_TYPES.some(t => t.name === n), n);
});

test("icon library has animals, plants and disasters, and every file exists", () => {
  for ( const c of ["animals", "plants", "disasters"] ) assert.ok(ICON_LIBRARY[c]?.length >= 5, c);
  for ( const [name] of [...ICON_LIBRARY.animals, ...ICON_LIBRARY.plants, ...ICON_LIBRARY.disasters] ) {
    assert.ok(fs.existsSync(new URL(`../assets/icons/${name}.svg`, import.meta.url)), name);
  }
});

test("biomes follow heat and moisture: cold is tundra or taiga, hot is desert, savanna or jungle", () => {
  assert.equal(biomeOf(0.1, 0.5), "tundra");
  assert.equal(biomeOf(0.35, 0.6), "taiga");
  assert.equal(biomeOf(0.55, 0.1), "desert");
  assert.equal(biomeOf(0.55, 0.6), "forest");
  assert.equal(biomeOf(0.9, 0.4), "savanna");
  assert.equal(biomeOf(0.9, 0.75), "jungle");
  assert.equal(biomeOf(0.9, 0.75, { coast: true, low: true }), "mangrove");
  // Тундра и пустыня не встречаются рядом: между ними всегда что-то есть.
  const { terrain } = generateTerrainData({ cells, center, seed: "nb" });
  for ( const c of cells ) {
    if ( terrain.get(k(c)) !== "desert" ) continue;
    for ( const nb of hm.neighbors(c) ) assert.notEqual(terrain.get(k(nb)), "tundra", `пустыня у тундры в ${c}`);
  }
});

test("every recipe builds a world with land and sea; different seeds give different shapes", () => {
  for ( const r of RECIPES ) {
    for ( const [id] of r.parts ) assert.ok(PIECES[id], `${r.id}: нет кусочка ${id}`);
    const d = generateTerrainData({ cells, center, seed: `r-${r.id}`, recipe: r.id });
    assert.equal(d.recipe, r.id);
    const water = [...d.terrain.values()].filter(t => t === "water").length / cells.length;
    assert.ok(water > 0.25 && water < 0.45, `${r.id}: вода ${water}`);
  }
  const a = generateTerrainData({ cells, center, seed: "u1" }), b = generateTerrainData({ cells, center, seed: "u2" });
  const same = cells.filter(c => (a.terrain.get(k(c)) === "water") === (b.terrain.get(k(c)) === "water")).length / cells.length;
  assert.ok(same < 0.9, `миры слишком похожи: ${same}`);
});

test("land pieces do not stack into one mountain where they overlap", () => {
  const rnd = seededRandom("stack");
  const layout = [{ id: "continent", cx: 0.5, cy: 0.5, k: 1, rot: 0 }, { id: "subcontinent", cx: 0.5, cy: 0.5, k: 1, rot: 0 }];
  const h = piecesHeight(layout, 1.5, rnd);
  assert.ok(h(0.5, 0.5) <= 0.71, `${h(0.5, 0.5)}`);
  assert.ok(layoutRecipe(RECIPES[0], seededRandom("l")).length >= 5);
});

test("neutral objects stand on fitting terrain, at least three hexes apart, with their own folder types", () => {
  const { features, terrain, stats } = generateWorld({ cells, center, seed: "poi", neutral: 1, newId: ids(), realms: [{ name: "А" }] });
  const poi = features.filter(f => f.system.ext.artariusGen.kind === "neutral");
  assert.ok(poi.length >= 5, `объектов ${poi.length}`);
  assert.equal(stats.neutral, poi.length);
  for ( const f of poi ) {
    const obj = NEUTRAL_OBJECTS.find(o => o.id === f.system.typeId);
    assert.ok(obj.terrain.includes(terrain.get(k(f.system.geometry.cell))), `${obj.id} не на своей местности`);
    assert.ok(obj.names.includes(f.name));
  }
  for ( const a of poi ) for ( const b of poi ) {
    if ( a !== b ) assert.ok(hexDist(a.system.geometry.cell, b.system.geometry.cell) >= 3);
  }
  const none = generateWorld({ cells, center, seed: "poi", neutral: 0, newId: ids() });
  assert.equal(none.stats.neutral, 0);
  const types = withNeutralTypes([{ id: "poi-ruins", name: "Мои руины" }]);
  assert.equal(types.find(t => t.id === "poi-ruins").name, "Мои руины", "свой тип не трогается");
  assert.equal(types.length, NEUTRAL_TYPES.length);
  assert.ok(NEUTRAL_TYPES.every(t => t.folder === "Нейтральные объекты"));
});

test("hexDist matches neighbours and straight runs", () => {
  for ( const nb of hm.neighbors([5, 5]) ) assert.equal(hexDist([5, 5], nb), 1);
  assert.equal(hexDist([4, 2], [4, 9]), 7);
  assert.equal(hexDist([3, 3], [3, 3]), 0);
});

test("curved label: path follows a long zone, letters go left to right and stay on the path", () => {
  // Дуга из гексов: середина ниже краёв.
  const arc = [];
  for ( let j = 2; j <= 20; j++ ) {
    const i = 8 + Math.round(4 * Math.sin(((j - 2) / 18) * Math.PI));
    arc.push([i, j], [i + 1, j]);
  }
  const part = largestComponent([...arc, [25, 40]], c => hm.neighbors(c));
  assert.equal(part.length, arc.length, "остров отброшен");
  const lp = labelPath(part.map(c => { const p = hm.center(c); return [p.x, p.y]; }));
  const width = hm.center([8, 20]).x - hm.center([8, 2]).x;
  assert.ok(lp.length > width * 0.6, `путь ${lp.length} при ширине ${width}`);
  const mid = lp.path[Math.floor(lp.path.length / 2)], first = lp.path[0], last = lp.path.at(-1);
  assert.ok(first[0] < last[0], "слева направо");
  assert.ok(mid[1] > first[1] && mid[1] > last[1], "путь прогибается вслед за зоной");
  const at = placeLetters(lp.path, [10, 10, 10, 10]);
  for ( let i = 1; i < at.length; i++ ) assert.ok(at[i].x > at[i - 1].x);
  assert.ok(Math.abs(pointAt(lp.path, -10).angle - pointAt(lp.path, 0).angle) < 1e-9, "до начала путь идёт прямо");
  assert.equal(fitFontSize("Держава", 1000, { max: 40 }), 40);
  assert.equal(fitFontSize("Держава", 10, { min: 12 }), 12);
  assert.equal(labelPath([[0, 0]]), null);
});

test("vertical zones get a label tilted at most 45°", () => {
  const col = [];
  for ( let i = 2; i < 24; i++ ) col.push([i, 10]);
  const lp = labelPath(col.map(c => { const p = hm.center(c); return [p.x, p.y]; }), { bend: 0 });
  const [a, b] = [lp.path[0], lp.path.at(-1)];
  assert.ok(Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0])) <= (Math.PI / 4) + 1e-6);
});
