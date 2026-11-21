// 0.9.2: zones catalog, «Add to zone» on the hex panel, several demiurges, visibility for demiurges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Studio from "../scripts/studio.mjs";
import MemoryBackend from "./harness/memory-backend.mjs";
import {
  demiurgesOf, setDemiurges, canSee, visibleStates, canEditVisibility, lockedViewers, needsGMApproval, checkOps
} from "../scripts/data/access.mjs";
import { diffOf } from "../scripts/review/describe.mjs";
import { blankState } from "../scripts/data/world.mjs";

const setup = () => {
  const backend = new MemoryBackend();
  const studio = new Studio(backend);
  return { backend, studio };
};
const marks = studio => [...studio.states.values()].filter(s => s.system.kind === "object");
const zones = studio => [...studio.states.values()].filter(s => s.system.kind === "area");
const place = async (studio, cells) => {
  studio.setTool("mark", { toggle: false });
  await studio.placeMarks(cells);
  studio.setTool("select", { toggle: false });
};
const paint = async (studio, cells, { name = "", typeId = null } = {}) => {
  studio.setTool("zone", { toggle: false });
  studio.zone.typeId = typeId ?? studio.typesOf("area").find(t => t.layerId === "politics")?.id ?? studio.typesOf("area")[0].id;
  studio.zone.target = "new";
  studio.zone.name = name;
  await studio.attach(cells);
  studio.setTool("select", { toggle: false });
  return zones(studio).find(z => z.name === (name || z.name));
};
/** Мастер принимает все заявки, потом снова смотрим глазами who. */
const acceptAll = async (studio, backend, who = "gm") => {
  backend.switchUser("gm");
  const ids = backend.claims().map(e => e.claim.id);
  if ( ids.length ) await studio.applyClaims(ids);
  backend.switchUser(who);
};

test("demiurges: old single field reads as a list, setDemiurges keeps the old field in step", () => {
  assert.deepEqual(demiurgesOf({ system: { demiurge: "a" } }), ["a"]);
  assert.deepEqual(demiurgesOf({ system: { demiurge: "a", demiurges: [] } }), ["a"], "old page after the schema added an empty list");
  assert.deepEqual(demiurgesOf({ system: { demiurge: "", demiurges: ["b", "c"] } }), ["b", "c"]);
  assert.deepEqual(demiurgesOf({ system: {} }), []);
  const sys = {};
  setDemiurges(sys, ["x", "y", "x", ""]);
  assert.deepEqual(sys, { demiurges: ["x", "y"], demiurge: "x" });
  setDemiurges(sys, []);
  assert.deepEqual(sys, { demiurges: [], demiurge: "" });
  assert.deepEqual(blankState({ id: "1", kind: "object", demiurge: "q" }).system.demiurges, ["q"]);
});

test("the page schema keeps author, visibility and demiurges (Foundry drops unknown system keys)", () => {
  const src = readFileSync(new URL("../scripts/data/feature-model.mjs", import.meta.url), "utf8");
  for ( const key of ["author", "visibility", "demiurges", "demiurge"] ) assert.match(src, new RegExp(`\\b${key}: new fields\\.`), key);
});

test("a player's new mark gets the player's character as demiurge, the GM's gets none", async () => {
  const { studio, backend } = setup();
  await place(studio, [[2, 2]]);
  assert.deepEqual(demiurgesOf(marks(studio)[0]), []);
  backend.switchUser("fire");
  await place(studio, [[5, 5]]);
  const mine = marks(studio).find(m => m.system.author === "fire");
  assert.deepEqual(demiurgesOf(mine), ["a-fire"]);
  // Без закреплённого персонажа демиургов нет.
  backend.users.find(u => u.id === "ice").character = "";
  backend.switchUser("ice");
  await place(studio, [[7, 7]]);
  assert.deepEqual(demiurgesOf(marks(studio).find(m => m.system.author === "ice")), []);
});

test("one, several or no demiurges from the card", async () => {
  const { studio } = setup();
  await place(studio, [[3, 3]]);
  const [m] = marks(studio);
  studio.toggleDemiurge(m.id, "a-fire");
  studio.toggleDemiurge(m.id, "a-ice");
  await studio.flush?.();
  assert.deepEqual(demiurgesOf(studio.stateOf(m.id)), ["a-fire", "a-ice"]);
  studio.toggleDemiurge(m.id, "a-fire");
  studio.toggleDemiurge(m.id, "a-ice");
  await studio.flush?.();
  assert.deepEqual(demiurgesOf(studio.stateOf(m.id)), []);
  studio.setField(m.id, "demiurge", "a-sun");
  await studio.flush?.();
  assert.deepEqual(demiurgesOf(studio.stateOf(m.id)), ["a-sun"]);
});

test("zones and lines hide too; a demiurge's player always sees the thing", () => {
  const zone = { system: { kind: "area", author: "gm", demiurges: ["a-ice"], visibility: { mode: "gm", users: [] } } };
  const line = { system: { kind: "line", author: "gm", visibility: { mode: "some", users: ["sun"] } } };
  assert.ok(!canSee(zone, "fire", false, ["a-fire"]));
  assert.ok(canSee(zone, "ice", false, ["a-ice"]), "demiurge sees it");
  assert.ok(canSee(line, "sun"));
  assert.ok(!canSee(line, "fire"));
  const states = new Map([["z", zone], ["l", line]]);
  assert.deepEqual([...visibleStates(states, "ice", false, new Set(["a-ice"])).keys()], ["z"]);
  const players = [{ id: "fire", actorIds: ["a-fire"] }, { id: "ice", actorIds: ["a-ice"] }];
  assert.deepEqual(lockedViewers(zone, players), ["ice"]);
});

test("only the GM or a demiurge's player may change visibility", async () => {
  const { studio, backend } = setup();
  await place(studio, [[4, 4]]);
  const [m] = marks(studio);
  setDemiurges(m.system, ["a-ice"]);
  assert.ok(canEditVisibility(m, { isGM: true }));
  assert.ok(canEditVisibility(m, { actorIds: ["a-ice"] }));
  assert.ok(!canEditVisibility(m, { actorIds: ["a-fire"] }));
  // Чужой игрок не меняет видимость даже правкой мимо карточки.
  const op = { action: "update", id: m.id, state: { ...m, system: { ...m.system, visibility: { mode: "gm", users: [] } } } };
  const { allowed, denied } = checkOps([op], () => m, { editOthers: true }, "fire", ["a-fire"]);
  assert.equal(allowed.length, 0);
  assert.deepEqual(denied.map(d => d.perm), ["visibility"]);
  assert.equal(checkOps([op], () => m, {}, "ice", ["a-ice"]).allowed.length, 1, "demiurge may");
  // В студии кнопка у не-демиурга ничего не делает.
  await studio.setDemiurges(m.id, ["a-ice"]);
  await studio.flush?.();
  backend.switchUser("fire");
  assert.ok(!studio.canChangeVisibility(studio.stateOf(m.id)));
  studio.setVisibility(m.id, "gm");
  await studio.flush?.();
  assert.equal(backend.draftOps().length, 0);
});

test("hiding keeps the demiurges' players: they stay checked and cannot be removed", async () => {
  const { studio } = setup();
  const z = await paint(studio, [[2, 2], [2, 3]], { name: "Север" });
  await studio.setDemiurges(z.id, ["a-fire"]);
  await studio.flush?.();
  studio.setVisibility(z.id, "some", ["sun"]);
  await studio.flush?.();
  assert.deepEqual(studio.stateOf(z.id).system.visibility.users.sort(), ["fire", "sun"]);
  studio.toggleViewer(z.id, "fire");
  await studio.flush?.();
  assert.ok(studio.stateOf(z.id).system.visibility.users.includes("fire"), "demiurge stays");
  studio.toggleViewer(z.id, "sun");
  await studio.flush?.();
  assert.deepEqual(studio.stateOf(z.id).system.visibility.users, ["fire"]);
});

test("a hidden zone disappears for other players, its demiurge's player still sees it", async () => {
  const { studio, backend } = setup();
  const z = await paint(studio, [[6, 6]], { name: "Тайная" });
  await studio.setDemiurges(z.id, ["a-ice"]);
  studio.setVisibility(z.id, "gm");
  await studio.flush?.();
  backend.switchUser("fire");
  assert.ok(!backend.states().has(z.id));
  backend.switchUser("ice");
  assert.ok(backend.states().has(z.id));
});

test("changing demiurges needs the GM even for a trusted player; a new thing with one's own character does not", () => {
  const before = { system: { kind: "object", demiurges: ["a-fire"], demiurge: "a-fire" } };
  const same = { action: "update", id: "x", state: { system: { ...before.system, statuses: [{ name: "Голод" }] } } };
  const changed = { action: "update", id: "x", state: { system: { ...before.system, demiurges: ["a-fire", "a-ice"] } } };
  assert.equal(needsGMApproval(same, before, ["a-fire"]), false);
  assert.equal(needsGMApproval(changed, before, ["a-fire"]), true);
  assert.equal(needsGMApproval({ action: "create", id: "y", state: { system: { demiurges: ["a-fire"] } } }, null, ["a-fire"]), false);
  assert.equal(needsGMApproval({ action: "create", id: "y", state: { system: { demiurges: ["a-sun"] } } }, null, ["a-fire"]), true);
  assert.equal(needsGMApproval({ action: "delete", id: "x" }, before, ["a-fire"]), false);
});

test("claim diff names the demiurges and who sees", () => {
  const before = { id: "a", name: "Крепость", system: { kind: "object", demiurges: ["a-fire"], demiurge: "a-fire" } };
  const after = { ...before, system: { ...before.system, demiurges: ["a-fire", "a-ice"], visibility: { mode: "some", users: ["sun"] } } };
  const names = { "a-fire": "Огонь", "a-ice": "Лёд", sun: "Солнце" };
  const rows = diffOf({ action: "update", id: "a", state: after }, new Map([["a", before]]),
    { t: k => k, actorName: id => names[id], userName: id => names[id] });
  const dem = rows.find(r => r.key === "demiurge");
  assert.deepEqual([dem.before, dem.after], ["Огонь", "Огонь, Лёд"]);
  assert.match(rows.find(r => r.key === "visibility").after, /Солнце/);
});

test("one catalog layer → type → zones, empty zones included", async () => {
  const { studio } = setup();
  const z = await paint(studio, [[3, 3]], { name: "Империя" });
  await studio.detach([[3, 3]]);
  const cat = studio.zoneCatalog();
  const politics = cat.find(g => g.layer.id === "politics");
  const all = politics.types.flatMap(x => x.zones.map(zz => zz.id));
  assert.ok(all.includes(z.id), "empty zone is in the catalog");
  assert.ok(politics.types.every(x => x.type.layerId === "politics"));
  assert.equal(studio.zoneCatalog("импер").flatMap(g => g.types.flatMap(x => x.zones)).length, 1);
  assert.equal(studio.zoneCatalog("нет такой").flatMap(g => g.types.flatMap(x => x.zones)).length, 0);
});

test("a zone can be created without hexes and shows up in the catalog", async () => {
  const { studio } = setup();
  studio.setTool("zone", { toggle: false });
  studio.zone.typeId = studio.typesOf("area").find(t => t.layerId === "politics").id;
  studio.zone.target = "new";
  studio.zone.name = "Пустая держава";
  await studio.createZone();
  const z = zones(studio).find(x => x.name === "Пустая держава");
  assert.ok(z, "created");
  assert.equal(z.system.geometry.cells.length, 0);
  assert.equal(studio.zone.target, z.id, "brush now paints with it");
  assert.ok(studio.zoneCatalog().some(g => g.types.some(x => x.zones.some(zz => zz.id === z.id))));
});

test("«Add to zone» on the hex panel lists existing zones and puts the hex into the chosen one", async () => {
  const { studio } = setup();
  const z = await paint(studio, [[2, 2]], { name: "Королевство" });
  studio.inspect([5, 5]);
  studio.toggleZoneMenu();
  assert.equal(studio.hudMenu?.kind, "zone");
  await studio.addHereToZone(z.id);
  assert.equal(studio.hudMenu, null);
  const cells = studio.stateOf(z.id).system.geometry.cells.map(c => c.join(":"));
  assert.ok(cells.includes("5:5"), "hex added to the existing zone");
  assert.equal(zones(studio).length, 1, "no new zone");
});

test("a trusted player's demiurge change stays in the GM queue (held), other edits pass", async () => {
  const { studio, backend } = setup();
  await place(studio, [[4, 4]]);
  const [m] = marks(studio);
  backend.switchUser("fire");
  studio.toggleDemiurge(m.id, "a-fire");
  await studio.flush?.();
  const [op] = backend.draftOps();
  assert.ok(needsGMApproval(op, backend.atlas.get(m.id), backend.myActorIds()));
  await acceptAll(studio, backend, "gm");
});
