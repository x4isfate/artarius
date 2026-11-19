// 0.8.0: inspecting several hexes, mark order on a hex, mark shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import Studio from "../scripts/studio.mjs";
import MemoryBackend from "./harness/memory-backend.mjs";
import { zoneCells, cellKey } from "../scripts/data/world.mjs";
import { layoutMarks } from "../scripts/data/mark-layout.mjs";
import { shapePoints, shapeOf, MARK_SHAPES } from "../scripts/data/mark-shape.mjs";

const setup = () => {
  const backend = new MemoryBackend();
  const studio = new Studio(backend);
  return { backend, studio, grid: backend.grid };
};
const paint = async (studio, typeId, cells) => {
  studio.setTool("zone", { toggle: false });
  studio.zone.target = "new";
  studio.zone.typeId = typeId;
  await studio.attach(cells);
};
const marksAt = (studio, cell) => [...studio.states.values()]
  .filter(s => s.system.kind === "object" && cellKey(s.system.geometry.cell ?? studio.grid.cellAt(s.system.geometry)) === cellKey(cell));

test("shift-click inspects several hexes and the card lists everything once with counts", async () => {
  const { studio, grid } = setup();
  await paint(studio, "forest", [[2, 2], [3, 2]]);
  await paint(studio, "hills", [[4, 2]]);
  studio.clearSelection();
  studio.setTool("select", { toggle: false });
  studio.pointerDown(grid.center([2, 2]));
  studio.pointerDown(grid.center([3, 2]), { shift: true });
  studio.pointerDown(grid.center([4, 2]), { shift: true });
  assert.equal(studio.multi, true);
  assert.equal(studio.inspectCells().length, 3, "первый гекс тоже в наборе");
  const c = studio.contents();
  const forest = c.zones.find(z => z.system.typeId === "forest");
  assert.equal(c.zones.filter(z => z.id === forest.id).length, 1, "зона без повторов");
  assert.equal(c.counts.get(forest.id), 2);
  assert.equal(studio.summary().cells, 3);

  studio.pointerDown(grid.center([3, 2]), { shift: true });
  assert.equal(studio.inspectCells().length, 2, "повторный Shift-щелчок убирает гекс");
  studio.pointerDown(grid.center([5, 5]));
  assert.equal(studio.multi, false, "простой щелчок начинает осмотр заново");
  assert.equal(cellKey(studio.inspected), "5,5");
});

test("shift-drag adds hexes; actions apply to all inspected hexes", async () => {
  const { studio, grid } = setup();
  await paint(studio, "desert", [[2, 3], [3, 3], [4, 3], [5, 3]]);
  studio.clearSelection();
  studio.setTool("select", { toggle: false });
  studio.pointerDown(grid.center([2, 3]), { shift: true });
  studio.pointerMove(grid.center([3, 3]));
  studio.pointerMove(grid.center([4, 3]));
  await studio.pointerUp();
  assert.deepEqual(studio.inspectCells().map(cellKey).sort(), ["2,3", "3,3", "4,3"]);

  // Тип зоны меняется только у выбранных гексов.
  const desert = [...studio.states.values()].find(z => z.system.typeId === "desert");
  await studio.setField(desert.id, "typeId", "forest");
  assert.deepEqual(zoneCells(studio.stateOf(desert.id)).map(cellKey), ["5,3"]);
  const forest = [...studio.states.values()].filter(z => z.system.typeId === "forest");
  assert.equal(forest.length, 1, "три гекса ушли в одну новую зону");
  assert.equal(zoneCells(forest[0]).length, 3);

  studio.mark.typeId = studio.typesOf("object")[0].id;
  await studio.markHere();
  const marks = [...studio.states.values()].filter(s => s.system.kind === "object");
  assert.equal(marks.length, 3, "метка встала на каждый выбранный гекс");
});

test("marks on a hex can be reordered and the layout follows", async () => {
  const { studio, grid } = setup();
  const cell = [6, 6];
  const types = studio.typesOf("object");
  for ( const t of types.slice(0, 3) ) {
    studio.mark.typeId = t.id;
    studio.mark.name = t.name;
    await studio.placeMarks([cell]);
  }
  const order = () => studio.markSlots().cells.get(cellKey(cell)).ids;
  const [a, b, c] = order();
  await studio.reorderMark(c, a);
  assert.deepEqual(order(), [c, a, b], "третья метка встала первой");
  await studio.shiftMark(c, 1);
  assert.deepEqual(order(), [a, c, b]);
  await studio.shiftMark(b, 1);
  assert.deepEqual(order(), [a, c, b], "последнюю дальше не сдвинуть");
  await studio.reorderMark(a, null);
  assert.deepEqual(order(), [c, b, a], "без соседа — в конец");
  studio.setTool("select", { toggle: false });
  studio.pointerDown(grid.center(cell));
  assert.deepEqual(studio.contents().marks.map(m => m.id), [c, b, a], "панель гекса в том же порядке");
  assert.equal(marksAt(studio, cell).length, 3);
});

test("mark shapes: type default, own override, polygons", async () => {
  const { studio } = setup();
  for ( const sh of MARK_SHAPES ) {
    const pts = shapePoints(sh, 10);
    if ( sh === "circle" || sh === "none" ) assert.equal(pts, null);
    else assert.ok(pts.length >= 4 && pts.every(([x, y]) => Math.hypot(x, y) <= 13), sh);
  }
  assert.equal(shapeOf({ shape: "weird" }), "circle");

  studio.editTypeInSettings("object", "new");
  Object.assign(studio.typeForm, { name: "Застава", shape: "shield" });
  await studio.saveTypeForm();
  const type = studio.typesOf("object").find(t => t.name === "Застава");
  assert.equal(type.style.shape, "shield");
  studio.mark.typeId = type.id;
  await studio.placeMarks([[3, 3]]);
  const m = [...studio.states.values()].find(s => s.system.typeId === type.id);
  await studio.setField(m.id, "shape", "diamond");
  assert.equal(studio.stateOf(m.id).system.style.shape, "diamond");
});
