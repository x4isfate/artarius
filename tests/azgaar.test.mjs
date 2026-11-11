// Azgaar import: region outlines, transform, what gets built from an export.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateAzgaar, makeTransform, regionRings, buildAzgaarFeatures, mergeTypesAndLayers, AZGAAR_TYPES
} from "../scripts/import/azgaar.mjs";
import { signedArea } from "../scripts/geometry/geometry.mjs";

/**
 * A tiny "Full" export: 6×4 square cells of 10 px on a 60×40 map.
 * Vertices are shared like in Azgaar's Voronoi graph. Every other cell lists its
 * vertices in the opposite order to check that orientation is normalized.
 * States: 1 on columns 0–2, 2 on columns 3–5 except cell (4,1) which is neutral (a hole).
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
      cells.push({ i, v, p: [(x * S) + 5, (y * S) + 5], state, province: x < 3 ? 1 : 0, burg: 0 });
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

const rect = { x: 100, y: 200, width: 600, height: 400 };
let n = 0;
const newId = () => `id${String(++n).padStart(14, "0")}`;

test("проверка файла различает полный экспорт", () => {
  assert.equal(validateAzgaar(null), "notJson");
  assert.equal(validateAzgaar({ pack: {} }), "noInfo");
  assert.equal(validateAzgaar({ info: { width: 1, height: 1 }, pack: { burgs: [] } }), "notFull");
  assert.equal(validateAzgaar(fixture()), null);
});

test("координаты карты растягиваются на прямоугольник сцены", () => {
  const t = makeTransform({ width: 60, height: 40 }, rect);
  assert.deepEqual(t.point([0, 0]), [100, 200]);
  assert.deepEqual(t.point([60, 40]), [700, 600]);
  assert.deepEqual(t.point([30, 20]), [400, 400]);
});

test("контур страны собирается из клеток с разным обходом", () => {
  const d = fixture();
  const rings = regionRings(d.pack.cells, d.pack.vertices, c => c.state === 1);
  assert.equal(rings.length, 1);
  assert.equal(Math.abs(signedArea(rings[0])), 30 * 40);
});

test("нейтральная клетка внутри страны остаётся дырой", () => {
  const d = fixture();
  const rings = regionRings(d.pack.cells, d.pack.vertices, c => c.state === 2);
  assert.equal(rings.length, 2);
  const areas = rings.map(signedArea);
  assert.equal(Math.abs(areas[0]) + Math.abs(areas[1]), (30 * 40) + 100);
  assert.ok(Math.sign(areas[0]) !== Math.sign(areas[1]), "дыра идёт обратным обходом");
});

test("из экспорта получаются страны, города, реки и дороги", () => {
  const { features, stats, mapId } = buildAzgaarFeatures(fixture(), { rect, newId });
  assert.equal(mapId, "777");
  assert.deepEqual(stats, { states: 2, provinces: 0, burgs: 2, rivers: 1, routes: 2 });
  const realm = features.find(f => f.name === "Царство Кумачей");
  assert.equal(realm.system.kind, "area");
  assert.equal(realm.system.typeId, "realm");
  assert.equal(realm.system.layerId, "politics");
  assert.equal(realm.system.style.color, "#aa3322");
  assert.match(realm.text, /Царство/);
  assert.deepEqual(realm.system.ext.azgaar, { mapId: "777", kind: "state", i: 1 });
  for ( const p of realm.system.geometry.shapes.flat() ) {
    assert.ok(p[0] >= 100 && p[0] <= 700 && p[1] >= 200 && p[1] <= 600, "точки внутри сцены");
  }
});

test("столица связана со своей страной и стоит на месте", () => {
  const { features } = buildAzgaarFeatures(fixture(), { rect, newId });
  const winter = features.find(f => f.name === "Винтер");
  const capital = features.find(f => f.name === "Винтерфол");
  assert.equal(capital.system.typeId, "capital");
  assert.deepEqual(capital.system.geometry, { x: 550, y: 450 });
  assert.deepEqual(capital.system.links, [{ target: winter.id, role: "столица" }]);
  assert.match(capital.text, /12\s?500/);
  assert.equal(features.find(f => f.name === "Деревня").system.typeId, "city");
  assert.equal(features.some(f => f.name === "Снесён"), false);
});

test("река идёт по центрам клеток, клетки за краем карты пропускаются", () => {
  const { features } = buildAzgaarFeatures(fixture(), { rect, newId });
  const river = features.find(f => f.system.typeId === "river");
  assert.equal(river.name, "Быстрая (River)");
  const pts = river.system.geometry.points;
  assert.deepEqual(pts[0], [150, 250]);
  assert.deepEqual(pts.at(-1), [150, 550]);
  assert.equal(features.filter(f => f.system.typeId === "river").length, 1, "река из одной клетки не нужна");
});

test("группы дорог Azgaar переходят в свои типы", () => {
  const { features } = buildAzgaarFeatures(fixture(), { rect, newId });
  assert.equal(features.find(f => f.name === "Тракт").system.typeId, "road");
  assert.ok(features.some(f => f.system.typeId === "searoute"));
});

test("можно взять только часть: провинции без стран", () => {
  const { stats, features } = buildAzgaarFeatures(fixture(), {
    rect, newId, parts: { states: false, provinces: true, burgs: false, rivers: false, routes: false }
  });
  assert.deepEqual(stats, { states: 0, provinces: 1, burgs: 0, rivers: 0, routes: 0 });
  assert.equal(features[0].system.layerId, "provinces");
});

test("недостающие типы и слои добавляются, свои не трогаются", () => {
  const mine = [{ id: "city", kind: "object", name: "Мой город", style: {} }];
  const { types, layers } = mergeTypesAndLayers(mine, [{ id: "politics", name: "П", sort: 0 }]);
  assert.equal(types.find(t => t.id === "city").name, "Мой город");
  assert.equal(types.length, AZGAAR_TYPES.length);
  assert.deepEqual(layers.map(l => l.id), ["politics", "provinces"]);
});
