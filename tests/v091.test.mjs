// 0.9.1 behaviour replaced in 0.5.0: right click no longer deletes marks.
import { test } from "node:test";
import assert from "node:assert/strict";
import Studio from "../scripts/studio.mjs";
import MemoryBackend from "./harness/memory-backend.mjs";

const setup = () => {
  const backend = new MemoryBackend();
  const studio = new Studio(backend);
  return { backend, studio, grid: backend.grid };
};

test("right click on empty map still clears selection, in line tool still removes a point", async () => {
  const { studio, grid } = setup();
  studio.setTool("select", { toggle: false });
  studio.pointerDown(grid.center([3, 3]));
  studio.pointerDown(grid.center([4, 3]), { shift: true });
  assert.ok(studio.selection.size > 0);
  await studio.rightClick();
  assert.equal(studio.selection.size, 0);

  studio.setTool("line", { toggle: false });
  studio.line.mode = "click";
  studio.pointerDown(grid.center([2, 2]));
  studio.pointerDown(grid.center([3, 2]));
  const n = studio.line.points.length;
  await studio.rightClick();
  assert.equal(studio.line.points.length, n - 1);
});
