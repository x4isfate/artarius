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

await check("init: слой, модель, настройки, API", async () => {
  Hooks.callAll("init");
  await F.settle();
  assert(CONFIG.Canvas.layers[LAYER]?.layerClass, "слой не зарегистрирован");
  assert(CONFIG.JournalEntryPage.dataModels["artarius.feature"], "модель страницы не зарегистрирована");
  assert(api()?.version === 2, "нет API 2");
  for ( const k of ["turn", "hiddenLayers", "autoApplyOnSuccess", "trustedUsers", "guideSeen", "checkUpdates", "notifiedVersion"] ) game.settings.get("artarius", k);
});

await check("ready: панели в DOM", async () => {
  Hooks.callAll("ready");
  await F.settle();
  assert(document.getElementById("artarius-ui"), "нет #artarius-ui");
});

let layer;
await check("canvasReady: атлас создан, панели видны", async () => {
  layer = new CONFIG.Canvas.layers[LAYER].layerClass();
  canvas[LAYER] = layer;
  Hooks.callAll("canvasReady", canvas);
  await F.settle();
  const atlas = api().getAtlas(scene);
  assert(atlas, "атлас не создан");
  assert(atlas.getFlag("artarius", "version") === 3, "версия атласа не 3");
  assert(!document.getElementById("artarius-ui").hidden, "панели спрятаны на сцене Артария");
  const left = getComputedStyle(document.getElementById("artarius-ui")).getPropertyValue("--art-left");
  assert(left.trim() === "76px", `отступ от левой колонки ${left}`);
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
  assert(Object.keys(c.tools).join() === "select,zone,mark,line", "не те инструменты");
  c.onToolChange(new Event("x"), c.tools.mark, true);
  assert(api().studio.tool === "mark", "инструмент из панели не выбран");
});

await check("мастер: зона из двух гексов пишется в атлас", async () => {
  const s = api().studio;
  s.setTool("zone", { toggle: false });
  assert(F.controlCalls.at(-1)?.control === LAYER, "слой не включён через ui.controls");
  layer.activate();
  const a = grid.hm.center([2, 3]), b = grid.hm.center([2, 4]);
  layer._onClickLeft({ interactionData: { origin: a } });
  layer._onClickLeft({ interactionData: { origin: b } });
  await F.settle();
  assert(s.selection.size === 2, `выбрано ${s.selection.size}`);
  s.zone.typeId = "forest";
  document.querySelector('#artarius-ui [data-action="attach"]').click();
  await F.settle();
  const pages = api().getAtlas(scene).pages.contents;
  assert(pages.length === 1, `страниц ${pages.length}`);
  assert(pages[0].system.geometry.cells.length === 2, "гексов в зоне не 2");
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
});

await check("мастер: метка и линия", async () => {
  const s = api().studio;
  s.setTool("mark", { toggle: false });
  layer._onClickLeft({ interactionData: { origin: grid.hm.center([5, 5]) } });
  await F.settle();
  document.querySelector('#artarius-ui [data-action="placeMarks"]').click();
  await F.settle();
  s.setTool("line", { toggle: false });
  layer._onClickLeft({ interactionData: { origin: { x: 50, y: 50 } } });
  layer._onClickLeft({ interactionData: { origin: { x: 400, y: 300 } } });
  layer._onClickLeft2({});
  await F.settle();
  const kinds = api().getAtlas(scene).pages.contents.map(p => p.system.kind).sort();
  assert(kinds.join() === "area,line,object", `элементы ${kinds}`);
});

await check("Осмотр и showFeature открывают гекс", async () => {
  const zone = api().getAtlas(scene).pages.contents.find(p => p.system.kind === "area");
  api().showFeature(zone.id);
  const s = api().studio;
  assert(s.rightOpen && s.inspected, "карточка не открыта");
  assert(canvas.panned, "камера не сдвинута");
  assert(document.querySelector("#artarius-ui .art-right:not([hidden])"), "правая панель скрыта");
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
  layer._onClickLeft({ interactionData: { origin: grid.hm.center([7, 7]) } });
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
  game.user = gm;
});

await check("мастер принимает заявку", async () => {
  const s = api().studio;
  const id = p1.getFlag("artarius", "claims")[0].id;
  await s.applyClaims([id]);
  await F.settle();
  assert(api().getAtlas(scene).pages.size === 4, "заявка не применена");
  assert(p1.getFlag("artarius", "claims")[0].status === "applied", "статус не applied");
});

await check("ходы: порядок, передача, сообщение в чат", async () => {
  const s = api().studio;
  await s.toggleTurns();
  await F.settle();
  const t = game.settings.get("artarius", "turn");
  assert(t.enabled, "ходы не включены");
  if ( !t.order.length ) await api().backend.setTurn({ ...t, order: ["p1", "p2"] });
  await s.passTurn();
  await F.settle();
  assert(F.created.messages.length >= 1, "нет сообщения о ходе");
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
  assert(document.getElementById("artarius-ui").hidden, "панели видны на обычной сцене");
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
  assert(old.getFlag("artarius", "version") === 3, "атлас не обновлён");
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

window.__done = true;
