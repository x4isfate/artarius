import { MODULE_ID, FEATURE_TYPE, CLAIM_STATUS, WORLD_DEFAULTS } from "./constants.mjs";
import FeatureModel from "./data/feature-model.mjs";
import * as store from "./data/store.mjs";
import { getAtlas, ensureAtlas, upgradeAtlas, getClaims } from "./data/store.mjs";
import HexLayer, { LAYER_NAME, runtime } from "./canvas/hex-layer.mjs";
import FoundryBackend, { isWorldScene, worldOf } from "./foundry-backend.mjs";
import Studio from "./studio.mjs";
import ArtariusUI, { EXTRA_ACTIONS } from "./ui/panels.mjs";
import FeaturePageSheet from "./sheets/feature-page-sheet.mjs";
import GuideApp from "./apps/guide-app.mjs";
import AzgaarApp, { AzgaarGenerator, importAzgaar } from "./apps/azgaar-app.mjs";
import { checkForUpdate } from "./update-check.mjs";
import { SOCKET, onSocket, onCheckMessage, onCheckUpdated, autoApplyTrusted, rollForClaim } from "./review/claims.mjs";
import { TURN_DEFAULT, markCell, cellsInShapes, cellKey } from "./data/world.mjs";
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
  S("turn", { scope: "world", config: false, type: Object, default: { ...TURN_DEFAULT }, onChange: () => runtime.backend?.emit() });
  S("hiddenLayers", { scope: "client", config: false, type: Array, default: [], onChange: () => runtime.backend?.emit() });

  const backend = new FoundryBackend();
  const studio = new Studio(backend);
  runtime.backend = backend;
  runtime.studio = studio;
  runtime.isWorld = () => isWorldScene();

  game.modules.get(MODULE_ID).api = {
    /** Версия API. Растёт при несовместимых изменениях. 2 — гекс-мир (0.3). */
    version: 2,
    backend, studio, store,
    isWorldScene, worldOf,
    openGuide: () => GuideApp.open(),
    openAzgaar: () => AzgaarApp.open(),
    openAzgaarGenerator: () => AzgaarGenerator.open(),
    openWorldSettings: () => openWorldSettings(),
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
     * Своя кнопка в круглом меню: { id, label, icon, onClick, visible? }.
     * icon — имя Font Awesome ("cloud-sun") или классы ("fa-solid fa-cloud-sun"). Можно и (id, { … }).
     */
    registerQuickAction: (idOrDef, action = {}) => {
      const def = typeof idOrDef === "object" ? idOrDef : { ...action, id: idOrDef };
      if ( !def?.id ) throw new Error("artarius | registerQuickAction: нужен id");
      if ( typeof def.label === "string" && game.i18n?.has?.(def.label) ) def.label = game.i18n.localize(def.label);
      EXTRA_ACTIONS.set(def.id, def);
      studio.changed("ui");
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
  runtime.ui = new ArtariusUI(studio, backend);
  syncUI();
  watchLayout();
  if ( !game.settings.get(MODULE_ID, "guideSeen") && isWorldScene() ) {
    GuideApp.open();
    game.settings.set(MODULE_ID, "guideSeen", true);
  }
  checkForUpdate();
  Hooks.callAll("artarius.ready", game.modules.get(MODULE_ID).api);
});

/** Показать или спрятать панели: они живут только на сцене Артария. */
function syncUI() {
  const ui2 = runtime.ui;
  if ( !ui2 ) return;
  const on = !!canvas?.ready && isWorldScene();
  ui2.hidden = !on;
  if ( on ) placePanels(ui2.root);
}

/**
 * Отступы панелей от интерфейса Foundry. Меряем настоящие элементы, а не берём числа
 * из стилей ядра: темы вроде Carolingian UI двигают и меняют колонку слева и боковую панель.
 */
function placePanels(root) {
  const box = id => {
    const r = document.getElementById(id)?.getBoundingClientRect();
    return r && r.width && r.height ? r : null;
  };
  const set = (k, v) => root.style.setProperty(k, `${Math.round(v)}px`);
  const controls = box("scene-controls") ?? box("controls");
  const sidebar = box("sidebar");
  const players = box("players");
  const W = window.innerWidth, H = window.innerHeight;
  // Колонка слева: обычная вертикальная или полоса сверху (тогда панели ниже неё).
  let topEdge = 0;
  if ( controls && controls.width <= 200 && controls.left < W / 2 ) {
    set("--art-left", controls.right + 16);
  } else if ( controls && controls.top < H / 3 ) {
    set("--art-left", 16);
    topEdge = controls.bottom;
  }
  // Полоска хода по центру сверху не должна лечь на список сцен.
  const nav = box("scene-navigation") ?? box("navigation");
  if ( nav && nav.top < 80 && nav.right > (W / 2) - 160 ) topEdge = Math.max(topEdge, nav.bottom);
  set("--art-turn-top", topEdge + 10);
  set("--art-top", Math.max(64, topEdge + 58));
  // Боковая панель: справа (как в ядре) или слева.
  if ( sidebar && sidebar.left > W / 2 ) set("--art-right", W - sidebar.left + 16);
  else if ( sidebar ) set("--art-right", 16);
  if ( players && players.top > H / 2 ) {
    set("--art-wheel-bottom", H - players.top + 70);
    set("--art-wheel-left", Math.max(24, players.left));
  }
}

/** Колонку, боковую панель и список игроков перестраивают и ядро, и темы: следим за их размером. */
function watchLayout() {
  if ( typeof ResizeObserver === "undefined" ) return;
  let frame = null;
  const ro = new ResizeObserver(() => {
    if ( frame ) return;
    frame = requestAnimationFrame(() => { frame = null; syncUI(); });
  });
  const seen = new WeakSet();
  const observe = () => {
    for ( const id of ["scene-controls", "controls", "sidebar", "players"] ) {
      const el = document.getElementById(id);
      if ( el && !seen.has(el) ) { seen.add(el); ro.observe(el); }
    }
  };
  observe();
  for ( const hook of ["renderSceneControls", "renderSidebar", "renderPlayers", "renderPlayerList"] ) Hooks.on(hook, observe);
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
  studio.line.points = [];
  syncUI();
  if ( isWorldScene() && game.user.isGM ) {
    const atlas = getAtlas(canvas.scene) ?? await ensureAtlas(canvas.scene);
    if ( await upgradeAtlas(atlas) ) await migrateAreas(atlas);
  }
  // Группа «Артарий» слева видна только на сцене Артария.
  try { ui.controls?.render({ reset: true }); } catch { /* панель ещё не готова */ }
  backend.emit();
});

for ( const hook of ["collapseSidebar", "renderPlayers", "renderPlayerList", "renderSceneControls"] ) Hooks.on(hook, () => syncUI());
window.addEventListener("resize", () => syncUI());

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

/** Размер гекса для сетки «острым верхом»: ширина и высота клетки. */
function hexSize(size) {
  try {
    const HG = foundry.grid.HexagonalGrid;
    const g = new HG({ size, columns: false, even: false });
    if ( g.sizeX && g.sizeY ) return { w: g.sizeX, h: g.sizeY };
  } catch { /* старый Foundry: считаем сами */ }
  return { w: size, h: size * 2 / Math.sqrt(3) };
}

/** Новая сцена Артария: гекс-сетка нужного размера и включённый режим. */
async function createWorldScene(options = null) {
  if ( !game.user.isGM ) return;
  let o = options;
  if ( !o ) {
    o = await foundry.applications.api.DialogV2.prompt({
      window: { title: L("ART.Scene.create") },
      content: `<div class="form-group"><label>${esc(L("ART.Scene.name"))}</label><input type="text" name="name" value="${esc(L("ART.Scene.defaultName"))}"></div>
        <div class="form-group"><label>${esc(L("ART.Scene.cols"))}</label><input type="number" name="cols" value="40" min="5" max="200"></div>
        <div class="form-group"><label>${esc(L("ART.Scene.rows"))}</label><input type="number" name="rows" value="28" min="5" max="200"></div>
        <div class="form-group"><label>${esc(L("ART.Scene.size"))}</label><input type="number" name="size" value="100" min="50" max="400"></div>
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
  const cols = Math.max(5, Math.min(200, Math.round(o.cols || 40)));
  const rows = Math.max(5, Math.min(200, Math.round(o.rows || 28)));
  const size = Math.max(50, Math.min(400, Math.round(o.size || 100)));
  const { w, h } = hexSize(size);
  const scene = await Scene.implementation.create({
    name: o.name || L("ART.Scene.defaultName"),
    width: Math.round((cols * w) + (w / 2)),
    height: Math.round(((rows - 1) * h * 0.75) + h),
    padding: 0.05,
    grid: { type: CONST.GRID_TYPES.HEXODDR, size, color: "#000000", alpha: 0.15 },
    tokenVision: false,
    fog: { exploration: false },
    flags: { [MODULE_ID]: { world: { ...WORLD_DEFAULTS, enabled: true } } }
  });
  await scene?.view();
  return scene;
}

/** Настройки мира текущей сцены: цвет пустых гексов и сетки. */
async function openWorldSettings() {
  const scene = canvas.scene;
  if ( !scene || !game.user.isGM ) return;
  const w = worldOf(scene);
  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: L("ART.World.settings") },
    content: `<div class="form-group"><label>${esc(L("ART.Scene.baseColor"))}</label><input type="color" name="baseColor" value="${esc(w.baseColor)}"></div>
      <div class="form-group"><label>${esc(L("ART.Scene.gridColor"))}</label><input type="color" name="gridColor" value="${esc(w.gridColor)}"></div>
      <div class="form-group"><label>${esc(L("ART.Scene.gridAlpha"))}</label><input type="number" name="gridAlpha" value="${w.gridAlpha}" min="0" max="1" step="0.05"></div>
      <p class="hint">${esc(L("ART.Scene.settingsHint"))}</p>`,
    ok: {
      label: L("ART.Save"),
      callback: (ev, button) => {
        const f = button.form.elements;
        return { baseColor: f.baseColor.value, gridColor: f.gridColor.value, gridAlpha: Math.max(0, Math.min(1, Number(f.gridAlpha.value) || 0)) };
      }
    },
    rejectClose: false
  });
  if ( result ) await scene.update({ [`flags.${MODULE_ID}.world`]: { ...w, ...result } });
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
  if ( cell ) studio.inspect(cell);
  studio.openId = id;
  studio.panTo(id);
  studio.changed("ui");
}
