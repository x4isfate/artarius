// 0.7.0: module settings window, custom layers, type editing from tool windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import Studio from "../scripts/studio.mjs";
import MemoryBackend from "./harness/memory-backend.mjs";
import { zoneCells, cellKey } from "../scripts/data/world.mjs";

const setup = () => {
  const backend = new MemoryBackend();
  const studio = new Studio(backend);
  return { backend, studio };
};
const paint = async (studio, typeId, cells) => {
  studio.setTool("zone", { toggle: false });
  studio.zone.target = "new";
  studio.zone.typeId = typeId;
  await studio.attach(cells);
};
const addLayer = async (studio, name, exclusive) => {
  studio.openSettings("layers");
  studio.settingsPick("new");
  Object.assign(studio.layerForm, { name, exclusive });
  await studio.saveLayerForm();
  return studio.layers.find(l => l.name === name);
};
const addAreaType = async (studio, name, layerId) => {
  studio.openSettings("area");
  studio.settingsPick("new");
  Object.assign(studio.typeForm, { name, layerId });
  await studio.saveTypeForm();
  return studio.typesOf("area").find(t => t.name === name);
};

test("a new layer is added at the end and its exclusive flag is honoured", async () => {
  const { studio } = setup();
  const n = studio.layers.length;
  const magic = await addLayer(studio, "Магия", true);
  assert.equal(studio.layers.length, n + 1);
  assert.equal(studio.layers.at(-1).id, magic.id);
  assert.equal(studio.settings.id, magic.id, "новый слой выбран в списке");
  const aura = await addAreaType(studio, "Аура", magic.id);
  const curse = await addAreaType(studio, "Проклятие", magic.id);
  await paint(studio, aura.id, [[2, 2], [3, 2]]);
  await paint(studio, curse.id, [[3, 2]]);
  const auraZone = [...studio.states.values()].find(z => z.system.typeId === aura.id);
  assert.deepEqual(zoneCells(auraZone).map(cellKey), ["2,2"], "в слое «гекс в одной зоне» новая зона забрала гекс");
});

test("an overlapping layer keeps both zones on the same hex", async () => {
  const { studio } = setup();
  const notes = await addLayer(studio, "Слухи", false);
  const a = await addAreaType(studio, "Слух А", notes.id);
  const b = await addAreaType(studio, "Слух Б", notes.id);
  await paint(studio, a.id, [[2, 2]]);
  await paint(studio, b.id, [[2, 2]]);
  assert.equal([...studio.states.values()].filter(z => [a.id, b.id].includes(z.system.typeId)).length, 2);
});

test("rename, reorder and delete a layer; terrain cannot be deleted", async () => {
  const { studio, backend } = setup();
  const magic = await addLayer(studio, "Магия", true);
  studio.settingsPick(magic.id);
  studio.layerForm.name = "Чары";
  await studio.saveLayerForm();
  assert.equal(studio.layers.find(l => l.id === magic.id).name, "Чары");
  await studio.moveLayer(magic.id, -1);
  assert.equal(studio.layers.at(-2).id, magic.id);
  await studio.moveLayer(studio.layers[0].id, -1);
  assert.equal(studio.layers.at(-2).id, magic.id, "первый слой выше не двигается");

  const aura = await addAreaType(studio, "Аура", magic.id);
  await paint(studio, aura.id, [[4, 4]]);
  backend.confirmAnswer = false;
  await studio.deleteLayer(magic.id);
  assert.ok(studio.layers.some(l => l.id === magic.id), "отказ в подтверждении оставляет слой");
  backend.confirmAnswer = true;
  await studio.deleteLayer(magic.id);
  assert.ok(!studio.layers.some(l => l.id === magic.id));
  assert.equal(studio.typeById(aura.id).layerId, "overlay", "тип переехал в «Прочее»");
  const zone = [...studio.states.values()].find(z => z.system.typeId === aura.id);
  assert.notEqual(zone.system.layerId, magic.id, "зона не осталась в удалённом слое");

  const n = studio.layers.length;
  await studio.deleteLayer("terrain");
  assert.equal(studio.layers.length, n, "местность не удаляется");
});

test("players see only type sections and cannot edit layers", async () => {
  const { studio, backend } = setup();
  backend.switchUser("fire");
  assert.equal(backend.isGM, false);
  studio.openSettings("layers");
  assert.equal(studio.settings.section, "area");
  const n = studio.layers.length;
  studio.layerForm = { id: null, name: "Тайный", exclusive: true };
  await studio.saveLayerForm();
  assert.equal(studio.layers.length, n);
});

test("editing a type from a tool window closes settings after save and keeps the type picked", async () => {
  const { studio } = setup();
  studio.setTool("mark", { toggle: false });
  studio.editTypeInSettings("object", "new");
  assert.ok(studio.settings.open && studio.typeForm?.kind === "object");
  studio.typeForm.name = "Маяк";
  await studio.saveTypeForm();
  const beacon = studio.typesOf("object").find(t => t.name === "Маяк");
  assert.ok(beacon);
  assert.equal(studio.mark.typeId, beacon.id);
  assert.equal(studio.settings.open, false, "настройки закрылись сами");

  studio.openSettings("object");
  studio.settingsPick(beacon.id);
  studio.typeForm.name = "Большой маяк";
  await studio.saveTypeForm();
  assert.equal(studio.settings.open, true, "открытые вручную настройки остаются открытыми");
  assert.equal(studio.settings.id, beacon.id);
});
