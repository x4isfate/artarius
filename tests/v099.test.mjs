// 0.9.9: единый интерфейс — папки, аспекты-предметы, вид слоя, берег, режимы, «Что нового».
import { test } from "node:test";
import assert from "node:assert/strict";
import Studio, { MODES } from "../scripts/studio.mjs";
import MemoryBackend from "./harness/memory-backend.mjs";
import { attachItem, detachItem, hostsOf, baseItems, searchItems } from "../scripts/data/aspects.mjs";
import { groupByFolders } from "../scripts/data/folders.mjs";

const setup = () => {
  const backend = new MemoryBackend();
  const studio = new Studio(backend);
  return { backend, studio };
};
const answer = (backend, text) => { backend.prompt = async () => text; };
const paint = async (studio, typeId, cells) => {
  studio.setTool("zone", { toggle: false });
  studio.zone.target = "new";
  studio.zone.typeId = typeId;
  await studio.attach(cells);
  return [...studio.states.values()].find(z => z.system.typeId === typeId);
};

test("six modes in the order of the bottom bar", () => {
  assert.deepEqual(MODES, ["select", "zones", "marks", "lines", "players", "layers"]);
  const { studio } = setup();
  studio.setMode("zones");
  assert.equal(studio.tool, "zone");
  studio.setMode("layers");
  assert.equal(studio.layersOpen, true, "«Слои» открывают окно");
  assert.equal(studio.tool, "zone", "окно слоёв не меняет инструмент");
});

test("a mark folder is created, renamed, recoloured and removed; its types go to the root", async () => {
  const { studio, backend } = setup();
  answer(backend, "Крепости");
  await studio.newFolder("object");
  const f = backend.folders().find(x => x.name === "Крепости");
  assert.ok(f && f.kind === "object" && /^#[0-9a-f]{6}$/i.test(f.color), "папка с цветом по кругу");
  studio.newInFolder("object", f.id);
  Object.assign(studio.typeForm, { name: "Цитадель" });
  await studio.saveTypeForm();
  const cit = studio.typesOf("object").find(t => t.name === "Цитадель");
  assert.equal(cit.folder, f.id, "«Новый тип в папке» кладёт тип в эту папку");
  assert.ok(studio.folderGroups("object").find(g => g.id === f.id).items.some(t => t.id === cit.id));

  answer(backend, "Твердыни");
  await studio.renameFolder("object", f.id);
  await studio.colorFolder("object", f.id, "#123456");
  const g = backend.folders().find(x => x.id === f.id);
  assert.equal(g.name, "Твердыни");
  assert.equal(g.color, "#123456");
  await studio.colorFolder("object", f.id, "red");
  assert.equal(backend.folders().find(x => x.id === f.id).color, "#123456", "не цвет — не пишется");

  await studio.removeFolder("object", f.id);
  assert.ok(!backend.folders().some(x => x.id === f.id));
  assert.equal(studio.typeById(cit.id).folder, undefined, "тип остался, без папки");
});

test("players cannot create folders", async () => {
  const { studio, backend } = setup();
  backend.switchUser("fire");
  answer(backend, "Моё");
  await studio.newFolder("object");
  assert.ok(!backend.folders().some(x => x.name === "Моё"));
});

test("zone types without a folder are grouped by their layer; renaming such a group makes a real folder", async () => {
  const { studio, backend } = setup();
  const groups = studio.folderGroups("area");
  const terrain = groups.find(g => g.id === "@layer:terrain");
  assert.ok(terrain?.virtual && terrain.items.some(t => t.id === "forest"));
  answer(backend, "Земли");
  await studio.renameFolder("area", "@layer:terrain");
  const real = backend.folders().find(x => x.name === "Земли");
  assert.ok(real, "запасная папка стала настоящей");
  assert.equal(studio.typeById("forest").folder, real.id, "типы слоя переехали в неё");
});

test("groupByFolders keeps old name-only folders as legacy groups", () => {
  const types = [{ id: "a", name: "А", folder: "Чудовища" }, { id: "b", name: "Б" }];
  const groups = groupByFolders("object", types, []);
  const legacy = groups.find(g => g.name === "Чудовища");
  assert.ok(legacy?.legacy && legacy.items[0].id === "a");
  assert.ok(groups.some(g => !g.id && g.items.some(t => t.id === "b")), "без папки — в корне");
});

test("base aspects are seeded as items: statuses keep their parent aspect", async () => {
  const { studio } = setup();
  await studio.seedAspects();
  const items = studio.aspects();
  const base = baseItems();
  assert.equal(items.length, base.length);
  const parent = items.find(i => i.system.kind === "aspect");
  const kids = items.filter(i => i.system.parentId === parent.id);
  assert.ok(kids.length >= 2, "статусы аспекта знают свой аспект");
  assert.ok(studio.folderGroups("aspect").some(g => g.id && g.items.length === items.length), "всё в папке «Базовые»");
  assert.equal(searchItems(items, "чума").length, 1);
});

test("an aspect is attached to a zone, shows its hosts and is detached", async () => {
  const { studio } = setup();
  await studio.seedAspects();
  const zone = await paint(studio, "forest", [[2, 2], [3, 2]]);
  const aspect = studio.aspects().find(i => i.system.kind === "aspect");
  const status = studio.aspects().find(i => i.system.parentId === aspect.id);
  assert.equal(await studio.attachAspect(zone.id, aspect.id), true);
  assert.equal(await studio.attachAspect(zone.id, aspect.id), false, "второй раз не вешается");
  // 1.0: аспект ложится вместе со своими статусами, второй раз статус не вешается.
  assert.equal(await studio.attachAspect(zone.id, status.id), false);
  const st = studio.stateOf(zone.id);
  assert.equal(st.system.aspects[0].itemId, aspect.id);
  assert.equal(st.system.aspects[0].statuses[0].itemId, status.id, "статус лёг внутрь своего аспекта");
  assert.deepEqual(studio.aspectHosts(status.id).map(h => h.state.id), [zone.id]);
  await studio.detachAspect(zone.id, aspect.id);
  assert.equal(studio.aspectHosts(aspect.id).length, 0);
  assert.equal(studio.aspectHosts(status.id).length, 0, "со снятым аспектом ушли и его статусы");
});

test("dropping an aspect on the map picks the mark, else the top zone of the hex", async () => {
  const { studio } = setup();
  await studio.seedAspects();
  const forest = await paint(studio, "forest", [[4, 4]]);
  const realm = await paint(studio, "realm", [[4, 4]]);
  const item = studio.aspects()[0];
  const pt = studio.grid.center([4, 4]);
  // Край гекса: мимо меток.
  const edge = { x: pt.x, y: pt.y + studio.grid.radius * 0.7 };
  assert.equal(studio.featureAt(edge), realm.id, "верхний слой — держава");
  await studio.dropAspect(item.id, edge);
  assert.ok(studio.aspectHosts(item.id).some(h => h.state.id === realm.id));
  assert.ok(!studio.aspectHosts(item.id).some(h => h.state.id === forest.id));
  studio.setTool("mark", { toggle: false });
  studio.mark.typeId = studio.typesOf("object")[0].id;
  await studio.placeMarks([[4, 4]]);
  const slot = studio.markSlots().slots.find(s => s.key === "4,4");
  assert.equal(studio.featureAt({ x: slot.x, y: slot.y }), slot.id, "метка под курсором важнее зоны");
  assert.equal(await studio.dropAspect(item.id, { x: -9999, y: -9999 }), false, "мимо карты — ничего");
});

test("attachItem/detachItem are pure and hostsOf finds nested statuses", () => {
  const st = { id: "z", system: { statuses: [], aspects: [] } };
  let n = 0;
  const id = () => `e${++n}`;
  const a = { id: "A", name: "Крепость", system: { kind: "aspect", steps: 0 } };
  const s = { id: "S", name: "Осада", system: { kind: "status", steps: 5, parentId: "A" } };
  const one = attachItem(st, a, id);
  const two = attachItem(one, s, id);
  assert.equal(st.system.aspects.length, 0, "исходное не тронуто");
  assert.equal(two.system.aspects[0].statuses[0].max, 5);
  assert.equal(hostsOf(new Map([["z", two]]), "S").length, 1);
  assert.equal(detachItem(two, "nope"), null);
  assert.equal(detachItem(two, "S").system.aspects[0].statuses.length, 0);
});

test("layer opacity and blur are set by the GM, clamped and reset", async () => {
  const { studio, backend } = setup();
  await studio.setLayerLook("politics", "opacity", "0.4");
  await studio.setLayerLook("politics", "blur", "50");
  let l = studio.layers.find(x => x.id === "politics");
  assert.equal(l.opacity, 0.4);
  assert.equal(l.blur, 20, "размытие не больше 20");
  await studio.setLayerLook("politics", "opacity", "");
  await studio.setLayerLook("politics", "blur", "0");
  l = studio.layers.find(x => x.id === "politics");
  assert.equal(l.opacity, undefined);
  assert.equal(l.blur, undefined);
  backend.switchUser("fire");
  await studio.setLayerLook("politics", "opacity", "0.1");
  assert.equal(studio.layers.find(x => x.id === "politics").opacity, undefined, "игрок не меняет вид слоя");
});

test("coast style is saved for everyone and reset", async () => {
  const { studio, backend } = setup();
  studio.pickLayer("@coast");
  assert.ok(studio.coastForm, "берег открыт справа");
  await studio.setCoast("pattern", "double");
  await studio.setCoast("width", "2.5");
  assert.equal(backend.world().coast.pattern, "double");
  assert.equal(Number(backend.world().coast.width), 2.5);
  await studio.resetCoast();
  assert.equal(backend.world().coast, undefined);
});

test("a line type has a layer; hidden layer hides the line from aspect drops", async () => {
  const { studio, backend } = setup();
  const road = studio.typeById("road");
  await backend.saveType({ ...road, layerId: "politics" });
  studio.setTool("line", { toggle: false });
  studio.line.typeId = "road";
  studio.line.mode = "free";
  const a = studio.grid.center([3, 3]), b = studio.grid.center([3, 6]);
  studio.pointerDown(a);
  studio.pointerDown(b);
  await studio.finishLine();
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const line = [...studio.states.values()].find(s => s.system.kind === "line");
  assert.ok(line);
  assert.equal(studio.featureAt(mid), line.id);
  await backend.toggleLayer("politics");
  assert.notEqual(studio.featureAt(mid), line.id, "линия скрытого слоя не ловит бросок");
});

test("double click on a mark opens its card", async () => {
  const { studio } = setup();
  studio.setTool("mark", { toggle: false });
  studio.mark.typeId = studio.typesOf("object")[0].id;
  await studio.placeMarks([[6, 6]]);
  studio.setTool("select", { toggle: false });
  const slot = studio.markSlots().slots.find(s => s.key === "6,6");
  assert.equal(studio.doubleClick({ x: slot.x, y: slot.y }), true);
  assert.equal(studio.openId, slot.id);
  assert.equal(studio.rightTab, "tile");
});

test("the quick inspect «+» opens the tool window with the inspected hexes selected", () => {
  const { studio } = setup();
  studio.setTool("select", { toggle: false });
  studio.inspect([5, 5]);
  studio.inspectToggle([5, 6]);
  studio.openToolHere("mark");
  assert.equal(studio.tool, "mark");
  assert.deepEqual([...studio.selection.keys()].sort(), ["5,5", "5,6"]);
});

test("changelogSections splits CHANGELOG.md by version, newest first", async () => {
  globalThis.foundry ??= { applications: { api: { ApplicationV2: class {} } } };
  const { changelogSections } = await import("../scripts/apps/news-app.mjs");
  const md = "# Изменения\n\nВступление.\n\n## 0.9.9\n\n- Новое\n\n## 0.9.6\n\nСтарое.\n";
  const list = changelogSections(md);
  assert.deepEqual(list.map(s => s.version), ["0.9.9", "0.9.6"]);
  assert.match(list[0].html, /<li>Новое<\/li>/);
});
