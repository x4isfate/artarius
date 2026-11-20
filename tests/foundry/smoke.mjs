/**
 * Дымовой тест связки с Foundry: main.mjs, слой холста, backend поверх документов.
 * Каждый шаг пишет в window.__steps: [название, ok, ошибка?].
 */
import * as F from "./stub.mjs";

const steps = window.__steps = [];
const check = async (name, fn) => {
  try {
    await fn();
    steps.push([name, true]);
  } catch(err) {
    console.error(name, err);
    steps.push([name, false, String(err?.stack ?? err)]);
  }
};
const assert = (cond, msg) => { if ( !cond ) throw new Error(msg); };

const lang = await (await fetch("../../lang/ru.json")).json();
const { gm, p1 } = await F.makeGame(lang);
const grid = F.makeGrid({ size: 100, rows: 10, cols: 14 });
const scene = new F.Scene({ _id: "sc1", name: "Мир", flags: { artarius: { world: { enabled: true } } } });
game.scenes.set(scene.id, scene);
F.makeCanvas(scene, grid);

await import("../../scripts/main.mjs");
const api = () => game.modules.get("artarius").api;
const LAYER = "artarius";

/** Нажатие мыши на холсте: настоящее DOM-событие на элементе <canvas>, координаты экрана. */
const press = (pt, { button = 0, shift = false, alt = false, type = "both" } = {}) => {
  const el = canvas.app.view;
  canvas.stage.transform.updateTransform(PIXI.Transform.IDENTITY);
  const g = canvas.stage.worldTransform.apply(new PIXI.Point(pt.x, pt.y));
  const r = el.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, button, shiftKey: shift, altKey: alt, clientX: r.left + g.x, clientY: r.top + g.y, pointerId: 1 };
  if ( type !== "up" ) el.dispatchEvent(new PointerEvent("pointerdown", init));
  if ( type !== "down" ) el.dispatchEvent(new PointerEvent("pointerup", init));
};
const hexAt = c => grid.hm.center(c);
const win = name => document.getElementById(`artarius-${name}`);
const tick = () => new Promise(r => setTimeout(r, 20));

await check("init: слой, модель, настройки, API", async () => {
  Hooks.callAll("init");
  await F.settle();
  assert(CONFIG.Canvas.layers[LAYER]?.layerClass, "слой не зарегистрирован");
  assert(CONFIG.JournalEntryPage.dataModels["artarius.feature"], "модель страницы не зарегистрирована");
  assert(api()?.version === 2, "нет API 2");
  for ( const k of ["hiddenLayers", "autoApplyOnSuccess", "trustedUsers", "guideSeen", "checkUpdates", "notifiedVersion"] ) game.settings.get("artarius", k);
});

await check("ready: панели собраны, круглого меню нет", async () => {
  Hooks.callAll("ready");
  await F.settle();
  const parts = Object.keys(api().layer ? {} : {});
  const ui2 = (await import("../../scripts/canvas/hex-layer.mjs")).runtime.ui;
  assert(ui2?.parts?.left && ui2.parts.right && !ui2.parts.turn, "части интерфейса не те");
  assert(!ui2.parts.wheel, "круглое меню осталось");
  assert(!document.getElementById("artarius-ui"), "слой поверх холста остался");
  void parts;
});

let layer;
await check("canvasReady: атлас создан, панели видны", async () => {
  layer = new CONFIG.Canvas.layers[LAYER].layerClass();
  canvas[LAYER] = layer;
  Hooks.callAll("canvasReady", canvas);
  await F.settle();
  const atlas = api().getAtlas(scene);
  assert(atlas, "атлас не создан");
  assert(atlas.getFlag("artarius", "version") === 4, "версия атласа не 4");
  assert(!win("left") && !win("right"), "окна открыты без инструмента");
});

await check("слой рисует пустой мир", async () => {
  await layer.draw();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  assert(layer.renderer, "нет renderer");
  assert(layer.children.length > 0, "слой пуст");
});

await check("группа инструментов слева", async () => {
  const c = CONFIG.Canvas.layers[LAYER].layerClass.prepareSceneControls();
  assert(c.name === LAYER && c.layer === LAYER && c.visible === true, "группа не видна на сцене Артария");
  const names = Object.keys(c.tools);
  for ( const n of ["select", "zone", "mark", "line", "queue", "settings", "generator", "guide"] ) assert(names.includes(n), `нет ${n}`);
  assert(!names.includes("turn"), "кнопка хода осталась");
  // 0.6.3: «Осмотр» не открывает окно сам; окно слоёв — по кнопке, его крестик инструмент не гасит.
  c.onToolChange(new Event("x"), c.tools.select, true);
  await tick();
  assert(api().studio.tool === "select" && !win("left"), "окно «Осмотра» всплыло само");
  const uiL = (await import("../../scripts/canvas/hex-layer.mjs")).runtime.ui;
  // 0.6: кнопка «Слои» открывает панель слоёв у названия сцены, как в Azgaar.
  c.tools.layers.onChange(new Event("x"), true);
  await tick();
  assert(document.querySelector("#artarius-layerbar .art-lb-panel [data-id='terrain']"), "кнопка «Слои» не открыла панель слоёв");
  c.tools.layers.onChange(new Event("x"), true);
  await tick();
  assert(!document.querySelector("#artarius-layerbar .art-lb-panel") && api().studio.tool === "select", "панель слоёв не закрылась");
  assert(c.tools.queue.button && c.tools.generator.visible, "кнопки не кнопки или генератор скрыт от мастера");
  // 0.7.0: кнопка «Настройки» открывает и закрывает окно настроек, крестик окна тоже закрывает.
  assert(c.tools.settings?.button, "нет кнопки настроек");
  c.tools.settings.onChange(new Event("x"), true);
  await tick();
  assert(win("settings")?.querySelector('[data-action="settingsSection"][data-section="layers"]'), "окно настроек не открылось");
  await uiL.host.windows.settings.close();
  await tick();
  assert(!api().studio.settings.open && !win("settings"), "крестик не закрыл настройки");
  c.onToolChange(new Event("x"), c.tools.mark, true);
  assert(api().studio.tool === "mark", "инструмент из панели не выбран");
  await tick();
  assert(win("left")?.textContent.includes("Метка"), "окно инструмента не открылось с заголовком");
  c.tools.queue.onChange(new Event("x"), true);
  await tick();
  assert(api().studio.rightOpen && api().studio.rightTab === "queue" && win("right"), "заявки не открылись");
  api().studio.closeRight();
  await tick();
  assert(!win("right"), "окно заявок не закрылось");
});

await check("мастер: зона из двух гексов пишется в атлас", async () => {
  const s = api().studio;
  s.setTool("zone", { toggle: false });
  assert(F.controlCalls.at(-1)?.control === LAYER, "слой не включён через ui.controls");
  layer.activate();
  press(hexAt([2, 3]));
  press(hexAt([2, 4]));
  await F.settle();
  assert(s.selection.size === 2, `выбрано ${s.selection.size}`);
  s.zone.typeId = "forest";
  await tick();
  win("left").querySelector('[data-action="attach"]').click();
  await F.settle();
  const pages = api().getAtlas(scene).pages.contents;
  assert(pages.length === 1, `страниц ${pages.length}`);
  assert(pages[0].system.geometry.cells.length === 2, "гексов в зоне не 2");
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
});

await check("мастер: метка и линия", async () => {
  const s = api().studio;
  s.setTool("mark", { toggle: false });
  press(hexAt([5, 5]));
  await tick();
  win("left").querySelector('[data-action="placeMarks"]').click();
  await F.settle();
  s.setTool("line", { toggle: false });
  press({ x: 50, y: 50 });
  const p1n = s.line.points.length;
  await new Promise(r => setTimeout(r, 400));
  press({ x: 400, y: 300 });
  const p2n = s.line.points.length;
  assert(p1n === 1 && p2n === 2, `точки после щелчков: ${p1n}, ${p2n}`);
  await new Promise(r => setTimeout(r, 400));
  press({ x: 600, y: 300 }, { button: 2 });
  assert(s.line.points.length === 1, `правый щелчок не убрал точку: ${JSON.stringify(s.line.points)} tool=${s.tool}`);
  press({ x: 400, y: 300 });
  press({ x: 400, y: 300 });
  await F.settle();
  const kinds = api().getAtlas(scene).pages.contents.map(p => p.system.kind).sort();
  assert(kinds.join() === "area,line,object", `элементы ${kinds}`);
});

await check("Осмотр: щелчок по гексу открывает карточку", async () => {
  const s = api().studio;
  s.setTool("select", { toggle: false });
  press(hexAt([2, 3]));
  await tick();
  assert(s.inspected?.join() === "2,3", `осмотрен ${s.inspected}`);
  const hudEl = document.getElementById("artarius-hud");
  assert(hudEl && !hudEl.hidden, "панель на гексе не появилась");
  assert(!win("right"), "большое окно открылось без кнопки «Подробно»");
  // Панель стоит на гексе: центр панели совпадает с центром гекса на экране.
  const c = canvas.stage.worldTransform.apply(new PIXI.Point(hexAt([2, 3]).x, hexAt([2, 3]).y));
  const r = canvas.app.view.getBoundingClientRect();
  assert(Math.abs(parseFloat(hudEl.style.left) - (r.left + c.x)) < 2 && Math.abs(parseFloat(hudEl.style.top) - (r.top + c.y)) < 2,
    `панель не на гексе: ${hudEl.style.left},${hudEl.style.top} против ${r.left + c.x},${r.top + c.y}`);
  // Карту сдвинули: панель едет следом.
  canvas.stage.position.set(130, 70);
  canvas.stage.transform.updateTransform(PIXI.Transform.IDENTITY);
  await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
  const c2 = canvas.stage.worldTransform.apply(new PIXI.Point(hexAt([2, 3]).x, hexAt([2, 3]).y));
  assert(Math.abs(parseFloat(hudEl.style.left) - (r.left + c2.x)) < 2, "панель не поехала за картой");
  canvas.stage.position.set(30, 20);
  canvas.stage.transform.updateTransform(PIXI.Transform.IDENTITY);
  hudEl.querySelector('[data-action="hudDetails"]').click();
  await tick();
  assert(win("right")?.textContent.includes("Лес"), "в карточке нет зоны");
  s.closeRight();
  s.closeHud();
});

await check("метку тащат зажатой кнопкой на другой гекс", async () => {
  const s = api().studio;
  s.setTool("select", { toggle: false });
  const mark = api().getAtlas(scene).pages.contents.find(p => p.system.kind === "object");
  const from = { x: mark.system.geometry.x, y: mark.system.geometry.y };
  const el = canvas.app.view;
  const rect = el.getBoundingClientRect();
  const scr = pt => { const g = canvas.stage.worldTransform.apply(new PIXI.Point(pt.x, pt.y)); return { clientX: rect.left + g.x, clientY: rect.top + g.y }; };
  const base = { bubbles: true, cancelable: true, button: 0, pointerId: 1 };
  let foundrySaw = false;
  const spy = () => { foundrySaw = true; };
  el.addEventListener("pointerdown", spy);
  el.dispatchEvent(new PointerEvent("pointerdown", { ...base, ...scr(from) }));
  el.removeEventListener("pointerdown", spy);
  assert(!foundrySaw, "нажатие на метку дошло до Foundry");
  const to = hexAt([7, 2]);
  for ( let k = 1; k <= 6; k++ ) {
    const pt = { x: from.x + ((to.x - from.x) * k / 6), y: from.y + ((to.y - from.y) * k / 6) };
    el.dispatchEvent(new PointerEvent("pointermove", { ...base, ...scr(pt) }));
  }
  el.dispatchEvent(new PointerEvent("pointerup", { ...base, ...scr(to) }));
  await F.settle();
  const moved = api().getAtlas(scene).pages.get(mark.id).system.geometry;
  assert(moved.cell?.join() === "7,2", `метка в ${moved.cell} (${moved.x},${moved.y})`);
  assert(!s.markDrag, "перетаскивание не закончилось");
});

await check("щелчок при чужой группе слева уходит Foundry", async () => {
  const s = api().studio;
  s.setTool("select", { toggle: false });
  s.inspected = null;
  const prev = { control: ui.controls.control, active: layer.active };
  ui.controls.control = { name: "tokens" };
  layer.active = false;
  press(hexAt([4, 4]));
  ui.controls.control = prev.control;
  layer.active = prev.active;
  assert(!s.inspected, `осмотрен ${s.inspected}`);
  assert(api().debugInput(false) === false, "нет api.debugInput");
  press(hexAt([4, 4]));
  assert(s.inspected?.join() === "4,4", "после возврата группы щелчок не дошёл");
  s.closeHud();
});

await check("линия по гексам и от руки на холсте", async () => {
  const s = api().studio;
  s.setTool("line", { toggle: false });
  s.setLineMode("hex");
  press(hexAt([1, 1]));
  press(hexAt([1, 4]));
  assert(s.line.points.length === 4, `точек ${s.line.points.length}`);
  s.clearLine();
  s.setLineMode("draw");
  const before = api().getAtlas(scene).pages.size;
  press({ x: 300, y: 300 }, { type: "down" });
  const el = canvas.app.view;
  const r = el.getBoundingClientRect();
  for ( let x = 310; x <= 600; x += 15 ) {
    const g = canvas.stage.worldTransform.apply(new PIXI.Point(x, 300 + (x % 30)));
    el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: r.left + g.x, clientY: r.top + g.y, pointerId: 1 }));
  }
  press({ x: 600, y: 300 }, { type: "up" });
  await F.settle();
  const atlas = api().getAtlas(scene);
  assert(atlas.pages.size === before + 1, "линия от руки не записана");
  // Убрать линию, чтобы счёт страниц дальше не сбился.
  const ids = atlas.pages.contents.filter(p => p.system.kind === "line").map(p => p.id);
  await atlas.deleteEmbeddedDocuments("JournalEntryPage", [ids.at(-1)]);
  await F.settle();
  s.setLineMode("free");
});

await check("выбор значка: разделы, поиск, своя картинка", async () => {
  const s = api().studio;
  s.setTool("mark", { toggle: false });
  s.editTypeInSettings("object", "new");
  await tick();
  const left = win("settings");
  assert(left.querySelectorAll('[data-action="pickIcon"]').length >= 10, "нет значков библиотеки");
  left.querySelector('[data-action="iconCat"][data-cat="resources"]').click();
  await tick();
  const ore = win("settings").querySelector('[data-icon$="/ore.svg"]');
  assert(ore, "нет руды в разделе ресурсов");
  ore.click();
  await tick();
  assert(s.typeForm.icon.endsWith("/ore.svg") && s.typeForm.tint, "значок не выбран");
  const search = win("settings").querySelector('[data-model="typeForm.iconQuery"]');
  search.value = "храм";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  assert(win("settings").querySelector('[data-icon$="/greek-temple.svg"]'), "поиск не нашёл храм");
  assert(win("settings").querySelector('[data-action="browseIcon"]'), "нет кнопки своей картинки");
  s.closeSettings();
  await tick();
  assert(!win("settings"), "настройки не закрылись");
});

await check("0.5.0: крестик закрывает окно, но инструмент и слой остаются; повторный выбор открывает окно", async () => {
  const ui2 = (await import("../../scripts/canvas/hex-layer.mjs")).runtime.ui;
  api().studio.setTool("zone", { toggle: false });
  await tick();
  await ui2.host.windows.left.close();
  assert(api().studio.tool === "zone", "инструмент выключился, Foundry ушёл бы к токенам");
  await tick();
  assert(!win("left"), "окно снова открылось само");
  api().studio.setTool("zone", { toggle: false });
  await tick();
  assert(win("left"), "повторный выбор инструмента не открыл окно");
  api().studio.setTool(null, { toggle: false });
  await tick();
});

await check("0.6.1: инструмент погас при активной группе — щелчок по соседнему гексу всё равно осматривает", async () => {
  const s = api().studio;
  layer.activate();
  ui.controls.control = { name: LAYER };
  ui.controls.tool = { name: "select" };
  s.setTool("select", { toggle: false });
  press(hexAt([5, 5]));
  assert(s.inspected?.join() === "5,5", "первый гекс не осмотрен");
  // Так выглядело зависание: инструмент студии null, а в колонке Foundry выбран «Осмотр».
  s.layerDeactivated();
  assert(!s.inspected && !s.hudOpen, "рамка осмотра осталась висеть без инструмента");
  press(hexAt([6, 5]));
  assert(s.tool === "select", `инструмент не вернулся: ${s.tool}`);
  assert(s.inspected?.join() === "6,5", `соседний гекс не осмотрен: ${s.inspected}`);
  press(hexAt([5, 6]));
  assert(s.inspected?.join() === "5,6", "следующий гекс не осмотрен");
  s.closeHud();
});

await check("showFeature открывает гекс", async () => {
  const zone = api().getAtlas(scene).pages.contents.find(p => p.system.kind === "area");
  api().showFeature(zone.id);
  const s = api().studio;
  assert(s.rightOpen && s.inspected, "карточка не открыта");
  assert(canvas.panned, "камера не сдвинута");
  await tick();
  assert(win("right"), "окно гекса не открылось");
});

await check("скрытый слой сохраняется в настройке клиента", async () => {
  await api().backend.toggleLayer("terrain");
  assert(game.settings.get("artarius", "hiddenLayers").includes("terrain"), "слой не скрыт");
  await api().backend.toggleLayer("terrain");
});

await check("игрок: правка уходит в черновик, заявка в флаги", async () => {
  game.user = p1;
  const s = api().studio;
  s.setTool("zone", { toggle: false });
  s.clearSelection();
  press(hexAt([7, 7]));
  s.zone.target = "new";
  s.zone.typeId = "realm";
  await s.attach();
  await F.settle();
  assert(api().getAtlas(scene).pages.size === 3, "игрок записал прямо в атлас");
  const drafts = p1.getFlag("artarius", `drafts.${scene.id}`);
  assert(drafts?.length === 1, `черновик ${JSON.stringify(drafts)}`);
  s.claimForm.title = "Огонь берёт долину";
  await s.submit();
  await F.settle();
  const claims = p1.getFlag("artarius", "claims");
  assert(claims?.length === 1 && claims[0].status === "pending", "заявка не подана");
  const notice = F.created.messages.at(-1);
  assert(notice?.flags?.artarius?.claimNotice, "нет сообщения о заявке");
  assert(JSON.stringify(notice.whisper) === JSON.stringify([gm.id]), `заявка ушла не мастеру: ${JSON.stringify(notice.whisper)}`);
  assert(notice.content.includes("Огонь берёт долину"), "в сообщении нет названия заявки");
  game.user = gm;
});

await check("мастер принимает заявку", async () => {
  const s = api().studio;
  const id = p1.getFlag("artarius", "claims")[0].id;
  await s.applyClaims([id]);
  await F.settle();
  assert(api().getAtlas(scene).pages.size === 4, "заявка не применена");
  assert(p1.getFlag("artarius", "claims")[0].status === "applied", "статус не applied");
  const msg = F.created.messages.at(-1);
  assert(msg && !msg.whisper?.length && msg.content.includes("Огонь берёт долину"), "принятая заявка не попала в чат");
  // Прямые правки мастера уходят одним сообщением.
  const chat = await import("../../scripts/review/chat.mjs");
  const n = F.created.messages.length;
  s.setTool("mark", { toggle: false });
  press(hexAt([3, 8]));
  await F.settle();
  await chat.flushDirect();
  assert(F.created.messages.length === n + 1, `сообщений о правках ${F.created.messages.length - n}`);
  s.setTool("select", { toggle: false });
});

await check("настройки сцены: галочка режима", async () => {
  const root = document.createElement("form");
  root.innerHTML = '<div class="tab" data-tab="grid"></div>';
  Hooks.callAll("renderSceneConfig", { document: scene, setPosition() {} }, root);
  assert(root.querySelector('input[name="flags.artarius.world.enabled"]')?.checked, "нет галочки или не отмечена");
});

await check("кнопка «Мир Артария» и создание сцены", async () => {
  const root = document.createElement("section");
  root.innerHTML = '<header class="directory-header"><div class="header-actions"></div></header>';
  Hooks.callAll("renderSceneDirectory", {}, root);
  assert(root.querySelector(".artarius-new-world"), "нет кнопки");
  const sc = await api().createWorldScene({ name: "Т", cols: 20, rows: 12, size: 100 });
  assert(sc?._source.grid.type === CONST.GRID_TYPES.HEXODDR, "не та сетка");
  assert(sc.getFlag("artarius", "world").enabled === true, "режим не включён");
  assert(sc.viewed, "сцена не открыта");
});

await check("смена режима сцены перерисовывает холст", async () => {
  await scene.update({ "flags.artarius.world.baseColor": "#112233" });
  assert(canvas.redrawn >= 1, "canvas.draw не вызван");
});

await check("обычная сцена: панели спрятаны, группа скрыта", async () => {
  const plain = new F.Scene({ _id: "sc2", name: "Таверна" });
  canvas.scene = plain;
  Hooks.callAll("canvasReady", canvas);
  await F.settle();
  await tick();
  assert(!document.querySelector(".artarius-part"), "окна открыты на обычной сцене");
  const c = CONFIG.Canvas.layers[LAYER].layerClass.prepareSceneControls();
  assert(c.visible === false, "группа видна на обычной сцене");
  const l2 = new CONFIG.Canvas.layers[LAYER].layerClass();
  await l2.draw();
  assert(!l2.renderer, "renderer создан на обычной сцене");
  canvas.scene = scene;
});

await check("старые области 0.2 переходят на гексы", async () => {
  const old = new F.Journal({ _id: "old", name: "Атлас старый", flags: { artarius: { sceneId: "sc3", version: 2, types: [], layers: [] } },
    pages: [{ _id: "a1", name: "Край", type: "artarius.feature", system: { kind: "area", typeId: "region", geometry: {
      cells: [], shapes: [[[0, 0], [400, 0], [400, 300], [0, 300]]], grid: { type: 1, size: 100 } } } }] });
  game.journal.set(old.id, old);
  const sc3 = new F.Scene({ _id: "sc3", name: "Старая", flags: { artarius: { atlas: "old", world: { enabled: true } } } });
  canvas.scene = sc3;
  Hooks.callAll("canvasReady", canvas);
  await F.settle();
  const cells = old.pages.get("a1").system.geometry.cells;
  assert(cells.length > 0, "гексы не появились");
  assert(old.getFlag("artarius", "version") === 4, "атлас не обновлён");
  assert(old.getFlag("artarius", "layers").some(l => l.id === "phenomena"), "нет слоя явлений");
  canvas.scene = scene;
});

await check("импорт Azgaar ложится на гексы", async () => {
  Hooks.callAll("canvasReady", canvas);
  await F.settle();
  const cells = [];
  for ( let y = 0; y < 4; y++ ) for ( let x = 0; x < 6; x++ ) cells.push({ i: (y * 6) + x, v: [], p: [(x * 10) + 5, (y * 10) + 5], h: x ? 30 : 10, biome: x ? 6 : 0, state: x < 3 ? 1 : 2 });
  const data = { info: { width: 60, height: 40, mapId: 1 }, pack: { cells, vertices: [], states: [{ i: 0 }, { i: 1, name: "А" }, { i: 2, name: "Б" }], burgs: [], rivers: [], routes: [] } };
  const r = await api().importAzgaar(data, scene, {});
  assert(r.stats.terrain === 2 && r.stats.states === 2, JSON.stringify(r.stats));
});

await check("генератор: местность, ресурсы, державы игроков", async () => {
  Hooks.callAll("canvasReady", canvas);
  await F.settle();
  const r = await api().generateTestWorld({ seed: "smoke", realmCount: 2, clear: true, water: 0.3, resources: 0.2, rough: true });
  const pages = api().getAtlas(scene).pages.contents;
  assert(r.stats.terrain >= 3 && r.stats.realms === 2 && r.stats.resources > 0, JSON.stringify(r.stats));
  assert(pages.length === r.features.length, "старые элементы не удалены");
  const types = api().getAtlas(scene).getFlag("artarius", "types").map(t => t.id);
  assert(types.includes("res-iron") && types.includes("forest"), "типы ресурсов не добавлены");
  const realm = pages.find(p => p.system.typeId === "realm");
  assert(realm.name.includes("Огонь"), `держава ${realm.name}`);
});

await check("0.9.0: вид «Атлас» по умолчанию, переключатель возвращает простой вид", async () => {
  const rd = layer.renderer;
  assert(rd.atlas === true, "атлас не включён по умолчанию");
  const zonesAtlas = rd.zones.children.length;
  await scene.update({ "flags.artarius.world": { ...scene.getFlag("artarius", "world"), style: "flat" } });
  await F.settle();
  layer.refresh?.(true);
  await F.settle();
  assert(layer.renderer.atlas === false, "простой вид не включился");
  assert(layer.renderer.zones.children.length !== zonesAtlas, "зоны нарисованы так же");
  await scene.update({ "flags.artarius.world": { ...scene.getFlag("artarius", "world"), style: "atlas" } });
  await F.settle();
  layer.refresh?.(true);
  await F.settle();
  assert(layer.renderer.atlas === true, "атлас не вернулся");
});

await check("0.5.0: превью сцены — снимок слоя, а не чёрный квадрат", async () => {
  canvas.app.renderer ??= new PIXI.Renderer({ width: 16, height: 16, backgroundAlpha: 0 });
  await F.settle();
  const ok = await api().backend.updateThumb();
  assert(ok, "снимок не сделан");
  assert(String(scene.thumb ?? "").startsWith("data:image/"), `превью: ${String(scene.thumb).slice(0, 30)}`);
  assert(String(scene.thumb).length > 2000, "превью почти пустое");
  window.__thumb = scene.thumb;
});

// ?shot: показать холст слоя, чтобы снять картинку сгенерированного мира.
if ( location.search.includes("shot") ) {
  const app = new PIXI.Application({ width: 1400, height: 900, background: "#111111", antialias: true });
  document.body.appendChild(app.view);
  app.view.style.cssText = "position:fixed;left:0;top:0;z-index:0";
  const k = Math.min(1400 / grid.rect.width, 900 / grid.rect.height);
  layer.scale.set(k);
  const realm = api().studio.types.find(t => t.id === "realm");
  if ( realm ) await api().backend.saveType({ ...realm, style: { ...realm.style, pattern: "hatch" } });
  await F.settle();
  app.stage.addChild(layer);
  // ?shot=layers-<id>,<id>: показать слои климата и украшения (0.6).
  const m = location.search.match(/shot=layers-([^&]+)/);
  if ( m ) {
    for ( const id of m[1].split(",") ) await api().backend.toggleLayer(`@${id}`);
    await F.settle();
  }
  layer.refresh(true);
  if ( location.search.includes("shot=civ") ) {
    // Метки как в Civ 5 и панель на гексе: настоящие значки, камера совпадает с холстом.
    foundry.canvas.loadTexture = src => PIXI.Assets.load(src);
    canvas.stage.scale.set(k);
    canvas.stage.position.set(0, 0);
    canvas.stage.transform.updateTransform(PIXI.Transform.IDENTITY);
    const s = api().studio;
    const put = async (cell, typeIds) => {
      for ( const typeId of typeIds ) {
        s.mark.typeId = typeId;
        s.inspected = cell;
        await s.markHere();
      }
    };
    const objTypes = s.typesOf("object").map(t => t.id);
    await put([4, 4], objTypes.slice(0, 2));
    await put([6, 3], objTypes.slice(0, 3));
    await put([8, 5], objTypes.slice(0, 4));
    await put([10, 4], objTypes.slice(0, 6));
    await F.settle();
    layer.refresh(true);
    s.setTool("select", { toggle: false });
    s.inspect([6, 3]);
    if ( location.search.includes("shot=civ-multi") ) {
      // Несколько гексов в осмотре: заливка, общая граница, короткая плашка.
      for ( const c of [[7, 3], [6, 4], [7, 4]] ) s.inspectToggle(c);
    }
    if ( location.search.includes("shot=civ-drag") ) {
      // Метку тащат: под курсором она сама, со значком, а не пустой кружок.
      const slot = s.markSlots().slots.find(x => x.cell[0] === 8 && x.cell[1] === 5);
      const to = s.grid.center([9, 6]);
      s.markDrag = { id: slot.id, from: slot.cell, at: { x: to.x + 10, y: to.y - 6 }, start: slot, moved: true };
      s.changed("overlay");
    }
    await new Promise(r => setTimeout(r, 1500));
  } else {
    // Окно метки с открытым выбором значка поверх карты.
    api().studio.setTool("mark", { toggle: false });
    api().studio.openTypeForm("object");
    api().studio.typeForm.color = "#f0c96a";
    api().studio.changed("ui");
    await new Promise(r => setTimeout(r, 1500));
  }
}

window.__done = true;
