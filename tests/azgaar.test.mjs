// Azgaar import onto hexes: transform, terrain, zones, marks and lines built from an export.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateAzgaar, makeTransform, terrainOf, buildAzgaarFeatures, mergeTypesAndLayers, AZGAAR_TYPES, AZGAAR_LAYERS
} from "../scripts/import/azgaar.mjs";
import HexMath from "../scripts/hex/hexmath.mjs";

/**
 * A tiny "Full" export: 6×4 square cells of 10 px on a 60×40 map.
 * Vertices are shared like in Azgaar's Voronoi graph. Every other cell lists its
 * vertices in the opposite order to check that orientation is normalized.
 * States: 1 on columns 0–2, 2 on columns 3–5 except cell (4,1) which is neutral.
 * Terrain: column 0 is sea (h 10), the rest is temperate forest (biome 6, h 30).
 */
function fixture() {
  const W = 6, H = 4, S = 10;
  const vid = (x, y) => (y * (W + 1)) + x;
  const vertices = [];
  for ( let y = 0; y <= H; y++ ) for ( let x = 0; x <= W; x++ ) vertices.push({ i: vid(x, y), p: [x * S, y * S] });
  const cells = [];
  for ( let y = 0; y < H; y++ ) {
    for ( let x = 0; x < W; x++ ) {
      const i = (y * W) + x;
      let v = [vid(x, y), vid(x + 1, y), vid(x + 1, y + 1), vid(x, y + 1)];
      if ( i % 2 ) v = v.reverse();
      let state = x < 3 ? 1 : 2;
      if ( x === 4 && y === 1 ) state = 0;
      cells.push({ i, v, p: [(x * S) + 5, (y * S) + 5], h: x === 0 ? 10 : 30, biome: x === 0 ? 0 : 6, state, province: x < 3 ? 1 : 0, burg: 0 });
    }
  }
  return {
    info: { width: W * S, height: H * S, seed: "42", mapId: 777, mapName: "Тест" },
    pack: {
      cells, vertices,
      states: [
        { i: 0, name: "Neutrals" },
        { i: 1, name: "Кумачи", fullName: "Царство Кумачей", color: "#aa3322", form: "Monarchy", formName: "Царство" },
        { i: 2, name: "Винтер", color: "#3355aa" },
        { i: 3, name: "Пустая", removed: true }
      ],
      provinces: [0, { i: 1, name: "Холмы", color: "#226622" }],
      burgs: [
        {},
        { i: 1, name: "Винтерфол", x: 45, y: 25, state: 2, capital: 1, population: 12.5, port: 1 },
        { i: 2, name: "Деревня", x: 5, y: 5, state: 1 },
        { i: 3, name: "Снесён", x: 1, y: 1, removed: true }
      ],
      rivers: [
        { i: 1, name: "Быстрая", type: "River", width: 2, cells: [0, 6, 12, 18, -1] },
        { i: 2, name: "Ручей", cells: [5] }
      ],
      routes: [
        { i: 0, group: "roads", name: "Тракт", points: [[5, 5, 0], [25, 5, 2], [45, 25, 16]] },
        { i: 1, group: "searoutes", points: [[0, 35, 18], [55, 35, 23]] }
      ]
    }
  };
}

// Сцена 600×400 из гексов: 12 гексов в ряд по 50 px.
const hm = new HexMath({ size: 50 / (Math.sqrt(3) / 2), rows: 10, cols: 12 });
const rect = { x: 0, y: 0, width: hm.width, height: hm.height };
const hexes = hm.allCells();
const center = c => hm.center(c);
const cellAt = p => hm.cellAt(p);
let n = 0;
const newId = () => `id${String(++n).padStart(14, "0")}`;
const build = (extra = {}) => buildAzgaarFeatures(fixture(), { rect, hexes, center, cellAt, newId, ...extra });
const k = ([i, j]) => `${i},${j}`;
const tr = makeTransform({ width: 60, height: 40 }, rect);
const toScene = ([x, y]) => { const [sx, sy] = tr.point([x, y]); return { x: sx, y: sy }; };

/** Клетка Azgaar под центром гекса (клетки — квадраты 10×10 карты 60×40). */
function azCell(hex) {
  const t = makeTransform({ width: 60, height: 40 }, rect);
  const [x, y] = t.back(center(hex));
  return { x: Math.min(5, Math.max(0, Math.floor(x / 10))), y: Math.min(3, Math.max(0, Math.floor(y / 10))) };
}

test("проверка файла различает полный экспорт", () => {
  assert.equal(validateAzgaar(null), "notJson");
  assert.equal(validateAzgaar({ pack: {} }), "noInfo");
  assert.equal(validateAzgaar({ info: { width: 1, height: 1 }, pack: { burgs: [] } }), "notFull");
  assert.equal(validateAzgaar(fixture()), null);
});

test("координаты карты растягиваются на прямоугольник сцены и обратно", () => {
  const r = { x: 100, y: 200, width: 600, height: 400 };
  const t = makeTransform({ width: 60, height: 40 }, r);
  assert.deepEqual(t.point([0, 0]), [100, 200]);
  assert.deepEqual(t.point([60, 40]), [700, 600]);
  assert.deepEqual(t.back({ x: 400, y: 400 }), [30, 20]);
});

test("местность: вода по высоте и биому, горы и холмы по высоте, остальное по биому", () => {
  assert.equal(terrainOf({ h: 10, biome: 6 }), "water");
  assert.equal(terrainOf({ h: 40, biome: 0 }), "water");
  assert.equal(terrainOf({ h: 80, biome: 6 }), "mountains");
  assert.equal(terrainOf({ h: 55, biome: 6 }), "hills");
  assert.equal(terrainOf({ h: 30, biome: 9 }), "forest");
  assert.equal(terrainOf({ h: 30, biome: 1 }), "desert");
  assert.equal(terrainOf({ h: 30, biome: 12 }), "swamp");
});

test("каждый гекс сцены попадает ровно в одну зону местности", () => {
  const { features, stats } = build();
  const terrain = features.filter(f => f.system.ext.azgaar.kind === "terrain");
  assert.equal(stats.terrain, 2);
  assert.deepEqual(terrain.map(f => f.system.typeId).sort(), ["forest", "water"]);
  for ( const f of terrain ) assert.equal(f.system.layerId, "terrain");
  const seen = terrain.flatMap(f => f.system.geometry.cells.map(k));
  assert.equal(seen.length, hexes.length);
  assert.equal(new Set(seen).size, hexes.length);
  const water = terrain.find(f => f.system.typeId === "water");
  for ( const c of water.system.geometry.cells ) assert.equal(azCell(c).x, 0, "вода только в первом столбце карты");
});

test("страны становятся зонами владений из своих гексов", () => {
  const { features, stats, mapId } = build();
  assert.equal(mapId, "777");
  assert.deepEqual(stats, { terrain: 2, states: 2, provinces: 0, burgs: 2, rivers: 1, routes: 2 });
  const realm = features.find(f => f.name === "Царство Кумачей");
  assert.equal(realm.system.kind, "area");
  assert.equal(realm.system.typeId, "realm");
  assert.equal(realm.system.layerId, "politics");
  assert.equal(realm.system.style.color, "#aa3322");
  assert.match(realm.text, /Царство/);
  assert.deepEqual(realm.system.ext.azgaar, { mapId: "777", kind: "state", i: 1 });
  assert.ok(realm.system.geometry.cells.length > 0);
  for ( const c of realm.system.geometry.cells ) assert.ok(azCell(c).x < 3, `гекс ${c} лежит в клетках страны`);
  const winter = features.find(f => f.name === "Винтер");
  for ( const c of winter.system.geometry.cells ) {
    const a = azCell(c);
    assert.ok(a.x >= 3 && !(a.x === 4 && a.y === 1), "нейтральная клетка не входит в страну");
  }
});

test("столица стоит меткой на своём гексе и связана со страной", () => {
  const { features } = build();
  const winter = features.find(f => f.name === "Винтер");
  const capital = features.find(f => f.name === "Винтерфол");
  assert.equal(capital.system.kind, "object");
  assert.equal(capital.system.typeId, "capital");
  const hex = cellAt(toScene([45, 25]));
  assert.deepEqual(capital.system.geometry.cell, hex);
  const c = center(hex);
  assert.deepEqual([capital.system.geometry.x, capital.system.geometry.y], [Math.round(c.x), Math.round(c.y)]);
  assert.deepEqual(capital.system.links, [{ target: winter.id, role: "столица" }]);
  assert.match(capital.text, /12\s?500/);
  assert.equal(features.find(f => f.name === "Деревня").system.typeId, "city");
  assert.equal(features.some(f => f.name === "Снесён"), false);
});

test("реки и дороги остаются свободными линиями", () => {
  const { features } = build();
  const river = features.find(f => f.system.typeId === "river");
  assert.equal(river.name, "Быстрая (River)");
  const pts = river.system.geometry.points;
  assert.deepEqual(pts[0], tr.point([5, 5]));
  assert.deepEqual(pts.at(-1), tr.point([5, 35]));
  assert.equal(features.filter(f => f.system.typeId === "river").length, 1, "река из одной клетки не нужна");
  assert.equal(features.find(f => f.name === "Тракт").system.typeId, "road");
  assert.ok(features.some(f => f.system.typeId === "searoute"));
});

test("можно взять только часть: провинции без остального", () => {
  const { stats, features } = build({ parts: { terrain: false, states: false, provinces: true, burgs: false, rivers: false, routes: false } });
  assert.deepEqual(stats, { terrain: 0, states: 0, provinces: 1, burgs: 0, rivers: 0, routes: 0 });
  assert.equal(features[0].system.layerId, "regions");
  assert.equal(features[0].system.typeId, "region");
});

test("недостающие типы и слои добавляются, свои не трогаются", () => {
  const mine = [{ id: "city", kind: "object", name: "Мой город", style: {} }];
  const { types, layers } = mergeTypesAndLayers(mine, [{ id: "politics", name: "П", sort: 0 }]);
  assert.equal(types.find(t => t.id === "city").name, "Мой город");
  assert.equal(types.length, AZGAAR_TYPES.length);
  assert.deepEqual(layers.map(l => l.id).sort(), [...new Set(["politics", ...AZGAAR_LAYERS.map(l => l.id)])].sort());
  assert.equal(layers.find(l => l.id === "politics").name, "П");
});
