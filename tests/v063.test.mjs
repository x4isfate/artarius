// 0.6.3: changing a zone's type in the hex card moves only that hex; no turn tracker.
import { test } from "node:test";
import assert from "node:assert/strict";
import Studio from "../scripts/studio.mjs";
import MemoryBackend from "./harness/memory-backend.mjs";
import { zoneCells, cellKey } from "../scripts/data/world.mjs";

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
const zoneOf = (studio, typeId) => [...studio.states.values()].filter(z => z.system.kind === "area" && z.system.typeId === typeId);

test("retyping a hex of a big zone moves only that hex into the neighbouring zone of the new type", async () => {
  const { studio, grid } = setup();
  await paint(studio, "desert", [[2, 2], [3, 2], [4, 2]]);
  await paint(studio, "forest", [[5, 2]]);
  const desert = zoneOf(studio, "desert")[0];
  studio.setTool("select", { toggle: false });
  studio.pointerDown(grid.center([4, 2]));
  await studio.setField(desert.id, "typeId", "forest");
  assert.equal(zoneOf(studio, "desert").length, 1);
  assert.deepEqual(zoneCells(studio.stateOf(desert.id)).map(cellKey).sort(), ["2,2", "3,2"], "пустыня осталась без одного гекса");
  const forest = zoneOf(studio, "forest");
  assert.equal(forest.length, 1, "новой зоны не надо, гекс ушёл в соседний лес");
  assert.ok(zoneCells(forest[0]).some(c => cellKey(c) === "4,2"));
});

test("without a forest zone a new one is created; a one-hex zone is retyped whole", async () => {
  const { studio, grid } = setup();
  await paint(studio, "desert", [[2, 2], [3, 2]]);
  const desert = zoneOf(studio, "desert")[0];
  studio.setTool("select", { toggle: false });
  studio.pointerDown(grid.center([3, 2]));
  await studio.setField(desert.id, "typeId", "forest");
  assert.deepEqual(zoneCells(studio.stateOf(desert.id)).map(cellKey), ["2,2"]);
  const forest = zoneOf(studio, "forest");
  assert.equal(forest.length, 1);
  // Одноклеточная зона меняет тип целиком.
  studio.pointerDown(grid.center([3, 2]));
  studio.pointerDown(grid.center([2, 2]));
  await studio.setField(desert.id, "typeId", "swamp");
  await studio.flush?.();
  assert.equal(studio.stateOf(desert.id).system.typeId, "swamp");
});

test("turn tracker is gone from studio and backend", () => {
  const { studio, backend } = setup();
  for ( const k of ["turn", "passTurn", "toggleTurns", "moveInOrder", "setTurnTo", "currentPlayerId"] ) assert.equal(studio[k], undefined, k);
  assert.equal(backend.turn, undefined);
});
