// Hex-world rules: zones in exclusive layers, marks, lines, tile contents, turns.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachOps, detachOps, cellsInShapes, markOps, lineOp, tileContents, boundaryEdges, mergeTypes, personalTypesUsed,
  blankState
} from "../scripts/data/world.mjs";
import { STARTER_TYPES, STARTER_LAYERS } from "../scripts/constants.mjs";
import HexMath from "../scripts/hex/hexmath.mjs";

const hm = new HexMath({ size: 100, rows: 6, cols: 8 });
const types = STARTER_TYPES;
const layers = STARTER_LAYERS;
const zone = (id, typeId, cells) => blankState({ id, kind: "area", typeId, layerId: types.find(t => t.id === typeId).layerId, geometry: { cells } });
const world = (...list) => new Map(list.map(s => [s.id, s]));

test("новая зона забирает гексы у соседей в исключающем слое", () => {
  const states = world(zone("f", "forest", [[0, 0], [0, 1]]), zone("r", "realm", [[0, 0]]));
  const ops = attachOps({ states, types, layers, cells: [[0, 0]], newZone: { id: "m", typeId: "mountains" } });
  assert.deepEqual(ops.map(o => [o.action, o.id]), [["create", "m"], ["update", "f"]]);
  assert.deepEqual(ops[1].state.system.geometry.cells, [[0, 1]]);
  assert.equal(ops.some(o => o.id === "r"), false, "держава в другом слое не тронута");
});

test("зона без гексов не удаляется, а уходит в архив с 0 гексов", () => {
  const states = world(zone("f", "forest", [[1, 1]]), zone("p", "plains", [[2, 2]]));
  const ops = attachOps({ states, types, layers, cells: [[1, 1]], target: "p" });
  assert.deepEqual(ops.map(o => [o.action, o.id]), [["update", "p"], ["update", "f"]]);
  assert.deepEqual(ops[1].state.system.geometry.cells, []);
  assert.deepEqual(ops[0].state.system.geometry.cells, [[2, 2], [1, 1]]);
});

test("в слое «Прочее» зоны перекрываются", () => {
  const overlay = [...types, { id: "fog", kind: "area", name: "Туман", layerId: "overlay", style: {} }];
  const states = world(blankState({ id: "a", kind: "area", typeId: "fog", layerId: "overlay", geometry: { cells: [[0, 0]] } }));
  const ops = attachOps({ states, types: overlay, layers, cells: [[0, 0]], newZone: { id: "b", typeId: "fog" } });
  assert.deepEqual(ops.map(o => o.id), ["b"]);
});

test("снять гексы можно с одной зоны или со всего слоя", () => {
  const states = world(zone("f", "forest", [[0, 0], [0, 1]]), zone("r", "realm", [[0, 0], [0, 1]]));
  assert.deepEqual(detachOps({ states, types, cells: [[0, 0]], zoneId: "r" }).map(o => o.id), ["r"]);
  const all = detachOps({ states, types, cells: [[0, 0], [0, 1]], layerId: "terrain" });
  assert.deepEqual(all.map(o => [o.action, o.id]), [["update", "f"]]);
  assert.deepEqual(all[0].state.system.geometry.cells, []);
});

test("метки встают по одной на гекс в его центр", () => {
  let n = 0;
  const ops = markOps({ cells: [[1, 2], [3, 4]], typeId: "city", types, center: c => hm.center(c), newId: () => `m${++n}` });
  assert.equal(ops.length, 2);
  const c = hm.center([3, 4]);
  assert.deepEqual(ops[1].state.system.geometry, { x: Math.round(c.x), y: Math.round(c.y), cell: [3, 4] });
  assert.equal(ops[0].state.name, types.find(t => t.id === "city").name);
});

test("линия из одной точки не создаётся", () => {
  assert.equal(lineOp({ points: [[0, 0]], typeId: "river", types, newId: () => "l" }), null);
  assert.equal(lineOp({ points: [[0, 0], [10.4, 20.6]], typeId: "river", types, newId: () => "l" }).state.system.geometry.points[1][1], 21);
});

test("карточка гекса показывает зоны, метки и линии на нём", () => {
  const a = hm.center([2, 2]), b = hm.center([2, 5]);
  const states = world(
    zone("f", "forest", [[2, 2]]),
    zone("r", "realm", [[2, 2], [2, 3]]),
    blankState({ id: "c", kind: "object", typeId: "city", geometry: { x: a.x, y: a.y, cell: [2, 2] } }),
    blankState({ id: "l", kind: "line", typeId: "river", geometry: { points: [[a.x, a.y], [b.x, b.y]] } }),
    blankState({ id: "far", kind: "line", typeId: "road", geometry: { points: [[0, 0], [10, 0]] } })
  );
  const t = tileContents({ states, types, layers, cell: [2, 2], center: a, radius: hm.radius, cellAt: p => hm.cellAt(p) });
  assert.deepEqual(t.zones.map(z => z.id).sort(), ["f", "r"]);
  assert.deepEqual(t.marks.map(m => m.id), ["c"]);
  assert.deepEqual(t.lines.map(l => l.id), ["l"]);
});

test("граница зоны: только внешние рёбра", () => {
  const edges = boundaryEdges([[2, 2], [2, 3]], c => hm.vertices(c));
  assert.equal(edges.length, 10, "у двух соседних гексов 12 рёбер, одно общее");
});

test("личные типы игроков видны со своим владельцем и попадают в заявку", () => {
  const mine = { id: "u1-shrine", kind: "object", name: "Святилище", style: {} };
  const merged = mergeTypes(types, [{ userId: "u1", types: [mine] }]);
  assert.equal(merged.find(t => t.id === "u1-shrine").personal, "u1");
  const ops = [{ action: "create", id: "x", state: blankState({ id: "x", kind: "object", typeId: "u1-shrine" }) }];
  assert.deepEqual(personalTypesUsed(ops, merged).map(t => t.id), ["u1-shrine"]);
});

test("свободный контур из 0.2 превращается в гексы под ним", () => {
  const a = hm.center([1, 1]), b = hm.center([1, 3]);
  const ring = [[a.x - 10, a.y - 10], [b.x + 10, a.y - 10], [b.x + 10, b.y + 10], [a.x - 10, b.y + 10]];
  const got = cellsInShapes([ring], hm.allCells(), c => hm.center(c)).map(c => c.join(","));
  assert.deepEqual(got.sort(), ["1,1", "1,2", "1,3"]);
  assert.deepEqual(cellsInShapes([], hm.allCells(), c => hm.center(c)), []);
});
