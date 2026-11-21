// Playing with players (0.7): base statuses and aspects, hidden marks, player rights, claim diff and "go to".
import { test } from "node:test";
import assert from "node:assert/strict";
import Studio from "../scripts/studio.mjs";
import MemoryBackend from "./harness/memory-backend.mjs";
import { BASE_STATUSES, BASE_ASPECTS, statusIcon, baseStatus, baseAspect } from "../scripts/data/statuses.mjs";
import { permsFor, canSee, visibleStates, isHidden, permFor, checkOps } from "../scripts/data/access.mjs";
import { describeOp, diffOf, plain } from "../scripts/review/describe.mjs";

const setup = () => {
  const backend = new MemoryBackend();
  const studio = new Studio(backend);
  return { backend, studio, grid: backend.grid };
};
const marks = studio => [...studio.states.values()].filter(s => s.system.kind === "object");
const place = async (studio, cells) => {
  studio.setTool("mark", { toggle: false });
  await studio.placeMarks(cells);
  studio.setTool("select", { toggle: false });
};
let n = 0;
const newId = () => `id${++n}`;

test("ten base statuses; building and digging have a level; hvon aspect brings its own statuses", () => {
  assert.equal(BASE_STATUSES.length, 10);
  assert.deepEqual(BASE_STATUSES.filter(s => s.level).map(s => s.key), ["building", "digging"]);
  assert.equal(baseStatus("building", newId).value, 1);
  assert.equal(baseStatus("fire", newId).value, null);
  assert.equal(baseStatus("nope", newId), null);
  const a = baseAspect("hvon", newId);
  assert.equal(a.name, "Ассимилированный Хвонами");
  assert.deepEqual(a.statuses.map(s => [s.name, s.max]), [["Изучившие Хвонов", 3], ["Изучившие марево", null]]);
  assert.equal(BASE_ASPECTS.length, 1);
});

test("status icon: base key, then words in a custom name, then a dot", () => {
  assert.equal(statusIcon({ key: "fire", name: "что угодно" }), "fire");
  assert.equal(statusIcon({ name: "Осаждён" }), "shield-halved");
  assert.equal(statusIcon("Великий голод"), "wheat-awn-circle-exclamation");
  assert.equal(statusIcon({ name: "Праздник" }), "circle-dot");
});

test("studio adds a base status and a base aspect to a mark", async () => {
  const { studio } = setup();
  await place(studio, [[4, 4]]);
  const [m] = marks(studio);
  await studio.addBaseStatus(m.id, "statuses", "siege");
  await studio.addBaseAspect(m.id, "hvon");
  await studio.flush?.();
  const st = studio.stateOf(m.id).system;
  assert.equal(st.statuses.at(-1).name, "Осаждён");
  assert.equal(st.aspects.at(-1).statuses.length, 2);
});

test("hidden mark: author and GM see it, chosen players too, others do not", () => {
  const mk = (mode, users = []) => ({ system: { kind: "object", author: "fire", visibility: { mode, users } } });
  assert.ok(canSee(mk("gm"), "fire"));
  assert.ok(canSee(mk("gm"), "ice", true), "GM sees all");
  assert.ok(!canSee(mk("gm"), "ice"));
  assert.ok(canSee(mk("some", ["ice"]), "ice"));
  assert.ok(!canSee(mk("some", ["ice"]), "sun"));
  assert.ok(canSee(mk("all"), "sun"));
  assert.ok(!canSee({ system: { kind: "area", visibility: { mode: "gm" } } }, "sun"), "zones hide too (0.9.2)");
  assert.ok(isHidden(mk("some")) && !isHidden(mk("all")));
  const states = new Map([["a", mk("gm")], ["b", mk("all")]]);
  assert.deepEqual([...visibleStates(states, "ice").keys()], ["b"]);
});

test("a player's hidden mark disappears for other players but stays for its author", async () => {
  const { studio, backend } = setup();
  backend.switchUser("fire");
  await place(studio, [[3, 3]]);
  const [m] = marks(studio);
  assert.equal(m.system.author, "fire");
  assert.ok(studio.canChangeVisibility(m));
  await studio.setVisibility(m.id, "gm");
  await studio.flush?.();
  // Заявку принимает мастер, потом смотрим глазами другого игрока.
  backend.claimForm = null;
  await studio.submit();
  backend.switchUser("gm");
  const [entry] = backend.claims();
  await studio.applyClaims([entry.claim.id]);
  assert.equal(marks(studio).length, 1, "GM sees it");
  backend.switchUser("ice");
  studio.backend.emit();
  assert.equal(backend.states().size, 0, "other player does not");
  backend.switchUser("fire");
  assert.equal(backend.states().size, 1, "author does");
});

test("rights: player setting beats role, role beats default, GM has everything", () => {
  const config = { roles: { 1: { draw: false } }, users: { fire: { draw: true, place: false } } };
  assert.deepEqual(permsFor(config, { id: "fire", role: 1 }), { place: false, draw: true, editOthers: true, statuses: true });
  assert.deepEqual(permsFor(config, { id: "ice", role: 1 }), { place: true, draw: false, editOthers: true, statuses: true });
  assert.equal(permsFor(config, { id: "gm", role: 4, isGM: true }).place, true);
});

test("which right an edit needs", () => {
  const mine = { name: "А", system: { kind: "object", author: "fire", statuses: [] } };
  const other = { name: "Б", system: { kind: "object", author: "ice", statuses: [] } };
  const zone = { name: "З", system: { kind: "area", author: "ice", geometry: { cells: [[1, 1]] } } };
  assert.equal(permFor({ action: "create", state: mine }, null, "fire"), "place");
  assert.equal(permFor({ action: "create", state: zone }, null, "fire"), "draw");
  assert.equal(permFor({ action: "delete" }, mine, "fire"), null);
  assert.equal(permFor({ action: "delete" }, other, "fire"), "editOthers");
  assert.equal(permFor({ action: "update", state: { ...other, system: { ...other.system, statuses: [{ name: "x" }] } } }, other, "fire"), "statuses");
  assert.equal(permFor({ action: "update", state: { ...other, name: "В" } }, other, "fire"), "editOthers");
  assert.equal(permFor({ action: "update", state: { ...zone, system: { ...zone.system, geometry: { cells: [] } } } }, zone, "fire"), "draw");
  const { allowed, denied } = checkOps([{ action: "delete", id: "o" }, { action: "delete", id: "m" }],
    id => (id === "o" ? other : mine), { editOthers: false }, "fire");
  assert.equal(allowed.length, 1);
  assert.deepEqual(denied.map(d => d.perm), ["editOthers"]);
});

test("studio drops edits a player has no right to and says so", async () => {
  const { studio, backend } = setup();
  backend.setPermissionConfig({ users: { fire: { place: false } } });
  backend.switchUser("fire");
  await place(studio, [[5, 5]]);
  assert.equal(marks(studio).length, 0);
  assert.ok(backend.log.some(([level]) => level === "warn"), "no warning");
});

test("claim diff: one line per edit and before/after rows under it", () => {
  const t = (k, d) => `${k}${d ? JSON.stringify(d) : ""}`;
  const ctx = { t, typeName: id => `T:${id}` };
  const before = { id: "a", name: "Крепость", text: "<p>Старая</p>", system: { kind: "object", typeId: "fort", statuses: [], geometry: { cell: [2, 3] } } };
  const after = { ...before, name: "Твердыня", system: { ...before.system, typeId: "city", statuses: [{ name: "Чума", value: null }] } };
  const base = new Map([["a", before]]);
  const op = { action: "update", id: "a", state: after };
  assert.match(describeOp(op, base, ctx), /ART\.Op\.update/);
  const rows = diffOf(op, base, ctx);
  assert.deepEqual(rows.map(r => r.key), ["name", "type", "statuses"]);
  assert.deepEqual(rows[0], { key: "name", label: "ART.Diff.name", before: "Крепость", after: "Твердыня" });
  assert.deepEqual([rows[1].before, rows[1].after], ["T:fort", "T:city"]);
  assert.equal(rows[2].after, "Чума");
  const del = diffOf({ action: "delete", id: "a" }, base, ctx);
  assert.ok(del.length && del.every(r => r.after === ""));
  const created = diffOf({ action: "create", id: "b", state: after }, new Map(), ctx);
  assert.ok(created.find(r => r.key === "name").before === "");
  assert.equal(plain("<p>a&nbsp;<b>b</b></p>"), "a b");
});

test("go to claim pans to its edits and highlights it", async () => {
  const { studio, backend, grid } = setup();
  backend.switchUser("fire");
  await place(studio, [[2, 2], [6, 2]]);
  await studio.submit();
  backend.switchUser("gm");
  const [entry] = backend.claims();
  backend.log = [];
  assert.equal(studio.goToClaim(entry.claim.id), true);
  const pan = backend.log.find(([k]) => k === "pan");
  const a = grid.center([2, 2]), b = grid.center([6, 2]);
  const [x, y] = pan[1].split(",").map(Number);
  assert.ok(Math.abs(x - ((a.x + b.x) / 2)) <= 1 && Math.abs(y - ((a.y + b.y) / 2)) <= 1, `pan ${pan[1]}`);
  assert.ok(studio.previewIds.has(entry.claim.id));
  assert.equal(studio.goToClaim("nope"), false);
});
