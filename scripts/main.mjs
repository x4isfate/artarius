import { MODULE_ID, FEATURE_TYPE, CLAIM_STATUS, WORLD_DEFAULTS } from "./constants.mjs";
import FeatureModel from "./data/feature-model.mjs";
import * as store from "./data/store.mjs";
import { getAtlas, ensureAtlas, upgradeAtlas, getClaims } from "./data/store.mjs";
import HexLayer, { LAYER_NAME, runtime, inputDebug, boardElement } from "./canvas/hex-layer.mjs";
import FoundryBackend, { isWorldScene, worldOf } from "./foundry-backend.mjs";
import Studio from "./studio.mjs";
import ArtariusUI, { EXTRA_ACTIONS } from "./ui/panels.mjs";
import FoundryHost from "./ui/windows.mjs";
import { openGenerator, generateTestWorld } from "./apps/generator.mjs";
import { resizeWorld, sceneDims } from "./apps/world-size.mjs";
import { normalizeDims, sceneSizeFor } from "./hex/dims.mjs";
import FeaturePageSheet from "./sheets/feature-page-sheet.mjs";
import GuideApp from "./apps/guide-app.mjs";
import AzgaarApp, { AzgaarGenerator, importAzgaar, importAzgaarText } from "./apps/azgaar-app.mjs";
import { checkForUpdate } from "./update-check.mjs";
import { SOCKET, onSocket, onCheckMessage, onCheckUpdated, autoApplyTrusted, rollForClaim } from "./review/claims.mjs";
import { markCell, cellsInShapes, cellKey } from "./data/world.mjs";
import { esc } from "./ui/dom.mjs";

const L = k => game.i18n.localize(k);

/* ------------------------------------------------------------------ */
/*  Подключение                                                        */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  CONFIG.JournalEntryPage.dataModels[FEATURE_TYPE] = FeatureModel;
  CONFIG.Canvas.layers[LAYER_NAME] = { layerClass: HexLayer, group: "interface" };

  try {
    foundry.applications.apps.DocumentSheetConfig.registerSheet(JournalEntryPage, MODULE_ID, FeaturePageSheet, {
      types: [FEATURE_TYPE], makeDefault: true, label: "VMAP.Sheet.page"
    });
  } catch(err) {
    console.warn(`${MODULE_ID} | page sheet`, err);
  }

  const S = (key, data) => game.settings.register(MODULE_ID, key, data);
  S("autoApplyOnSuccess", {
    name: "VMAP.Settings.autoApplyOnSuccess.name", hint: "VMAP.Settings.autoApplyOnSuccess.hint",
    scope: "world", config: true, type: Boolean, default: true, onChange: () => runtime.backend?.emit()
  });
  S("trustedUsers", { scope: "world", config: false, type: Array, default: [] });
  S("guideSeen", { scope: "client", config: false, type: Boolean, default: false });
  S("checkUpdates", {
    name: "VMAP.Settings.checkUpdates.name", hint: "VMAP.Settings.checkUpdates.hint",
    scope: "world", config: true, type: Boolean, default: true
  });
  S("notifiedVersion", { scope: "world", config: false, type: String, default: "" });
  S("hiddenLayers", { scope: "client", config: false, type: Array, default: [], onChange: () => runtime.backend?.emit() });
  S("layerPresets", { scope: "client", config: false, type: Array, default: [], onChange: () => runtime.backend?.emit() });
  S("windows", { scope: "client", config: false, type: Object, default: {} });

  const backend = new FoundryBackend();
  const studio = new Studio(backend);
  runtime.backend = backend;
  runtime.studio = studio;
  runtime.isWorld = () => isWorldScene();
  // Кнопки в колонке инструментов (группа Артария слева).
  runtime.buttons = {
    queue: () => studio.openQueue(),
    layers: () => runtime.ui?.toggleLayerPanel(),
    settings: () => (studio.settings.open ? studio.closeSettings() : studio.openSettings()),
    generator: () => openGenerator(),
    guide: () => GuideApp.open()
  };
  runtime.extraButtons = () => [...EXTRA_ACTIONS.values()];

  game.modules.get(MODULE_ID).api = {
    /** Версия API. Растёт при несовместимых изменениях. 2 — гекс-мир (0.3). */
    version: 2,
    backend, studio, store,
    isWorldScene, worldOf,
    openGuide: () => GuideApp.open(),
    openAzgaar: () => AzgaarApp.open(),
    openAzgaarGenerator: () => AzgaarGenerator.open(),
    /** Окно генератора тестового мира. generateTestWorld(options) — то же без окна. */
    openGenerator: () => openGenerator(),
    /** Отладка мыши: api.debugInput(true) пишет каждое нажатие на холсте в консоль. */
    debugInput: (on = true) => { inputDebug.on = !!on; inputDebug.warned = false; return inputDebug.on; },
    generateTestWorld: options => generateTestWorld(options),
    openWorldSettings: () => openWorldSettings(),
    applyWorldSettings: values => applyWorldSettings(values),
    worldInfo: () => worldInfo(),
    importAzgaarText: (text, fileName, options) => importAzgaarText(text, fileName, options),
    /** Перестроить поле: resizeWorld({ cols, rows, size }). Элементы переносятся на новое поле. */
    resizeWorld: (dims, scene = canvas.scene) => resizeWorld(scene, dims),
    /** Размер поля текущей сцены: { cols, rows, size }. */
    sceneDims: (scene = canvas.scene) => sceneDims(scene),
    createWorldScene: options => createWorldScene(options),
    importAzgaar,
    getAtlas, ensureAtlas,
    /** Выбрать инструмент: "select" | "zone" | "mark" | "line" | null. */
    setTool: tool => studio.setTool(tool, { toggle: false }),
    /** Открыть гекс [i, j] в карточке. */
    inspect: cell => studio.inspect(cell),
    /** Найти элемент по id: открыть его гекс, раскрыть карточку и навести камеру. */
    showFeature: id => showFeature(id),
    /**
     * Своя кнопка в группе Артария слева: { id, label, icon, onClick, gmOnly?, visible? }.
     * icon — имя Font Awesome ("cloud-sun") или классы ("fa-solid fa-cloud-sun"). Можно и (id, { … }).
     */
    registerQuickAction: (idOrDef, action = {}) => {
      const def = typeof idOrDef === "object" ? idOrDef : { ...action, id: idOrDef };
      if ( !def?.id ) throw new Error("artarius | registerQuickAction: нужен id");
      if ( typeof def.label === "string" && game.i18n?.has?.(def.label) ) def.label = game.i18n.localize(def.label);
      EXTRA_ACTIONS.set(def.id, def);
      studio.changed("ui");
      try { ui.controls?.render({ reset: true }); } catch { /* панель ещё не готова */ }
    },
    unregisterQuickAction: id => { EXTRA_ACTIONS.delete(id); studio.changed("ui"); },
    refresh: () => backend.emit(),
    layer: () => canvas[LAYER_NAME]
  };
  Hooks.callAll("artarius.init", game.modules.get(MODULE_ID).api);
});

Hooks.once("ready", () => {
  const { backend, studio } = runtime;
  game.socket.on(SOCKET, onSocket);
  rememberClaimStatuses();
  const host = new FoundryHost({ onClose: name => runtime.ui?.windowClosed(name) });
  runtime.ui = new ArtariusUI(studio, backend, { host, project: screenPoint });
  syncUI();
  if ( !game.settings.get(MODULE_ID, "guideSeen") && isWorldScene() ) {
    GuideApp.open();
    game.settings.set(MODULE_ID, "guideSeen", true);
  }
  checkForUpdate();
  Hooks.callAll("artarius.ready", game.modules.get(MODULE_ID).api);
});

/** Точка сцены → пиксели окна браузера (для панели на гексе). */
function screenPoint(pt) {
  const el = boardElement();
  const r = el.getBoundingClientRect();
  const p = canvas.stage.worldTransform.apply(new PIXI.Point(pt.x, pt.y));
  return { x: r.left + p.x, y: r.top + p.y };
}

/** Показать или спрятать окна: они живут только на сцене Артария. */
function syncUI() {
  const ui2 = runtime.ui;
  if ( !ui2 ) return;
  ui2.hidden = !(canvas?.ready && isWorldScene());
}

Hooks.on("canvasReady", async () => {
  const { backend, studio } = runtime;
  if ( !backend ) return;
  backend.grid.reset();
  studio.tool = null;
  studio.selection.clear();
  studio.inspected = null;
  studio.openId = null;
  studio.rightOpen = false;
  studio.hudOpen = false;
  studio.markDrag = null;
  studio.line.points = [];
  studio.markSel?.clear();
  studio.box = null;
  studio.hudMenu = null;
  studio.clearHistory?.();
  syncUI();
  if ( isWorldScene() && game.user.isGM ) {
    const atlas = getAtlas(canvas.scene) ?? await ensureAtlas(canvas.scene);
    if ( await upgradeAtlas(atlas) ) await migrateAreas(atlas);
    // Превью в списке сцен: снимаем один раз, если его ещё нет. Дальше его обновляют импорт, генератор и кнопка.
    if ( !canvas.scene.thumb ) scheduleThumb(1500);
  }
  // Группа «Артарий» слева видна только на сцене Артария.
  try { ui.controls?.render({ reset: true }); } catch { /* панель ещё не готова */ }
  backend.emit();
});


// Окно инструмента закрыли крестиком, а потом снова нажали тот же инструмент в колонке Foundry.
// Foundry повторный щелчок по активному инструменту не сообщает, поэтому слушаем кнопку сами.
Hooks.on("renderSceneControls", (app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if ( !root || root.dataset.artBound ) return;
  root.dataset.artBound = "1";
  root.addEventListener("click", ev => {
    const btn = ev.target.closest?.("[data-tool]");
    if ( !btn || ui.controls?.control?.name !== LAYER_NAME || !runtime.ui?.leftClosed ) return;
    if ( btn.dataset.tool !== runtime.ui.leftClosed.tool ) return;
    runtime.ui.leftClosed = null;
    runtime.studio?.changed("ui");
  });
});

let thumbTimer = null;
/** Снять превью сцены чуть позже: холст должен успеть перерисоваться. */
function scheduleThumb(delay = 1200) {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => runtime.backend?.updateThumb(), delay);
}
Hooks.on("artarius.importAzgaar", () => scheduleThumb());
Hooks.on("artarius.generate", () => scheduleThumb());

/**
 * Области 0.2 → зоны на гексах. Свободный контур переходит в гексы под ним.
 * Клетки, нарисованные на другой сетке, пересчитываются по их центрам.
 */
async function migrateAreas(atlas) {
  const grid = runtime.backend.grid;
  const all = grid.allCells();
  const T = CONST.GRID_TYPES;
  const updates = [];
  for ( const page of atlas.pages ) {
    if ( page.type !== FEATURE_TYPE || page.system.kind !== "area" ) continue;
    try {
      const g = page._source.system?.geometry ?? {};
      const old = g.grid;
      let cells = (g.cells ?? []).map(c => [Number(c[0]), Number(c[1])]);
      const sameGrid = !old || (old.type === canvas.grid.type && old.size === canvas.grid.size);
      if ( !sameGrid && cells.length ) {
        const cfg = { size: old.size, columns: [T.HEXODDQ, T.HEXEVENQ].includes(old.type), even: [T.HEXEVENR, T.HEXEVENQ].includes(old.type) };
        const G = old.type === T.SQUARE ? foundry.grid.SquareGrid : foundry.grid.HexagonalGrid;
        const was = new G(cfg);
        cells = cells.map(([i, j]) => grid.cellAt(was.getCenterPoint({ i, j })));
      }
      cells.push(...cellsInShapes(g.shapes, all, grid.center));
      const seen = new Set();
      cells = cells.filter(c => grid.inBounds(c) && !seen.has(cellKey(c)) && seen.add(cellKey(c)));
      if ( sameGrid && !(g.shapes?.length) ) continue;
      updates.push({ _id: page.id, "system.geometry": { cells, shapes: [], grid: { type: canvas.grid.type, size: canvas.grid.size } } });
    } catch(err) {
      console.warn(`${MODULE_ID} | migrate area ${page.id}`, err);
    }
  }
  if ( updates.length ) await atlas.updateEmbeddedDocuments("JournalEntryPage", updates);
}

/* ------------------------------------------------------------------ */
/*  Ошибки модуля не должны пропадать молча                            */
/* ------------------------------------------------------------------ */

function reportError(err) {
  const stack = String(err?.stack ?? "");
  if ( !stack.includes(`modules/${MODULE_ID}/`) ) return;
  console.error(`${MODULE_ID} |`, err);
  ui.notifications?.error(game.i18n.format("VMAP.Notify.error", { message: err?.message ?? String(err) }), { permanent: true });
}
window.addEventListener("error", ev => reportError(ev.error));
window.addEventListener("unhandledrejection", ev => reportError(ev.reason));

/* ------------------------------------------------------------------ */
/*  Данные поменялись: перерисовать                                    */
/* ------------------------------------------------------------------ */

const emit = () => runtime.backend?.emit();
const isCurrentAtlas = journal => !!journal && journal === getAtlas(canvas?.scene);

for ( const hook of ["createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage"] ) {
  Hooks.on(hook, page => { if ( page.type === FEATURE_TYPE ) emit(); });
}
Hooks.on("updateJournalEntry", journal => { if ( isCurrentAtlas(journal) ) emit(); });
Hooks.on("createJournalEntry", () => emit());
Hooks.on("updateActor", () => emit());

Hooks.on("updateScene", (scene, changes) => {
  if ( scene !== canvas?.scene ) return;
  const worldChanged = foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.world`);
  const gridChanged = "grid" in changes || "width" in changes || "height" in changes || "padding" in changes;
  if ( worldChanged || gridChanged ) {
    // Режим сцены или сетка поменялись: холст перерисует Foundry, если поменялась сетка; иначе сами.
    if ( !gridChanged ) canvas.draw();
  } else if ( foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`) ) emit();
});

Hooks.on("updateUser", (user, changes) => {
  if ( !foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`) ) return;
  emit();
  if ( user.isSelf ) announceDecisions(user);
  if ( game.user.isGM ) autoApplyTrusted(user);
});

/* ------------------------------------------------------------------ */
/*  Решения по заявкам: сообщить игроку                                */
/* ------------------------------------------------------------------ */

let knownStatuses = new Map();

function rememberClaimStatuses() {
  knownStatuses = new Map(getClaims(game.user).map(c => [c.id, c.status]));
}

function announceDecisions(user) {
  if ( user.isGM ) return rememberClaimStatuses();
  for ( const claim of getClaims(user) ) {
    const before = knownStatuses.get(claim.id);
    if ( !before || before === claim.status ) continue;
    const key = {
      [CLAIM_STATUS.applied]: "VMAP.Claims.youApplied",
      [CLAIM_STATUS.rejected]: "VMAP.Claims.youRejected",
      [CLAIM_STATUS.check]: "VMAP.Claims.youCheck"
    }[claim.status];
    if ( key ) ui.notifications.info(game.i18n.format(key, { title: claim.title }));
  }
  rememberClaimStatuses();
}

/* ------------------------------------------------------------------ */
/*  Чат: карточка проверки по заявке                                   */
/* ------------------------------------------------------------------ */

Hooks.on("renderChatMessageHTML", (message, html) => {
  const flag = message.getFlag(MODULE_ID, "claimCheck");
  if ( !flag ) return;
  const btn = html.querySelector("[data-vmap-claim-roll]");
  if ( !btn ) return;
  const claim = getClaims(game.users.get(flag.userId)).find(c => c.id === flag.claimId);
  const canRoll = (flag.userId === game.user.id || game.user.isGM) && claim?.status === CLAIM_STATUS.check
    && claim?.messageId === message.id;
  if ( !canRoll ) {
    btn.disabled = true;
    if ( claim && claim.status !== CLAIM_STATUS.check ) btn.textContent = L(`VMAP.ClaimStatus.${claim.status}`);
    return;
  }
  btn.addEventListener("click", ev => {
    ev.preventDefault();
    rollForClaim(message);
  });
});

Hooks.on("createChatMessage", message => onCheckMessage(message));
Hooks.on("updateChatMessage", (message, changes) => onCheckUpdated(message, changes));

/* ------------------------------------------------------------------ */
/*  Сцена Артария: переключатель в настройках сцены                    */
/* ------------------------------------------------------------------ */

Hooks.on("renderSceneConfig", (app, html) => {
  try {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if ( !root || root.querySelector(".artarius-scene-toggle") ) return;
    const scene = app.document;
    const world = worldOf(scene);
    const tab = root.querySelector('.tab[data-tab="grid"]') ?? root.querySelector('.tab[data-tab="basics"]') ?? root.querySelector("form, .window-content");
    if ( !tab ) return;
    const box = document.createElement("fieldset");
    box.className = "artarius-scene-toggle";
    box.innerHTML = `<legend>Artarius</legend>
      <div class="form-group">
        <label>${esc(L("ART.Scene.enabled"))}</label>
        <div class="form-fields"><input type="checkbox" name="flags.${MODULE_ID}.world.enabled" ${world.enabled ? "checked" : ""}></div>
        <p class="hint">${esc(L("ART.Scene.enabledHint"))}</p>
      </div>
      <div class="form-group">
        <label>${esc(L("ART.Scene.baseColor"))}</label>
        <div class="form-fields"><input type="color" name="flags.${MODULE_ID}.world.baseColor" value="${esc(world.baseColor)}"></div>
      </div>`;
    tab.appendChild(box);
    app.setPosition?.({ height: "auto" });
  } catch(err) {
    console.warn(`${MODULE_ID} | scene config`, err);
  }
});

/* Кнопка «Мир Артарии» в списке сцен ------------------------------- */

Hooks.on("renderSceneDirectory", (app, html) => {
  if ( !game.user.isGM ) return;
  try {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if ( !root || root.querySelector(".artarius-new-world") ) return;
    const bar = root.querySelector(".header-actions") ?? root.querySelector(".directory-header");
    if ( !bar ) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "artarius-new-world";
    btn.innerHTML = `<i class="fa-solid fa-dice-d6"></i> ${esc(L("ART.Scene.create"))}`;
    btn.addEventListener("click", ev => {
      ev.preventDefault();
      createWorldScene();
    });
    bar.appendChild(btn);
  } catch(err) {
    console.warn(`${MODULE_ID} | scene directory`, err);
  }
});

/** Новая сцена Артария: гекс-сетка нужного размера и включённый режим. */
async function createWorldScene(options = null) {
  if ( !game.user.isGM ) return;
  let o = options;
  if ( !o ) {
    o = await foundry.applications.api.DialogV2.prompt({
      window: { title: L("ART.Scene.create") },
      content: `<div class="form-group"><label>${esc(L("ART.Scene.name"))}</label><input type="text" name="name" value="${esc(L("ART.Scene.defaultName"))}"></div>
        <div class="form-group"><label>${esc(L("ART.Scene.cols"))}</label><input type="number" name="cols" value="40" min="5" max="300"></div>
        <div class="form-group"><label>${esc(L("ART.Scene.rows"))}</label><input type="number" name="rows" value="28" min="5" max="300"></div>
        <div class="form-group"><label>${esc(L("ART.Scene.size"))}</label><input type="number" name="size" value="100" min="30" max="400"></div>
        <p class="hint">${esc(L("ART.Scene.createHint"))}</p>`,
      ok: {
        label: L("ART.Scene.createOk"),
        callback: (ev, button) => {
          const f = button.form.elements;
          return { name: f.name.value, cols: Number(f.cols.value), rows: Number(f.rows.value), size: Number(f.size.value) };
        }
      },
      rejectClose: false
    });
    if ( !o ) return;
  }
  const dims = normalizeDims(o);
  const scene = await Scene.implementation.create({
    name: o.name || L("ART.Scene.defaultName"),
    ...sceneSizeFor(dims),
    padding: 0.05,
    grid: { type: CONST.GRID_TYPES.HEXODDR, size: dims.size, color: "#000000", alpha: 0.15 },
    tokenVision: false,
    fog: { exploration: false },
    flags: { [MODULE_ID]: { world: { ...WORLD_DEFAULTS, enabled: true } } }
  });
  await scene?.view();
  return scene;
}

/**
 * Настройки мира текущей сцены: размер поля в гексах, размер гекса,
 * цвета пустых гексов и сетки, неровные границы местности.
 */
async function openWorldSettings() {
  const scene = canvas.scene;
  if ( !scene || !game.user.isGM ) return;
  const w = worldOf(scene);
  const d = sceneDims(scene);
  const num = (name, value, min, max, step = 1) => `<input type="number" name="${name}" value="${value}" min="${min}" max="${max}" step="${step}">`;
  const row = (label, input, hint = "") => `<div class="form-group"><label>${esc(L(label))}</label><div class="form-fields">${input}</div>${hint ? `<p class="hint">${esc(L(hint))}</p>` : ""}</div>`;
  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: L("ART.World.settings") },
    position: { width: 460 },
    content: `<fieldset><legend>${esc(L("ART.World.size"))}</legend>
        ${row("ART.Scene.cols", num("cols", d.cols, 5, 300))}
        ${row("ART.Scene.rows", num("rows", d.rows, 5, 300))}
        ${row("ART.Scene.size", num("size", d.size, 30, 400, 5), "ART.World.sizeHint")}
      </fieldset>
      ${row("ART.Scene.baseColor", `<input type="color" name="baseColor" value="${esc(w.baseColor)}">`)}
      ${row("ART.Scene.gridColor", `<input type="color" name="gridColor" value="${esc(w.gridColor)}">`)}
      ${row("ART.Scene.gridAlpha", num("gridAlpha", w.gridAlpha, 0, 1, 0.05))}
      ${row("ART.World.rough", `<input type="checkbox" name="rough" ${w.rough ? "checked" : ""}>`, "ART.World.roughHint")}
      <p class="hint">${esc(L("ART.Scene.settingsHint"))}</p>`,
    ok: {
      label: L("ART.Save"),
      callback: (ev, button) => {
        const f = button.form.elements;
        return {
          dims: { cols: Number(f.cols.value), rows: Number(f.rows.value), size: Number(f.size.value) },
          world: {
            baseColor: f.baseColor.value, gridColor: f.gridColor.value,
            gridAlpha: Math.max(0, Math.min(1, Number(f.gridAlpha.value) || 0)),
            rough: f.rough.checked
          }
        };
      }
    },
    rejectClose: false
  });
  if ( !result ) return;
  await applyWorldSettings(result);
}

/** Записать настройки мира: { dims: { cols, rows, size }, world: { baseColor, gridColor, gridAlpha, rough } }. */
async function applyWorldSettings({ dims, world }, scene = canvas.scene) {
  if ( !scene || !game.user.isGM ) return;
  // Сначала поле: правка флагов тоже перерисовывает холст и сбила бы ожидание перерисовки после смены сетки.
  if ( dims && await resizeWorld(scene, dims) ) ui.notifications.info(game.i18n.format("ART.World.resized", normalizeDims(dims)));
  if ( world ) await scene.update({ [`flags.${MODULE_ID}.world`]: { ...worldOf(scene), ...world } });
}

/** Что показать во вкладке «Мир»: размер поля, цвета, число игроков. */
function worldInfo(scene = canvas.scene) {
  if ( !scene ) return null;
  return {
    dims: sceneDims(scene),
    world: worldOf(scene),
    roughDefault: worldOf(scene).rough || !scene.getFlag(MODULE_ID, "world")?.roughSet,
    players: game.users.filter(u => !u.isGM).length
  };
}

/** Найти элемент: открыть его гекс, раскрыть строку и навести камеру. */
function showFeature(id) {
  const { studio, backend } = runtime;
  const s = studio.stateOf(id);
  if ( !s ) return ui.notifications.warn(L("VMAP.Notify.featureMissing"));
  let cell;
  if ( s.system.kind === "object" ) cell = markCell(s, backend.grid.cellAt);
  else if ( s.system.kind === "area" ) cell = (s.system.geometry?.cells ?? [])[0];
  else {
    const p = (s.system.geometry?.points ?? [])[0];
    if ( p ) cell = backend.grid.cellAt({ x: p[0], y: p[1] });
  }
  if ( cell ) studio.inspect(cell, { details: true });
  studio.openId = id;
  studio.panTo(id);
  studio.changed("ui");
}
