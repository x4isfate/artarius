// 0.9.1: quick mark delete by right click, Ctrl+Z restore.
import { test } from "node:test";
import assert from "node:assert/strict";
import Studio from "../scripts/studio.mjs";
import MemoryBackend from "./harness/memory-backend.mjs";
import { markAt } from "../scripts/data/mark-layout.mjs";

const setup = () => {
  const backend = new MemoryBackend();
  const studio = new Studio(backend);
  return { backend, studio, grid: backend.grid };
};
const marks = studio => [...studio.states.values()].filter(s => s.system.kind === "object");

test("right click on a mark deletes it, restore brings it back with the same id", async () => {
  const { studio, grid } = setup();
  const cell = [6, 6];
  studio.mark.typeId = studio.typesOf("object")[0].id;
  studio.mark.name = "Мельница";
  await studio.placeMarks([cell]);
  studio.setTool("select", { toggle: false });
  const [m] = marks(studio);
  const slot = studio.markSlots().slots.find(s => s.id === m.id);
  assert.ok(markAt(studio.markSlots().slots, slot), "метка находится по своей точке");

  await studio.rightClick({ x: slot.x, y: slot.y });
  assert.equal(marks(studio).length, 0, "метка удалена без вопроса");
  assert.equal(studio.lastDeleted?.id, m.id);

  assert.equal(await studio.restoreDeleted(), true);
  const back = marks(studio);
  assert.equal(back.length, 1);
  assert.equal(back[0].id, m.id);
  assert.equal(back[0].name, "Мельница");
  assert.equal(await studio.restoreDeleted(), false, "второй раз возвращать нечего");
});

test("right click on empty map still clears selection, in line tool still removes a point", async () => {
  const { studio, grid } = setup();
  studio.setTool("select", { toggle: false });
  studio.pointerDown(grid.center([3, 3]));
  studio.pointerDown(grid.center([4, 3]), { shift: true });
  assert.ok(studio.selection.size > 0);
  await studio.rightClick(grid.center([9, 9]));
  assert.equal(studio.selection.size, 0);

  studio.setTool("line", { toggle: false });
  studio.line.mode = "click";
  studio.pointerDown(grid.center([2, 2]));
  studio.pointerDown(grid.center([3, 2]));
  const n = studio.line.points.length;
  await studio.rightClick(grid.center([3, 2]));
  assert.equal(studio.line.points.length, n - 1);
});
