// 0.6.0: hex HUD state, Civ 5 style mark groups, dragging marks between hexes, more icons.
import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutMarks, markAt, counterAt, MAX_SHOWN } from "../scripts/data/mark-layout.mjs";
import { allIcons, ICON_LIBRARY } from "../scripts/data/icons.mjs";
import Studio from "../scripts/studio.mjs";
import MemoryBackend from "./harness/memory-backend.mjs";

const setup = () => {
  const backend = new MemoryBackend();
  const studio = new Studio(backend);
  studio.setTool("select", { toggle: false });
  return { backend, studio, grid: backend.grid };
};
const mark = (id, cell, grid, extra = {}) => {
  const c = grid.center(cell);
  return { id, name: id, system: { kind: "object", typeId: "city", geometry: { x: c.x, y: c.y, cell }, sort: 0, ...extra } };
};

test("one mark keeps its own spot and size", () => {
  const { grid } = setup();
  const m = mark("a", [3, 3], grid);
  m.system.geometry.x += 7;
  const { slots, cells } = layoutMarks([m], grid);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].x, m.system.geometry.x);
  assert.equal(slots[0].d, grid.radius * 2 * 0.6);
  assert.equal(cells.get("3,3").count, 1);
});

test("several marks in a hex form a group that stays inside and readable", () => {
  const { grid } = setup();
  const r = grid.radius;
  for ( const n of [2, 3, 4, 5, 9] ) {
    const marks = Array.from({ length: n }, (_, k) => mark(`m${k}`, [4, 4], grid));
    const { slots, cells } = layoutMarks(marks, grid);
    const c = grid.center([4, 4]);
    assert.equal(cells.get("4,4").count, n, "счётчик");
    assert.equal(slots.length, Math.min(n, MAX_SHOWN), `мест для ${n}`);
    for ( const s of slots ) {
      assert.ok(Math.hypot(s.x - c.x, s.y - c.y) + (s.d / 2) <= r * 0.9, `${n}: значок вылез из гекса`);
      assert.ok(s.d >= r * 0.6, `${n}: значок слишком мелкий`);
    }
    for ( const a of slots ) for ( const b of slots ) {
      if ( a !== b ) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= Math.min(a.d, b.d) * 0.95, `${n}: значки налезают`);
    }
    if ( n > MAX_SHOWN ) assert.equal(slots.at(-1).more, n - (MAX_SHOWN - 1), "плашка +N");
    const cnt = counterAt(cells.get("4,4"), r);
    for ( const s of slots ) assert.ok(Math.hypot(s.x - cnt.x, s.y - cnt.y) >= (s.d / 2) + (cnt.r * 0.5), `${n}: счётчик закрывает значок`);
  }
});

test("resources go after ordinary marks in a group", () => {
  const { grid } = setup();
  const res = mark("res", [2, 2], grid, { typeId: "res-gold" });
  const city = mark("city", [2, 2], grid);
  const { slots } = layoutMarks([res, city], grid);
  assert.deepEqual(slots.map(s => s.id), ["city", "res"]);
});

test("markAt finds the top mark under the cursor and skips +N", () => {
  const { grid } = setup();
  const marks = Array.from({ length: 6 }, (_, k) => mark(`m${k}`, [5, 5], grid));
  const { slots } = layoutMarks(marks, grid);
  assert.equal(markAt(slots, { x: slots[1].x, y: slots[1].y }).id, slots[1].id);
  assert.equal(markAt(slots, { x: slots.at(-1).x, y: slots.at(-1).y }), null);
  assert.equal(markAt(slots, { x: -999, y: -999 }), null);
});

test("click on a hex opens the HUD, not the big window; second click hides it", () => {
  const { studio, grid } = setup();
  studio.pointerDown(grid.center([2, 3]));
  assert.ok(studio.hudOpen && !studio.rightOpen);
  assert.deepEqual(studio.inspected, [2, 3]);
  studio.pointerDown(grid.center([2, 3]));
  assert.ok(!studio.hudOpen && !studio.inspected);
  studio.pointerDown(grid.center([2, 3]));
  studio.openDetails();
  assert.ok(studio.rightOpen && studio.rightTab === "tile");
  studio.setTool("zone", { toggle: false });
  assert.ok(!studio.hudOpen, "другой инструмент убирает панель");
});

test("HUD summary names terrain, realm and counts marks", async () => {
  const { studio, grid } = setup();
  studio.setTool("zone", { toggle: false });
  studio.zone.typeId = "forest";
  await studio.attach([[6, 6]]);
  studio.setTool("select", { toggle: false });
  studio.pointerDown(grid.center([6, 6]));
  await studio.markHere();
  await studio.markHere();
  const sum = studio.summary();
  assert.ok(sum.terrain, "нет местности");
  assert.equal(sum.marks.length, 2);
});

test("dragging a mark moves it to another hex; a short press inspects", async () => {
  const { studio, grid, backend } = setup();
  studio.pointerDown(grid.center([1, 1]));
  await studio.markHere();
  const id = studio.contents().marks[0].id;
  studio.closeHud();
  // Короткое нажатие на метку без протяжки — осмотр гекса.
  assert.equal(studio.pointerDown(grid.center([1, 1])), "grab");
  await studio.pointerUp();
  assert.deepEqual(studio.inspected, [1, 1]);
  // Протяжка на другой гекс.
  assert.equal(studio.pointerDown(grid.center([1, 1])), "grab");
  studio.pointerMove(grid.center([2, 1]));
  studio.pointerMove(grid.center([4, 2]));
  assert.ok(studio.markDrag.moved);
  await studio.pointerUp();
  const g = backend.atlas.get(id).system.geometry;
  assert.deepEqual(g.cell, [4, 2]);
  const c = grid.center([4, 2]);
  assert.deepEqual([g.x, g.y], [Math.round(c.x), Math.round(c.y)]);
  assert.equal(studio.markDrag, null);
  // Отпустили за картой — метка остаётся на месте.
  studio.pointerDown(grid.center([4, 2]));
  studio.pointerMove({ x: -5000, y: -5000 });
  await studio.pointerUp();
  assert.deepEqual(backend.atlas.get(id).system.geometry.cell, [4, 2]);
});

test("icon library got people, trade and creature sections", () => {
  for ( const c of ["people", "trade", "creatures"] ) assert.ok(ICON_LIBRARY[c]?.length >= 15, c);
  assert.ok(allIcons().length >= 130);
});

test("0.6.1: pressing the active tool again keeps it; turning the tool off drops the stray outline", () => {
  const { studio, grid } = setup();
  studio.pointerDown(grid.center([3, 3]));
  studio.setTool("select", { toggle: false });
  assert.equal(studio.tool, "select");
  assert.deepEqual(studio.inspected, [3, 3]);
  studio.pointerDown(grid.center([4, 3]));
  assert.deepEqual(studio.inspected, [4, 3], "соседний гекс");
  studio.setTool(null, { toggle: false });
  assert.ok(!studio.inspected && !studio.hudOpen);
  studio.setTool("select", { toggle: false });
  studio.pointerDown(grid.center([2, 2]));
  studio.layerDeactivated();
  assert.ok(!studio.inspected && !studio.hudOpen);
});
