// 0.5.0: delete via trash/Delete, undo/redo, mark multi-select, Alt free move, mark size, zone archive, goto.
import { test } from "node:test";
import assert from "node:assert/strict";
import Studio from "../scripts/studio.mjs";
import MemoryBackend from "./harness/memory-backend.mjs";
import { layoutMarks, markDiameter, markFootprint } from "../scripts/data/mark-layout.mjs";

const setup = () => {
  const backend = new MemoryBackend();
  const studio = new Studio(backend);
  return { backend, studio, grid: backend.grid };
};
const marks = studio => [...studio.states.values()].filter(s => s.system.kind === "object");
const place = async (studio, cells, typeId = null) => {
  studio.setTool("mark", { toggle: false });
  if ( typeId ) studio.mark.typeId = typeId;
  await studio.placeMarks(cells);
  studio.setTool("select", { toggle: false });
};
const slotOf = (studio, id) => studio.markSlots().slots.find(s => s.id === id);

test("click on a mark selects it, Delete-style removal needs no confirm, Ctrl+Z restores, redo deletes again", async () => {
  const { studio, backend } = setup();
  let asked = 0;
  backend.confirm = async () => { asked++; return true; };
  await place(studio, [[4, 4]]);
  const [m] = marks(studio);
  const sl = slotOf(studio, m.id);
  studio.pointerDown({ x: sl.x, y: sl.y });
  await studio.pointerUp();
  assert.deepEqual([...studio.markSel], [m.id]);
  assert.equal(studio.inspected.join(), "4,4");
  await studio.deleteMarks();
  assert.equal(marks(studio).length, 0);
  assert.equal(asked, 0, "no confirm dialog");
  assert.equal(studio.markSel.size, 0);
  await studio.undo();
  assert.equal(marks(studio).length, 1);
  assert.equal(marks(studio)[0].id, m.id, "same id comes back");
  await studio.redo();
  assert.equal(marks(studio).length, 0);
});

test("undo covers placing, moving and retyping; a new edit clears redo", async () => {
  const { studio } = setup();
  await place(studio, [[3, 3], [5, 5]]);
  assert.equal(marks(studio).length, 2);
  const [a, b] = marks(studio);
  await studio.moveMark(a.id, [7, 7]);
  assert.equal(studio.stateOf(a.id).system.geometry.cell.join(), "7,7");
  await studio.undo();
  assert.equal(studio.stateOf(a.id).system.geometry.cell.join(), "3,3");
  const other = studio.typesOf("object").find(t => t.id !== a.system.typeId).id;
  studio.markSel = new Set([a.id, b.id]);
  await studio.retypeMarks(other);
  assert.ok(marks(studio).every(m => m.system.typeId === other));
  await studio.undo();
  assert.ok(marks(studio).every(m => m.system.typeId !== other));
  assert.ok(studio.canRedo);
  await studio.moveMark(b.id, [8, 8]);
  assert.ok(!studio.canRedo, "new step drops redo");
  await studio.undo();
  await studio.undo();
  assert.equal(marks(studio).length, 0, "placing undone too");
  assert.equal(await studio.undo(), false, "nothing left");
});

test("shift-click adds marks to the selection, ctrl-box selects all marks inside", async () => {
  const { studio, grid } = setup();
  await place(studio, [[2, 2], [3, 2], [9, 9]]);
  const [a, b, c] = marks(studio).sort((x, y) => x.system.geometry.cell[0] - y.system.geometry.cell[0] || x.system.geometry.cell[1] - y.system.geometry.cell[1]);
  const pa = slotOf(studio, a.id), pb = slotOf(studio, b.id);
  studio.pointerDown({ x: pa.x, y: pa.y }, { shift: true });
  studio.pointerDown({ x: pb.x, y: pb.y }, { shift: true });
  assert.equal(studio.markSel.size, 2);
  studio.pointerDown({ x: pb.x, y: pb.y }, { shift: true });
  assert.deepEqual([...studio.markSel], [a.id]);
  const p1 = grid.center([1, 1]), p2 = grid.center([4, 3]);
  assert.equal(studio.pointerDown(p1, { ctrl: true }), "grab");
  studio.pointerMove(p2);
  await studio.pointerUp();
  assert.deepEqual(new Set(studio.markSel), new Set([a.id, b.id]));
  assert.ok(!studio.markSel.has(c.id));
  studio.dismiss();
  assert.equal(studio.markSel.size, 0, "Esc clears mark selection");
});

test("right click never deletes a mark", async () => {
  const { studio } = setup();
  await place(studio, [[4, 4]]);
  const [m] = marks(studio);
  studio.markSel = new Set([m.id]);
  await studio.rightClick();
  assert.equal(marks(studio).length, 1);
});

test("hud trash: one mark goes at once, several marks open a list, selected ones go first", async () => {
  const { studio } = setup();
  await place(studio, [[4, 4]]);
  studio.inspect([4, 4]);
  await studio.hudDelete();
  assert.equal(marks(studio).length, 0);
  await place(studio, [[4, 4]]);
  await place(studio, [[4, 4]]);
  studio.inspect([4, 4], { toggle: false });
  await studio.hudDelete();
  assert.equal(studio.hudMenu?.kind, "delete");
  assert.equal(marks(studio).length, 2);
  const [first] = marks(studio);
  studio.markSel = new Set([first.id]);
  await studio.hudDelete();
  assert.equal(marks(studio).length, 1);
  assert.ok(!studio.stateOf(first.id));
});

test("quick type picker: chosen type places a mark and moves to the top of the menu", async () => {
  const { studio } = setup();
  studio.setTool("select", { toggle: false });
  studio.inspect([6, 6]);
  const types = studio.typesOf("object");
  const pick = types[2];
  studio.toggleTypeMenu();
  assert.equal(studio.hudMenu?.kind, "type");
  await studio.quickMark(pick.id);
  assert.equal(studio.hudMenu, null);
  assert.equal(marks(studio).length, 1);
  assert.equal(marks(studio)[0].system.typeId, pick.id);
  assert.equal(studio.markTypesForMenu()[0].id, pick.id);
});

test("Alt drag puts a mark at a free point, out of the hex group", async () => {
  const { studio, grid } = setup();
  await place(studio, [[5, 5]]);
  await place(studio, [[5, 5]]);
  const [a] = marks(studio);
  const sl = slotOf(studio, a.id);
  const c = grid.center([5, 5]);
  const to = { x: c.x + grid.radius * 0.5, y: c.y + grid.radius * 0.3 };
  studio.pointerDown({ x: sl.x, y: sl.y }, { alt: true });
  studio.pointerMove(to);
  await studio.pointerUp();
  const g = studio.stateOf(a.id).system.geometry;
  assert.equal(g.free, true);
  assert.equal(g.x, Math.round(to.x));
  const moved = slotOf(studio, a.id);
  assert.ok(moved.solo);
  assert.equal(Math.round(moved.x), Math.round(to.x));
  // A normal drag snaps back to a hex and to the group.
  studio.pointerDown({ x: moved.x, y: moved.y });
  studio.pointerMove(grid.center([7, 7]));
  await studio.pointerUp();
  assert.equal(studio.stateOf(a.id).system.geometry.free, false);
  assert.equal(studio.stateOf(a.id).system.geometry.cell.join(), "7,7");
});

test("mark size: cells N×N and visual scale are separate", async () => {
  const { studio, grid } = setup();
  await place(studio, [[6, 6]]);
  const [m] = marks(studio);
  const d1 = slotOf(studio, m.id).d;
  await studio.setField(m.id, "cells", 2);
  const d2 = slotOf(studio, m.id).d;
  assert.ok(d2 > d1 * 2, `2×2 is about two hexes wide (${d1} → ${d2})`);
  await studio.setField(m.id, "size", 0.3);
  assert.ok(slotOf(studio, m.id).d < d2, "scale shrinks the icon inside its cells");
  await studio.setField(m.id, "cells", 9);
  assert.equal(studio.stateOf(m.id).system.style.cells, 4, "cells clamped to 4");
  assert.ok(markFootprint(studio.stateOf(m.id), grid, 2).length >= 7, "2×2 mark covers the hex and its ring");
  assert.equal(markFootprint(studio.stateOf(m.id), grid, 1).length, 1);
  assert.equal(markDiameter(10, 0.5, 1), 10);
  studio.inspect([6, 7], { toggle: false });
  assert.ok(studio.contents().marks.some(s => s.id === m.id), "big mark shows in neighbour hex contents");
});

test("layoutMarks keeps free and big marks out of hex groups", () => {
  const grid = { radius: 10, center: c => ({ x: c[0] * 20, y: c[1] * 20 }), cellAt: p => [Math.round(p.x / 20), Math.round(p.y / 20)] };
  const mk = (id, extra = {}) => ({ id, system: { typeId: "x", geometry: { cell: [1, 1], x: 20, y: 20, ...extra } } });
  const { slots, cells } = layoutMarks([mk("a"), mk("b"), mk("c", { free: true, x: 25, y: 27 })], grid);
  assert.equal(cells.get("1,1").count, 2);
  const c = slots.find(s => s.id === "c");
  assert.deepEqual([c.x, c.y, c.solo], [25, 27, true]);
});

test("goto parses 27:22, 27 22 and 2722; bad input warns", () => {
  const { studio, backend } = setup();
  assert.deepEqual(studio.parseCoords("12:9"), [12, 9]);
  assert.deepEqual(studio.parseCoords("12 9"), [12, 9]);
  assert.deepEqual(studio.parseCoords("1209"), [12, 9]);
  assert.deepEqual(studio.parseCoords("129"), [12, 9]);
  assert.deepEqual(studio.parseCoords("57"), [5, 7]);
  assert.equal(studio.parseCoords("99:99"), null);
  assert.equal(studio.parseCoords("abc"), null);
  let panned = null;
  backend.panTo = p => { panned = p; };
  assert.equal(studio.goTo("5:7"), true);
  assert.equal(studio.inspected.join(), "5,7");
  assert.ok(panned);
  const before = backend.notes?.length ?? 0;
  assert.equal(studio.goTo("x"), false);
  if ( backend.notes ) assert.ok(backend.notes.length > before);
});

test("empty zone stays as an archived zone with 0 hexes and can be painted again", async () => {
  const { studio } = setup();
  studio.setTool("zone", { toggle: false });
  const typeId = studio.typesOf("area")[0].id;
  studio.zone.typeId = typeId;
  studio.zone.target = "new";
  await studio.attach([[3, 3]]);
  const z = [...studio.states.values()].find(s => s.system.kind === "area");
  assert.ok(z);
  await studio.detach([[3, 3]]);
  const after = studio.stateOf(z.id);
  assert.ok(after, "zone kept");
  assert.equal(after.system.geometry.cells.length, 0);
  studio.zone.target = z.id;
  await studio.attach([[4, 4]]);
  assert.equal(studio.stateOf(z.id).system.geometry.cells.length, 1);
});
