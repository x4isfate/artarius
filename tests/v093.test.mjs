// 0.9.3: map modes 1–5, brush eraser and eyedropper, mark click opens its card, «Undo» toast, catalog jump.
import { test } from "node:test";
import assert from "node:assert/strict";
import Studio, { MODES } from "../scripts/studio.mjs";
import MemoryBackend from "./harness/memory-backend.mjs";

const setup = () => {
  const backend = new MemoryBackend();
  const studio = new Studio(backend);
  return { backend, studio };
};
const zones = studio => [...studio.states.values()].filter(s => s.system.kind === "area");
const marks = studio => [...studio.states.values()].filter(s => s.system.kind === "object");
const cellsOf = z => (z.system.geometry?.cells ?? []).map(c => `${c[0]}:${c[1]}`).sort();
const paint = async (studio, typeId, cells, name) => {
  studio.setTool("zone", { toggle: false });
  studio.zone.typeId = typeId;
  studio.zone.target = "new";
  studio.zone.name = name;
  await studio.attach(cells);
  return zones(studio).find(z => z.name === name);
};

test("six modes, in key order (0.9.9)", () => {
  assert.deepEqual(MODES, ["select", "zones", "marks", "lines", "players", "layers"]);
});

test("modes switch tools; the same mode again goes back to select", () => {
  const { studio } = setup();
  assert.equal(studio.mode, "");
  studio.setMode("zones");
  assert.equal(studio.tool, "zone");
  assert.equal(studio.mode, "zones");
  assert.equal(studio.zone.scope, "", "one zones mode lists every zone type");
  studio.setMode("marks");
  assert.equal(studio.tool, "mark");
  studio.setMode("lines");
  assert.equal(studio.tool, "line");
  studio.setMode("lines");
  assert.equal(studio.tool, "select");
  assert.equal(studio.mode, "select");
  studio.setMode("players");
  assert.equal(studio.mode, "players");
  assert.equal(studio.rightTab, "queue");
  studio.setMode("players");
  assert.equal(studio.mode, "select", "second press closes the queue");
  studio.setMode("layers");
  assert.ok(studio.layersOpen, "layers opens its window");
  assert.equal(studio.tool, "select", "and keeps the tool");
  studio.setMode("layers");
  assert.ok(!studio.layersOpen);
  studio.setMode("nonsense");
  assert.equal(studio.mode, "select");
});

test("each brush mode lists only its own zone types", () => {
  const { studio } = setup();
  studio.zone.scope = "terrain";
  assert.ok(studio.zoneTypes().every(t => t.layerId === "terrain"));
  studio.zone.scope = "realms";
  const realms = studio.zoneTypes();
  assert.ok(realms.length && realms.every(t => t.layerId !== "terrain"));
  assert.ok(realms.some(t => t.id === "realm"));
  studio.zone.scope = "";
  assert.equal(studio.zoneTypes().length, studio.typesOf("area").length);
});

test("eraser takes hexes out of the zones of its mode only", async () => {
  const { studio } = setup();
  const forest = await paint(studio, "forest", [[2, 2], [3, 2], [4, 2]], "Лес");
  const realm = await paint(studio, "realm", [[2, 2], [3, 2]], "Держава");
  studio.setTool("zone", { toggle: false });
  studio.zone.target = "new";
  studio.zone.typeId = "realm";
  studio.setBrush("erase");
  assert.ok(studio.zone.erase && !studio.zone.paint);
  await studio.eraseCells([[2, 2]]);
  assert.deepEqual(cellsOf(studio.stateOf(realm.id)), ["3:2"]);
  assert.deepEqual(cellsOf(studio.stateOf(forest.id)), ["2:2", "3:2", "4:2"], "terrain stays while a realm type is picked");
  // С выбранной зоной ластик трогает только её.
  studio.zone.target = forest.id;
  studio.setBrush("erase");
  await studio.eraseCells([[3, 2]]);
  assert.deepEqual(cellsOf(studio.stateOf(forest.id)), ["2:2", "4:2"]);
  assert.deepEqual(cellsOf(studio.stateOf(realm.id)), ["3:2"]);
  studio.setBrush("paint");
  assert.ok(studio.zone.paint && !studio.zone.erase);
});

test("eraser drag on the map goes through pointerUp", async () => {
  const { studio, backend } = setup();
  const realm = await paint(studio, "realm", [[5, 5], [6, 5]], "Держава");
  studio.setTool("zone", { toggle: false });
  studio.zone.target = realm.id;
  studio.setBrush("erase");
  studio.pointerDown(backend.grid.center([5, 5]));
  await studio.pointerUp();
  assert.deepEqual(cellsOf(studio.stateOf(realm.id)), ["6:5"]);
});

test("Alt-click with the brush picks the zone under the cursor", async () => {
  const { studio, backend } = setup();
  await paint(studio, "forest", [[4, 4]], "Лес");
  const realm = await paint(studio, "realm", [[4, 4]], "Держава");
  studio.setTool("zone", { toggle: false });
  studio.zone.target = "new";
  studio.pointerDown(backend.grid.center([4, 4]), { alt: true });
  assert.equal(studio.zone.target, realm.id, "the top layer wins");
  assert.equal(studio.zone.typeId, "realm");
  studio.eyedrop([9, 9]);
  assert.match(backend.log.at(-1)[1], /.+/, "empty hex says nothing is here");
  assert.equal(studio.stateOf(studio.zone.target)?.name, "Держава", "empty hex keeps the brush");
});

test("in the marks mode a click on a mark opens its card instead of placing another", async () => {
  const { studio, backend } = setup();
  studio.setTool("mark", { toggle: false });
  await studio.placeMarks([[6, 6]]);
  const [m] = marks(studio);
  studio.setMode("select");
  studio.setTool("select", { toggle: false });
  studio.setMode("marks");
  const slot = studio.markSlots().slots.find(s => s.id === m.id);
  assert.ok(slot);
  studio.pointerDown({ x: slot.x, y: slot.y });
  await studio.pointerUp();
  assert.equal(marks(studio).length, 1);
  assert.equal(studio.openId, m.id);
  assert.ok(studio.rightOpen);
  assert.equal(studio.rightTab, "tile");
  assert.deepEqual(studio.inspected, [6, 6]);
  assert.ok(backend);
});

test("delete shows the undo toast; Undo brings the mark back and hides it", async () => {
  const { studio, backend } = setup();
  studio._hasToastUI = true;
  studio.setTool("mark", { toggle: false });
  await studio.placeMarks([[2, 3]]);
  const [m] = marks(studio);
  const before = backend.log.length;
  await studio.deleteMarks([m.id]);
  assert.equal(marks(studio).length, 0);
  assert.ok(studio.toast?.undo);
  assert.equal(backend.log.length, before, "with panels the toast replaces the notification");
  await studio.undo();
  assert.equal(marks(studio).length, 1);
  assert.equal(studio.toast, null);
  studio.showToast("x");
  studio.hideToast();
  assert.equal(studio.toast, null);
});

test("without panels the toast text still reaches the user", () => {
  const { studio, backend } = setup();
  studio.showToast("Удалено");
  assert.deepEqual(backend.log.at(-1), ["info", "Удалено"]);
});

test("catalog jump pans to the thing, inspects its hex and opens its card", async () => {
  const { studio, backend } = setup();
  const realm = await paint(studio, "realm", [[7, 3], [8, 3]], "Держава");
  studio.setTool("select", { toggle: false });
  studio.focusFeature(realm.id);
  assert.equal(backend.log.at(-1)[0], "pan");
  assert.deepEqual(studio.inspected, [7, 3]);
  assert.equal(studio.openId, realm.id);
  assert.ok(studio.rightOpen);
  studio.focusFeature("missing");
  assert.equal(studio.openId, realm.id);
});
