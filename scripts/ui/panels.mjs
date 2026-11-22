/**
 * Интерфейс гекс-мира на чистом DOM: части left (инструмент),
 * right (гекс и заявки), wheel (круглое меню, только в стенде без Foundry).
 *
 * Без хозяина части лежат поверх холста в своём корне #artarius-ui.
 * С хозяином (ui/windows.mjs в Foundry) каждая часть живёт в своём окне
 * ApplicationV2, а кнопки инструментов стоят в группе Артария слева.
 * Все кнопки работают через data-action и делегированную подписку на части.
 * tools/check-buttons.mjs проверяет, что у каждого data-action есть обработчик.
 */
import { esc, data, patch, icon, htmlToText } from "./dom.mjs";
import { cellKey, zoneCells, layerIdOf } from "../data/world.mjs";
import { formatStatus } from "../review/ops.mjs";
import { demiurgesOf } from "../data/access.mjs";
import { describeOp, diffOf } from "../review/describe.mjs";
import { KIND_TOOL } from "../constants.mjs";
import { VIEW_PART_DEFS, isShown } from "../data/view.mjs";
import { hasField } from "../data/fields.mjs";
import { RECIPES } from "../gen/pieces.mjs";
import { statusIcon, BASE_STATUSES, BASE_ASPECTS } from "../data/statuses.mjs";

import { ICON_LIBRARY, allIcons, searchIcons } from "../data/icons.mjs";
import { MARK_SHAPES, shapeSwatch, shapeOf } from "../data/mark-shape.mjs";
import { LINE_SHAPES, LINE_PATTERNS, lineCurve, lineDash } from "../canvas/style.mjs";
import { UnifiedUI } from "./unified.mjs";

/**
 * Значок для показа в панели. Белые значки библиотеки рисуются маской цветом типа,
 * как на карте; свои картинки показываются как есть.
 */
/**
 * Полный адрес картинки. Относительный путь внутри CSS-переменной браузер считает
 * от файла стилей (modules/artarius/styles/), а не от страницы: маска значка не находилась.
 */
export function absoluteUrl(path) {
  try { return new URL(path, globalThis.document?.baseURI).href; }
  catch { return path; }
}

export function iconImg(path, color, { tint = true, cls = "art-icon-img" } = {}) {
  if ( !path ) return "";
  if ( tint ) return `<span class="${cls} art-mask" style="--src:url('${esc(absoluteUrl(path))}');--c:${esc(color || "#ddd")}"></span>`;
  return `<img class="${cls}" src="${esc(path)}" alt="">`;
}

/**
 * Поле цвета: палитра и код рядом, как у цветов в настройках Foundry. attrs — data-model или data-field/data-id.
 * Палитра не закрывается на каждом шаге: пока её крутят, обновляются только образцы, а не всё окно.
 */
export function colorField(attrs, value, key) {
  const v = /^#[0-9a-f]{6}$/i.test(value ?? "") ? value : "#cccccc";
  return `<span class="art-color"><input type="color" value="${esc(v)}" ${attrs} data-key="${esc(key)}">`
    + `<input type="text" class="art-color-hex" value="${esc(v)}" maxlength="7" spellcheck="false" ${attrs} data-hex="1" data-key="${esc(key)}-hex"></span>`;
}

/** Штриховки зон поверх цвета. */
export const PATTERNS = ["none", "hatch", "crosshatch", "cross", "dots", "vertical"];

/** Маленький образец штриховки для кнопки выбора. */
function patternSwatch(p) {
  const line = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  const body = {
    none: "",
    hatch: [0, 8, 16].map(o => line(o - 8, 24, o + 16, 0)).join(""),
    crosshatch: [0, 8, 16].map(o => line(o - 8, 24, o + 16, 0) + line(o - 8, 0, o + 16, 24)).join(""),
    cross: [[6, 6], [18, 6], [12, 18]].map(([x, y]) => line(x - 3, y - 3, x + 3, y + 3) + line(x - 3, y + 3, x + 3, y - 3)).join(""),
    dots: [[6, 6], [18, 6], [12, 12], [6, 18], [18, 18]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.8"/>`).join(""),
    vertical: [4, 10, 16, 22].map(x => line(x, 0, x, 24)).join("")
  }[p] ?? "";
  return `<svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" fill="currentColor" stroke-width="1.6">${body}</svg>`;
}

const TOOL_ICONS = { select: "arrow-pointer", zone: "draw-polygon", mark: "location-dot", line: "route" };
/** Сколько секунд висит плашка «Удалено · Отменить». */
const TOAST_MS = 6000;
/** Нижний край панелей у низа экрана (кисть, выбранные метки): выше панели макросов Foundry. */
const BAR_BOTTOM = 72;
/** Зазор между панелями внизу. */
const BAR_GAP = 8;

/** Дополнительные кнопки меню от других модулей: id → { label, icon, onClick, visible? }. */
export const EXTRA_ACTIONS = new Map();

export default class ArtariusUI {
  /**
   * host — куда класть части интерфейса. Без него всё лежит в одном слое поверх холста
   * (стенд). В Foundry host раскладывает части по окнам ApplicationV2: их можно
   * двигать и растягивать, темы интерфейса оформляют их как свои окна.
   * host: { wheel: bool, attach(name, el), show(name, on, { title }), setHidden(bool) }.
   * project(point) — точка сцены → { x, y } в пикселях окна браузера; без неё панели на гексе нет.
   */
  constructor(studio, backend, { mount = document.body, host = null, project = null, syncRender = false } = {}) {
    this.syncRender = syncRender;
    this.studio = studio;
    this.backend = backend;
    this.host = host;
    this.t = (k, d) => backend.t(k, d);
    this.root = document.createElement("div");
    this.root.id = "artarius-ui";
    this.root.className = "artarius";
    this.root.innerHTML = `
      <section class="art-panel art-left" data-part="left" hidden></section>
      <section class="art-panel art-right" data-part="right" hidden></section>
      <section class="art-panel art-settings" data-part="settings" hidden></section>
      <section class="art-panel art-layerwin" data-part="layers" hidden></section>
      <section class="art-panel art-aspectwin" data-part="aspects" hidden></section>
      <nav class="art-wheel" data-part="wheel"></nav>`;
    this.parts = Object.fromEntries([...this.root.querySelectorAll("[data-part]")].map(el => [el.dataset.part, el]));
    for ( const el of Object.values(this.parts) ) { this._bind(el); this._bindAspectDrag(el); }
    if ( host ) {
      for ( const [name, el] of Object.entries(this.parts) ) {
        el.hidden = false;
        if ( name === "wheel" && !host.wheel ) { el.remove(); delete this.parts.wheel; continue; }
        host.attach(name, el);
      }
    } else mount.appendChild(this.root);
    // Панель кнопок на гексе живёт поверх холста отдельно от окон, как Token HUD у Foundry.
    this.project = project;
    this.hud = document.createElement("div");
    this.hud.id = "artarius-hud";
    this.hud.className = "artarius art-hud";
    this.hud.hidden = true;
    document.body.appendChild(this.hud);
    // Подсказка с названием линии под курсором.
    this.tip = document.createElement("div");
    this.tip.id = "artarius-tip";
    this.tip.className = "artarius art-tip";
    this.tip.hidden = true;
    document.body.appendChild(this.tip);
    // Панель действий над выбранными метками: внизу по центру, как в стратегиях.
    this.bar = document.createElement("div");
    this.bar.id = "artarius-bar";
    this.bar.className = "artarius art-bar";
    this.bar.hidden = true;
    document.body.appendChild(this.bar);
    // Переход к гексу по координатам (Shift+Пробел).
    this.goto = document.createElement("div");
    this.goto.id = "artarius-goto";
    this.goto.className = "artarius art-goto";
    this.goto.hidden = true;
    document.body.appendChild(this.goto);
    // Слои как в Azgaar: кнопка у названия сцены и выпадающая панель с выключателем у каждого слоя.
    this.layerbar = document.createElement("div");
    this.layerbar.id = "artarius-layerbar";
    this.layerbar.className = "artarius art-layerbar";
    this.layerbar.hidden = true;
    document.body.appendChild(this.layerbar);
    this._onResize = () => this._placeLayerbar();
    window.addEventListener("resize", this._onResize);
    this._onKey = ev => {
      if ( ev.key !== "Escape" || ev.target?.matches?.("input, textarea, select") ) return;
      if ( this.studio.aspectsOpen ) this.studio.toggleAspects(false);
      else if ( this.studio.layersOpen ) this.studio.toggleLayers(false);
    };
    document.addEventListener("keydown", this._onKey);
    this._bind(this.hud);
    this._bind(this.bar);
    this._bind(this.layerbar);
    // Кисть зон внизу (макет А): какая зона, красить или стирать, «Готово».
    this.brushbar = document.createElement("div");
    this.brushbar.id = "artarius-brushbar";
    this.brushbar.className = "artarius art-brushbar";
    this.brushbar.hidden = true;
    document.body.appendChild(this.brushbar);
    this._bind(this.brushbar);
    // «Удалено · Отменить» на несколько секунд.
    this.toastEl = document.createElement("div");
    this.toastEl.id = "artarius-toast";
    this.toastEl.className = "artarius art-toast";
    this.toastEl.hidden = true;
    this.toastEl.setAttribute("role", "status");
    document.body.appendChild(this.toastEl);
    this._bind(this.toastEl);
    studio._hasToastUI = true;
    this._bindMarkDrag(this.hud);
    // Окна перерисовываются не чаще раза в кадр и не во время мазка кистью (он трогает только карту).
    this._unsub = studio.subscribe(what => {
      if ( what === "hover" ) return this.renderTip();
      if ( what === "data" || what === "ui" ) this.scheduleRender();
    });
    this.render();
  }

  destroy() {
    this._unsub?.();
    this.root.remove();
    this.hud.remove();
    this.tip.remove();
    this.bar.remove();
    this.goto.remove();
    this.layerbar.remove();
    this.brushbar?.remove();
    this.toastEl?.remove();
    clearTimeout(this._toastTimer);
    window.removeEventListener("resize", this._onResize);
    document.removeEventListener("keydown", this._onKey);
    if ( this._hudFrame ) cancelAnimationFrame(this._hudFrame);
    if ( this._renderFrame ) (globalThis.cancelAnimationFrame ?? clearTimeout)(this._renderFrame);
  }

  set hidden(v) {
    this._hidden = !!v;
    if ( this.host ) {
      this.host.setHidden(this._hidden);
      if ( !this._hidden ) this.render();
    } else this.root.hidden = this._hidden;
    this.renderHud();
  }

  get hidden() { return !!this._hidden; }

  /** Окно закрыли крестиком: привести состояние студии в соответствие. */
  windowClosed(name) {
    const s = this.studio;
    // Крестик закрывает только окно: инструмент остаётся, Foundry не уходит к токенам.
    if ( name === "left" && s.tool && this.host ) { this.leftClosed = { tool: s.tool, picks: s.toolPicks ?? 0 }; return; }
    if ( name === "left" && s.tool ) s.setTool(null, { toggle: false });
    else if ( name === "right" && s.rightOpen ) s.closeRight();
    else if ( name === "settings" && s.settings.open ) s.closeSettings();
    else if ( name === "layers" && s.layersOpen ) s.toggleLayers(false);
    else if ( name === "aspects" && s.aspectsOpen ) s.toggleAspects(false);
  }

  _show(name, on, title) {
    if ( this.host ) {
      if ( !this._hidden ) this.host.show(name, on, { title });
    } else if ( this.parts[name] ) this.parts[name].hidden = !on;
  }

  /* ---------------------------------------------------------------- */
  /*  События                                                           */
  /* ---------------------------------------------------------------- */

  /** Перетаскивание меток на панели гекса: метка встаёт перед той, на которую её бросили. */
  _bindMarkDrag(target) {
    const over = ev => ev.target.closest?.("[data-drag-mark]");
    target.addEventListener("dragstart", ev => {
      const el = over(ev);
      if ( !el ) return;
      this._dragMark = el.dataset.dragMark;
      ev.dataTransfer?.setData("text/plain", this._dragMark);
      if ( ev.dataTransfer ) ev.dataTransfer.effectAllowed = "move";
      el.classList.add("dragging");
    });
    target.addEventListener("dragover", ev => {
      const el = over(ev);
      if ( !el || !this._dragMark ) return;
      ev.preventDefault();
      for ( const x of target.querySelectorAll(".drop-before") ) if ( x !== el ) x.classList.remove("drop-before");
      el.classList.add("drop-before");
    });
    target.addEventListener("dragleave", ev => over(ev)?.classList.remove("drop-before"));
    target.addEventListener("drop", ev => {
      const el = over(ev);
      const id = this._dragMark;
      this._dragMark = null;
      if ( !el || !id ) return;
      ev.preventDefault();
      ev.stopPropagation();
      const to = el.dataset.dragMark;
      // Бросили на соседа снизу — встаём после него, иначе перед.
      const ids = [...target.querySelectorAll("[data-drag-mark]")].map(x => x.dataset.dragMark);
      const before = ids.indexOf(id) < ids.indexOf(to) ? (ids[ids.indexOf(to) + 1] ?? null) : to;
      this.studio.reorderMark(id, before).catch(err => console.error("artarius | reorder", err));
    });
    target.addEventListener("dragend", () => {
      this._dragMark = null;
      for ( const x of target.querySelectorAll(".dragging, .drop-before") ) x.classList.remove("dragging", "drop-before");
    });
  }

  _bind(target) {
    target.addEventListener("click", ev => {
      const el = ev.target.closest("[data-action]");
      if ( !el || !target.contains(el) || el.disabled ) return;
      ev.preventDefault();
      ev.stopPropagation();
      const fn = this.actions[el.dataset.action];
      if ( !fn ) return console.warn("artarius | no handler for", el.dataset.action);
      Promise.resolve().then(() => fn.call(this, el, ev)).catch(err => {
        console.error("artarius | action", el.dataset.action, err);
        this.backend.notify("error", String(err?.message ?? err));
      });
    });
    const onInput = ev => {
      const el = ev.target;
      if ( el.type === "color" && ev.type === "input" ) return this._liveColor(el);
      // Ползунок пишется, когда его отпустили: иначе перерисовка окна обрывает протяжку.
      if ( el.type === "range" && ev.type === "input" ) return;
      if ( el.dataset.hex ) {
        // Код цвета: принимаем только целый #rrggbb, и только когда поле отпустили.
        if ( ev.type !== "change" ) return;
        let v = el.value.trim();
        if ( /^[0-9a-f]{6}$/i.test(v) ) v = `#${v}`;
        if ( !/^#[0-9a-f]{6}$/i.test(v) ) { el.value = el.previousElementSibling?.value ?? ""; return; }
        el.value = v.toLowerCase();
      }
      if ( el.dataset.wf ) {
        // Поля вкладки «Мир»: запоминаем набранное, чтобы перерисовка окна его не стёрла.
        const [form, ...rest] = el.dataset.wf.split(".");
        (this.wf ??= { settings: {}, azgaar: {}, gen: {} })[form][rest.join(".")] = el.type === "checkbox" ? el.checked : el.value;
        return;
      }
      if ( el.dataset.wfFile ) {
        if ( ev.type !== "change" ) return;
        const file = el.files?.[0];
        if ( file ) file.text().then(text => { this.azgaarFile = { name: file.name, text }; this.render(); });
        return;
      }
      if ( el.dataset.change ) {
        if ( ev.type === "change" ) Promise.resolve(this.actions[el.dataset.change]?.call(this, el, ev)).catch(err => {
          console.error("artarius | change", el.dataset.change, err);
          this.backend.notify("error", String(err?.message ?? err));
        });
        return;
      }
      if ( el.dataset.model ) {
        this._setModel(el.dataset.model, el.type === "checkbox" ? el.checked : el.value);
        this.studio.changed("ui");
        if ( el.dataset.model.startsWith("zone.") ) this.studio.changed("overlay");
      } else if ( el.dataset.field && el.dataset.id ) {
        if ( ev.type === "input" && (el.tagName === "SELECT" || el.type === "color") ) return;
        this.studio.setField(el.dataset.id, el.dataset.field, el.value);
      }
    };
    target.addEventListener("input", onInput);
    target.addEventListener("change", onInput);
    // Раскрытые разделы вкладки «Мир» остаются раскрытыми после перерисовки. toggle не всплывает, ловим на захвате.
    target.addEventListener("toggle", ev => {
      const folder = ev.target?.dataset?.folder;
      if ( folder !== undefined ) {
        this.typeFolderShut ??= new Set();
        if ( ev.target.open ) this.typeFolderShut.delete(folder); else this.typeFolderShut.add(folder);
        return;
      }
      const id = ev.target?.dataset?.fold;
      if ( !id ) return;
      this.wfOpen ??= new Set(["settings"]);
      if ( ev.target.open ) this.wfOpen.add(id); else this.wfOpen.delete(id);
    }, true);
    // Клавиши в полях не должны уходить в Foundry (WASD двигает камеру, Delete удаляет токены).
    target.addEventListener("keydown", ev => {
      if ( ev.target.matches("input, textarea, select") ) {
        ev.stopPropagation();
        if ( ev.key === "Enter" && ev.target.dataset.enter ) {
          ev.preventDefault();
          ev.target.dispatchEvent(new Event("change", { bubbles: true }));
          this.actions[ev.target.dataset.enter]?.call(this, ev.target, ev);
        }
      }
    });
    // Колесо над панелью крутит панель, а не масштаб карты.
    target.addEventListener("wheel", ev => ev.stopPropagation(), { passive: true });
  }

  /** Цвет, пока палитра открыта: код и образцы рядом меняются сразу, окно не перерисовывается. */
  _liveColor(el) {
    const v = el.value;
    const hex = el.nextElementSibling;
    if ( hex?.dataset.hex ) hex.value = v;
    const box = el.closest(".art-item, .art-citem, .art-form, .art-ucol-right");
    if ( box && (el.dataset.model === "typeForm.color" || el.dataset.field === "color") ) {
      for ( const m of box.querySelectorAll(".art-mask, .art-swatch, .art-live-color, .art-plate, .art-circ") ) m.style.setProperty("--c", v);
    }
  }

  _setModel(path, value) {
    const [obj, key] = path.split(".");
    if ( obj === "typeForm" ) { if ( this.studio.typeForm ) this.studio.typeForm[key] = value; return; }
    if ( obj === "claimForm" ) { this.studio.claimForm[key] = value; return; }
    if ( this.studio[obj] ) this.studio[obj][key] = value;
  }

  get actions() {
    const s = this.studio;
    return Object.assign(this.unifiedActions(), {
      // Кнопка уже выбранного инструмента его не выключает: выключает крестик в шапке.
      tool: el => s.setTool(el.dataset.tool, { toggle: false }),
      toggleMenu: () => s.setTool(s.tool ? null : "select"),
      setMode: el => s.setMode(el.dataset.mode),
      toggleHints: () => { s.showHints = !s.showHints; s.changed("ui"); },
      dockRight: () => { this.host?.dock?.("right", !this.host.isDocked("right")); this.render(); },
      brushMode: el => s.setBrush(el.dataset.mode),
      brushDone: () => s.setTool("select", { toggle: false }),
      hideToast: () => s.hideToast(),
      addBaseStatus: el => s.addBaseStatus(el.dataset.id, el.dataset.path, el.dataset.key),
      addBaseAspect: el => s.addBaseAspect(el.dataset.id, el.dataset.key),
      permRole: el => this._setPerm(cfg => { ((cfg.roles ??= {})[el.dataset.role] ??= {})[el.dataset.perm] = el.checked; }),
      permUser: el => this._setPerm(cfg => {
        const u = ((cfg.users ??= {})[el.dataset.user] ??= {});
        if ( el.value === "" ) delete u[el.dataset.perm]; else u[el.dataset.perm] = el.value === "true";
      }),
      visMode: el => s.setVisibility(el.dataset.id, el.value),
      visUser: el => s.toggleViewer(el.dataset.id, el.dataset.user),
      toggleDemiurge: el => s.toggleDemiurge(el.dataset.id, el.dataset.actor),
      editStatuses: el => { this.statusEdit = el.dataset.id || null; this.render(); },
      extra: el => EXTRA_ACTIONS.get(el.dataset.id)?.onClick?.(),
      help: () => this.backend.openGuide?.(),
      // Зона
      // Новая зона без выбранных гексов создаётся пустой, остальное — как раньше.
      attach: () => (s.zone.target === "new" || !s.states.has(s.zone.target) ? s.createZone() : s.attach()),
      hudZoneAdd: el => s.addHereToZone(el.dataset.id),
      hudZoneNew: () => s.zoneHere(),
      detach: () => s.detach(),
      clearSelection: () => s.clearSelection(),
      zoneTarget: el => s.setZoneTarget(el.dataset.id),
      pickZone: el => {
        // Кисть открывается в режиме слоя этой зоны: местность или владения.
        const z = s.states.get(el.dataset.id);
        if ( z ) s.zone.scope = "";
        s.setTool("zone", { toggle: false });
        s.setZoneTarget(el.dataset.id);
      },
      focusFeature: el => s.focusFeature(el.dataset.id),
      catalogFold: el => {
        const shut = s.catalog.shut;
        if ( shut.has(el.dataset.key) ) shut.delete(el.dataset.key); else shut.add(el.dataset.key);
        s.changed("ui");
      },
      // Метка, линия
      placeMarks: () => s.placeMarks(),
      finishLine: () => s.finishLine(),
      lineMode: el => s.setLineMode(el.dataset.mode),
      undoPoint: () => s.undoPoint(),
      clearLine: () => s.clearLine(),
      // Типы
      pickType: el => s.pickType(el.dataset.kind, el.dataset.id),
      saveType: () => s.saveTypeForm(),
      // Настройки модуля
      openSettings: el => s.openSettings(el.dataset.section || undefined),
      closeSettings: () => s.closeSettings(),
      settingsSection: el => s.settingsSection(el.dataset.section),
      saveLayer: () => s.saveLayerForm(),
      deleteLayer: el => s.deleteLayer(el.dataset.id),
      layerUp: el => s.moveLayer(el.dataset.id, -1),
      layerDown: el => s.moveLayer(el.dataset.id, 1),
      deleteType: el => s.deleteType(el.dataset.id),
      lineShape: el => { if ( s.typeForm ) { s.typeForm.lineShape = el.dataset.v; s.changed("ui"); } },
      linePattern: el => { if ( s.typeForm ) { s.typeForm.linePattern = el.dataset.v; s.changed("ui"); } },
      pickShape: el => { if ( s.typeForm ) { s.typeForm.shape = el.dataset.shape; s.changed("ui"); } },
      setShape: el => s.setField(el.dataset.id, "shape", el.dataset.shape),
      pickPattern: el => { if ( s.typeForm ) { s.typeForm.pattern = el.dataset.pattern; s.changed("ui"); } },
      pickIcon: el => s.pickIcon(el.dataset.icon),
      iconCat: el => { if ( s.typeForm ) { s.typeForm.iconCat = el.dataset.cat; s.changed("ui"); } },
      browseIcon: () => this.backend.pickFile?.(s.typeForm?.icon ?? "", path => {
        s.pickIcon(path);
      }),
      // Слои и мир
      toggleLayer: el => this.backend.toggleLayer?.(el.dataset.id),
      applyPreset: el => s.applyPreset(el.value),
      savePreset: () => s.savePreset(),
      deletePreset: el => s.deletePreset(el.dataset.id),
      sceneThumb: () => this.backend.updateThumb?.({ quiet: false }),
      azgaarGenerator: () => this.backend.openAzgaarGenerator?.(),
      wfSettings: () => this._wfRun("settings", async () => {
        await this.backend.applyWorldSettings?.(this._wfValues("settings"));
        this.wf.settings = {};
      }),
      wfImport: () => this._wfRun("azgaar", async () => {
        const f = this.azgaarFile;
        if ( !f ) return;
        const done = await this.backend.importAzgaarText?.(f.text, f.name, this._wfValues("azgaar"));
        if ( done ) this.azgaarFile = null;
      }),
      wfGenerate: () => this._wfRun("gen", async () => {
        await this.backend.generateWorld?.(this._wfValues("gen"));
        this.wfSeed = null;
        delete this.wf.gen.seed;
      }),
      // Новый мир одной кнопкой: случайное зерно и рецепт, остальное по умолчанию, сцена очищается.
      wfQuickWorld: () => this._wfRun("quick", async () => {
        const v = this._wfValues("gen");
        await this.backend.generateWorld?.({ ...v, seed: Math.floor(Math.random() * 1e9).toString(36), recipe: "", clear: true });
      }),
      azgaar: () => this.backend.openAzgaar?.(),
      // Панель на гексе
      hudDetails: el => s.openDetails(el.dataset.id || null),
      hudMark: () => s.toggleTypeMenu(),
      quickMark: el => s.quickMark(el.dataset.id),
      deleteMark: el => s.deleteMarks([el.dataset.id]),
      deleteSelected: () => s.deleteMarks(),
      clearMarkSel: () => s.clearMarkSel(),
      bulkType: el => { if ( el.value ) s.retypeMarks(el.value); },
      markScale: el => s.setField(el.dataset.id, "size", Number(el.value) / 100),
      undo: () => s.undo(),
      redo: () => s.redo(),
      hudZone: () => s.toggleZoneMenu(),
      // Карточка
      closeRight: () => s.closeRight(),
      rightTab: el => s.setRightTab(el.dataset.tab),
      openItem: el => s.toggleOpen(el.dataset.id),
      pan: el => s.panTo(el.dataset.id),
      deleteFeature: el => s.deleteFeature(el.dataset.id),
      removeCell: el => s.removeCellFromZone(el.dataset.id),
      markUp: el => s.shiftMark(el.dataset.id, -1),
      markDown: el => s.shiftMark(el.dataset.id, 1),
      addStatus: el => s.addStatus(el.dataset.id, el.dataset.path),
      removeStatus: el => s.removeStatus(el.dataset.id, el.dataset.path, Number(el.dataset.n)),
      stepLevel: el => s.stepLevel(el.dataset.id, el.dataset.path, Number(el.dataset.n), Number(el.dataset.delta)),
      toAspect: el => s.statusToAspect(el.dataset.id, Number(el.dataset.n)),
      addAspect: el => s.addAspect(el.dataset.id),
      removeAspect: el => s.removeAspect(el.dataset.id, Number(el.dataset.n)),
      // Заявки
      openQueue: () => s.openQueue(),
      submit: () => s.submit(),
      undoOp: el => s.undoDraftOp(el.dataset.id),
      preview: el => s.togglePreview(el.dataset.id),
      claimGoTo: el => s.goToClaim(el.dataset.id),
      check: el => s.toggleChecked(el.dataset.id),
      checkAll: () => s.checkAll(),
      apply: el => s.applyClaims([el.dataset.id]),
      reject: el => s.rejectClaims([el.dataset.id]),
      applyChecked: () => s.applyClaims([...s.checkedIds]),
      rejectChecked: () => s.rejectClaims([...s.checkedIds]),
      requestCheck: el => s.requestCheck(el.dataset.id),
      returnToDraft: el => this.backend.returnToDraft(el.dataset.id),
      dropClaim: el => this.backend.dropClaim(el.dataset.id)
    });
  }

  /** Старое имя: окно слоёв теперь хранит студия (studio.layersOpen). */
  get layersPanel() { return !!this.studio.layersOpen; }

  /* ---------------------------------------------------------------- */
  /*  Отрисовка                                                         */
  /* ---------------------------------------------------------------- */

  /** Перерисовать окна в следующем кадре; вызовы в одном кадре склеиваются. */
  scheduleRender() {
    if ( this.syncRender ) return this.render();
    if ( this._renderFrame ) return;
    const raf = globalThis.requestAnimationFrame ?? (fn => setTimeout(fn, 16));
    this._renderFrame = raf(() => {
      this._renderFrame = null;
      this.render();
    });
  }

  render() {
    const s = this.studio;
    if ( this._renderFrame ) {
      (globalThis.cancelAnimationFrame ?? clearTimeout)(this._renderFrame);
      this._renderFrame = null;
    }
    // Каждая часть рисуется отдельно: ошибка в одной (например, на непривычных данных мира) не гасит остальные.
    const safe = (name, fn) => {
      try { fn(); } catch(err) { this._renderError(name, err); }
    };
    safe("wheel", () => { if ( this.parts.wheel ) patch(this.parts.wheel, this.renderWheel()); });
    safe("left", () => {
      const leftOn = this._leftVisible();
      if ( leftOn ) patch(this.parts.left, this.renderLeft());
      this._show("left", leftOn, this._leftTitle());
    });
    safe("right", () => {
      if ( s.rightOpen ) patch(this.parts.right, this.renderRight());
      this._show("right", s.rightOpen, this.t({ queue: "ART.Queue.title", catalog: "ART.Catalog.tab" }[s.rightTab] ?? "ART.Card.tab"));
    });
    safe("aspects", () => {
      if ( !this.parts.aspects ) return;
      const on = !!s.aspectsOpen && !this._hidden;
      if ( on ) patch(this.parts.aspects, this.renderAspectsWindow());
      this._show("aspects", on, this.t("ART.Aspect.title"));
    });
    safe("settings", () => {
      if ( s.settings.open ) patch(this.parts.settings, this.renderSettings());
      this._show("settings", s.settings.open, this.t("ART.Settings.title"));
    });
    safe("hud", () => this.renderHud());
    safe("bar", () => this.renderBar());
    safe("modes", () => this.renderLayerbar());
    safe("brush", () => this.renderBrushbar());
    safe("toast", () => this.renderToast());
    safe("theme", () => this._syncTheme());
    safe("place", () => this._placeLayerbar());
  }

  /** Ошибка отрисовки: в консоль и один раз уведомлением с текстом, чтобы её можно было прислать. */
  _renderError(part, err) {
    console.error(`artarius | render ${part}`, err);
    const msg = `${part}: ${err?.message ?? err}`;
    this._renderErrors ??= new Set();
    if ( this._renderErrors.has(msg) ) return;
    this._renderErrors.add(msg);
    this.backend.notify?.("error", `Artarius ${msg}`);
  }

  /** Окно инструмента: у зоны, метки и линии всегда; у «Осмотра» в Foundry — только по кнопке «Слои». */
  _leftVisible() {
    const tool = this.studio.tool;
    if ( !tool ) return false;
    const c = this.leftClosed;
    if ( c && c.tool === tool && c.picks === (this.studio.toolPicks ?? 0) ) return false;
    return !this.host || tool !== "select";
  }

  _leftTitle() {
    const tool = this.studio.tool;
    if ( !tool ) return "";
    const mode = { zone: "zones", mark: "marks", line: "lines" }[tool];
    if ( mode ) return this.t(`ART.Mode.${mode}`);
    return this.t(tool === "select" && this.host ? "ART.Layer.title" : `ART.Tool.${tool}`);
  }

  /* Круглое меню ---------------------------------------------------- */

  renderWheel() {
    const s = this.studio;
    const open = !!s.tool;
    const items = [
      ...["select", "zone", "mark", "line"].map(tool => ({
        action: "tool", attrs: { tool }, icon: TOOL_ICONS[tool], label: this.t(`ART.Tool.${tool}`), active: s.tool === tool
      })),
      { action: "openQueue", icon: "scroll", label: this.t("ART.Queue.title"), badge: this._queueBadge() },
      { action: "help", icon: "circle-question", label: this.t("ART.Guide.title") }
    ];
    for ( const [id, a] of EXTRA_ACTIONS ) {
      if ( a.gmOnly && !this.backend.isGM ) continue;
      if ( a.visible && !a.visible() ) continue;
      items.push({ action: "extra", attrs: { id }, icon: a.icon ?? "star", label: a.label ?? id });
    }
    // Дуга над и справа от центра: от −100° (почти вверх) до +20°. Лишние кнопки — во втором кольце.
    const ring = items.map((it, k) => {
      const outer = k >= 6;
      const r = outer ? 170 : 118;
      const count = outer ? items.length - 6 : Math.min(items.length, 6);
      const idx = outer ? k - 6 : k;
      const a = (-100 + ((120 / Math.max(1, count - 1)) * idx)) * Math.PI / 180;
      const x = Math.round(Math.cos(a) * r), y = Math.round(Math.sin(a) * r);
      return `<button type="button" class="art-wheel-btn${it.active ? " active" : ""}" data-action="${it.action}"${data(it.attrs ?? {})}
        style="--x:${x}px;--y:${y}px" title="${esc(it.label)}" aria-label="${esc(it.label)}">${icon(it.icon)}${it.badge ? `<span class="art-badge">${it.badge}</span>` : ""}</button>`;
    }).join("");
    return `<div class="art-wheel-inner${open ? " open" : ""}">
      ${open ? ring : ""}
      <button type="button" class="art-wheel-hub${open ? " active" : ""}" data-action="toggleMenu"
        title="${esc(this.t(open ? "ART.Menu.close" : "ART.Menu.open"))}" aria-label="${esc(this.t("ART.Menu.open"))}">${icon("dice-d6")}<span>${esc(this.t("ART.Menu.hub"))}</span></button>
    </div>`;
  }

  _queueBadge() {
    if ( this.backend.isGM ) return this.backend.claims().filter(e => ["pending", "rolled"].includes(e.claim.status)).length || "";
    return this.backend.draftOps().length || "";
  }

  /* Левая панель: инструмент ---------------------------------------- */

  renderLeft() {
    const s = this.studio;
    const title = this._leftTitle();
    const closeTitle = esc(this.t("ART.Menu.close"));
    const close = `<button type="button" class="art-icon-btn" data-action="toggleMenu" title="${closeTitle}">${icon("xmark")}</button>`;
    let body = "";
    const kind = { zone: "area", mark: "object", line: "line" }[s.tool];
    body = kind ? this.renderToolWindow(kind) : this.renderSelectTool();
    const undo = `<button type="button" class="art-icon-btn" data-action="undo" ${s.canUndo ? "" : "disabled"}
        title="${esc(this.t("ART.Undo.undo"))}" aria-label="${esc(this.t("ART.Undo.undo"))}">${icon("rotate-left")}</button>
      <button type="button" class="art-icon-btn" data-action="redo" ${s.canRedo ? "" : "disabled"}
        title="${esc(this.t("ART.Undo.redo"))}" aria-label="${esc(this.t("ART.Undo.redo"))}">${icon("rotate-right")}</button>`;
    return `<header class="art-head">${icon(TOOL_ICONS[s.tool])}<h3>${esc(title)}</h3>
      ${this.hintsButton()}${undo}${close}</header>
      <div class="art-body" data-scroll="left">${this.host ? `<div class="art-body-tools">${this.hintsButton()}</div>` : ""}${body}</div>`;
  }

  /** Подсказка-абзац: прячется под «?» в шапке окна (0.9.3), чтобы окна были короче. */
  introHint(key) {
    return this.studio.showHints ? `<p class="art-hint art-intro">${esc(this.t(key))}</p>` : "";
  }

  /** Кнопка «?» в шапке: показать или спрятать подсказки. */
  hintsButton() {
    const on = !!this.studio.showHints;
    return `<button type="button" class="art-icon-btn${on ? " active" : ""}" data-action="toggleHints" aria-pressed="${on}"
      title="${esc(this.t(on ? "ART.Hints.hide" : "ART.Hints.show"))}" aria-label="${esc(this.t("ART.Hints.show"))}">${icon("circle-question")}</button>`;
  }

  renderSelectTool() {
    const gm = this.backend.isGM;
    const keys = [["Shift", "ART.Keys.shift"], ["Ctrl", "ART.Keys.box"], ["Alt", "ART.Keys.alt"], ["Del", "ART.Keys.del"],
      ["Ctrl+Z", "ART.Keys.undo"], ["Shift+␣", "ART.Keys.goto"], ["Esc", "ART.Keys.esc"]]
      .map(([k, t]) => `<li><kbd>${esc(k)}</kbd> <span>${esc(this.t(t))}</span></li>`).join("");
    return `${this.introHint("ART.Select.hint")}
      <section class="art-block"><h4>${esc(this.t("ART.Keys.title"))}</h4><ul class="art-keys">${keys}</ul></section>
      <section class="art-block art-row-btns">
        <button type="button" class="art-btn" data-action="toggleLayerPanel">${icon("layer-group")} ${esc(this.t("ART.Layer.title"))}</button>
        <button type="button" class="art-btn" data-action="openSettings" data-section="world" ${gm ? "" : "hidden"}>${icon("gear")} ${esc(this.t("ART.Settings.open"))}</button>
      </section>`;
  }

  /** Выбор значка: поиск, разделы библиотеки, свой файл и галочка «красить». */
  renderIconPicker(f) {
    const q = (f.iconQuery ?? "").trim();
    const list = q ? searchIcons(q) : allIcons().filter(i => i.category === (f.iconCat || "settlements"));
    const cats = Object.keys(ICON_LIBRARY).map(c => `<button type="button" class="art-btn${!q && c === f.iconCat ? " active" : ""}" data-action="iconCat" data-cat="${c}">${esc(this.t(`ART.Icons.cat.${c}`))}</button>`).join("");
    const grid = list.length
      ? list.map(i => `<button type="button" class="art-icon-pick${i.path === f.icon ? " active" : ""}" data-action="pickIcon" data-icon="${esc(i.path)}" title="${esc(i.label)}">${iconImg(i.path, f.color)}</button>`).join("")
      : `<p class="art-hint">${esc(this.t("ART.Icons.none"))}</p>`;
    return `<div class="art-field"><span>${esc(this.t("ART.Type.icon"))}</span>
      <div class="art-icon-current">${iconImg(f.icon, f.color, { tint: f.tint !== false, cls: "art-icon-big" })}
        <input type="search" data-model="typeForm.iconQuery" data-key="tf-iq" value="${esc(q)}" placeholder="${esc(this.t("ART.Icons.search"))}"></div>
      ${q ? "" : `<div class="art-seg art-icon-cats">${cats}</div>`}
      <div class="art-icons">${grid}</div>
      <div class="art-row-btns"><button type="button" class="art-btn" data-action="browseIcon">${icon("folder-open")} ${esc(this.t("ART.Icons.own"))}</button></div>
      <p class="art-hint">${esc(this.t("ART.Icons.ownHint"))}</p>
      <input type="text" data-model="typeForm.icon" data-key="tf-icon" value="${esc(f.icon)}" placeholder="worlds/…/my-icon.webp">
      <label class="art-check"><input type="checkbox" data-model="typeForm.tint" ${f.tint !== false ? "checked" : ""}> ${esc(this.t("ART.Icons.tint"))}</label>
      <p class="art-hint">${esc(this.t("ART.Icons.credit"))}</p></div>`;
  }

  /**
   * Подпись зоны: изогнутая, прямая или скрытая, и размер. В форме типа (model) — для всех зон типа,
   * в карточке зоны (id) — только для неё; пустое значение — «как у типа».
   */
  renderLabelControls(mode, scale, { model = false, id = "", inherit = "" } = {}) {
    const bind = f => (model ? `data-model="typeForm.${f}"` : `data-id="${esc(id)}" data-field="${f}"`);
    const opts = [["", model ? this.t("ART.Label.auto") : `${this.t("ART.Label.asType")} (${this.t(`ART.Label.${inherit || "straight"}`)})`],
      ["curved", this.t("ART.Label.curved")], ["straight", this.t("ART.Label.straight")], ["none", this.t("ART.Label.none")]]
      .map(([v, n]) => `<option value="${v}"${(mode ?? "") === v ? " selected" : ""}>${esc(n)}</option>`).join("");
    const pct = Math.round((Number(scale) || 1) * 100);
    return `<div class="art-grid2">
      <label class="art-field"><span>${esc(this.t("ART.Label.title"))}</span><select ${bind("labelMode")}>${opts}</select></label>
      <label class="art-field"><span>${esc(this.t("ART.Label.size"))}: ${pct}%</span>
        <input type="range" min="0.4" max="3" step="0.1" value="${esc(String(Number(scale) || 1))}" ${bind("labelScale")} data-key="${model ? "tf-lscale" : `${esc(id)}:lscale`}"></label>
    </div>`;
  }

  /** Выбор формы подложки метки: без id — форма типа (pickShape), с id — одной метки (setShape). */
  renderShapePicker(current, id = "") {
    const cur = shapeOf({ shape: current });
    return `<div class="art-field"><span>${esc(this.t("ART.Shape.title"))}</span><div class="art-patterns art-shapes">${MARK_SHAPES.map(sh =>
      (id
        ? `<button type="button" class="art-pattern-pick${sh === cur ? " active" : ""}" data-action="setShape" data-shape="${sh}" data-id="${esc(id)}"
          title="${esc(this.t(`ART.Shape.${sh}`))}">${shapeSwatch(sh)}</button>`
        : `<button type="button" class="art-pattern-pick${sh === cur ? " active" : ""}" data-action="pickShape" data-shape="${sh}"
          title="${esc(this.t(`ART.Shape.${sh}`))}">${shapeSwatch(sh)}</button>`)).join("")}</div></div>`;
  }

  /** Вид линии в форме типа: форма, излом, узор, толщина в начале и в конце. */
  renderLineStyle(f) {
    const seg = (list, cur, key) => `<div class="art-seg">${list.map(v => key === "shape"
      ? `<button type="button" class="art-btn${v === cur ? " active" : ""}" data-action="lineShape" data-v="${v}">${esc(this.t(`ART.LineStyle.${v}`))}</button>`
      : `<button type="button" class="art-btn${v === cur ? " active" : ""}" data-action="linePattern" data-v="${v}">${esc(this.t(`ART.LineStyle.${v}`))}</button>`).join("")}</div>`;
    return `<div class="art-field"><span>${esc(this.t("ART.LineStyle.shape"))}</span>${seg(LINE_SHAPES, f.lineShape, "shape")}</div>
      ${f.lineShape === "rounded" ? `<label class="art-field"><span>${esc(this.t("ART.LineStyle.bend"))} <b>${Math.round((f.bend ?? 0.5) * 100)}%</b></span>
        <input type="range" min="0" max="1" step="0.05" value="${esc(f.bend ?? 0.5)}" data-model="typeForm.bend" data-key="tf-bend"></label>` : ""}
      <div class="art-field"><span>${esc(this.t("ART.LineStyle.pattern"))}</span>${seg(LINE_PATTERNS, f.linePattern, "pattern")}</div>
      <div class="art-grid2">
        <label class="art-field"><span>${esc(this.t("ART.LineStyle.widthStart"))}</span><input type="number" min="1" max="40" step="1" value="${esc(f.widthStart)}" data-model="typeForm.widthStart" data-key="tf-w0"></label>
        <label class="art-field"><span>${esc(this.t("ART.LineStyle.widthEnd"))}</span><input type="number" min="1" max="40" step="1" value="${esc(f.widthEnd)}" data-model="typeForm.widthEnd" data-key="tf-w1"></label>
      </div>
      <div class="art-line-preview">${this.linePreview(f)}</div>`;
  }

  /** Образец линии в форме типа (SVG). */
  /** Кнопки штриховки зон для формы типа. */
  patternButtons(current) {
    const cur = current || "none";
    return PATTERNS.map(p => `<button type="button" class="art-pattern-pick${p === cur ? " active" : ""}" data-action="pickPattern" data-pattern="${p}" title="${esc(this.t(`ART.Pattern.${p}`))}">${patternSwatch(p)}</button>`).join("");
  }

  linePreview(f) {
    const pts = [[8, 34], [60, 10], [112, 34], [164, 10], [212, 30]];
    const style = { shape: f.lineShape, bend: f.bend, pattern: f.linePattern, meander: 0 };
    const curve = lineCurve(pts, style);
    const w = Math.max(Number(f.widthStart) || 3, Number(f.widthEnd) || 3);
    const [dash, gap] = lineDash(style, w);
    const d = curve.map(([x, y], n) => `${n ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    return `<svg viewBox="0 0 220 44" width="100%" height="44" aria-hidden="true"><path d="${d}" fill="none" stroke="${esc(f.color)}" stroke-width="${w}"
      stroke-linecap="round" stroke-linejoin="round"${dash > 0 ? ` stroke-dasharray="${dash < 1 ? 0 : dash} ${gap}"` : ""}/></svg>`;
  }

  /* Панель на гексе ------------------------------------------------- */

  /** Панель видна, когда гекс выбран, инструменты Артария включены и интерфейс не спрятан. */
  _hudVisible() {
    const s = this.studio;
    return !!(this.project && s.hudOpen && s.inspected && s.tool && !this._hidden);
  }

  renderHud() {
    const on = this._hudVisible();
    this.hud.hidden = !on;
    if ( !on ) {
      if ( this._hudFrame ) cancelAnimationFrame(this._hudFrame);
      this._hudFrame = null;
      this._hudAt = null;
      return;
    }
    // Быстрый осмотр 7А (0.9.9): плашка над гексом, меню справа от него.
    patch(this.hud, this.renderQuickInspect());
    this._placeHud();
    // Панель едет за гексом, пока карту двигают и приближают: место сверяем каждый кадр.
    if ( !this._hudFrame ) {
      const loop = () => {
        this._hudFrame = this._hudVisible() ? requestAnimationFrame(loop) : null;
        if ( this._hudFrame ) this._placeHud();
      };
      this._hudFrame = requestAnimationFrame(loop);
    }
  }

  /** Подсказка над линией под курсором: название участка или всей линии. */
  renderTip() {
    const h = this.studio.hoverLine;
    if ( !h || !this.project || this._hidden || this.studio.markDrag ) { this.tip.hidden = true; return; }
    let p;
    try { p = this.project(h.at); } catch { this.tip.hidden = true; return; }
    const html = this.hoverCard(h);
    if ( !html ) { this.tip.hidden = true; return; }
    if ( this._tipKey !== html ) { this.tip.innerHTML = html; this._tipKey = html; }
    this.tip.style.left = `${Math.round(p.x)}px`;
    this.tip.style.top = `${Math.round(p.y)}px`;
    this.tip.hidden = false;
  }

  /** Карточка при наведении: название, тип, хозяин, статусы и аспекты значками с уровнями. */
  hoverCard(h) {
    const st = this.studio.stateOf(h.id);
    if ( !st ) return h.name ? `<b>${esc(h.name)}</b>` : "";
    const type = this.studio.typeById(st.system.typeId);
    const title = h.name || st.name || type?.name || "";
    const sub = [type && type.name !== title ? type.name : "", this.demiurgeNames(st)].filter(Boolean).map(esc).join(" · ");
    const chips = this.statusChips(st);
    if ( !title && !sub && !chips ) return "";
    return `<div class="art-hc-title">${esc(title)}</div>${sub ? `<div class="art-hc-sub">${sub}</div>` : ""}${chips ? `<div class="art-hc-chips">${chips}</div>` : ""}`;
  }

  /** Статусы и аспекты как значки с уровнем: точки, если уровней до пяти, иначе «3/7». */
  statusChips(st, { limit = 8 } = {}) {
    const chip = (x, aspect) => {
      const has = x.value !== null && x.value !== undefined && x.value !== "";
      const max = Number(x.max) || 0;
      const level = !has ? "" : (max > 0 && max <= 5
        ? `<span class="art-pips">${Array.from({ length: max }, (_, n) => `<i class="${n < Number(x.value) ? "on" : ""}"></i>`).join("")}</span>`
        : `<span class="art-lvl">${esc(String(x.value))}${max ? `/${max}` : ""}</span>`);
      const ic = x.icon || (aspect ? (x.key ? statusIcon(x) : "star") : statusIcon(x));
      return `<span class="art-chip${aspect ? " art-chip-aspect" : ""}" title="${esc(formatStatus(x))}">${icon(ic)}<span>${esc(x.name)}</span>${level}</span>`;
    };
    const list = [...(st.system.statuses ?? []).filter(x => x.name).map(x => chip(x, false)),
      ...(st.system.aspects ?? []).filter(x => x.name).map(x => chip(x, true))];
    const more = list.length > limit ? `<span class="art-chip art-chip-more">+${list.length - limit}</span>` : "";
    return list.slice(0, limit).join("") + more;
  }

  /** Поставить панель по гексу: центр и полуразмеры гекса на экране. */
  _placeHud() {
    const s = this.studio;
    if ( !s.inspected ) return;
    let box;
    try {
      // Несколько гексов: панель обнимает их все, а не последний, чтобы кнопки не закрывали выбор.
      const cells = s.multi ? s.inspectCells() : [s.inspected];
      const pts = cells.flatMap(c => s.grid.vertices(c)).map(v => this.project(v));
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      box = [Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2), Math.round((x1 - x0) / 2), Math.round((y1 - y0) / 2)];
    } catch { return; }
    const key = box.join();
    if ( key === this._hudAt ) return;
    this._hudAt = key;
    const [x, y, hw, hh] = box;
    const st = this.hud.style;
    st.left = `${x}px`;
    st.top = `${y}px`;
    st.setProperty("--hw", `${hw}px`);
    st.setProperty("--hh", `${hh}px`);
  }

  /** Значок элемента для кнопки: значок метки, цвет зоны или линии. */
  _hudItemIcon(st) {
    const type = this.studio.typeById(st.system.typeId);
    const color = st.system.style?.color ?? type?.style?.color ?? "#ccc";
    const kind = st.system.kind;
    if ( kind === "object" ) {
      const path = st.system.style?.icon ?? type?.style?.icon;
      const tint = (st.system.style?.tint ?? type?.style?.tint) !== false;
      if ( path ) return iconImg(path, st.system.style?.iconColor ?? color, { tint, cls: "art-hud-ico" });
    }
    if ( kind === "line" ) return `<i class="art-hud-line" style="--c:${esc(color)}"></i>`;
    return `<i class="art-hud-swatch" style="--c:${esc(color)}"></i>`;
  }


  /** Быстрое меню у панели гекса: выбор типа метки или какую метку удалить. */
  _hudMenu(sum, current) {
    const s = this.studio;
    const m = s.hudMenu;
    if ( !m ) return "";
    if ( m.kind === "zone" ) return this._hudZoneMenu(m);
    if ( m.kind === "type" ) {
      const rows = s.markTypesForMenu().map(t => `<button type="button" class="art-menu-row${t.id === current?.id ? " active" : ""}" data-action="quickMark" data-id="${esc(t.id)}">
        ${this.typeSwatch(t)}<span>${esc(t.name)}</span></button>`).join("");
      return `<div class="art-hud-menu" role="menu"><div class="art-menu-head">${esc(this.t("ART.Hud.markPick"))}</div>${rows}</div>`;
    }
    const rows = sum.marks.map(st => `<button type="button" class="art-menu-row art-menu-del" data-action="deleteMark" data-id="${esc(st.id)}">
        ${this._hudItemIcon(st)}<span>${esc(st.name || this.t("ART.Card.unnamed"))}</span>${icon("trash")}</button>`).join("");
    return `<div class="art-hud-menu" role="menu"><div class="art-menu-head">${esc(this.t("ART.Hud.deleteWhich"))}</div>${rows}</div>`;
  }

  /**
   * Меню «Добавить в зону»: поиск и справочник «слой → тип → зоны», пустые зоны тоже.
   * Щелчок кладёт гекс в зону. Внизу — новая зона текущего типа, как раньше.
   */
  _hudZoneMenu(m) {
    const s = this.studio;
    const here = new Set(s.contents().zones.map(z => z.id));
    const types = s.types;
    const colorOf = st => st.system.style?.color ?? types.find(t => t.id === st.system.typeId)?.style?.color ?? "#ccc";
    const groups = s.zoneCatalog(m.q ?? "").map(({ layer, types: list }) => {
      const rows = list.flatMap(({ type, zones }) => zones.map(z => {
        const n = zoneCells(z).length;
        const inside = here.has(z.id);
        return `<button type="button" class="art-menu-row${inside ? " active" : ""}" data-action="hudZoneAdd" data-id="${esc(z.id)}" ${inside ? "disabled" : ""}
          title="${esc(`${type?.name ?? ""} · ${this.t("ART.Zone.cells", { n })}`)}"><i class="art-swatch" style="--c:${esc(colorOf(z))}"></i>
          <span>${esc(z.name || this.t("ART.Card.unnamed"))}</span><small class="art-row-note">${n}</small></button>`;
      })).join("");
      return rows ? `<div class="art-menu-head">${esc(layer.name)}</div>${rows}` : "";
    }).join("");
    const zoneType = s.typeById(s.zone.typeId) ?? s.typesOf("area")[0];
    return `<div class="art-hud-menu art-hud-zones" role="menu"><div class="art-menu-head">${esc(this.t("ART.Hud.zoneAdd"))}</div>
      <input type="search" class="art-search" data-model="hudMenu.q" data-key="hud-zone-q" value="${esc(m.q ?? "")}" placeholder="${esc(this.t("ART.Zone.find"))}">
      ${groups || `<p class="art-empty">${esc(this.t("ART.Zone.noneFound"))}</p>`}
      <button type="button" class="art-menu-row art-menu-new" data-action="hudZoneNew">${icon("plus")}<span>${esc(this.t("ART.Hud.zoneNew", { name: zoneType?.name ?? "" }))}</span></button></div>`;
  }

  /** Панель внизу: сколько меток выбрано и что с ними сделать. */
  renderBar() {
    const s = this.studio;
    const marks = s.tool && !this._hidden ? s.selectedMarks() : [];
    this.bar.hidden = !marks.length;
    if ( !marks.length ) return;
    const types = s.typesOf("object").map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
    patch(this.bar, `<div class="art-bar-in">
      <b class="art-bar-count">${esc(this.t("ART.Bar.count", { n: marks.length }))}</b>
      <select data-change="bulkType" aria-label="${esc(this.t("ART.Bar.retype"))}"><option value="">${esc(this.t("ART.Bar.retype"))}</option>${types}</select>
      <button type="button" class="art-btn art-danger" data-action="deleteSelected" title="${esc(this.t("ART.Bar.deleteHint"))}">${icon("trash")} ${esc(this.t("ART.Bar.delete"))} <kbd>Del</kbd></button>
      <button type="button" class="art-btn art-icon-only" data-action="clearMarkSel" title="${esc(this.t("ART.Bar.clear"))}" aria-label="${esc(this.t("ART.Bar.clear"))}">${icon("xmark")}</button>
    </div>`);
  }

  /**
   * Плашка «Слои · набор» у названия сцены. Щелчок открывает окно слоёв:
   * набор слоёв и выключатель у каждого слоя, как панель «Слои» в Azgaar.
   */
  renderLayerbar() {
    const s = this.studio;
    const el = this.layerbar;
    el.hidden = !!this._hidden || (this.backend.isWorld && !this.backend.isWorld());
    const open = !!s.layersOpen && !el.hidden;
    if ( this.parts.layers ) {
      if ( open ) patch(this.parts.layers, this.renderLayersWindow());
      this._show("layers", open, this.t("ART.Layer.title"));
    }
    if ( el.hidden ) return;
    // Полоса режимов (0.9.9): Осмотр, Зоны, Метки, Линии, Заявки, Слои с названием набора.
    patch(el, `<nav class="art-modes" aria-label="${esc(this.t("ART.Mode.title"))}">${this.renderModes()}</nav>`);
    this._placeLayerbar();
  }

  /**
   * Панели внизу по центру, снизу вверх: кисть, выбранные метки, полоса режимов, «Отменить» (0.9.4–0.9.5).
   * Место считается от высоты окна браузера и ставится через top: если тема Foundry растягивает
   * или сдвигает body, отсчёт от его низа (bottom) уводит панели за край экрана.
   * Над панелью макросов Foundry, если она видна внизу.
   */
  _placeLayerbar() {
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    let y = vh - BAR_BOTTOM;
    const hot = document.getElementById("hotbar")?.getBoundingClientRect?.();
    if ( hot && hot.height && hot.top > vh / 2 && hot.top < vh ) y = Math.min(y, hot.top - BAR_GAP);
    for ( const el of [this.brushbar, this.bar, this.layerbar, this.toastEl] ) {
      if ( !el || el.hidden ) continue;
      const h = el.offsetHeight || 44;
      el.style.top = `${Math.max(BAR_GAP, Math.round(y - h))}px`;
      el.style.bottom = "auto";
      y -= h + BAR_GAP;
    }
  }

  /**
   * Цвета панелей у низа экрана берутся у кнопок сцены Foundry: так полосы выглядят как интерфейс,
   * который включён (ядро, Carolingian UI или другая тема). Нет кнопок — остаётся своя палитра.
   */
  _syncTheme() {
    const pick = sel => { for ( const q of sel ) { const el = document.querySelector(q); if ( el ) return el; } return null; };
    const btn = pick(["#scene-controls-layers button:not(.active)", "#scene-controls button.control:not(.active)", "#scene-controls button:not(.active)", "#controls .scene-control:not(.active)"]);
    const on = pick(["#scene-controls-tools button.active", "#scene-controls button.active", "#scene-controls .active", "#controls .control-tool.active"]);
    const side = pick(["#sidebar-content", "#sidebar .sidebar-tab.active", "#sidebar"]);
    const solid = c => c && !/^(transparent|rgba\(\s*0,\s*0,\s*0,\s*0\s*\))$/i.test(c.trim());
    const vars = {};
    if ( btn ) {
      const cs = getComputedStyle(btn);
      if ( solid(cs.color) ) vars["--art-bar-ink"] = cs.color;
      if ( solid(cs.borderTopColor) && parseFloat(cs.borderTopWidth) > 0 ) vars["--art-bar-line"] = cs.borderTopColor;
      if ( solid(cs.backgroundColor) ) vars["--art-bar-btn"] = cs.backgroundColor;
    }
    if ( on ) {
      const cs = getComputedStyle(on);
      if ( solid(cs.backgroundColor) ) vars["--art-bar-on-bg"] = cs.backgroundColor;
      if ( solid(cs.color) ) vars["--art-bar-on-ink"] = cs.color;
    }
    if ( side ) {
      const bg = getComputedStyle(side).backgroundColor;
      if ( solid(bg) ) vars["--art-bar-bg"] = bg;
    }
    const key = JSON.stringify(vars);
    if ( key === this._themeKey ) return;
    this._themeKey = key;
    for ( const el of [this.bar, this.brushbar, this.layerbar, this.toastEl] ) {
      if ( !el ) continue;
      for ( const name of ["--art-bar-ink", "--art-bar-line", "--art-bar-btn", "--art-bar-on-bg", "--art-bar-on-ink", "--art-bar-bg"] ) {
        if ( vars[name] ) el.style.setProperty(name, vars[name]);
        else el.style.removeProperty(name);
      }
      el.classList.toggle("art-themed", Object.keys(vars).length > 0);
    }
  }

  /** Кисть зон внизу экрана: зона, «Красить сразу», ластик, «Готово». Видна у кисти зон. */
  renderBrushbar() {
    const s = this.studio;
    const on = s.tool === "zone" && !this._hidden && (!this.backend.isWorld || this.backend.isWorld());
    this.brushbar.hidden = !on;
    if ( !on ) return;
    const z = s.zone;
    const target = z.target !== "new" ? s.states.get(z.target) : null;
    const type = target ? s.typeById(target.system.typeId) : s.typeById(z.typeId);
    const color = target?.system.style?.color ?? type?.style?.color ?? "#ccc";
    const what = target ? (target.name || this.t("ART.Card.unnamed")) : this.t("ART.Brush.newOf", { name: type?.name ?? "" });
    const mode = z.erase ? "erase" : z.paint ? "paint" : "pick";
    const seg = ["pick", "paint", "erase"].map(m => `<button type="button" class="art-btn${mode === m ? " active" : ""}" data-action="brushMode" data-mode="${m}"
      aria-pressed="${mode === m}" title="${esc(this.t(`ART.Brush.hint.${m}`))}">${icon({ pick: "hand-pointer", paint: "paintbrush", erase: "eraser" }[m])} ${esc(this.t(`ART.Brush.${m}`))}</button>`).join("");
    const n = s.selection.size;
    patch(this.brushbar, `<div class="art-brush-in">
      <span class="art-brush-target" title="${esc(this.t("ART.Brush.eyedrop"))}"><i class="art-swatch" style="--c:${esc(color)}"></i><b>${esc(what)}</b></span>
      <div class="art-seg">${seg}</div>
      ${mode === "pick" && n ? `<button type="button" class="art-btn art-accent" data-action="attach">${icon("check")} ${esc(this.t(target ? "ART.Zone.attachTo" : "ART.Zone.create", { n, name: target?.name ?? "" }))}</button>` : ""}
      <button type="button" class="art-btn" data-action="brushDone" title="Esc">${icon("check")} ${esc(this.t("ART.Brush.done"))}</button>
    </div>`);
  }

  /** «Удалено · Отменить»: живёт несколько секунд, Ctrl+Z работает и без неё. */
  renderToast() {
    const t = this.studio.toast;
    const on = !!t && !this._hidden && Date.now() - t.at < TOAST_MS;
    this.toastEl.hidden = !on;
    if ( !on ) return;
    patch(this.toastEl, `<span>${esc(t.text)}</span>
      ${t.undo ? `<button type="button" class="art-btn" data-action="undo">${icon("rotate-left")} ${esc(this.t("ART.Toast.undo"))} <kbd>Ctrl+Z</kbd></button>` : ""}
      <button type="button" class="art-icon-btn" data-action="hideToast" aria-label="${esc(this.t("ART.Close"))}">${icon("xmark")}</button>`);
    if ( this._toastId !== t.id ) {
      this._toastId = t.id;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { if ( this.studio.toast?.id === t.id ) this.studio.hideToast(); }, TOAST_MS);
    }
  }

  toggleLayerPanel(force = null) {
    this.studio.toggleLayers(force);
  }

  /** Поле «Перейти к гексу» (Shift+Пробел). */
  openGoto() {
    const g = this.goto;
    g.innerHTML = `<form class="art-goto-in"><label for="art-goto-field">${esc(this.t("ART.Goto.title"))}</label>
      <input id="art-goto-field" type="text" inputmode="numeric" autocomplete="off" placeholder="${esc(this.t("ART.Goto.ph"))}">
      <span class="art-hint">${esc(this.t("ART.Goto.hint"))}</span></form>`;
    g.hidden = false;
    const input = g.querySelector("input");
    const close = () => { g.hidden = true; g.innerHTML = ""; };
    g.querySelector("form").addEventListener("submit", ev => {
      ev.preventDefault();
      if ( this.studio.goTo(input.value) ) close();
    });
    input.addEventListener("keydown", ev => {
      ev.stopPropagation();
      if ( ev.key === "Escape" ) close();
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
    input.focus();
  }

  /* Схема «список и правка рядом» (макет C от 19.11) --------------- */

  /** Размер метки, как у токена: сколько клеток занимает и масштаб вида внутри них. */
  renderMarkSize(st, type, id) {
    const style = { ...(type?.style ?? {}), ...(st.system.style ?? {}) };
    const cells = style.cells ?? 1;
    const pct = Math.round((style.size ?? 0.62) * 100);
    const opts = [1, 2, 3, 4].map(n => `<option value="${n}"${n === cells ? " selected" : ""}>${n}×${n}</option>`).join("");
    return `<div class="art-grid2">
      <label class="art-field"><span>${esc(this.t("ART.Size.cells"))}</span><select data-id="${esc(id)}" data-field="cells">${opts}</select></label>
      <label class="art-field"><span>${esc(this.t("ART.Size.scale", { n: pct }))}</span>
        <input type="range" min="20" max="200" step="5" value="${pct}" data-change="markScale" data-id="${esc(id)}"></label>
    </div><p class="art-hint">${esc(this.t("ART.Size.hint"))}</p>`;
  }

  /** Две колонки: слева список, справа правка выбранного. На узком окне колонки встают друг под друга. */
  renderSplit(list, main, key) {
    return `<div class="art-split"><nav class="art-split-list" data-scroll="${esc(key)}-list">${list}</nav>
      <div class="art-split-main" data-scroll="${esc(key)}-main">${main}</div></div>`;
  }

  /** Строка списка: значок, название, мелкая подпись справа. */
  listRow({ action, id, active, sw, name, note = "", attrs = "" }) {
    return `<button type="button" class="art-row-item${active ? " active" : ""}" data-action="${action}" data-id="${esc(id)}"${attrs}>
      ${sw}<span class="art-row-name">${esc(name)}</span>${note ? `<span class="art-row-note">${esc(note)}</span>` : ""}</button>`;
  }

  /** Образец типа для списка: значок метки, полоска линии или квадрат зоны. */
  typeSwatch(t) {
    const st = t?.style ?? {};
    const c = st.color ?? "#ccc";
    if ( t?.kind === "object" && st.emoji ) return `<span class="art-row-ico art-emoji">${esc(st.emoji)}</span>`;
    if ( t?.kind === "object" && st.icon ) return iconImg(st.icon, c, { tint: st.tint !== false, cls: "art-row-ico" });
    if ( t?.kind === "line" ) return `<i class="art-line-sw" style="--c:${esc(c)}"></i>`;
    return `<i class="art-swatch" style="--c:${esc(c)}"></i>`;
  }

  /* Окно настроек модуля -------------------------------------------- */

  renderSettings() {
    const s = this.studio;
    const gm = this.backend.isGM;
    const sec = s.settings.section;
    // С 0.9.9 типы правятся в окнах инструментов, слои — в окне «Слои». Здесь мир и права.
    const secs = [
      gm && { id: "world", ic: "earth-europe" },
      gm && { id: "rights", ic: "user-shield" }
    ].filter(Boolean);
    const tabs = `<nav class="art-tabs art-settings-tabs">${secs.map(x => `<button type="button" class="${x.id === sec ? "active" : ""}"
      data-action="settingsSection" data-section="${x.id}">${icon(x.ic)} ${esc(this.t(`ART.Settings.sec.${x.id}`))}</button>`).join("")}</nav>`;
    let body;
    if ( !gm ) body = `<p class="art-empty">${esc(this.t("ART.Settings.gmOnly"))}</p>`;
    else if ( sec === "rights" ) body = this.renderRights();
    else body = this.renderWorldSection();
    const head = `<header class="art-head">${icon("gear")}<h3>${esc(this.t("ART.Settings.title"))}</h3>
      <button type="button" class="art-icon-btn" data-action="closeSettings" title="${esc(this.t("ART.Close"))}">${icon("xmark")}</button></header>`;
    return `${head}<div class="art-body art-settings-body">${tabs}${body}</div>`;
  }

  /**
   * Права игроков: строки — роли и отдельные игроки, столбцы — что можно.
   * У роли галочка, у игрока выбор «как у роли / можно / нельзя».
   */
  renderRights() {
    const cfg = this.backend.permissionConfig?.() ?? {};
    const PERMS = ["place", "draw", "editOthers", "statuses"];
    const head = `<tr><th></th>${PERMS.map(p => `<th>${esc(this.t(`ART.Perm.${p}`))}</th>`).join("")}</tr>`;
    const ROLE = { 1: "ART.Perm.player", 2: "ART.Perm.trusted" };
    const roleRows = [1, 2].map(r => `<tr><th>${esc(this.t(ROLE[r]))}</th>${PERMS.map(p => {
      const on = cfg.roles?.[r]?.[p] ?? true;
      return `<td><input type="checkbox" data-change="permRole" data-role="${r}" data-perm="${p}" ${on ? "checked" : ""} aria-label="${esc(this.t(`ART.Perm.${p}`))}"></td>`;
    }).join("")}</tr>`).join("");
    const users = this.backend.roster?.() ?? [];
    const userRows = users.map(u => `<tr><th>${esc(u.name)}</th>${PERMS.map(p => {
      const v = cfg.users?.[u.id]?.[p];
      const opt = (val, label) => `<option value="${val}"${String(v ?? "") === val ? " selected" : ""}>${esc(this.t(label))}</option>`;
      return `<td><select data-change="permUser" data-user="${esc(u.id)}" data-perm="${p}" aria-label="${esc(this.t(`ART.Perm.${p}`))}">
        ${opt("", "ART.Perm.asRole")}${opt("true", "ART.Perm.yes")}${opt("false", "ART.Perm.no")}</select></td>`;
    }).join("")}</tr>`).join("");
    return `<p class="art-hint">${esc(this.t("ART.Perm.hint"))}</p>
      <table class="art-rights"><thead>${head}</thead><tbody>${roleRows}</tbody></table>
      ${users.length ? `<h4>${esc(this.t("ART.Perm.players"))}</h4><table class="art-rights"><thead>${head}</thead><tbody>${userRows}</tbody></table>` : `<p class="art-empty">${esc(this.t("ART.Perm.noPlayers"))}</p>`}`;
  }

  async _setPerm(fn) {
    const cfg = this.backend.permissionConfig?.() ?? {};
    fn(cfg);
    await this.backend.setPermissionConfig?.(cfg);
  }

  /**
   * Вкладка «Мир»: настройки поля, импорт Azgaar и генератор раскрываются на месте, без отдельных окон.
   * Набранное в полях живёт в this.wf, пока окно перерисовывается.
   */
  renderWorldSection() {
    const info = this.backend.worldInfo?.();
    if ( !info ) return `<p class="art-empty">${esc(this.t("VMAP.Azgaar.noScene"))}</p>`;
    const wf = this.wf ??= { settings: {}, azgaar: {}, gen: {} };
    const open = this.wfOpen ??= new Set(["settings"]);
    const val = (form, name, def) => wf[form][name] ?? def;
    const num = (form, name, def, min, max, step = 1) => `<input type="number" data-wf="${form}.${name}" value="${esc(String(val(form, name, def)))}" min="${min}" max="${max}" step="${step}">`;
    const check = (form, name, def) => `<input type="checkbox" data-wf="${form}.${name}" ${val(form, name, def) ? "checked" : ""}>`;
    const row = (label, input, hint = "") => `<label class="art-field"><span>${esc(this.t(label))}</span>${input}</label>${hint ? `<p class="art-hint">${esc(this.t(hint))}</p>` : ""}`;
    const fold = (id, ic, title, body) => `<details class="art-acc" data-fold="${id}" ${open.has(id) ? "open" : ""}>
      <summary>${icon(ic)} <span>${esc(this.t(title))}</span></summary><div class="art-acc-body">${body}</div></details>`;
    const d = info.dims, w = info.world;
    const settings = `<div class="art-grid3">
        ${row("ART.Scene.cols", num("settings", "cols", d.cols, 5, 300))}
        ${row("ART.Scene.rows", num("settings", "rows", d.rows, 5, 300))}
        ${row("ART.Scene.size", num("settings", "size", d.size, 30, 400, 5))}</div>
      <p class="art-hint">${esc(this.t("ART.World.sizeHint"))}</p>
      <div class="art-grid3">
        ${row("ART.Scene.baseColor", `<input type="color" data-wf="settings.baseColor" value="${esc(val("settings", "baseColor", w.baseColor))}">`)}
        ${row("ART.Scene.gridColor", `<input type="color" data-wf="settings.gridColor" value="${esc(val("settings", "gridColor", w.gridColor))}">`)}
        ${row("ART.Scene.gridAlpha", num("settings", "gridAlpha", w.gridAlpha, 0, 1, 0.05))}</div>
      <label class="art-field"><span>${esc(this.t("ART.World.style"))}</span><select data-wf="settings.style">${["atlas", "flat"].map(v => `<option value="${v}" ${val("settings", "style", w.style ?? "atlas") === v ? "selected" : ""}>${esc(this.t(`ART.World.style_${v}`))}</option>`).join("")}</select></label>
      <p class="art-hint">${esc(this.t("ART.World.styleHint"))}</p>
      <label class="art-check">${check("settings", "rough", w.rough)} ${esc(this.t("ART.World.rough"))}</label>
      <p class="art-hint">${esc(this.t("ART.World.roughHint"))}</p>
      <div class="art-row-btns"><button type="button" class="art-btn art-accent" data-action="wfSettings">${icon("floppy-disk")} ${esc(this.t("ART.Save"))}</button>
        <button type="button" class="art-btn" data-action="sceneThumb" title="${esc(this.t("ART.World.thumbHint"))}">${icon("image")} ${esc(this.t("ART.World.thumb"))}</button></div>`;
    const PARTS = ["terrain", "states", "provinces", "cultures", "religions", "burgs", "rivers", "routes", "markers", "armies"];
    const DEF = { provinces: false };
    const file = this.azgaarFile;
    const azgaar = `<p class="art-hint">${esc(this.t("VMAP.Azgaar.generateHint"))}</p>
      <div class="art-row-btns">
        <button type="button" class="art-btn" data-action="azgaarGenerator">${icon("wand-magic-sparkles")} ${esc(this.t("VMAP.Azgaar.openGenerator"))}</button>
        <button type="button" class="art-btn" data-action="azgaar">${icon("up-right-from-square")} ${esc(this.t("ART.World.azgaarWindow"))}</button></div>
      <p class="art-hint">${esc(this.t("VMAP.Azgaar.importHint"))}</p>
      <label class="art-btn art-file-btn">${icon("file-arrow-up")} ${esc(file ? file.name : this.t("VMAP.Azgaar.file"))}
        <input type="file" accept=".json,application/json" data-wf-file="azgaar" hidden></label>
      <div class="art-parts">${PARTS.map(k => `<label class="art-check">${check("azgaar", `part.${k}`, DEF[k] ?? true)} ${esc(this.t(`VMAP.Azgaar.part.${k}`))}</label>`).join("")}</div>
      <label class="art-check">${check("azgaar", "replace", true)} ${esc(this.t("VMAP.Azgaar.replace"))}</label>
      <label class="art-check">${check("azgaar", "fit", true)} ${esc(this.t("VMAP.Azgaar.fit"))}</label>
      ${row("VMAP.Azgaar.cols", num("azgaar", "cols", d.cols, 5, 300), "VMAP.Azgaar.fitHint")}
      <div class="art-row-btns"><button type="button" class="art-btn art-accent" data-action="wfImport" ${file && !this.wfBusy ? "" : "disabled"}>
        ${icon(this.wfBusy === "azgaar" ? "spinner fa-spin" : "file-import")} ${esc(this.t("VMAP.Azgaar.doImport"))}</button></div>`;
    const seed = this.wfSeed ??= Math.floor(Math.random() * 1e9).toString(36);
    const recipes = [["", this.t("ART.Gen.recipeAny")], ...RECIPES.map(r => [r.id, r.name])]
      .map(([id, name]) => `<option value="${esc(id)}"${(val("gen", "recipe", "") === id) ? " selected" : ""}>${esc(name)}</option>`).join("");
    const gen = `<div class="art-row-btns"><button type="button" class="art-btn art-accent art-wide" data-action="wfQuickWorld" ${this.wfBusy ? "disabled" : ""}>
        ${icon(this.wfBusy === "quick" ? "spinner fa-spin" : "dice")} ${esc(this.t("ART.Gen.quick"))}</button></div>
      <p class="art-hint">${esc(this.t("ART.Gen.quickHint"))}</p>
      <details class="art-fold-inner" data-fold="gen-more"${(this.wfOpen ?? new Set()).has("gen-more") ? " open" : ""}><summary>${esc(this.t("ART.Gen.more"))}</summary>
      <p class="art-hint">${esc(this.t("ART.Gen.hint"))}</p>
      <label class="art-field"><span>${esc(this.t("ART.Gen.recipe"))}</span><select data-wf="gen.recipe">${recipes}</select></label>
      <div class="art-grid3">
        ${row("ART.Scene.cols", num("gen", "cols", d.cols, 5, 300))}
        ${row("ART.Scene.rows", num("gen", "rows", d.rows, 5, 300))}
        ${row("ART.Scene.size", num("gen", "size", d.size, 30, 400, 5))}</div>
      <label class="art-field"><span>${esc(this.t("ART.Gen.seed"))}</span><input type="text" data-wf="gen.seed" value="${esc(val("gen", "seed", seed))}"></label>
      <div class="art-grid3">
        ${row("ART.Gen.water", num("gen", "water", 35, 0, 80, 5))}
        ${row("ART.Gen.mountains", num("gen", "mountains", 10, 0, 40))}
        ${row("ART.Gen.resources", num("gen", "resources", 10, 0, 60))}</div>
      ${row("ART.Gen.neutral", num("gen", "neutral", 50, 0, 100, 10), "ART.Gen.neutralHint")}
      ${row("ART.Gen.realms", num("gen", "realms", info.players || 3, 0, 12), "ART.Gen.realmsHint")}
      <label class="art-check">${check("gen", "rough", info.roughDefault)} ${esc(this.t("ART.World.rough"))}</label>
      <label class="art-check">${check("gen", "clear", true)} ${esc(this.t("ART.Gen.clear"))}</label>
      <p class="art-hint">${esc(this.t("ART.Gen.clearHint"))}</p>
      <div class="art-row-btns"><button type="button" class="art-btn art-accent" data-action="wfGenerate" ${this.wfBusy ? "disabled" : ""}>
        ${icon(this.wfBusy === "gen" ? "spinner fa-spin" : "wand-magic-sparkles")} ${esc(this.t("ART.Gen.go"))}</button></div></details>`;
    return `<div class="art-accs">
      ${fold("settings", "sliders", "ART.World.settings", settings)}
      ${fold("azgaar", "earth-europe", "ART.World.azgaar", azgaar)}
      ${fold("gen", "mountain-sun", "ART.Gen.title", gen)}
    </div><p class="art-hint">${esc(this.t("ART.Settings.worldHint"))}</p>`;
  }

  /** Поля вкладки «Мир» в виде настроек: значения из this.wf поверх того, что сейчас на сцене. */
  _wfValues(form) {
    const info = this.backend.worldInfo?.() ?? { dims: {}, world: {} };
    const v = this.wf?.[form] ?? {};
    const n = (x, def) => (x === undefined || x === "" ? def : Number(x));
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    if ( form === "settings" ) return {
      dims: { cols: n(v.cols, info.dims.cols), rows: n(v.rows, info.dims.rows), size: n(v.size, info.dims.size) },
      world: {
        baseColor: v.baseColor ?? info.world.baseColor, gridColor: v.gridColor ?? info.world.gridColor,
        gridAlpha: clamp(n(v.gridAlpha, info.world.gridAlpha) || 0, 0, 1), rough: v.rough ?? !!info.world.rough,
        style: v.style ?? info.world.style ?? "atlas"
      }
    };
    if ( form === "azgaar" ) {
      const parts = { terrain: true, states: true, provinces: false, cultures: true, religions: true, burgs: true, rivers: true, routes: true, markers: true, armies: true };
      for ( const k of Object.keys(parts) ) if ( v[`part.${k}`] !== undefined ) parts[k] = !!v[`part.${k}`];
      return { parts, replace: v.replace ?? true, fit: v.fit ?? true, cols: n(v.cols, info.dims.cols) };
    }
    return {
      seed: String(v.seed ?? this.wfSeed ?? "").trim() || this.wfSeed,
      cols: n(v.cols, info.dims.cols), rows: n(v.rows, info.dims.rows), size: n(v.size, info.dims.size),
      water: clamp(n(v.water, 35), 0, 80) / 100, mountains: clamp(n(v.mountains, 10), 0, 40) / 100,
      resources: clamp(n(v.resources, 10), 0, 60) / 100, realmCount: Math.round(clamp(n(v.realms, info.players || 3), 0, 12)),
      neutral: clamp(n(v.neutral, 50), 0, 100) / 100, recipe: v.recipe || "",
      rough: v.rough ?? !!info.roughDefault, clear: v.clear ?? true
    };
  }

  async _wfRun(kind, fn) {
    if ( this.wfBusy ) return;
    this.wfBusy = kind;
    this.render();
    try { await fn(); }
    finally { this.wfBusy = null; this.render(); }
  }

  /* Правая панель --------------------------------------------------- */

  renderRight() {
    const s = this.studio;
    const tab = s.rightTab;
    // Вкладки как в макете Б: гекс, справочник, заявки, шестерёнка настроек.
    const tabs = `<nav class="art-tabs">
      <button type="button" class="${tab === "tile" ? "active" : ""}" data-action="rightTab" data-tab="tile">${icon("hexagon")} ${esc(this.t("ART.Card.tab"))}</button>
      <button type="button" class="${tab === "catalog" ? "active" : ""}" data-action="rightTab" data-tab="catalog">${icon("book")} ${esc(this.t("ART.Catalog.tab"))}</button>
      <button type="button" class="${tab === "queue" ? "active" : ""}" data-action="rightTab" data-tab="queue">${icon("scroll")} ${esc(this.t("ART.Queue.title"))}${this._queueBadge() ? ` <span class="art-badge">${this._queueBadge()}</span>` : ""}</button>
      ${this.backend.isGM ? `<button type="button" class="art-icon-btn" data-action="openSettings" data-section="world" title="${esc(this.t("ART.Settings.open"))}" aria-label="${esc(this.t("ART.Settings.open"))}">${icon("gear")}</button>` : ""}
      ${this.host?.dock ? `<button type="button" class="art-icon-btn${this.host.isDocked("right") ? " active" : ""}" data-action="dockRight" aria-pressed="${this.host.isDocked("right")}"
        title="${esc(this.t(this.host.isDocked("right") ? "ART.Dock.off" : "ART.Dock.on"))}">${icon("thumbtack")}</button>` : ""}
      <button type="button" class="art-icon-btn" data-action="closeRight" title="${esc(this.t("ART.Close"))}">${icon("xmark")}</button>
    </nav>`;
    const body = tab === "queue" ? this.renderQueue() : tab === "catalog" ? this.renderCatalog() : this.renderTile();
    return `${tabs}<div class="art-body" data-scroll="right-${tab}">${body}</div>`;
  }

  /**
   * Справочник (макет Б): всё, что есть на карте, деревом. Слои зон → типы → зоны, потом метки по типам и линии.
   * Глаз у слоя прячет его только у себя, щелчок по элементу ведёт к нему и раскрывает карточку.
   */
  renderCatalog() {
    const s = this.studio;
    const c = s.catalog;
    const q = (c.q ?? "").trim().toLowerCase();
    const hidden = s.hidden();
    const types = s.types;
    const typeName = id => types.find(t => t.id === id)?.name ?? "";
    const match = st => !q || (st.name ?? "").toLowerCase().includes(q) || typeName(st.system.typeId).toLowerCase().includes(q)
      || this.demiurgeNames(st).toLowerCase().includes(q);
    const fold = (key, title, count, extra = "") => {
      const open = q || !c.shut.has(key);
      return { open, head: `<div class="art-cat-head"><button type="button" class="art-cat-fold" data-action="catalogFold" data-key="${esc(key)}" aria-expanded="${!!open}">
        ${icon(open ? "chevron-down" : "chevron-right")}<span>${esc(title)}</span><small>${count}</small></button>${extra}</div>` };
    };
    const eye = id => {
      const on = isShown(id, hidden);
      return `<button type="button" class="art-icon-btn" data-action="toggleLayer" data-id="${esc(id)}" aria-pressed="${on}"
        title="${esc(this.t(on ? "ART.Layer.hide" : "ART.Layer.show"))}">${icon(on ? "eye" : "eye-slash")}</button>`;
    };
    const item = (st, sw) => {
      const own = this.demiurgeNames(st);
      const n = st.system.kind === "area" ? zoneCells(st).length : "";
      return `<div class="art-cat-row${st.id === s.openId ? " active" : ""}"><button type="button" class="art-cat-item" data-action="focusFeature" data-id="${esc(st.id)}"
        title="${esc(this.t("ART.Catalog.show"))}">${sw}<span class="art-row-name">${esc(st.name || this.t("ART.Card.unnamed"))}</span>${own ? `<small class="art-muted">${esc(own)}</small>` : ""}${n !== "" ? `<small>${n}</small>` : ""}</button>
        ${st.system.kind === "area" ? `<button type="button" class="art-icon-btn" data-action="pickZone" data-id="${esc(st.id)}" title="${esc(this.t("ART.Zone.paintWith"))}">${icon("paintbrush")}</button>` : ""}</div>`;
    };
    const colorOf = st => st.system.style?.color ?? types.find(t => t.id === st.system.typeId)?.style?.color ?? "#ccc";
    const zoneLayers = s.zoneCatalog(q).map(({ layer, types: groups }) => {
      const total = groups.reduce((n, g) => n + g.zones.length, 0);
      if ( q && !total ) return "";
      const f = fold(`layer:${layer.id}`, layer.name, total, layer.id ? eye(layer.id) : "");
      const body = f.open ? groups.map(({ type, zones }) => {
        if ( !zones.length ) return "";
        return `${type ? `<div class="art-cat-type">${this.typeSwatch(type)} ${esc(type.name)} <small>${zones.length}</small></div>` : ""}
          ${zones.map(z => item(z, `<i class="art-swatch" style="--c:${esc(colorOf(z))}"></i>`)).join("")}`;
      }).join("") || `<p class="art-empty">${esc(this.t("ART.Catalog.emptyLayer"))}</p>` : "";
      return `<section class="art-cat-layer">${f.head}${f.open ? `<div class="art-cat-body">${body}</div>` : ""}</section>`;
    }).join("");
    const group = (key, kind, title) => {
      const list = [...s.states.values()].filter(st => st.system.kind === kind && match(st))
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
      if ( q && !list.length ) return "";
      const f = fold(key, title, list.length);
      if ( !f.open ) return `<section class="art-cat-layer">${f.head}</section>`;
      const byType = new Map();
      for ( const st of list ) {
        if ( !byType.has(st.system.typeId) ) byType.set(st.system.typeId, []);
        byType.get(st.system.typeId).push(st);
      }
      const body = [...byType].map(([tid, items]) => {
        const type = s.typeById(tid);
        return `<div class="art-cat-type">${type ? this.typeSwatch(type) : ""} ${esc(type?.name ?? "")} <small>${items.length}</small></div>
          ${items.map(st => item(st, type ? this.typeSwatch(type) : "")).join("")}`;
      }).join("") || `<p class="art-empty">${esc(this.t("ART.Catalog.none"))}</p>`;
      return `<section class="art-cat-layer">${f.head}<div class="art-cat-body">${body}</div></section>`;
    };
    const all = zoneLayers + group("marks", "object", this.t("ART.Card.marks")) + group("lines", "line", this.t("ART.Card.lines"));
    return `<input type="search" class="art-search" data-model="catalog.q" data-key="catalog-q" value="${esc(c.q ?? "")}" placeholder="${esc(this.t("ART.Catalog.find"))}">
      <div class="art-catalog">${all || `<p class="art-empty">${esc(this.t("ART.Catalog.none"))}</p>`}</div>`;
  }

  renderTile() {
    const s = this.studio;
    if ( !s.inspected ) return `<p class="art-empty">${esc(this.t("ART.Card.pick"))}</p>`;
    const { zones, marks, lines, counts } = s.contents();
    const [i, j] = s.inspected;
    const n = s.multi ? s.selection.size : 1;
    const note = id => n > 1 ? this.t("ART.Card.inOf", { k: counts.get(id) ?? 0, n }) : "";
    const sum = s.summary();
    const facts = [sum?.terrain?.name, sum?.realm?.name ?? sum?.region?.name].filter(Boolean).map(esc).join(" · ");
    const head = n > 1
      ? `<header class="art-tile-head"><h3>${esc(this.t("ART.Card.hexes", { n }))}</h3>
        <button type="button" class="art-link" data-action="clearSelection">${esc(this.t("ART.Sel.clear"))}</button></header>
        <p class="art-hint">${esc(this.t("ART.Card.multiHint"))}</p>`
      : `<header class="art-tile-head"><h3>${esc(this.t("ART.Card.hex", { i, j }))}</h3>${facts ? `<span class="art-muted">${facts}</span>` : ""}</header>`;
    // Сжатая карточка (0.9.9): строки элементов; раскрытая — описание и значки, карандаш — правка.
    return `${head}${this.uCardSection("zones", zones, note)}${this.uCardSection("marks", marks, note)}${this.uCardSection("lines", lines, note)}`;
  }

  renderEditor(st, type) {
    const id = st.id;
    const s = this.studio;
    const kind = st.system.kind;
    const f = (field, extra = "") => `data-id="${esc(id)}" data-field="${esc(field)}" data-key="${esc(`${id}:${field}`)}"${extra}`;
    const typeOpts = s.typesOf(kind).map(t => `<option value="${esc(t.id)}"${t.id === st.system.typeId ? " selected" : ""}>${esc(t.name)}</option>`).join("");
    const color = st.system.style?.color ?? type?.style?.color ?? "#cccccc";
    const terrain = kind === "area" && type?.layerId === "terrain";
    return `<div class="art-editor">
      <label class="art-field"><span>${esc(this.t("ART.Field.name"))}</span><input type="text" value="${esc(st.name)}" ${f("name")}></label>
      <div class="art-grid2">
        <label class="art-field"><span>${esc(this.t("ART.Field.type"))}</span><select ${f("typeId")}>${typeOpts}</select></label>
        ${terrain ? "" : `<label class="art-field"><span>${esc(this.t("ART.Field.color"))}</span>${colorField(`data-id="${esc(id)}" data-field="color"`, color, `${id}:color`)}</label>`}
      </div>
      ${kind === "line" && s.inspected ? `<label class="art-field"><span>${esc(this.t(s.multi ? "ART.Line.segmentMany" : "ART.Line.segment"))}</span>
        <input type="text" value="${esc(s.segmentNameHere(id))}" placeholder="${esc(st.name || "")}" ${f("segment")}></label>
        <p class="art-hint">${esc(this.t("ART.Line.segmentHint"))}</p>` : ""}
      ${kind === "object" ? this.renderShapePicker(st.system.style?.shape ?? type?.style?.shape, id) : ""}
      ${kind === "object" ? this.renderMarkSize(st, type, id) : ""}
      ${this.renderVisibility(st)}
      ${kind === "area" && !terrain ? this.renderLabelControls(st.system.style?.labelMode ?? "", st.system.style?.labelScale ?? type?.style?.labelScale ?? 1,
        { id, inherit: type?.style?.labelMode ?? ((type?.layerId ?? st.system.layerId) === "politics" ? "curved" : "straight") }) : ""}
      ${kind === "object" && s.contents().marks.length > 1 && !s.multi ? `<div class="art-row-btns"><span class="art-muted">${esc(this.t("ART.Card.order"))}</span>
        <button type="button" class="art-btn art-icon-only" data-action="markUp" data-id="${esc(id)}" title="${esc(this.t("ART.Card.earlier"))}">${icon("arrow-up")}</button>
        <button type="button" class="art-btn art-icon-only" data-action="markDown" data-id="${esc(id)}" title="${esc(this.t("ART.Card.later"))}">${icon("arrow-down")}</button></div>` : ""}
      ${kind === "area" && zoneCells(st).length > 1 ? `<p class="art-hint">${esc(this.t(s.multi ? "ART.Field.typeHereMany" : "ART.Field.typeHere"))}</p>` : ""}
      ${this.renderDemiurges(st)}
      <label class="art-field"><span>${esc(this.t("ART.Field.text"))}</span><textarea rows="3" ${f("text")}>${esc(htmlToText(st.text))}</textarea></label>
      ${this.statusEdit === id ? this.renderStatusEditor(st) : this.renderStatusView(st)}
      <div class="art-row-btns">
        <button type="button" class="art-btn" data-action="pan" data-id="${esc(id)}">${icon("crosshairs")} ${esc(this.t("ART.Card.pan"))}</button>
        ${kind === "area" ? `<button type="button" class="art-btn" data-action="removeCell" data-id="${esc(id)}">${icon("eraser")} ${esc(this.t(s.multi ? "ART.Card.removeCells" : "ART.Card.removeCell"))}</button>` : ""}
        <button type="button" class="art-btn art-danger" data-action="deleteFeature" data-id="${esc(id)}" title="${esc(this.t("ART.Card.delete"))}">${icon("trash")}</button>
      </div>
    </div>`;
  }

  /** Имена демиургов через запятую. */
  demiurgeNames(st) {
    const actors = this.backend.actors();
    return demiurgesOf(st).map(id => actors.find(a => a.id === id)?.name).filter(Boolean).join(", ");
  }

  /** Демиурги: можно отметить одного, нескольких или никого. У игрока правка уходит мастеру заявкой. */
  renderDemiurges(st) {
    const id = st.id;
    const mine = new Set(demiurgesOf(st));
    const actors = this.backend.actors();
    const rows = actors.map(a => `<label class="art-check">
      <input type="checkbox" data-change="toggleDemiurge" data-id="${esc(id)}" data-actor="${esc(a.id)}" ${mine.has(a.id) ? "checked" : ""}> ${esc(a.name)}</label>`).join("");
    const none = !mine.size ? `<span class="art-muted">${esc(this.t("ART.Card.noOwner"))}</span>` : "";
    return `<div class="art-field"><span>${icon("crown")} ${esc(this.t("ART.Field.owners"))} ${none}</span>
      ${rows ? `<div class="art-parts art-pick">${rows}</div>` : `<p class="art-empty">${esc(this.t("ART.Card.noActors"))}</p>`}
      ${this.backend.isGM ? "" : `<p class="art-hint">${esc(this.t("ART.Card.ownersByClaim"))}</p>`}</div>`;
  }

  /**
   * Кто видит элемент (метку, зону, линию), как у скрытого токена. Мастер и помощник видят всё.
   * Менять может мастер или игрок-демиург; игроков-демиургов из списка не убрать.
   */
  renderVisibility(st) {
    const id = st.id;
    const v = st.system.visibility ?? { mode: "all", users: [] };
    const mode = v.mode || "all";
    const can = this.studio.canChangeVisibility(st);
    const locked = new Set(this.studio.lockedViewers(st));
    const opt = m => `<option value="${m}"${mode === m ? " selected" : ""}>${esc(this.t(`ART.Vis.${m}`))}</option>`;
    const others = this.backend.players().filter(p => p.id !== st.system.author);
    const players = mode === "some" ? others.map(p => {
      const lock = locked.has(p.id);
      return `<label class="art-check${lock ? " art-locked" : ""}"${lock ? ` title="${esc(this.t("ART.Vis.locked"))}"` : ""}>
      <input type="checkbox" data-change="visUser" data-id="${esc(id)}" data-user="${esc(p.id)}" ${lock || (v.users ?? []).includes(p.id) ? "checked" : ""} ${can && !lock ? "" : "disabled"}> ${esc(p.name)}${lock ? ` ${icon("lock")}` : ""}</label>`;
    }).join("") : "";
    const lockedNames = mode === "gm" ? others.filter(p => locked.has(p.id)).map(p => p.name).join(", ") : "";
    return `<label class="art-field"><span>${icon(mode !== "all" ? "eye-slash" : "eye")} ${esc(this.t("ART.Vis.title"))}</span>
      <select data-change="visMode" data-id="${esc(id)}" ${can ? "" : "disabled"}>${opt("all")}${opt("gm")}${opt("some")}</select></label>
      ${players ? `<div class="art-parts">${players}</div>` : ""}
      ${lockedNames ? `<p class="art-hint">${esc(this.t("ART.Vis.lockedList", { names: lockedNames }))}</p>` : ""}
      ${can ? "" : `<p class="art-hint">${esc(this.t("ART.Vis.onlyDemiurge"))}</p>`}`;
  }

  /** Статусы и аспекты для чтения: значки с уровнями, у аспекта описание. Правка — по кнопке. */
  renderStatusView(st) {
    const id = st.id;
    const statuses = (st.system.statuses ?? []).filter(x => x.name);
    const aspects = (st.system.aspects ?? []).filter(x => x.name);
    const chips = this.statusChips({ system: { statuses, aspects: [] } }, { limit: 99 });
    const aspectRows = aspects.map(a => `<div class="art-aspect-view">
      <div class="art-chips">${this.statusChips({ system: { statuses: [], aspects: [a] } })}${this.statusChips({ system: { statuses: a.statuses ?? [], aspects: [] } })}</div>
      ${a.description ? `<p>${esc(a.description)}</p>` : ""}</div>`).join("");
    const empty = !statuses.length && !aspects.length;
    return `<section class="art-view-block"><h5>${esc(this.t("ART.Card.statusesAspects"))}
        <button type="button" class="art-btn" data-action="editStatuses" data-id="${esc(id)}">${icon("pen")} ${esc(this.t("ART.Card.editStatuses"))}</button></h5>
      ${empty ? `<p class="art-empty">${esc(this.t("ART.Card.noStatusesYet"))}</p>` : ""}
      ${chips ? `<div class="art-chips">${chips}</div>` : ""}${aspectRows}
    </section>`;
  }

  /** Правка статусов и аспектов: поля, уровни, «в аспект». Кнопка «Готово» возвращает к просмотру. */
  renderStatusEditor(st) {
    const id = st.id;
    return `${this.renderStatuses(id, "statuses", st.system.statuses ?? [], true)}
      <section class="art-sub-block"><h5>${esc(this.t("ART.Card.aspects"))}
        <button type="button" class="art-icon-btn" data-action="addAspect" data-id="${esc(id)}" title="${esc(this.t("ART.Card.addAspect"))}">${icon("plus")}</button></h5>
        ${(st.system.aspects ?? []).map((a, n) => this.renderAspect(id, a, n)).join("") || `<p class="art-empty">${esc(this.t("ART.Card.noAspects"))}</p>`}
        ${(() => {
          const have = new Set((st.system.aspects ?? []).map(a => a.key).filter(Boolean));
          const quick = BASE_ASPECTS.filter(a => !have.has(a.key)).map(a => `<button type="button" class="art-chip art-chip-add art-chip-aspect" data-action="addBaseAspect"
            data-id="${esc(id)}" data-key="${esc(a.key)}">${icon(a.icon)}<span>${esc(a.name)}</span></button>`).join("");
          return quick ? `<div class="art-chips art-quick">${quick}</div>` : "";
        })()}
      </section>
      <div class="art-row-btns"><button type="button" class="art-btn art-accent" data-action="editStatuses" data-id="">${icon("check")} ${esc(this.t("ART.Card.doneStatuses"))}</button></div>`;
  }

  renderStatuses(id, path, list, withAspect) {
    const rows = list.map((x, n) => {
      const base = `${path}.${n}`;
      const f = key => `data-id="${esc(id)}" data-field="${esc(`${base}.${key}`)}" data-key="${esc(`${id}:${base}.${key}`)}"`;
      return `<li class="art-status-row">
        <input type="text" class="art-st-name" value="${esc(x.name)}" placeholder="${esc(this.t("ART.Card.statusPh"))}" ${f("name")}>
        <button type="button" class="art-icon-btn" data-action="stepLevel" data-id="${esc(id)}" data-path="${esc(path)}" data-n="${n}" data-delta="-1" title="−1">${icon("minus")}</button>
        <input type="number" class="art-num" value="${x.value ?? ""}" placeholder="—" ${f("value")}>
        <span class="art-muted">/</span>
        <input type="number" class="art-num" value="${x.max ?? ""}" placeholder="—" ${f("max")}>
        <button type="button" class="art-icon-btn" data-action="stepLevel" data-id="${esc(id)}" data-path="${esc(path)}" data-n="${n}" data-delta="1" title="+1">${icon("plus")}</button>
        ${withAspect ? `<button type="button" class="art-icon-btn" data-action="toAspect" data-id="${esc(id)}" data-n="${n}" title="${esc(this.t("ART.Card.toAspect"))}">${icon("star")}</button>` : ""}
        <button type="button" class="art-icon-btn" data-action="removeStatus" data-id="${esc(id)}" data-path="${esc(path)}" data-n="${n}" title="${esc(this.t("ART.Card.remove"))}">${icon("xmark")}</button>
      </li>`;
    }).join("");
    // Быстрые кнопки базовых статусов: у метки — десять общих, у базового аспекта — его собственные.
    const st = this.studio.stateOf(id);
    const aspectN = path.startsWith("aspects.") ? Number(path.split(".")[1]) : null;
    const aspectKey = aspectN !== null ? st?.system.aspects?.[aspectN]?.key : null;
    const bases = aspectKey ? (BASE_ASPECTS.find(a => a.key === aspectKey)?.statuses ?? [])
      : (path === "statuses" && st?.system.kind === "object" ? BASE_STATUSES : []);
    const have = new Set(list.map(x => x.key).filter(Boolean));
    const quick = bases.filter(b => !have.has(b.key)).map(b => `<button type="button" class="art-chip art-chip-add" data-action="addBaseStatus"
      data-id="${esc(id)}" data-path="${esc(path)}" data-key="${esc(b.key)}" title="${esc(this.t("ART.Card.addStatus"))}">${icon(b.icon)}<span>${esc(b.name)}</span></button>`).join("");
    return `<section class="art-sub-block"><h5>${esc(this.t(path === "statuses" ? "ART.Card.statuses" : "ART.Card.aspectStatuses"))}
      <button type="button" class="art-icon-btn" data-action="addStatus" data-id="${esc(id)}" data-path="${esc(path)}" title="${esc(this.t("ART.Card.addOwnStatus"))}">${icon("plus")}</button></h5>
      ${rows ? `<ul class="art-status-list">${rows}</ul>` : `<p class="art-empty">${esc(this.t("ART.Card.noStatuses"))}</p>`}
      ${quick ? `<div class="art-chips art-quick">${quick}</div>` : ""}</section>`;
  }

  renderAspect(id, a, n) {
    const base = `aspects.${n}`;
    const f = key => `data-id="${esc(id)}" data-field="${esc(`${base}.${key}`)}" data-key="${esc(`${id}:${base}.${key}`)}"`;
    return `<div class="art-aspect-box">
      <div class="art-status-row">
        ${icon("star", "art-aspect-star")}
        <input type="text" class="art-st-name" value="${esc(a.name)}" placeholder="${esc(this.t("ART.Card.aspectPh"))}" ${f("name")}>
        <button type="button" class="art-icon-btn" data-action="stepLevel" data-id="${esc(id)}" data-path="aspects" data-n="${n}" data-delta="-1">${icon("minus")}</button>
        <input type="number" class="art-num" value="${a.value ?? ""}" placeholder="—" ${f("value")}>
        <span class="art-muted">/</span>
        <input type="number" class="art-num" value="${a.max ?? ""}" placeholder="—" ${f("max")}>
        <button type="button" class="art-icon-btn" data-action="stepLevel" data-id="${esc(id)}" data-path="aspects" data-n="${n}" data-delta="1">${icon("plus")}</button>
        <button type="button" class="art-icon-btn" data-action="removeAspect" data-id="${esc(id)}" data-n="${n}" title="${esc(this.t("ART.Card.remove"))}">${icon("xmark")}</button>
      </div>
      <textarea rows="2" placeholder="${esc(this.t("ART.Field.text"))}" ${f("description")}>${esc(a.description ?? "")}</textarea>
      ${this.renderStatuses(id, `${base}.statuses`, a.statuses ?? [], false)}
    </div>`;
  }

  /* Заявки ---------------------------------------------------------- */

  /** Короткое описание правки: «Зона «Лес»: +12 гексов». */
  describeOp(op, base) {
    return describeOp(op, base, this._describeCtx());
  }

  _describeCtx() {
    return { t: (k, d) => this.t(k, d), typeName: id => this.studio.typeById(id)?.name ?? id,
      layerName: id => this.studio.layers?.find?.(l => l.id === id)?.name ?? id,
      actorName: id => this.backend.actors().find(x => x.id === id)?.name ?? id,
      userName: id => this.backend.players().find(x => x.id === id)?.name ?? id };
  }

  /** Правка заявки: строка и под стрелкой «было/стало». */
  renderClaimOp(op, base, conflict) {
    const rows = diffOf(op, base, this._describeCtx());
    const warn = conflict ? ` <em class="art-warn">${esc(this.t(`VMAP.Conflict.${conflict}`))}</em>` : "";
    const head = `${esc(this.describeOp(op, base))}${warn}`;
    if ( !rows.length ) return `<li class="art-op art-op-${op.action}">${head}</li>`;
    const table = rows.map(r => `<tr><th>${esc(r.label)}</th><td class="art-was">${esc(r.before) || "—"}</td><td class="art-now">${esc(r.after) || "—"}</td></tr>`).join("");
    return `<li class="art-op art-op-${op.action}"><details class="art-diff"><summary>${head}</summary>
      <table><thead><tr><th></th><th>${esc(this.t("ART.Queue.was"))}</th><th>${esc(this.t("ART.Queue.now"))}</th></tr></thead><tbody>${table}</tbody></table>
      </details></li>`;
  }

  renderQueue() {
    return this.backend.isGM ? this.renderQueueGM() : this.renderQueuePlayer();
  }

  renderQueuePlayer() {
    const s = this.studio;
    const base = this.backend.atlasStates();
    const ops = this.backend.draftOps();
    const draft = ops.length ? `<ul class="art-ops">${ops.map(op => `<li class="art-op art-op-${op.action}">
        <span>${esc(this.describeOp(op, base))}</span>
        <button type="button" class="art-icon-btn" data-action="undoOp" data-id="${esc(op.id)}" title="${esc(this.t("ART.Queue.undo"))}">${icon("rotate-left")}</button></li>`).join("")}</ul>
      <label class="art-field"><span>${esc(this.t("ART.Queue.claimTitle"))}</span>
        <input type="text" data-model="claimForm.title" data-key="claim-title" value="${esc(s.claimForm.title)}" placeholder="${esc(this.t("ART.Queue.claimTitlePh"))}"></label>
      <label class="art-field"><span>${esc(this.t("ART.Queue.claimNote"))}</span>
        <textarea rows="2" data-model="claimForm.note" data-key="claim-note">${esc(s.claimForm.note)}</textarea></label>
      <button type="button" class="art-btn art-accent art-wide" data-action="submit">${icon("paper-plane")} ${esc(this.t("ART.Queue.submit"))}</button>`
      : `<p class="art-empty">${esc(this.t("ART.Queue.emptyDraft"))}</p>`;
    const mine = this.backend.myClaims();
    const claims = mine.length ? mine.map(c => `<article class="art-claim art-st-${esc(c.status)}">
        <header><b>${esc(c.title)}</b><span class="art-pill">${esc(this.t(`VMAP.ClaimStatus.${c.status}`))}</span></header>
        ${c.comment ? `<p class="art-muted">${esc(c.comment)}</p>` : ""}
        <div class="art-row-btns">
          ${["pending", "rejected"].includes(c.status) ? `<button type="button" class="art-btn" data-action="returnToDraft" data-id="${esc(c.id)}">${icon("rotate-left")} ${esc(this.t("ART.Queue.toDraft"))}</button>` : ""}
          ${["applied", "rejected", "pending"].includes(c.status) ? `<button type="button" class="art-btn" data-action="dropClaim" data-id="${esc(c.id)}">${icon("trash")}</button>` : ""}
        </div></article>`).join("") : `<p class="art-empty">${esc(this.t("ART.Queue.noClaims"))}</p>`;
    return `<section class="art-block"><h4>${esc(this.t("ART.Queue.draft"))}</h4>${draft}</section>
      <section class="art-block"><h4>${esc(this.t("ART.Queue.mine"))}</h4>${claims}</section>`;
  }

  renderQueueGM() {
    const s = this.studio;
    const base = this.backend.atlasStates();
    const entries = this.backend.claims();
    if ( !entries.length ) return `<p class="art-empty">${esc(this.t("ART.Queue.none"))}</p>`;
    const allChecked = entries.every(e => s.checkedIds.has(e.claim.id));
    const n = [...s.checkedIds].filter(id => entries.some(e => e.claim.id === id)).length;
    const list = entries.map(({ user, claim }) => {
      const id = claim.id;
      const conflicts = this.backend.conflicts?.(claim) ?? {};
      const outcome = claim.status === "rolled" ? `<span class="art-pill art-out-${esc(claim.outcome)}">${esc(this.t(`VMAP.Outcome.${claim.outcome}`))}${claim.partial ? ` · ${esc(this.t("ART.Queue.partial"))}` : ""}</span>` : "";
      return `<article class="art-claim art-st-${esc(claim.status)}${s.previewIds.has(id) ? " previewing" : ""}">
        <header>
          <input type="checkbox" data-action="check" data-id="${esc(id)}" ${s.checkedIds.has(id) ? "checked" : ""}>
          <i class="art-dot" style="--c:${esc(user.color)}"></i><b>${esc(claim.title)}</b>
          <span class="art-muted">${esc(user.name)}</span>
          <span class="art-pill">${esc(this.t(`VMAP.ClaimStatus.${claim.status}`))}</span>${outcome}
        </header>
        ${claim.note ? `<p class="art-note">${esc(claim.note)}</p>` : ""}
        <ul class="art-ops">${(claim.ops ?? []).map(op => this.renderClaimOp(op, base, conflicts[op.id])).join("")}</ul>
        <div class="art-row-btns">
          <button type="button" class="art-btn${s.previewIds.has(id) ? " active" : ""}" data-action="preview" data-id="${esc(id)}" title="${esc(this.t("ART.Queue.preview"))}">${icon("eye")} ${esc(this.t("ART.Queue.highlight"))}</button>
          <button type="button" class="art-btn" data-action="claimGoTo" data-id="${esc(id)}">${icon("location-crosshairs")} ${esc(this.t("ART.Queue.goTo"))}</button>
          <button type="button" class="art-btn art-accent" data-action="apply" data-id="${esc(id)}">${icon("check")} ${esc(this.t("ART.Queue.apply"))}</button>
          <button type="button" class="art-btn" data-action="reject" data-id="${esc(id)}">${icon("xmark")} ${esc(this.t("ART.Queue.reject"))}</button>
          ${claim.status === "pending" ? `<button type="button" class="art-btn" data-action="requestCheck" data-id="${esc(id)}" title="${esc(this.t("ART.Queue.checkHint"))}">${icon("dice-six")}</button>` : ""}
        </div>
      </article>`;
    }).join("");
    return `<div class="art-row-btns art-sticky">
        <label class="art-check"><input type="checkbox" data-action="checkAll" ${allChecked ? "checked" : ""}> ${esc(this.t("ART.Queue.all"))}</label>
        <button type="button" class="art-btn art-accent" data-action="applyChecked" ${n ? "" : "disabled"}>${esc(this.t("ART.Queue.applyN", { n }))}</button>
        <button type="button" class="art-btn" data-action="rejectChecked" ${n ? "" : "disabled"}>${esc(this.t("ART.Queue.rejectN", { n }))}</button>
      </div>${list}`;
  }
}

export { cellKey };

Object.assign(ArtariusUI.prototype, UnifiedUI);
