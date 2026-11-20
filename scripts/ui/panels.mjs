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
import { describeOp, diffOf } from "../review/describe.mjs";
import { KIND_TOOL } from "../constants.mjs";
import { VIEW_PART_DEFS, isShown } from "../data/view.mjs";
import { hasField } from "../data/fields.mjs";
import { RECIPES } from "../gen/pieces.mjs";
import { statusIcon, BASE_STATUSES, BASE_ASPECTS } from "../data/statuses.mjs";

import { ICON_LIBRARY, allIcons, searchIcons } from "../data/icons.mjs";
import { MARK_SHAPES, shapeSwatch, shapeOf } from "../data/mark-shape.mjs";
import { LINE_SHAPES, LINE_PATTERNS, lineCurve, lineDash } from "../canvas/style.mjs";

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
  constructor(studio, backend, { mount = document.body, host = null, project = null } = {}) {
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
      <nav class="art-wheel" data-part="wheel"></nav>`;
    this.parts = Object.fromEntries([...this.root.querySelectorAll("[data-part]")].map(el => [el.dataset.part, el]));
    /** Окно слоёв для «Осмотра» в Foundry открывается только кнопкой, само не всплывает. */
    this.layersPanel = false;
    for ( const el of Object.values(this.parts) ) this._bind(el);
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
    this._onKey = ev => { if ( ev.key === "Escape" && this.layersPanel ) this.toggleLayerPanel(false); };
    document.addEventListener("keydown", this._onKey);
    this._bind(this.hud);
    this._bind(this.bar);
    this._bind(this.layerbar);
    this._bindMarkDrag(this.hud);
    this._unsub = studio.subscribe(what => {
      if ( what === "hover" ) return this.renderTip();
      if ( what !== "overlay" ) this.render();
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
    window.removeEventListener("resize", this._onResize);
    document.removeEventListener("keydown", this._onKey);
    if ( this._hudFrame ) cancelAnimationFrame(this._hudFrame);
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
    const box = el.closest(".art-item") ?? el.closest(".art-form");
    if ( box && (el.dataset.model === "typeForm.color" || el.dataset.field === "color") ) {
      for ( const m of box.querySelectorAll(".art-mask, .art-swatch, .art-live-color") ) m.style.setProperty("--c", v);
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
    return {
      // Кнопка уже выбранного инструмента его не выключает: выключает крестик в шапке.
      tool: el => s.setTool(el.dataset.tool, { toggle: false }),
      toggleMenu: () => s.setTool(s.tool ? null : "select"),
      toggleLayerPanel: () => this.toggleLayerPanel(),
      addBaseStatus: el => s.addBaseStatus(el.dataset.id, el.dataset.path, el.dataset.key),
      addBaseAspect: el => s.addBaseAspect(el.dataset.id, el.dataset.key),
      permRole: el => this._setPerm(cfg => { ((cfg.roles ??= {})[el.dataset.role] ??= {})[el.dataset.perm] = el.checked; }),
      permUser: el => this._setPerm(cfg => {
        const u = ((cfg.users ??= {})[el.dataset.user] ??= {});
        if ( el.value === "" ) delete u[el.dataset.perm]; else u[el.dataset.perm] = el.value === "true";
      }),
      visMode: el => s.setVisibility(el.dataset.id, el.value),
      visUser: el => {
        const st = s.stateOf(el.dataset.id);
        const set = new Set(st?.system.visibility?.users ?? []);
        if ( el.checked ) set.add(el.dataset.user); else set.delete(el.dataset.user);
        s.setVisibility(el.dataset.id, "some", [...set]);
      },
      editStatuses: el => { this.statusEdit = el.dataset.id || null; this.render(); },
      extra: el => EXTRA_ACTIONS.get(el.dataset.id)?.onClick?.(),
      help: () => this.backend.openGuide?.(),
      // Зона
      attach: () => s.attach(),
      detach: () => s.detach(),
      clearSelection: () => s.clearSelection(),
      zoneTarget: el => s.setZoneTarget(el.dataset.id),
      toggleArchive: () => { s.zone.archiveOpen = !s.zone.archiveOpen; s.changed("ui"); },
      // Метка, линия
      placeMarks: () => s.placeMarks(),
      finishLine: () => s.finishLine(),
      lineMode: el => s.setLineMode(el.dataset.mode),
      undoPoint: () => s.undoPoint(),
      clearLine: () => s.clearLine(),
      // Типы
      pickType: el => s.pickType(el.dataset.kind, el.dataset.id),
      newType: el => s.editTypeInSettings(el.dataset.kind, "new"),
      editType: el => s.editTypeInSettings(el.dataset.kind, el.dataset.id),
      saveType: () => s.saveTypeForm(),
      cancelType: () => {
        if ( s.settings.back ) return s.closeSettings();
        const sec = s.settings.section;
        if ( s.settings.id === "new" ) return s.settingsPick(s.typesOf(sec)[0]?.id ?? null);
        s.settingsPick(s.settings.id);
      },
      // Настройки модуля
      openSettings: el => s.openSettings(el.dataset.section || undefined),
      closeSettings: () => s.closeSettings(),
      settingsSection: el => s.settingsSection(el.dataset.section),
      settingsPick: el => { s.settings.back = false; s.settingsPick(el.dataset.id); },
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
      hudDelete: () => s.hudDelete(),
      deleteMark: el => s.deleteMarks([el.dataset.id]),
      deleteSelected: () => s.deleteMarks(),
      clearMarkSel: () => s.clearMarkSel(),
      bulkType: el => { if ( el.value ) s.retypeMarks(el.value); },
      markScale: el => s.setField(el.dataset.id, "size", Number(el.value) / 100),
      undo: () => s.undo(),
      redo: () => s.redo(),
      hudZone: () => s.zoneHere(),
      hudPan: () => s.inspected && this.backend.panTo(s.grid.center(s.inspected)),
      hudClose: () => s.closeHud(),
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
    };
  }

  /* ---------------------------------------------------------------- */
  /*  Отрисовка                                                         */
  /* ---------------------------------------------------------------- */

  render() {
    const s = this.studio;
    try {
      if ( this.parts.wheel ) patch(this.parts.wheel, this.renderWheel());
      const leftOn = this._leftVisible();
      if ( leftOn ) patch(this.parts.left, this.renderLeft());
      this._show("left", leftOn, this._leftTitle());
      if ( s.rightOpen ) patch(this.parts.right, this.renderRight());
      this._show("right", s.rightOpen, this.t(s.rightTab === "queue" ? "ART.Queue.title" : "ART.Card.tab"));
      if ( s.settings.open ) patch(this.parts.settings, this.renderSettings());
      this._show("settings", s.settings.open, this.t("ART.Settings.title"));
      this.renderHud();
      this.renderBar();
      this.renderLayerbar();
    } catch(err) {
      console.error("artarius | render", err);
    }
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
    if ( s.tool === "zone" ) body = this.renderZoneTool();
    else if ( s.tool === "mark" ) body = this.renderMarkTool();
    else if ( s.tool === "line" ) body = this.renderLineTool();
    else body = this.renderSelectTool();
    const undo = `<button type="button" class="art-icon-btn" data-action="undo" ${s.canUndo ? "" : "disabled"}
        title="${esc(this.t("ART.Undo.undo"))}" aria-label="${esc(this.t("ART.Undo.undo"))}">${icon("rotate-left")}</button>
      <button type="button" class="art-icon-btn" data-action="redo" ${s.canRedo ? "" : "disabled"}
        title="${esc(this.t("ART.Undo.redo"))}" aria-label="${esc(this.t("ART.Undo.redo"))}">${icon("rotate-right")}</button>`;
    return `<header class="art-head">${icon(TOOL_ICONS[s.tool])}<h3>${esc(title)}</h3>
      ${undo}${close}</header>
      <div class="art-body" data-scroll="left">${body}</div>`;
  }

  renderSelectTool() {
    const gm = this.backend.isGM;
    const keys = [["Shift", "ART.Keys.shift"], ["Ctrl", "ART.Keys.box"], ["Alt", "ART.Keys.alt"], ["Del", "ART.Keys.del"],
      ["Ctrl+Z", "ART.Keys.undo"], ["Shift+␣", "ART.Keys.goto"], ["Esc", "ART.Keys.esc"]]
      .map(([k, t]) => `<li><kbd>${esc(k)}</kbd> <span>${esc(this.t(t))}</span></li>`).join("");
    return `<p class="art-hint">${esc(this.t("ART.Select.hint"))}</p>
      <section class="art-block"><h4>${esc(this.t("ART.Keys.title"))}</h4><ul class="art-keys">${keys}</ul></section>
      <section class="art-block art-row-btns">
        <button type="button" class="art-btn" data-action="toggleLayerPanel">${icon("layer-group")} ${esc(this.t("ART.Layer.title"))}</button>
        <button type="button" class="art-btn" data-action="openSettings" data-section="${gm ? "layers" : "area"}">${icon("gear")} ${esc(this.t("ART.Settings.open"))}</button>
      </section>`;
  }

  /**
   * Список типов вида для левой колонки окна инструмента (макет C): строки со значком,
   * у выбранного карандаш правки, внизу «новый тип». Правка открывается в окне настроек.
   */
  renderTypes(kind, selectedId) {
    const s = this.studio;
    const list = s.typesOf(kind);
    const row = t => {
      const edit = t.id === selectedId && s.canEditType(t)
        ? `<button type="button" class="art-row-edit" data-action="editType" data-kind="${kind}" data-id="${esc(t.id)}" title="${esc(this.t("ART.Type.edit"))}">${icon("pen")}</button>` : "";
      return `<div class="art-row-wrap">${this.listRow({ action: "pickType", id: t.id, active: t.id === selectedId, sw: this.typeSwatch(t), name: t.name,
        note: t.personal ? "★" : "", attrs: ` data-kind="${kind}"${t.personal ? ` title="${esc(this.t("ART.Type.personal"))}"` : ""}` })}${edit}</div>`;
    };
    let rows;
    if ( kind === "area" ) {
      rows = s.layers.map(l => {
        const items = list.filter(t => (t.layerId ?? "overlay") === l.id);
        return items.length ? `<span class="art-eyebrow">${esc(l.name)}</span>${items.map(row).join("")}` : "";
      }).join("");
      const orphan = list.filter(t => !s.layers.some(l => l.id === (t.layerId ?? "overlay")));
      if ( orphan.length ) rows += orphan.map(row).join("");
    } else rows = this._folderRows(kind, list, row);
    return `${rows}<button type="button" class="art-row-item art-row-new" data-action="newType" data-kind="${kind}">${icon("plus")}<span class="art-row-name">${esc(this.t("ART.Type.new"))}</span></button>`;
  }

  /** Типы по папкам: без папки сверху, папки раскрываются. Открытые папки помнятся до перезагрузки. */
  _folderRows(kind, list, row) {
    const folders = this.studio.typeFolders(kind);
    if ( folders.length < 2 && !folders[0] ) return list.map(row).join("");
    this.typeFolderShut ??= new Set();
    return folders.map(name => {
      const items = list.filter(t => (t.folder ?? "") === name);
      if ( !name ) return items.map(row).join("");
      const open = !this.typeFolderShut.has(name);
      return `<details class="art-folder" data-folder="${esc(name)}"${open ? " open" : ""}><summary>${icon(open ? "folder-open" : "folder")} ${esc(name)} <span class="art-muted">${items.length}</span></summary>${items.map(row).join("")}</details>`;
    }).join("");
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

  /** Папка типа: своё название или одна из уже заведённых. */
  renderFolderField(f) {
    const opts = this.studio.typeFolders("object").filter(Boolean).map(n => `<option value="${esc(n)}"></option>`).join("");
    return `<label class="art-field"><span>${esc(this.t("ART.Type.folder"))}</span>
      <input type="text" list="art-type-folders" data-model="typeForm.folder" data-key="tf-folder" value="${esc(f.folder ?? "")}" placeholder="${esc(this.t("ART.Type.folderPh"))}">
      <datalist id="art-type-folders">${opts}</datalist></label>`;
  }

  /** Шрифт подписей элементов этого типа. */
  renderFontField(f) {
    const fonts = this.backend.fonts?.() ?? [];
    const opt = v => `<option value="${esc(v)}"${(f.labelFont ?? "") === v ? " selected" : ""}${v ? ` style="font-family:'${esc(v)}'"` : ""}>${esc(v || this.t("ART.Type.fontDefault"))}</option>`;
    return `<label class="art-field"><span>${esc(this.t("ART.Type.font"))}</span>
      <select data-model="typeForm.labelFont">${opt("")}${fonts.map(opt).join("")}</select></label>`;
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

  renderTypeForm() {
    const f = this.studio.typeForm;
    const layers = this.studio.layers.map(l => `<option value="${esc(l.id)}"${l.id === f.layerId ? " selected" : ""}>${esc(l.name)}</option>`).join("");
    const icons = f.kind === "object" ? this.renderIconPicker(f) : "";
    return `<div class="art-form">
      <h4>${esc(this.t(f.id ? "ART.Type.editTitle" : "ART.Type.newTitle"))}</h4>
      <label class="art-field"><span>${esc(this.t("ART.Field.name"))}</span>
        <input type="text" data-model="typeForm.name" data-key="tf-name" data-enter="saveType" value="${esc(f.name)}" placeholder="${esc(this.t("ART.Type.namePh"))}"></label>
      <label class="art-field art-inline"><span>${esc(this.t("ART.Field.color"))}</span>${colorField('data-model="typeForm.color"', f.color, "tf-color")}</label>
      ${f.kind === "area" ? `<label class="art-field"><span>${esc(this.t("ART.Layer.one"))}</span><select data-model="typeForm.layerId">${layers}</select></label>
      <div class="art-field"><span>${esc(this.t("ART.Pattern.title"))}</span>
        <div class="art-patterns">${PATTERNS.map(p => `<button type="button" class="art-pattern-pick${p === (f.pattern || "none") ? " active" : ""}" data-action="pickPattern" data-pattern="${p}" title="${esc(this.t(`ART.Pattern.${p}`))}">${patternSwatch(p)}</button>`).join("")}</div></div>
      ${f.pattern && f.pattern !== "none" ? `<label class="art-field art-inline"><span>${esc(this.t("ART.Pattern.color"))}</span>${colorField('data-model="typeForm.patternColor"', f.patternColor || "#1a1a1a", "tf-pcolor")}</label>` : ""}` : ""}
      ${f.kind === "object" ? this.renderFolderField(f) : ""}
      ${f.kind === "area" ? this.renderLabelControls(f.labelMode ?? "", f.labelScale ?? 1, { model: true }) : ""}
      ${f.kind === "object" ? this.renderShapePicker(f.shape) : ""}
      ${f.kind === "line" ? this.renderLineStyle(f) : ""}
      ${f.kind === "object" ? `<label class="art-field"><span>${esc(this.t("ART.Type.emoji"))}</span>
        <input type="text" class="art-emoji-input" maxlength="8" data-model="typeForm.emoji" data-key="tf-emoji" value="${esc(f.emoji ?? "")}" placeholder="🐉"></label>
        <p class="art-hint">${esc(this.t("ART.Type.emojiHint"))}</p>` : ""}
      ${f.emoji ? "" : icons}
      ${this.renderFontField(f)}
      <div class="art-row-btns">
        <button type="button" class="art-btn art-accent" data-action="saveType">${icon("check")} ${esc(this.t("ART.Save"))}</button>
        <button type="button" class="art-btn" data-action="cancelType">${esc(this.t("ART.Cancel"))}</button>
        ${f.id ? `<button type="button" class="art-btn art-danger" data-action="deleteType" data-id="${esc(f.id)}">${icon("trash")}</button>` : ""}
      </div>
    </div>`;
  }

  renderSelectionBar() {
    const n = this.studio.selection.size;
    return `<div class="art-selbar"><span>${esc(this.t("ART.Sel.count", { n }))}</span>
      ${n ? `<button type="button" class="art-link" data-action="clearSelection">${esc(this.t("ART.Sel.clear"))}</button>` : ""}</div>`;
  }

  /** Папка «Архив»: зоны, у которых не осталось гексов. Выбрал — и можно снова красить ею. */
  _archiveList(zones, filter, typeName, colorOf) {
    const z = this.studio.zone;
    const list = zones.filter(zz => !zoneCells(zz).length)
      .filter(zz => !filter || zz.name.toLowerCase().includes(filter) || typeName(zz.system.typeId).toLowerCase().includes(filter))
      .sort((a, b) => a.name.localeCompare(b.name));
    if ( !list.length ) return "";
    const open = z.archiveOpen || list.some(zz => zz.id === z.target) || !!filter;
    const rows = list.map(zz => `<button type="button" class="art-zone art-row-item art-archived${zz.id === z.target ? " active" : ""}"
        data-action="zoneTarget" data-id="${esc(zz.id)}" title="${esc(typeName(zz.system.typeId))}"><i class="art-swatch" style="--c:${esc(colorOf(zz))}"></i>
        <span class="art-zone-name art-row-name">${esc(zz.name || this.t("ART.Card.unnamed"))}</span>
        <span class="art-row-note">0</span></button>`).join("");
    return `<button type="button" class="art-eyebrow art-fold${open ? " open" : ""}" data-action="toggleArchive" aria-expanded="${open}">
        ${icon(open ? "chevron-down" : "chevron-right")} ${esc(this.t("ART.Zone.archive"))} <span class="art-row-note">${list.length}</span></button>
      ${open ? rows : ""}`;
  }

  /**
   * Окно «Зоны» по макету C: слева список (новая зона и зоны по слоям с поиском),
   * справа то, что делаем с выбранным: тип и поля новой зоны или сведения о зоне, и кнопки.
   */
  renderZoneTool() {
    const s = this.studio;
    const z = s.zone;
    const types = s.types;
    const layers = s.layers;
    const zones = s.zones();
    const filter = z.filter.trim().toLowerCase();
    const target = z.target !== "new" && s.states.has(z.target) ? s.states.get(z.target) : null;
    const typeName = id => types.find(t => t.id === id)?.name ?? "";
    const colorOf = st => st.system.style?.color ?? types.find(t => t.id === st.system.typeId)?.style?.color ?? "#ccc";

    const byLayer = layers.map(l => {
      const list = zones.filter(zz => layerIdOf(zz, types) === l.id && zoneCells(zz).length)
        .filter(zz => !filter || zz.name.toLowerCase().includes(filter) || typeName(zz.system.typeId).toLowerCase().includes(filter))
        .sort((a, b) => a.name.localeCompare(b.name));
      if ( !list.length ) return "";
      return `<span class="art-eyebrow">${esc(l.name)}</span>` + list.map(zz => `<button type="button" class="art-zone art-row-item${zz.id === z.target ? " active" : ""}"
        data-action="zoneTarget" data-id="${esc(zz.id)}" title="${esc(typeName(zz.system.typeId))}"><i class="art-swatch" style="--c:${esc(colorOf(zz))}"></i>
        <span class="art-zone-name art-row-name">${esc(zz.name || this.t("ART.Card.unnamed"))}</span>
        <span class="art-row-note">${zoneCells(zz).length}</span></button>`).join("");
    }).join("") + this._archiveList(zones, filter, typeName, colorOf);

    const n = s.selection.size;
    const layerOpts = [`<option value="">${esc(this.t("ART.Zone.allLayers"))}</option>`,
      ...layers.map(l => `<option value="${esc(l.id)}"${l.id === z.detachLayer ? " selected" : ""}>${esc(l.name)}</option>`)].join("");
    const newType = types.find(t => t.id === z.typeId);
    const terrain = newType?.layerId === "terrain";
    const isNew = z.target === "new" || !target;
    const list = `<button type="button" class="art-zone art-zone-new art-row-item${isNew ? " active" : ""}" data-action="zoneTarget" data-id="new">
        ${icon("plus")}<span class="art-zone-name art-row-name">${esc(this.t("ART.Zone.newZone"))}</span></button>
      ${zones.length ? `<input type="search" class="art-search" data-model="zone.filter" data-key="zone-filter" value="${esc(z.filter)}" placeholder="${esc(this.t("ART.Zone.find"))}">
      <div class="art-zone-list">${byLayer}</div>` : ""}`;
    const main = isNew
      ? `<h4>${esc(this.t("ART.Zone.newZone"))}</h4>
        <div class="art-type-list">${this.renderTypes("area", z.typeId)}</div>
        <label class="art-field"><span>${esc(this.t("ART.Field.name"))}</span>
          <input type="text" data-model="zone.name" data-key="zone-name" value="${esc(z.name)}" placeholder="${esc(newType?.name ?? "")}"></label>
        <label class="art-field"><span>${esc(this.t("ART.Field.text"))}</span>
          <textarea rows="2" data-model="zone.text" data-key="zone-text" placeholder="${esc(this.t("ART.Field.textPh"))}">${esc(z.text ?? "")}</textarea></label>
        ${terrain ? "" : `<label class="art-field art-inline"><span>${esc(this.t("ART.Field.color"))}</span>
          ${colorField('data-model="zone.color"', z.color || "#c96f4a", "zone-color")}</label>`}`
      : `<h4><i class="art-swatch" style="--c:${esc(colorOf(target))}"></i> ${esc(target.name || this.t("ART.Card.unnamed"))}</h4>
        <p class="art-muted">${esc(typeName(target.system.typeId))} · ${esc(this.t("ART.Zone.cells", { n: zoneCells(target).length }))}</p>`;
    return `<p class="art-hint">${esc(this.t("ART.Zone.hint"))}</p>
      ${this.renderSelectionBar()}
      ${this.renderSplit(list, `${main}
        <div class="art-row-btns art-sticky">
          <button type="button" class="art-btn art-accent" data-action="attach" ${n ? "" : "disabled"}>${icon("check")} ${esc(this.t(target ? "ART.Zone.attachTo" : "ART.Zone.create", { n, name: target?.name ?? "" }))}</button>
        </div>
        <label class="art-check"><input type="checkbox" data-model="zone.paint" ${z.paint ? "checked" : ""}> ${esc(this.t("ART.Zone.paint"))}</label>
        <section class="art-block">
          <h4>${esc(this.t("ART.Zone.detachTitle"))}</h4>
          <div class="art-row-btns"><select data-model="zone.detachLayer">${layerOpts}</select>
          <button type="button" class="art-btn" data-action="detach" ${n ? "" : "disabled"}>${icon("eraser")} ${esc(this.t("ART.Zone.detach"))}</button></div>
        </section>`, "zones")}`;
  }

  renderMarkTool() {
    const s = this.studio;
    const m = s.mark;
    const n = s.selection.size;
    const type = s.typeById(m.typeId);
    return `<p class="art-hint">${esc(this.t("ART.Mark.hint"))}</p>
      ${this.renderSelectionBar()}
      ${this.renderSplit(this.renderTypes("object", m.typeId), `
        ${type ? `<div class="art-pick-head">${this.typeSwatch(type)}<b>${esc(type.name)}</b></div>` : ""}
        <label class="art-field"><span>${esc(this.t("ART.Field.name"))}</span>
          <input type="text" data-model="mark.name" data-key="mark-name" data-enter="placeMarks" value="${esc(m.name)}" placeholder="${esc(type?.name ?? "")}"></label>
        <label class="art-field"><span>${esc(this.t("ART.Field.text"))}</span>
          <textarea rows="2" data-model="mark.text" data-key="mark-text" placeholder="${esc(this.t("ART.Field.textPh"))}">${esc(m.text ?? "")}</textarea></label>
        <div class="art-row-btns art-sticky">
          <button type="button" class="art-btn art-accent" data-action="placeMarks" ${n ? "" : "disabled"}>${icon("location-dot")} ${esc(this.t("ART.Mark.place", { n }))}</button>
        </div>
        <label class="art-check"><input type="checkbox" data-model="mark.paint" ${m.paint ? "checked" : ""}> ${esc(this.t("ART.Mark.paint"))}</label>`, "marks")}`;
  }

  renderLineTool() {
    const s = this.studio;
    const l = s.line;
    const n = l.points.length;
    const type = s.typeById(l.typeId);
    return `<p class="art-hint">${esc(this.t("ART.Line.hint"))}</p>
      ${this.renderSplit(this.renderTypes("line", l.typeId), `
        ${type ? `<div class="art-pick-head">${this.typeSwatch(type)}<b>${esc(type.name)}</b></div>` : ""}
        <label class="art-field"><span>${esc(this.t("ART.Field.name"))}</span>
          <input type="text" data-model="line.name" data-key="line-name" data-enter="finishLine" value="${esc(l.name)}" placeholder="${esc(type?.name ?? "")}"></label>
        <label class="art-field"><span>${esc(this.t("ART.Field.text"))}</span>
          <textarea rows="2" data-model="line.text" data-key="line-text" placeholder="${esc(this.t("ART.Field.textPh"))}">${esc(l.text ?? "")}</textarea></label>
        <div class="art-field"><span>${esc(this.t("ART.Line.mode"))}</span>
          <div class="art-seg">${["free", "hex", "edge", "draw"].map(m => `<button type="button" class="art-btn${l.mode === m ? " active" : ""}" data-action="lineMode" data-mode="${m}" title="${esc(this.t(`ART.Line.hints.${m}`))}">${icon({ free: "bezier-curve", hex: "border-all", edge: "vector-square", draw: "pencil" }[m])} ${esc(this.t(`ART.Line.modes.${m}`))}</button>`).join("")}</div>
          <p class="art-hint">${esc(this.t(`ART.Line.hints.${l.mode}`))}</p></div>
        ${l.mode === "free" ? `<label class="art-check"><input type="checkbox" data-model="line.snap" ${l.snap ? "checked" : ""}> ${esc(this.t("ART.Line.snap"))}</label>` : ""}
        <label class="art-check"><input type="checkbox" data-model="line.join" ${l.join !== false ? "checked" : ""}> ${esc(this.t("ART.Line.join"))}</label>
        <div class="art-selbar"><span>${esc(this.t("ART.Line.points", { n }))}</span></div>
        <div class="art-row-btns art-sticky">
          <button type="button" class="art-btn art-accent" data-action="finishLine" ${n >= 2 ? "" : "disabled"}>${icon("check")} ${esc(this.t("ART.Line.finish"))}</button>
          <button type="button" class="art-btn" data-action="undoPoint" ${n ? "" : "disabled"}>${icon("rotate-left")}</button>
          <button type="button" class="art-btn" data-action="clearLine" ${n ? "" : "disabled"}>${icon("xmark")}</button>
        </div>`, "lines")}`;
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
    if ( patch(this.hud, this.renderHudBody()) ) {
      // Сводка встаёт над гексом и над колонками кнопок, если они выше гекса.
      const ch = Math.max(0, ...[...this.hud.querySelectorAll(".art-hud-col")].map(el => el.offsetHeight));
      this.hud.style.setProperty("--ch", `${ch}px`);
    }
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
    const owner = st.system.demiurge ? this.backend.actors().find(a => a.id === st.system.demiurge) : null;
    const title = h.name || st.name || type?.name || "";
    const sub = [type && type.name !== title ? type.name : "", owner?.name ?? ""].filter(Boolean).map(esc).join(" · ");
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
      return `<span class="art-chip${aspect ? " art-chip-aspect" : ""}" title="${esc(formatStatus(x))}">${icon(aspect ? (x.key ? statusIcon(x) : "star") : statusIcon(x))}<span>${esc(x.name)}</span>${level}</span>`;
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

  renderHudBody() {
    const s = this.studio;
    const sum = s.summary();
    if ( !sum ) return "";
    const [i, j] = sum.cell;
    const owner = sum.owner ? this.backend.actors().find(a => a.id === sum.owner) : null;
    const facts = [sum.terrain?.name, sum.realm?.name, sum.region?.name, owner?.name].filter(Boolean);
    const plate = sum.cells > 1 ? `<div class="art-hud-plate" title="${esc(this.t("ART.Hud.multiHint"))}">
      <b>${esc(this.t("ART.Card.hexes", { n: sum.cells }))}</b>
      ${sum.marks.length ? `<span class="art-hud-count" title="${esc(this.t("ART.Hud.marksHere"))}">${icon("location-dot")} ${sum.marks.length}</span>` : ""}
    </div>` : `<div class="art-hud-plate">
      <b>${esc(this.t("ART.Card.hex", { i, j }))}</b>${facts.length ? ` · ${facts.map(esc).join(" · ")}` : ""}
      ${sum.marks.length ? `<span class="art-hud-count" title="${esc(this.t("ART.Hud.marksHere"))}">${icon("location-dot")} ${sum.marks.length}</span>` : ""}
    </div>`;
    const btn = ({ action, ic, title }) => `<button type="button" class="art-hud-btn" data-action="${action}"
      title="${esc(title)}" aria-label="${esc(title)}">${icon(ic)}</button>`;
    const markType = s.typeById(s.mark.typeId) ?? s.typesOf("object")[0];
    const zoneTarget = s.zone.target !== "new" ? s.states.get(s.zone.target) : null;
    const zoneName = zoneTarget?.name ?? s.typeById(s.zone.typeId)?.name ?? s.typesOf("area")[0]?.name ?? "";
    const left = [
      { action: "hudDetails", ic: "circle-info", title: this.t("ART.Hud.details") },
      { action: "hudMark", ic: "location-dot", title: this.t("ART.Hud.markPick") },
      { action: "hudZone", ic: "draw-polygon", title: this.t("ART.Hud.zone", { name: zoneName }) },
      ...(sum.marks.length ? [{ action: "hudDelete", ic: "trash", title: this.t("ART.Hud.delete") }] : []),
      { action: "hudPan", ic: "crosshairs", title: this.t("ART.Card.pan") },
      { action: "hudClose", ic: "xmark", title: this.t("ART.Close") }
    ].map(b => btn(b).replace('class="art-hud-btn"', `class="art-hud-btn${s.hudMenu && ((b.action === "hudMark" && s.hudMenu.kind === "type") || (b.action === "hudDelete" && s.hudMenu.kind === "delete")) ? " active" : ""}"`)).join("");
    const menu = this._hudMenu(sum, markType);
    // Справа — что лежит на гексе: метки, потом зоны и линии. Щелчок открывает элемент в окне.
    const items = [...sum.marks, ...sum.zones, ...sum.lines];
    const MAX = 6;
    const shown = items.length > MAX ? items.slice(0, MAX - 1) : items;
    const right = shown.map(st => {
      const type = s.typeById(st.system.typeId);
      const title = `${st.name || this.t("ART.Card.unnamed")}${type?.name && type.name !== st.name ? ` (${type.name})` : ""}`;
      // Метки на одном гексе можно перетащить вверх-вниз: так меняется их порядок на карте.
      const drag = st.system.kind === "object" && sum.marks.length > 1 && sum.cells === 1
        ? ` draggable="true" data-drag-mark="${esc(st.id)}"` : "";
      const hint = drag ? ` · ${this.t("ART.Hud.dragOrder")}` : "";
      const sel = s.markSel.has(st.id) ? " selected" : "";
      return `<button type="button" class="art-hud-btn art-hud-item${sel}" data-action="hudDetails" data-id="${esc(st.id)}"${drag}
        title="${esc(title + hint)}" aria-label="${esc(title)}">${this._hudItemIcon(st)}</button>`;
    }).join("") + (items.length > shown.length
      ? `<button type="button" class="art-hud-btn art-hud-more" data-action="hudDetails" title="${esc(this.t("ART.Hud.details"))}">+${items.length - shown.length}</button>`
      : "");
    return `${plate}<div class="art-hud-col art-hud-left">${left}</div>${menu}
      ${right ? `<div class="art-hud-col art-hud-right">${right}</div>` : ""}`;
  }

  /** Быстрое меню у панели гекса: выбор типа метки или какую метку удалить. */
  _hudMenu(sum, current) {
    const s = this.studio;
    const m = s.hudMenu;
    if ( !m ) return "";
    if ( m.kind === "type" ) {
      const rows = s.markTypesForMenu().map(t => `<button type="button" class="art-menu-row${t.id === current?.id ? " active" : ""}" data-action="quickMark" data-id="${esc(t.id)}">
        ${this.typeSwatch(t)}<span>${esc(t.name)}</span></button>`).join("");
      return `<div class="art-hud-menu" role="menu"><div class="art-menu-head">${esc(this.t("ART.Hud.markPick"))}</div>${rows}</div>`;
    }
    const rows = sum.marks.map(st => `<button type="button" class="art-menu-row art-menu-del" data-action="deleteMark" data-id="${esc(st.id)}">
        ${this._hudItemIcon(st)}<span>${esc(st.name || this.t("ART.Card.unnamed"))}</span>${icon("trash")}</button>`).join("");
    return `<div class="art-hud-menu" role="menu"><div class="art-menu-head">${esc(this.t("ART.Hud.deleteWhich"))}</div>${rows}</div>`;
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

  /** Слои у названия сцены: набор слоёв и выключатель у каждого слоя, как панель «Слои» в Azgaar. */
  renderLayerbar() {
    const s = this.studio;
    const el = this.layerbar;
    el.hidden = !!this._hidden || (this.backend.isWorld && !this.backend.isWorld());
    if ( el.hidden ) return;
    const hidden = s.hidden();
    const presets = s.presets();
    const active = s.activePreset();
    const current = presets.find(p => p.id === active)?.name ?? this.t("ART.Preset.manual");
    const open = !!this.layersPanel;
    let panel = "";
    if ( open ) {
      const options = [`<option value=""${active ? "" : " selected"}>${esc(this.t("ART.Preset.manual"))}</option>`,
        ...presets.map(p => `<option value="${esc(p.id)}"${p.id === active ? " selected" : ""}>${esc(p.name)}</option>`)].join("");
      const custom = presets.find(p => p.id === active && p.custom);
      const fields = this.backend.fields?.();
      const btn = (id, name, { disabled = false, hint = "" } = {}) => {
        const on = isShown(id, hidden);
        return `<button type="button" class="art-lb-btn${on ? " on" : ""}" data-action="toggleLayer" data-id="${esc(id)}"
          aria-pressed="${on}" ${disabled ? "disabled" : ""} title="${esc(hint || this.t(on ? "ART.Layer.hide" : "ART.Layer.show"))}">${esc(name)}</button>`;
      };
      const zoneBtns = s.layers.map(l => btn(l.id, l.name));
      const FIELD = { "@heights": "height", "@temp": "temp", "@prec": "prec", "@pop": "pop", "@ice": "temp" };
      const partBtns = VIEW_PART_DEFS.map(d => {
        const f = FIELD[d.id];
        const empty = f && !hasField(fields, f);
        return btn(d.id, this.t(`ART.View.${d.id.slice(1)}`), empty ? { disabled: true, hint: this.t("ART.View.noData") } : {});
      });
      panel = `<div class="art-lb-panel" role="dialog" aria-label="${esc(this.t("ART.Layer.title"))}">
        <div class="art-row"><label class="art-lb-label">${esc(this.t("ART.Preset.title"))}</label>
          <select data-change="applyPreset">${options}</select>
          <button type="button" class="art-icon-btn" data-action="savePreset" title="${esc(this.t("ART.Preset.save"))}">${icon("floppy-disk")}</button>
          ${custom ? `<button type="button" class="art-icon-btn" data-action="deletePreset" data-id="${esc(custom.id)}" title="${esc(this.t("ART.Preset.delete"))}">${icon("trash")}</button>` : ""}</div>
        <div class="art-lb-grid">${[...zoneBtns, ...partBtns].join("")}</div>
        <p class="art-hint">${esc(this.t("ART.Layer.barHint"))}</p>
      </div>`;
    }
    patch(el, `<button type="button" class="art-lb-toggle${open ? " active" : ""}" data-action="toggleLayerPanel" aria-expanded="${open}"
        title="${esc(this.t("ART.Layer.barTitle"))}">${icon("layer-group")} <span>${esc(this.t("ART.Layer.title"))}</span> <b>${esc(current)}</b> ${icon(open ? "chevron-up" : "chevron-down")}</button>
      ${panel}`);
    this._placeLayerbar();
  }

  /** Встать под названием сцены в верхней панели Foundry; без неё — в левый верхний угол. */
  _placeLayerbar() {
    const el = this.layerbar;
    if ( !el || el.hidden ) return;
    const nav = document.querySelector("#scene-navigation, #navigation");
    const r = nav?.getBoundingClientRect?.();
    const left = r && r.width ? r.left : 120;
    const top = r && r.height ? r.bottom + 6 : 8;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  toggleLayerPanel(force = null) {
    this.layersPanel = force ?? !this.layersPanel;
    this.renderLayerbar();
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
    const secs = [
      gm && { id: "layers", ic: "layer-group" },
      { id: "area", ic: "draw-polygon" },
      { id: "object", ic: "location-dot" },
      { id: "line", ic: "route" },
      gm && { id: "world", ic: "earth-europe" },
      gm && { id: "rights", ic: "user-shield" }
    ].filter(Boolean);
    const tabs = `<nav class="art-tabs art-settings-tabs">${secs.map(x => `<button type="button" class="${x.id === sec ? "active" : ""}"
      data-action="settingsSection" data-section="${x.id}">${icon(x.ic)} ${esc(this.t(`ART.Settings.sec.${x.id}`))}</button>`).join("")}</nav>`;
    let body;
    if ( sec === "layers" ) body = this.renderSplit(this.renderLayerList(), this.renderLayerForm(), "set-layers");
    else if ( sec === "world" ) body = this.renderWorldSection();
    else if ( sec === "rights" ) body = this.renderRights();
    else body = this.renderSplit(this.renderTypeList(sec), s.typeForm?.kind === sec ? this.renderTypeForm() : `<p class="art-empty">${esc(this.t("ART.Settings.pick"))}</p>`, `set-${sec}`);
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

  renderTypeList(kind) {
    const s = this.studio;
    const list = s.typesOf(kind);
    const sel = s.settings.id;
    const row = t => this.listRow({ action: "settingsPick", id: t.id, active: t.id === sel, sw: this.typeSwatch(t), name: t.name,
      note: t.personal ? "★" : "" });
    let rows;
    if ( kind === "area" ) {
      rows = s.layers.map(l => {
        const items = list.filter(t => (t.layerId ?? "overlay") === l.id);
        return items.length ? `<span class="art-eyebrow">${esc(l.name)}</span>${items.map(row).join("")}` : "";
      }).join("");
      const orphan = list.filter(t => !s.layers.some(l => l.id === (t.layerId ?? "overlay")));
      if ( orphan.length ) rows += orphan.map(row).join("");
    } else rows = this._folderRows(kind, list, row);
    return `${rows}${this.listRow({ action: "settingsPick", id: "new", active: sel === "new", sw: icon("plus"), name: this.t("ART.Type.new"), attrs: ' data-new="1"' })}`;
  }

  renderLayerList() {
    const s = this.studio;
    const sel = s.settings.id;
    const types = s.typesOf("area");
    const rows = s.layers.map(l => this.listRow({ action: "settingsPick", id: l.id, active: l.id === sel, sw: icon("layer-group"),
      name: l.name, note: String(types.filter(t => (t.layerId ?? "overlay") === l.id).length) })).join("");
    return `${rows}${this.listRow({ action: "settingsPick", id: "new", active: sel === "new", sw: icon("plus"), name: this.t("ART.Layer.new") })}`;
  }

  renderLayerForm() {
    const s = this.studio;
    const f = s.layerForm;
    if ( !f ) return `<p class="art-empty">${esc(this.t("ART.Settings.pick"))}</p>`;
    const n = f.id ? s.layers.findIndex(l => l.id === f.id) : -1;
    const types = f.id ? s.typesOf("area").filter(t => (t.layerId ?? "overlay") === f.id) : [];
    return `<div class="art-form art-form-flat">
      <h4>${esc(this.t(f.id ? "ART.Layer.edit" : "ART.Layer.new"))}</h4>
      <label class="art-field"><span>${esc(this.t("ART.Field.name"))}</span>
        <input type="text" data-model="layerForm.name" data-key="lf-name" data-enter="saveLayer" value="${esc(f.name)}" placeholder="${esc(this.t("ART.Layer.namePh"))}"></label>
      <label class="art-check"><input type="checkbox" data-model="layerForm.exclusive" ${f.exclusive ? "checked" : ""}> ${esc(this.t("ART.Layer.exclusiveCheck"))}</label>
      <p class="art-hint">${esc(this.t("ART.Layer.exclusiveHint"))}</p>
      ${types.length ? `<div class="art-field"><span>${esc(this.t("ART.Layer.types"))}</span><div class="art-chips">${types.map(t => `<span class="art-chip">${this.typeSwatch(t)} ${esc(t.name)}</span>`).join("")}</div></div>` : ""}
      <div class="art-row-btns">
        <button type="button" class="art-btn art-accent" data-action="saveLayer">${icon("check")} ${esc(this.t("ART.Save"))}</button>
        ${f.id ? `<button type="button" class="art-btn art-icon-only" data-action="layerUp" data-id="${esc(f.id)}" title="${esc(this.t("ART.Layer.up"))}" ${n > 0 ? "" : "disabled"}>${icon("arrow-up")}</button>
        <button type="button" class="art-btn art-icon-only" data-action="layerDown" data-id="${esc(f.id)}" title="${esc(this.t("ART.Layer.down"))}" ${n >= 0 && n < s.layers.length - 1 ? "" : "disabled"}>${icon("arrow-down")}</button>
        ${f.id !== "terrain" ? `<button type="button" class="art-btn art-danger" data-action="deleteLayer" data-id="${esc(f.id)}" title="${esc(this.t("ART.Layer.delete"))}">${icon("trash")}</button>` : ""}` : ""}
      </div>
      ${f.id === "terrain" ? `<p class="art-hint">${esc(this.t("ART.Layer.terrainHint"))}</p>` : ""}
    </div>`;
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
    const tabs = `<nav class="art-tabs">
      <button type="button" class="${tab === "tile" ? "active" : ""}" data-action="rightTab" data-tab="tile">${icon("hexagon")} ${esc(this.t("ART.Card.tab"))}</button>
      <button type="button" class="${tab === "queue" ? "active" : ""}" data-action="rightTab" data-tab="queue">${icon("scroll")} ${esc(this.t("ART.Queue.title"))}${this._queueBadge() ? ` <span class="art-badge">${this._queueBadge()}</span>` : ""}</button>
      <button type="button" class="art-icon-btn" data-action="closeRight" title="${esc(this.t("ART.Close"))}">${icon("xmark")}</button>
    </nav>`;
    const body = tab === "queue" ? this.renderQueue() : this.renderTile();
    return `${tabs}<div class="art-body" data-scroll="right-${tab}">${body}</div>`;
  }

  renderTile() {
    const s = this.studio;
    if ( !s.inspected ) return `<p class="art-empty">${esc(this.t("ART.Card.pick"))}</p>`;
    const { zones, marks, lines, counts } = s.contents();
    const [i, j] = s.inspected;
    const n = s.multi ? s.selection.size : 1;
    const note = id => n > 1 ? this.t("ART.Card.inOf", { k: counts.get(id) ?? 0, n }) : "";
    const section = (key, list) => list.length ? `<section class="art-block"><h4>${esc(this.t(`ART.Card.${key}`))} <span class="art-muted">${list.length}</span></h4>
      ${list.map(st => this.renderItem(s.stateOf(st.id) ?? st, note(st.id))).join("")}</section>` : "";
    const empty = !zones.length && !marks.length && !lines.length;
    const head = n > 1
      ? `<header class="art-tile-head"><h3>${esc(this.t("ART.Card.hexes", { n }))}</h3>
        <button type="button" class="art-link" data-action="clearSelection">${esc(this.t("ART.Sel.clear"))}</button></header>
        <p class="art-hint">${esc(this.t("ART.Card.multiHint"))}</p>`
      : `<header class="art-tile-head"><h3>${esc(this.t("ART.Card.hex", { i, j }))}</h3></header>`;
    return `${head}
      ${empty ? `<p class="art-empty">${esc(this.t("ART.Card.empty"))}</p>` : ""}
      ${section("zones", zones)}${section("marks", marks)}${section("lines", lines)}`;
  }

  /** Строка элемента в карточке; раскрытая — с полями. */
  renderItem(st, note = "") {
    const s = this.studio;
    const types = s.types;
    const type = types.find(t => t.id === st.system.typeId);
    const color = st.system.style?.color ?? type?.style?.color ?? "#ccc";
    const owner = this.backend.actors().find(a => a.id === st.system.demiurge);
    const draft = this.backend.isGM ? null : this.backend.draftOps().find(op => op.id === st.id);
    const open = s.openId === st.id;
    const statuses = (st.system.statuses ?? []).filter(x => x.name).map(x => `<span class="art-status">${esc(formatStatus(x))}</span>`).join("");
    const aspects = (st.system.aspects ?? []).filter(x => x.name).map(x => `<span class="art-status art-aspect">${icon("star")} ${esc(formatStatus(x))}</span>`).join("");
    const kind = st.system.kind;
    const head = `<button type="button" class="art-item-head" data-action="openItem" data-id="${esc(st.id)}" aria-expanded="${open}">
      ${kind === "object" && (st.system.style?.icon ?? type?.style?.icon)
        ? iconImg(st.system.style?.icon ?? type.style.icon, color, { tint: (st.system.style?.tint ?? type?.style?.tint) !== false, cls: "art-item-icon" })
        : `<i class="art-swatch" style="--c:${esc(color)}"></i>`}
      <span class="art-item-title"><b>${esc(st.name || this.t("ART.Card.unnamed"))}</b>
      <span class="art-muted">${esc(type?.name ?? "")}${note ? ` · ${esc(note)}` : ""}${owner ? ` · ${esc(owner.name)}` : ""}${draft ? ` · <em>${esc(this.t("ART.Card.inDraft"))}</em>` : ""}</span></span>
      ${icon(open ? "chevron-up" : "chevron-down")}</button>`;
    const tags = !open && (statuses || aspects) ? `<div class="art-tags">${statuses}${aspects}</div>` : "";
    return `<article class="art-item${open ? " open" : ""}">${head}${tags}${open ? this.renderEditor(st, type) : ""}</article>`;
  }

  renderEditor(st, type) {
    const id = st.id;
    const s = this.studio;
    const kind = st.system.kind;
    const f = (field, extra = "") => `data-id="${esc(id)}" data-field="${esc(field)}" data-key="${esc(`${id}:${field}`)}"${extra}`;
    const typeOpts = s.typesOf(kind).map(t => `<option value="${esc(t.id)}"${t.id === st.system.typeId ? " selected" : ""}>${esc(t.name)}</option>`).join("");
    const actors = this.backend.actors();
    const ownerOpts = [`<option value="">${esc(this.t("ART.Card.noOwner"))}</option>`,
      ...actors.map(a => `<option value="${esc(a.id)}"${a.id === st.system.demiurge ? " selected" : ""}>${esc(a.name)}</option>`)].join("");
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
      ${kind === "object" ? this.renderVisibility(st) : ""}
      ${kind === "area" && !terrain ? this.renderLabelControls(st.system.style?.labelMode ?? "", st.system.style?.labelScale ?? type?.style?.labelScale ?? 1,
        { id, inherit: type?.style?.labelMode ?? ((type?.layerId ?? st.system.layerId) === "politics" ? "curved" : "straight") }) : ""}
      ${kind === "object" && s.contents().marks.length > 1 && !s.multi ? `<div class="art-row-btns"><span class="art-muted">${esc(this.t("ART.Card.order"))}</span>
        <button type="button" class="art-btn art-icon-only" data-action="markUp" data-id="${esc(id)}" title="${esc(this.t("ART.Card.earlier"))}">${icon("arrow-up")}</button>
        <button type="button" class="art-btn art-icon-only" data-action="markDown" data-id="${esc(id)}" title="${esc(this.t("ART.Card.later"))}">${icon("arrow-down")}</button></div>` : ""}
      ${kind === "area" && zoneCells(st).length > 1 ? `<p class="art-hint">${esc(this.t(s.multi ? "ART.Field.typeHereMany" : "ART.Field.typeHere"))}</p>` : ""}
      <label class="art-field"><span>${esc(this.t("ART.Field.owner"))}</span><select ${f("demiurge")}>${ownerOpts}</select></label>
      <label class="art-field"><span>${esc(this.t("ART.Field.text"))}</span><textarea rows="3" ${f("text")}>${esc(htmlToText(st.text))}</textarea></label>
      ${this.statusEdit === id ? this.renderStatusEditor(st) : this.renderStatusView(st)}
      <div class="art-row-btns">
        <button type="button" class="art-btn" data-action="pan" data-id="${esc(id)}">${icon("crosshairs")} ${esc(this.t("ART.Card.pan"))}</button>
        ${kind === "area" ? `<button type="button" class="art-btn" data-action="removeCell" data-id="${esc(id)}">${icon("eraser")} ${esc(this.t(s.multi ? "ART.Card.removeCells" : "ART.Card.removeCell"))}</button>` : ""}
        <button type="button" class="art-btn art-danger" data-action="deleteFeature" data-id="${esc(id)}" title="${esc(this.t("ART.Card.delete"))}">${icon("trash")}</button>
      </div>
    </div>`;
  }

  /** Кому видна метка, как у скрытого токена. Мастер и помощник видят всё. Менять может мастер или автор. */
  renderVisibility(st) {
    const id = st.id;
    const v = st.system.visibility ?? { mode: "all", users: [] };
    const can = this.studio.canChangeVisibility(st);
    const opt = m => `<option value="${m}"${(v.mode ?? "all") === m ? " selected" : ""}>${esc(this.t(`ART.Vis.${m}`))}</option>`;
    const players = v.mode === "some" ? this.backend.players().filter(p => p.id !== st.system.author).map(p => `<label class="art-check">
      <input type="checkbox" data-change="visUser" data-id="${esc(id)}" data-user="${esc(p.id)}" ${(v.users ?? []).includes(p.id) ? "checked" : ""} ${can ? "" : "disabled"}> ${esc(p.name)}</label>`).join("") : "";
    return `<label class="art-field"><span>${icon(v.mode && v.mode !== "all" ? "eye-slash" : "eye")} ${esc(this.t("ART.Vis.title"))}</span>
      <select data-change="visMode" data-id="${esc(id)}" ${can ? "" : "disabled"}>${opt("all")}${opt("gm")}${opt("some")}</select></label>
      ${players ? `<div class="art-parts">${players}</div>` : ""}
      ${can ? "" : `<p class="art-hint">${esc(this.t("ART.Vis.onlyAuthor"))}</p>`}`;
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
      layerName: id => this.studio.layers?.find?.(l => l.id === id)?.name ?? id };
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
