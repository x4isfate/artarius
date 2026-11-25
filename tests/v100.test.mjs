// 1.0 (ЗБТ): статусы аспекта, ступени X/X, своя иконка, выбор по названию, перенос статусов с карты в общий список.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Studio from "../scripts/studio.mjs";
import MemoryBackend from "./harness/memory-backend.mjs";
import {
  stepsOf, cleanSteps, statusIdsOf, aspectsWith, attachItem, attachInto, searchItems, rankItems, itemByName,
  looseEntries, linkEntries, isImageIcon, hasEntryLike, entryOf
} from "../scripts/data/aspects.mjs";

const setup = () => {
  const backend = new MemoryBackend();
  const studio = new Studio(backend);
  return { backend, studio };
};
const marks = studio => [...studio.states.values()].filter(s => s.system.kind === "object");
const place = async (studio, cells) => {
  studio.setTool("mark", { toggle: false });
  await studio.placeMarks(cells);
  studio.setTool("select", { toggle: false });
};
let n = 0;
const newId = () => `e${++n}`;
const item = (id, name, kind, extra = {}) => ({ id, name, folder: "", system: { kind, icon: "", emoji: "", steps: 0, start: null, statusIds: [], parentId: "", ...extra } });

test("steps are any X/X: start and max are clamped, empty max means no steps, old items start at 1", () => {
  assert.deepEqual(cleanSteps("2", "7"), { steps: 7, start: 2 });
  assert.deepEqual(cleanSteps("", "7"), { steps: 7, start: 1 }, "пустая ступень — первая");
  assert.deepEqual(cleanSteps("0", "4"), { steps: 4, start: 0 }, "можно начать с нуля");
  assert.deepEqual(cleanSteps("12", "4"), { steps: 4, start: 4 }, "ступень не выше максимума");
  assert.deepEqual(cleanSteps("3", ""), { steps: 0, start: null }, "без максимума ступеней нет");
  assert.deepEqual(cleanSteps("1", "5000"), { steps: 999, start: 1 });
  assert.deepEqual(stepsOf(item("a", "A", "status", { steps: 5 })), { max: 5, start: 1 }, "старый предмет без start");
  assert.deepEqual(stepsOf(item("a", "A", "status", { steps: 10, start: 3 })), { max: 10, start: 3 });
  const e = entryOf(item("s", "Голод", "status", { steps: 10, start: 3, emoji: "🌾" }), newId);
  assert.equal(e.value, 3);
  assert.equal(e.max, 10);
  assert.equal(e.emoji, "🌾", "эмодзи переходит на элемент");
});

test("an aspect lists its statuses through statusIds and the old parentId", () => {
  const items = [
    item("asp", "Неурожай", "aspect", { statusIds: ["s1"] }),
    item("s1", "Голод", "status"),
    item("s2", "Бунт", "status", { parentId: "asp" }),
    item("s3", "Чума", "status")
  ];
  assert.deepEqual(statusIdsOf(items[0], items), ["s1", "s2"]);
  assert.deepEqual(aspectsWith("s2", items).map(a => a.id), ["asp"]);
  assert.deepEqual(aspectsWith("s3", items), []);
  // Поиск по статусу находит и аспект, в который он входит.
  assert.deepEqual(searchItems(items, "голод").map(i => i.id), ["asp", "s1"]);
});

test("an aspect comes with its statuses; a status already on the mark moves inside with its step", () => {
  const items = [
    item("asp", "Неурожай", "aspect", { statusIds: ["s1", "s2"] }),
    item("s1", "Голод", "status", { steps: 10, start: 1 }),
    item("s2", "Бунт", "status")
  ];
  let st = { id: "m", system: { statuses: [], aspects: [] } };
  st = attachItem(st, items[1], newId, items);
  st.system.statuses[0].value = 4;
  st = attachItem(st, items[0], newId, items);
  assert.equal(st.system.statuses.length, 0, "отдельный «Голод» ушёл внутрь аспекта");
  assert.deepEqual(st.system.aspects[0].statuses.map(x => [x.name, x.value]), [["Голод", 4], ["Бунт", null]]);
  assert.equal(attachItem(st, items[2], newId, items), null, "второй раз статус не вешается");
  // Свой статус прямо внутрь аспекта.
  const plague = item("s3", "Чума", "status");
  const next = attachInto(st, 0, plague, newId);
  assert.deepEqual(next.system.aspects[0].statuses.map(x => x.name), ["Голод", "Бунт", "Чума"]);
  assert.equal(attachInto(st, 0, items[0], newId), null, "аспект в аспект не кладётся");
  assert.ok(hasEntryLike(next, "чум"), "поиск в списках «На карте» видит статусы элемента");
});

test("name matching: exact first, then prefix; an existing name is found regardless of case", () => {
  const items = [item("1", "Осадное положение", "status"), item("2", "Осада", "status"), item("3", "Долгая осада", "aspect")];
  assert.deepEqual(rankItems(searchItems(items, "осада"), "осада").map(i => i.id), ["2", "3"]);
  assert.deepEqual(rankItems(searchItems(items, "оса"), "оса").map(i => i.id), ["1", "2", "3"]);
  assert.equal(itemByName(items, "  ОСАДА ")?.id, "2");
  assert.equal(itemByName(items, "Осада", "aspect"), null);
});

test("icon is an emoji, a library icon or an image path", () => {
  assert.equal(isImageIcon("modules/artarius/icons/x.svg"), true);
  assert.equal(isImageIcon("worlds/w/my.webp"), true);
  assert.equal(isImageIcon("wheat-awn"), false);
  assert.equal(isImageIcon(""), false);
});

test("the aspect form saves X/X steps, emoji and its statuses; removing a status clears its old parentId", async () => {
  const { studio } = setup();
  studio.newAspect("", "status");
  Object.assign(studio.aspectForm, { name: "Голод", steps: "10", start: "2", emoji: "🌾" });
  await studio.saveAspectForm();
  const famine = studio.aspects().find(i => i.name === "Голод");
  assert.equal(famine.system.steps, 10);
  assert.equal(famine.system.start, 2);
  assert.equal(famine.system.emoji, "🌾");
  studio.newAspect("", "status");
  Object.assign(studio.aspectForm, { name: "Бунт" });
  await studio.saveAspectForm();
  const riot = studio.aspects().find(i => i.name === "Бунт");
  studio.newAspect("", "aspect");
  Object.assign(studio.aspectForm, { name: "Неурожай" });
  studio.addFormStatus(famine.id);
  studio.addFormStatus(riot.id);
  studio.addFormStatus(famine.id);
  assert.deepEqual(studio.aspectForm.statusIds, [famine.id, riot.id], "без повторов");
  await studio.saveAspectForm();
  const crop = studio.aspects().find(i => i.name === "Неурожай");
  assert.deepEqual(crop.system.statusIds, [famine.id, riot.id]);
  // Старый статус со ссылкой parentId: после снятия из формы ссылка пропадает.
  await studio.backend.saveAspect({ id: riot.id, name: riot.name, folder: "", system: { ...riot.system, parentId: crop.id } });
  studio.pickAspect(crop.id);
  studio.removeFormStatus(riot.id);
  await studio.saveAspectForm();
  assert.deepEqual(statusIdsOf(studio.aspectById(crop.id), studio.aspects()), [famine.id]);
  assert.equal(studio.aspectById(riot.id).system.parentId, "");
});

test("the picker creates a status by the typed name and puts it on the mark; a known name is not offered again", async () => {
  const { studio } = setup();
  await place(studio, [[3, 3]]);
  const m = marks(studio)[0];
  studio.toggleAspectPick({ featureId: m.id });
  studio.aspectPick.q = "Голод";
  assert.deepEqual(studio.pickCreateKinds(), ["status", "aspect"]);
  await studio.createFromPick("status");
  await studio.flush();
  const famine = studio.aspects().find(i => i.name === "Голод");
  assert.ok(famine, "статус попал в общий список");
  assert.equal(studio.stateOf(m.id).system.statuses[0].itemId, famine.id);
  studio.toggleAspectPick({ featureId: m.id });
  studio.aspectPick.q = "голод";
  assert.deepEqual(studio.pickCreateKinds(), ["aspect"], "статус «Голод» уже есть");
  assert.ok(!studio.pickList().some(i => i.id === famine.id), "висящий на метке не предлагается");
});

test("a player without item rights puts a loose status on the mark; the GM collects it into the list", async () => {
  const { studio, backend } = setup();
  await place(studio, [[4, 4]]);
  const m = marks(studio)[0];
  studio.edit(m.id, s => { s.system.statuses = [{ id: "x1", name: "Чума", value: 2, max: 5 }]; s.system.aspects = [{ id: "x2", name: "Мор", value: null, max: null, description: "", statuses: [{ id: "x3", name: "чума", value: null, max: null }] }]; }, { now: true });
  await studio.flush();
  const loose = looseEntries(studio.states, studio.aspects());
  assert.deepEqual(loose.map(x => `${x.kind}:${x.name}`), ["status:Чума", "aspect:Мор"], "без повторов по названию");
  await studio.collectLoose();
  const plague = studio.aspects().find(i => i.name === "Чума");
  assert.equal(plague.system.steps, 5);
  const st = studio.stateOf(m.id).system;
  assert.equal(st.statuses[0].itemId, plague.id);
  assert.equal(st.aspects[0].statuses[0].itemId, plague.id, "та же «чума» внутри аспекта связана по названию");
  assert.equal(looseEntries(studio.states, studio.aspects()).length, 0);
  assert.equal(linkEntries(studio.stateOf(m.id), studio.aspects()), null, "второй раз связывать нечего");
  backend.switchUser("fire");
  await studio.collectLoose();
  assert.equal(studio.aspects().filter(i => i.name === "Чума").length, 1, "игрок перенос не запускает");
});

test("the item and page schemas keep the 1.0 keys (Foundry drops unknown system keys)", () => {
  const asp = readFileSync(new URL("../scripts/data/aspect-model.mjs", import.meta.url), "utf8");
  for ( const key of ["emoji", "tint", "start", "statusIds", "steps"] ) assert.match(asp, new RegExp(`\\b${key}: new fields\\.`), key);
  const feat = readFileSync(new URL("../scripts/data/feature-model.mjs", import.meta.url), "utf8");
  assert.ok((feat.match(/\bemoji: new fields\./g) ?? []).length >= 2, "эмодзи у статуса и у аспекта на элементе");
});
