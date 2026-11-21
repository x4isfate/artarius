/**
 * Студия: состояние интерфейса гекс-мира и все действия игрока.
 * Не знает ни про Foundry, ни про PIXI: данные и запись идут через backend,
 * поэтому студию целиком можно гонять на стенде в браузере.
 *
 * backend — см. docs/API.md, раздел «Backend». Главное:
 *   states(), atlasStates(), types(), layers(), grid, commitOps(ops), saveType(t), deleteType(id),
 *   newId(), isGM, userId, players(), actors(), draftOps(), submitDraft(),
 *   claims(), applyClaims(), rejectClaims(), requestCheck(), returnToDraft(), dropClaim(),
 *   panTo(point), notify(level, text), t(key, data), onChange(fn).
 */
import { TOOL_KIND } from "./constants.mjs";
import {
  cellKey, parseKey, attachOps, detachOps, markOps, lineOp, tileContents, cellsAlong,
  makeType, nextZoneColor, layerIdOf, zoneCells, markCell, blankState
} from "./data/world.mjs";
import { randomId, statusToAspect } from "./review/ops.mjs";
import { simplify } from "./geometry/geometry.mjs";
import { viewOf, activePreset, BUILTIN_PRESETS, VIEW_PARTS } from "./data/view.mjs";
import { ICON_LIBRARY, iconPath, isLibraryIcon } from "./data/icons.mjs";
import { layoutMarks, markAt, groupOrder, markFootprint } from "./data/mark-layout.mjs";
import { baseStatus, baseAspect } from "./data/statuses.mjs";
import { checkOps, demiurgesOf, setDemiurges, canEditVisibility, lockedViewers } from "./data/access.mjs";
import { joinLine, lineAt, nameRange, rangeForCells, segmentNameAt, nearestVertex, edgePath } from "./data/lines.mjs";
import { resolveStyleOf } from "./canvas/style.mjs";
import { isResourceType } from "./data/view.mjs";

/** Раздел библиотеки, где лежит значок; для чужих картинок — первый раздел. */
const iconCategory = path => Object.keys(ICON_LIBRARY).find(c => ICON_LIBRARY[c].some(([n]) => path === iconPath(n))) ?? "settlements";

export const TOOLS = ["select", "zone", "mark", "line"];

export default class Studio {
  constructor(backend) {
    this.backend = backend;
    /** Текущий инструмент; null — Артарий выключен, мышь у Foundry. */
    this.tool = null;
    /** Выбранные гексы: ключ "i,j" → [i, j]. Общие для зоны и метки. */
    this.selection = new Map();
    /** Гекс, который смотрим в карточке. */
    this.inspected = null;
    /** Раскрытый элемент в карточке. */
    this.openId = null;
    /** Вкладка правой панели: "tile" или "queue". */
    this.rightTab = "tile";
    this.rightOpen = false;
    /** Панель кнопок вокруг осматриваемого гекса. */
    this.hudOpen = false;
    /** Метку тащат мышью: { id, from, at, moved }. */
    this.markDrag = null;
    /** Настройки инструментов. */
    this.zone = { target: "new", typeId: "forest", name: "", text: "", color: "", paint: false, detachLayer: "terrain", filter: "" };
    this.mark = { typeId: "city", name: "", text: "", paint: false };
    /** mode: "free" — точки где угодно, "hex" — путь через центры гексов, "draw" — от руки протяжкой. */
    this.line = { typeId: "river", name: "", text: "", points: [], snap: false, mode: "free", cells: [], join: true };
    /** Форма нового или изменяемого типа: { kind, id?, name, color, icon, layerId } или null. */
    this.typeForm = null;
    /** Окно настроек модуля: раздел и выбранный в списке элемент. Раздел: layers | area | object | line | world. */
    this.settings = { open: false, section: "layers", id: null, back: false };
    /** Форма слоя в настройках: { id?, name, exclusive } или null. */
    this.layerForm = null;
    /** Форма заявки игрока. */
    this.claimForm = { title: "", note: "" };
    /** Заявки, которые мастер смотрит на карте, и отмеченные галочкой. */
    this.previewIds = new Set();
    this.checkedIds = new Set();
    /** Курсор над гексом (для подсветки). */
    this.hover = null;
    /** Линия под курсором: { id, name, at } или null. */
    this.hoverLine = null;
    /** Выбранные метки (id). Действия панели внизу, Delete и корзина работают с ними. */
    this.markSel = new Set();
    /** Рамка выбора меток (Ctrl-протяжка): { start, at, add }. */
    this.box = null;
    /** Быстрое меню на панели гекса: { kind: "type" | "delete" } или null. */
    this.hudMenu = null;
    /** История для Ctrl+Z: записи { undo(), redo(), label }. */
    this._history = [];
    this._redo = [];
    this.listeners = new Set();
    this._drag = null;
    this._busy = false;
    backend.onChange?.(() => this.changed("data"));
  }

  t(key, data) { return this.backend.t(key, data); }

  /* ---------------------------------------------------------------- */
  /*  Подписка                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * fn(what): what — "data" (данные карты), "ui" (окна), "overlay" (выделение и курсор на карте),
   * "stroke" (идёт мазок кистью: только накладка, окна ждут конца мазка), "cursor" (гекс под курсором),
   * "hover" (подсказка у курсора).
   */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed(what = "ui") {
    // Места меток пересчитываются, только когда поменялись данные (вид слоёв — тоже данные).
    if ( what === "data" ) this._slotsCache = null;
    for ( const fn of this.listeners ) {
      try { fn(what); }
      catch(err) { console.error("artarius | studio listener", err); }
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Данные                                                            */
  /* ---------------------------------------------------------------- */

  get states() { return this.backend.states(); }
  get types() { return this.backend.types(); }
  get layers() { return this.backend.layers(); }
  get grid() { return this.backend.grid; }

  /* ---------------------------------------------------------------- */
  /*  Что видно: слои и наборы слоёв                                   */
  /* ---------------------------------------------------------------- */

  hidden() { return this.backend.hiddenIds?.() ?? new Set(this.layers.filter(l => l.visible === false).map(l => l.id)); }
  view() { return viewOf(this.hidden()); }
  presets() {
    const custom = (this.backend.customPresets?.() ?? []).map(p => ({ ...p, custom: true }));
    return [...BUILTIN_PRESETS.map(p => ({ ...p, name: this.t(`ART.Preset.${p.id}`) })), ...custom];
  }
  activePreset() { return activePreset(this.hidden(), this.presets(), new Set([...this.layers.map(l => l.id), ...VIEW_PARTS])); }

  async applyPreset(id) {
    const p = this.presets().find(x => x.id === id);
    if ( p ) await this.backend.setHidden?.(p.hidden);
    this.changed("ui");
  }

  async savePreset() {
    const name = await this.backend.prompt?.(this.t("ART.Preset.saveTitle"), "");
    if ( !name ) return;
    const list = this.backend.customPresets?.() ?? [];
    list.push({ id: `custom-${this.backend.newId()}`, name, hidden: [...this.hidden()] });
    await this.backend.setCustomPresets?.(list);
    this.changed("ui");
  }

  async deletePreset(id) {
    const list = (this.backend.customPresets?.() ?? []).filter(p => p.id !== id);
    await this.backend.setCustomPresets?.(list);
    this.changed("ui");
  }

  typesOf(kind) { return this.types.filter(t => t.kind === kind); }

  typeById(id) { return this.types.find(t => t.id === id) ?? null; }

  /** Тип по умолчанию для вида, если выбранного больше нет. */
  _ensureType(slot, kind) {
    const list = this.typesOf(kind);
    if ( !list.some(t => t.id === this[slot].typeId) ) this[slot].typeId = list[0]?.id ?? "";
  }

  zones() {
    return [...this.states.values()].filter(s => s.system.kind === "area");
  }

  /**
   * Один справочник зон: слой → тип → зоны, вместе с пустыми (у них 0 гексов).
   * Его читают кисть зон, меню «Добавить в зону», окно слоёв и настройки.
   * filter ищет по названию зоны и типа. Зоны с неизвестным типом идут последней группой.
   */
  zoneCatalog(filter = "") {
    const f = String(filter ?? "").trim().toLowerCase();
    const types = this.typesOf("area");
    const typeName = id => types.find(t => t.id === id)?.name ?? "";
    const match = z => !f || (z.name ?? "").toLowerCase().includes(f) || typeName(z.system.typeId).toLowerCase().includes(f);
    const zones = this.zones().filter(match).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    const out = this.layers.map(layer => ({
      layer,
      types: types.filter(t => (t.layerId ?? "overlay") === layer.id)
        .map(type => ({ type, zones: zones.filter(z => z.system.typeId === type.id) }))
    }));
    const placed = new Set(out.flatMap(g => g.types.flatMap(x => x.zones.map(z => z.id))));
    const lost = zones.filter(z => !placed.has(z.id));
    if ( lost.length ) out.push({ layer: { id: "", name: this.t("ART.Zone.otherZones") }, types: [{ type: null, zones: lost }] });
    return out;
  }

  /* ---------------------------------------------------------------- */
  /*  Инструменты                                                       */
  /* ---------------------------------------------------------------- */

  /** Выбрать инструмент. Повторный выбор того же убирает инструменты (toggle), если не сказано иначе. */
  setTool(tool, { toggle = true, fromCanvas = false } = {}) {
    if ( tool && !TOOLS.includes(tool) ) return;
    const prev = this.tool;
    this.tool = toggle && tool === prev ? null : tool;
    if ( this.tool === prev && fromCanvas ) return;
    // Счётчик выборов инструмента: закрытое крестиком окно снова открывается, когда инструмент выбирают заново.
    if ( !fromCanvas || this.tool !== prev ) this.toolPicks = (this.toolPicks ?? 0) + 1;
    if ( this.tool !== "line" ) { this.line.points = []; this.line.cells = []; }
    // Панель на гексе — часть осмотра: другой инструмент её убирает.
    if ( this.tool !== "select" ) this.hudOpen = false;
    // Без инструмента рамка осмотра не висит на карте сама по себе (окно подробностей её держит).
    if ( !this.tool && !this.rightOpen ) this.inspected = null;
    this.markDrag = null;
    this.typeForm = null;
    if ( this.tool === "zone" ) this._ensureType("zone", "area");
    if ( this.tool === "mark" ) this._ensureType("mark", "object");
    if ( this.tool === "line" ) this._ensureType("line", "line");
    if ( !fromCanvas ) this.backend.activateLayer?.(this.tool);
    this.changed("ui");
    this.changed("overlay");
  }

  /** Foundry переключил слой: если не наш, инструмент гаснет. */
  layerDeactivated() {
    if ( !this.tool ) return;
    this.tool = null;
    this.line.points = [];
    this.hudOpen = false;
    this.markDrag = null;
    if ( !this.rightOpen ) this.inspected = null;
    this.changed("ui");
    this.changed("overlay");
  }

  /* ---------------------------------------------------------------- */
  /*  Мышь на карте (вызывает слой)                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Нажатие на карте. dragStart — Foundry сообщает о начале протяжки после щелчка:
   * точку линии второй раз не ставим, гекс осмотра не открываем.
   */
  pointerDown(point, { shift = false, alt = false, ctrl = false, dragStart = false } = {}) {
    const cell = this.grid.cellAt(point);
    const inside = this.grid.inBounds(cell);
    // Осмотр с Shift: протяжка добавляет гексы в осмотр.
    if ( dragStart && shift && this.tool === "select" && inside ) {
      this._drag = { last: cell, erase: false, added: new Map(), inspect: true };
      this._touch(cell);
      return;
    }
    if ( dragStart && (alt || this.tool === "select" || this.tool === "line") ) return;
    if ( this.tool === "select" && ctrl ) {
      // Ctrl-протяжка: рамка выбора меток. Shift вместе с Ctrl добавляет к уже выбранным.
      this.box = { start: point, at: point, add: shift };
      this.changed("overlay");
      return "grab";
    }
    if ( shift && this.tool === "select" && !alt ) {
      // Shift-щелчок по метке добавляет её к выбранным или убирает; по пустому месту — гекс в осмотр.
      const onMark = markAt(this.markSlots().slots, point);
      if ( onMark ) { this.toggleMarkSel(onMark.id); return; }
      if ( inside ) {
        this.inspectToggle(cell);
        // Если кнопку не отпустили и повели, гексы по пути добавляются в осмотр.
        this._drag = { last: cell, erase: false, added: new Map(), inspect: true };
      }
      return;
    }
    if ( alt || this.tool === "select" ) {
      // Метку под курсором можно утащить на другой гекс, с Alt — в любую точку; щелчок без протяжки выбирает её.
      const hit = this.tool === "select" ? markAt(this.markSlots().slots, point) : null;
      if ( hit ) {
        this.markDrag = { id: hit.id, from: hit.cell, at: point, start: point, moved: false, free: alt };
        return "grab";
      }
      if ( this.markSel.size ) { this.markSel.clear(); this.changed("overlay"); }
      if ( inside ) {
        // Простой щелчок после осмотра нескольких гексов начинает осмотр заново, с одного гекса.
        if ( !alt && this.selection.size > 1 ) this.selection.clear();
        this.inspect(cell, { toggle: true });
      }
      return;
    }
    if ( this.tool === "line" ) {
      const l = this.line;
      if ( l.mode === "draw" ) {
        // От руки: линия пишется протяжкой и заканчивается, когда кнопку отпустили.
        l.points = [[Math.round(point.x), Math.round(point.y)]];
        this._sketch = true;
      } else if ( l.mode === "edge" ) {
        // По краям гексов: щелчок встаёт в ближайшую вершину, путь до неё идёт по рёбрам клеток.
        const v = nearestVertex(this.grid, point);
        if ( !v ) return;
        const last = l.points.at(-1);
        // Точки линии округлены до пикселя: путь начинаем от настоящей вершины рядом с последней точкой.
        const path = last ? edgePath(this.grid, nearestVertex(this.grid, { x: last[0], y: last[1] }), v).slice(1) : [v];
        for ( const p of path ) l.points.push([Math.round(p.x), Math.round(p.y)]);
        l.cells.push(path.length);
      } else if ( l.mode === "hex" ) {
        if ( !inside ) return;
        const last = l.cells.at(-1);
        const path = last ? cellsAlong(last, cell, this.grid.center, this.grid.cellAt).slice(1) : [cell];
        for ( const c of path ) {
          if ( !this.grid.inBounds(c) ) continue;
          const p = this.grid.center(c);
          l.cells.push(c);
          l.points.push([Math.round(p.x), Math.round(p.y)]);
        }
      } else {
        const p = l.snap || ctrl ? this.grid.center(cell) : point;
        l.points.push([Math.round(p.x), Math.round(p.y)]);
      }
      this.changed("ui");
      this.changed("overlay");
      return;
    }
    if ( (this.tool === "zone" || this.tool === "mark") && inside ) {
      this._drag = { last: cell, erase: shift, added: new Map() };
      this._touch(cell);
    }
  }

  pointerMove(point) {
    if ( this.box ) {
      this.box.at = point;
      this.changed("overlay");
      return;
    }
    if ( this.markDrag ) {
      const d = this.markDrag;
      d.at = point;
      if ( !d.moved && Math.hypot(point.x - d.start.x, point.y - d.start.y) > this.grid.radius * 0.2 ) d.moved = true;
      if ( d.moved ) this.changed("overlay");
      return;
    }
    if ( this._sketch ) {
      const pts = this.line.points;
      const last = pts.at(-1);
      // Точка не чаще чем через четверть гекса: линия гладкая и не раздутая.
      if ( Math.hypot(point.x - last[0], point.y - last[1]) >= this.grid.radius * 0.25 ) {
        pts.push([Math.round(point.x), Math.round(point.y)]);
        this.changed("overlay");
      }
      return;
    }
    this._hoverLine(point);
    const cell = this.grid.cellAt(point);
    const k = this.grid.inBounds(cell) ? cellKey(cell) : null;
    const hoverChanged = (this.hover ? cellKey(this.hover) : null) !== k;
    this.hover = k ? cell : null;
    if ( this._drag && k && cellKey(this._drag.last) !== k ) {
      for ( const c of cellsAlong(this._drag.last, cell, this.grid.center, this.grid.cellAt) ) {
        if ( this.grid.inBounds(c) ) this._touch(c);
      }
      this._drag.last = cell;
    }
    if ( hoverChanged ) this.changed("cursor");
  }

  async pointerUp() {
    if ( this.box ) {
      const b = this.box;
      this.box = null;
      const [x0, x1] = [Math.min(b.start.x, b.at.x), Math.max(b.start.x, b.at.x)];
      const [y0, y1] = [Math.min(b.start.y, b.at.y), Math.max(b.start.y, b.at.y)];
      if ( !b.add ) this.markSel.clear();
      for ( const sl of this.markSlots().slots ) {
        if ( sl.id && sl.x >= x0 && sl.x <= x1 && sl.y >= y0 && sl.y <= y1 ) this.markSel.add(sl.id);
      }
      this.changed("overlay");
      this.changed("ui");
      return;
    }
    if ( this.markDrag ) {
      const d = this.markDrag;
      this.markDrag = null;
      if ( !d.moved ) {
        // Щелчок по метке: гекс в осмотр и сама метка выбрана (корзина и Delete удалят её).
        this.markSel = new Set([d.id]);
        this.inspect(d.from, { toggle: false });
        this.changed("overlay");
        return;
      }
      const to = this.grid.cellAt(d.at);
      if ( d.free ) { if ( this.grid.inBounds(to) ) await this.moveMarkFree(d.id, d.at); }
      else if ( this.grid.inBounds(to) && cellKey(to) !== cellKey(d.from) ) await this.moveMark(d.id, to);
      this.changed("overlay");
      return;
    }
    if ( this._sketch ) {
      this._sketch = false;
      if ( this.line.points.length >= 2 ) await this.finishLine();
      else { this.line.points = []; this.changed("overlay"); }
      return;
    }
    const d = this._drag;
    this._drag = null;
    if ( !d ) return;
    // В режиме «Рисовать сразу» протяжка тут же уходит в зону или ставит метки.
    if ( !d.erase && d.added.size ) {
      if ( this.tool === "zone" && this.zone.paint ) await this.attach([...d.added.values()]);
      else if ( this.tool === "mark" && this.mark.paint ) await this.placeMarks([...d.added.values()]);
    }
    this.changed("ui");
  }

  /** Линия под курсором: её название (или название участка) всплывает подсказкой. */
  _hoverLine(point) {
    const view = this.view();
    // Сначала метка под курсором (карточка с хозяином и статусами), потом линия.
    const mark = !this._drag && !this.box ? markAt(this.markSlots().slots, point) : null;
    const hit = !mark && !this._drag && (view.lines !== false || view.rivers !== false)
      ? lineAt(this.states, [point.x, point.y], Math.max(6, this.grid.radius * 0.18))
      : null;
    const next = mark ? { id: mark.id, name: this.stateOf(mark.id)?.name ?? "", at: { x: mark.x, y: mark.y - (mark.d / 2) }, mark: true }
      : hit ? { id: hit.state.id, name: hit.name ?? "", at: point } : null;
    const prev = this.hoverLine;
    this.hoverLine = next;
    if ( (prev?.id ?? null) !== (next?.id ?? null) || prev?.name !== next?.name || next ) this.changed("hover");
  }

  _touch(cell) {
    const k = cellKey(cell);
    if ( this._drag.erase ) this.selection.delete(k);
    else {
      if ( this._drag.inspect && !this.selection.size && this.inspected ) this.selection.set(cellKey(this.inspected), this.inspected);
      this.selection.set(k, cell);
      this._drag.added.set(k, cell);
      if ( this._drag.inspect ) { this.inspected = cell; this.hudOpen = true; }
    }
    // Во время мазка перерисовывается только выделение на карте; окна обновятся, когда кнопку отпустят.
    this.changed("stroke");
  }

  /** Правая кнопка: убрать последнюю точку линии или снять выделение. Метки она не удаляет. */
  rightClick() {
    if ( this.hudMenu ) { this.hudMenu = null; this.changed("ui"); return; }
    if ( this.tool === "line" && this.line.points.length ) this.undoPoint();
    else this.selection.clear();
    this.changed("ui");
    this.changed("overlay");
  }

  /** Esc: сбросить начатое. Возвращает true, если было что сбрасывать. */
  dismiss() {
    if ( this.box ) { this.box = null; this.changed("overlay"); return true; }
    if ( this.markDrag ) { this.markDrag = null; this.changed("overlay"); return true; }
    if ( this.hudMenu ) { this.hudMenu = null; this.changed("ui"); return true; }
    if ( this.markSel.size ) { this.markSel.clear(); this.changed("ui"); this.changed("overlay"); return true; }
    if ( this.typeForm ) { this.typeForm = null; this.changed("ui"); return true; }
    if ( this.hudOpen ) { this.closeHud(); return true; }
    if ( this.line.points.length ) { this.clearLine(); return true; }
    if ( this.selection.size ) { this.clearSelection(); return true; }
    return false;
  }

  clearSelection() {
    this.selection.clear();
    this.changed("ui");
    this.changed("overlay");
  }

  selectedCells() { return [...this.selection.values()]; }

  /* ---------------------------------------------------------------- */
  /*  Зона                                                              */
  /* ---------------------------------------------------------------- */

  async attach(cells = this.selectedCells()) {
    if ( !cells.length ) return this.backend.notify("warn", this.t("ART.Zone.noCells"));
    const { states, types, layers } = this;
    let ops;
    if ( this.zone.target && this.zone.target !== "new" && states.has(this.zone.target) ) {
      ops = attachOps({ states, types, layers, cells, target: this.zone.target });
    } else {
      const type = this.typeById(this.zone.typeId);
      if ( !type ) return this.backend.notify("warn", this.t("ART.Zone.noType"));
      const id = this.backend.newId();
      const terrain = type.layerId === "terrain";
      ops = attachOps({
        states, types, layers, cells,
        newZone: {
          id, typeId: type.id, name: this.zone.name.trim() || type.name,
          color: terrain ? "" : (this.zone.color || nextZoneColor(states))
        }
      });
      const text = this.zone.text?.trim();
      if ( text ) for ( const op of ops ) if ( op.action === "create" && op.id === id ) op.state.text = text;
      // Дальше рисуем в ту же зону, а не плодим новые.
      this.zone.target = id;
      this.zone.name = "";
      this.zone.text = "";
      this.zone.color = "";
    }
    await this._commit(ops);
    for ( const c of cells ) this.selection.delete(cellKey(c));
    this.changed("ui");
    this.changed("overlay");
  }

  /**
   * Кнопка «Создать зону» в окне зон: с выбранными гексами — как «Добавить», без них — пустая зона.
   * Пустая зона встаёт в справочник с 0 гексов, красить ею можно потом.
   */
  async createZone() {
    if ( this.selection.size ) return this.attach();
    const type = this.typeById(this.zone.typeId);
    if ( !type ) return this.backend.notify("warn", this.t("ART.Zone.noType"));
    const id = this.backend.newId();
    const state = blankState({
      id, kind: "area", name: this.zone.name.trim() || type.name, typeId: type.id, layerId: type.layerId ?? "overlay",
      style: type.layerId === "terrain" ? {} : { color: this.zone.color || nextZoneColor(this.states) },
      geometry: { cells: [] }
    });
    const text = this.zone.text?.trim();
    if ( text ) state.text = text;
    this.zone.target = id;
    this.zone.name = "";
    this.zone.text = "";
    this.zone.color = "";
    await this._commit([{ action: "create", id, state }]);
    this.backend.notify("info", this.t("ART.Zone.createdEmpty", { name: state.name }));
    this.changed("ui");
  }

  /** Убрать выбранные гексы из зон слоя. */
  async detach(cells = this.selectedCells()) {
    if ( !cells.length ) return this.backend.notify("warn", this.t("ART.Zone.noCells"));
    const ops = detachOps({ states: this.states, types: this.types, cells, layerId: this.zone.detachLayer || null });
    if ( !ops.length ) return this.backend.notify("info", this.t("ART.Zone.nothingToDetach"));
    await this._commit(ops);
    this.selection.clear();
    this.changed("ui");
    this.changed("overlay");
  }

  setZoneTarget(target) {
    this.zone.target = target || "new";
    const z = this.states.get(this.zone.target);
    if ( z ) this.zone.typeId = z.system.typeId;
    this.changed("ui");
    this.changed("overlay");
  }

  /* ---------------------------------------------------------------- */
  /*  Метка                                                             */
  /* ---------------------------------------------------------------- */

  async placeMarks(cells = this.selectedCells()) {
    if ( !cells.length ) return this.backend.notify("warn", this.t("ART.Mark.noCells"));
    if ( !this.typeById(this.mark.typeId) ) return this.backend.notify("warn", this.t("ART.Mark.noType"));
    const ops = markOps({
      cells, typeId: this.mark.typeId, name: this.mark.name.trim(), types: this.types,
      center: this.grid.center, newId: () => this.backend.newId()
    });
    const text = this.mark.text?.trim();
    if ( text ) for ( const op of ops ) if ( op.action === "create" ) op.state.text = text;
    await this._commit(ops);
    for ( const c of cells ) this.selection.delete(cellKey(c));
    this.changed("ui");
    this.changed("overlay");
  }

  /** Видимые метки и их места на карте (группы в гексах, как в Civ 5). */
  markSlots() {
    if ( this._slotsCache ) return this._slotsCache;
    this._slotsCache = this._layoutSlots();
    return this._slotsCache;
  }

  _layoutSlots() {
    const view = this.view();
    const types = this.types;
    const marks = [...this.states.values()].filter(s => s.system.kind === "object"
      && (isResourceType(s.system.typeId) ? view.resources : view.marks));
    return layoutMarks(marks, this.grid, m => resolveStyleOf(m, types).size, m => resolveStyleOf(m, types).cells ?? 1);
  }

  /** Перенести метку в центр другого гекса. У игрока перенос уходит в черновик, как любая правка. */
  async moveMark(id, cell) {
    const st = this.stateOf(id);
    if ( !st || st.system.kind !== "object" || !this.grid.inBounds(cell) ) return;
    const { x, y } = this.grid.center(cell);
    await this.edit(id, s => {
      s.system.geometry = { ...(s.system.geometry ?? {}), x: Math.round(x), y: Math.round(y), cell: [...cell], free: false };
    }, { now: true });
    this.changed("ui");
    this.changed("overlay");
  }

  /** Перенести метку в любую точку (Alt-протяжка): она стоит там, где отпустили, и не встаёт в группу гекса. */
  async moveMarkFree(id, point) {
    const st = this.stateOf(id);
    const cell = this.grid.cellAt(point);
    if ( !st || st.system.kind !== "object" || !this.grid.inBounds(cell) ) return;
    await this.edit(id, s => {
      s.system.geometry = { ...(s.system.geometry ?? {}), x: Math.round(point.x), y: Math.round(point.y), cell: [...cell], free: true };
    }, { now: true });
    this.changed("ui");
    this.changed("overlay");
  }

  /* ---------------------------------------------------------------- */
  /*  Выбор меток и действия над ними                                  */
  /* ---------------------------------------------------------------- */

  toggleMarkSel(id) {
    if ( this.markSel.has(id) ) this.markSel.delete(id);
    else this.markSel.add(id);
    this.changed("overlay");
    this.changed("ui");
  }

  clearMarkSel() {
    this.markSel.clear();
    this.changed("overlay");
    this.changed("ui");
  }

  /** Выбранные метки, которые ещё существуют. */
  selectedMarks() {
    return [...this.markSel].map(id => this.stateOf(id)).filter(s => s?.system.kind === "object");
  }

  /** Удалить метки без вопроса: Ctrl+Z вернёт. ids по умолчанию — выбранные. */
  async deleteMarks(ids = [...this.markSel]) {
    const list = ids.map(id => this.stateOf(id)).filter(s => s?.system.kind === "object");
    if ( !list.length ) return;
    for ( const s of list ) {
      this._pending?.delete(s.id);
      this.markSel.delete(s.id);
      if ( this.openId === s.id ) this.openId = null;
    }
    this.hudMenu = null;
    await this._commit(list.map(s => ({ action: "delete", id: s.id, name: s.name })), { label: "delete" });
    const name = list.length === 1 ? (list[0].name || this.t("ART.Card.unnamed")) : "";
    this.backend.notify("info", list.length === 1 ? this.t("ART.Mark.deletedOne", { name }) : this.t("ART.Mark.deletedMany", { n: list.length }));
    this.changed("ui");
    this.changed("overlay");
  }

  /** Сменить тип всем выбранным меткам одной записью. */
  async retypeMarks(typeId, ids = [...this.markSel]) {
    if ( !this.typeById(typeId) ) return;
    const ops = [];
    for ( const id of ids ) {
      const s = this.stateOf(id);
      if ( s?.system.kind !== "object" || s.system.typeId === typeId ) continue;
      const next = plainClone(s);
      next.system.typeId = typeId;
      ops.push({ action: "update", id, state: next });
      this._pending?.delete(id);
    }
    await this._commit(ops);
    this.changed("ui");
    this.changed("overlay");
  }

  /** Корзина на панели гекса: удалить выбранные метки, одну метку гекса сразу или открыть список, что удалить. */
  async hudDelete() {
    const here = new Set(this.contents().marks.map(m => m.id));
    const chosen = [...this.markSel].filter(id => here.has(id));
    if ( chosen.length ) return this.deleteMarks(chosen);
    if ( here.size === 1 ) return this.deleteMarks([...here]);
    this.hudMenu = this.hudMenu?.kind === "delete" ? null : { kind: "delete" };
    this.changed("ui");
  }

  /** Кнопка «Поставить метку»: быстрый выбор типа, недавние сверху. */
  toggleTypeMenu() {
    this.hudMenu = this.hudMenu?.kind === "type" ? null : { kind: "type" };
    this.changed("ui");
  }

  /** Недавние типы меток впереди, потом остальные по порядку. */
  markTypesForMenu() {
    const recent = this._recentTypes ?? [];
    const list = this.typesOf("object");
    const rank = t => { const n = recent.indexOf(t.id); return n < 0 ? 999 : n; };
    return list.map((t, n) => ({ t, n })).sort((a, b) => (rank(a.t) - rank(b.t)) || (a.n - b.n)).map(x => x.t);
  }

  async quickMark(typeId) {
    if ( !this.typeById(typeId) ) return;
    this.mark.typeId = typeId;
    this._recentTypes = [typeId, ...(this._recentTypes ?? []).filter(id => id !== typeId)].slice(0, 5);
    this.hudMenu = null;
    await this.markHere();
  }

  /**
   * Порядок меток на гексе. id встаёт перед before (или в конец, если before пуст).
   * Всем меткам гекса пишется sort по новому порядку: на карте и на панели они идут так же.
   */
  async reorderMark(id, before = null) {
    const st = this.stateOf(id);
    if ( !st || st.system.kind !== "object" || id === before ) return;
    const key = cellKey(markCell(st, this.grid.cellAt));
    const list = [...this.states.values()].map(s => this.stateOf(s.id))
      .filter(s => s.system.kind === "object" && cellKey(markCell(s, this.grid.cellAt)) === key)
      .sort(groupOrder);
    const ids = list.map(s => s.id).filter(x => x !== id);
    const at = before ? ids.indexOf(before) : -1;
    ids.splice(at < 0 ? ids.length : at, 0, id);
    const ops = [];
    ids.forEach((mid, n) => {
      const s = list.find(x => x.id === mid);
      if ( (s.system.sort ?? 0) === n + 1 ) return;
      const next = plainClone(s);
      next.system.sort = n + 1;
      ops.push({ action: "update", id: mid, state: next });
    });
    if ( ops.length ) await this._commit(ops);
    this.changed("ui");
    this.changed("overlay");
  }

  /** Сдвинуть метку на шаг в порядке гекса: dir −1 — раньше, +1 — позже. */
  async shiftMark(id, dir) {
    const st = this.stateOf(id);
    if ( !st ) return;
    const key = cellKey(markCell(st, this.grid.cellAt));
    const ids = [...this.states.values()].map(s => this.stateOf(s.id))
      .filter(s => s.system.kind === "object" && cellKey(markCell(s, this.grid.cellAt)) === key)
      .sort(groupOrder).map(s => s.id);
    const n = ids.indexOf(id);
    const m = n + dir;
    if ( n < 0 || m < 0 || m >= ids.length ) return;
    return this.reorderMark(id, dir < 0 ? ids[m] : (ids[m + 1] ?? null));
  }

  /* ---------------------------------------------------------------- */
  /*  Линия                                                             */
  /* ---------------------------------------------------------------- */

  setLineMode(mode) {
    if ( !["free", "hex", "edge", "draw"].includes(mode) ) return;
    this.line.mode = mode;
    this.clearLine();
  }

  async finishLine() {
    if ( this.line.points.length < 2 ) return this.backend.notify("warn", this.t("ART.Line.needTwo"));
    if ( !this.typeById(this.line.typeId) ) return this.backend.notify("warn", this.t("ART.Line.noType"));
    const points = this.line.mode === "draw" ? simplify(this.line.points, this.grid.radius * 0.06) : this.line.points;
    const name = this.line.name.trim();
    // Конец новой линии у конца линии того же типа: они сливаются в одну.
    const join = this.line.join !== false
      ? joinLine({ states: this.states, points, typeId: this.line.typeId, name, tol: this.grid.radius * 0.5 })
      : null;
    let ops;
    if ( join ) {
      const keep = plainClone(this.stateOf(join.keep.id) ?? join.keep);
      keep.system.geometry = { ...(keep.system.geometry ?? {}), points: join.points.map(([x, y]) => [Math.round(x), Math.round(y)]), segments: join.segments };
      ops = [{ action: "update", id: keep.id, state: keep }];
      if ( join.remove ) ops.push({ action: "delete", id: join.remove.id, name: join.remove.name });
    } else {
      const op = lineOp({ points, typeId: this.line.typeId, name, types: this.types, newId: () => this.backend.newId() });
      if ( this.line.text?.trim() ) op.state.text = this.line.text.trim();
      // Линии по гексам и от руки не виляют сами: их форму задал игрок.
      if ( this.line.mode !== "free" ) op.state.system.style = { ...(op.state.system.style ?? {}), meander: 0 };
      ops = [op];
    }
    this.line.points = [];
    this.line.cells = [];
    this.line.name = "";
    this.line.text = "";
    await this._commit(ops);
    if ( join ) this.backend.notify("info", this.t("ART.Line.joined", { name: join.keep.name || this.t("ART.Card.unnamed") }));
    this.changed("ui");
    this.changed("overlay");
  }

  undoPoint() {
    // По гексам шаг назад убирает последний гекс пути, по краям — весь путь последнего щелчка.
    if ( this.line.mode === "edge" ) {
      const n = this.line.cells.pop() ?? 1;
      this.line.points.splice(-n, n);
    } else this.line.points.pop();
    if ( this.line.mode === "hex" ) this.line.cells.pop();
    this.changed("ui");
    this.changed("overlay");
  }

  clearLine() {
    this.line.points = [];
    this.line.cells = [];
    this.changed("ui");
    this.changed("overlay");
  }

  /* ---------------------------------------------------------------- */
  /*  Типы                                                              */
  /* ---------------------------------------------------------------- */

  /** Открыть форму нового типа для текущего инструмента или правки существующего. */
  openTypeForm(kind, id = null) {
    const existing = id ? this.typeById(id) : null;
    if ( existing ) {
      this.typeForm = {
        kind, id, name: existing.name, color: existing.style?.color ?? "#cccccc",
        icon: existing.style?.icon ?? "", layerId: existing.layerId ?? "overlay",
        pattern: existing.style?.pattern ?? "none", patternColor: existing.style?.patternColor ?? "#1a1a1a",
        tint: existing.style?.tint !== false, iconQuery: "", iconCat: iconCategory(existing.style?.icon),
        shape: existing.kind === "line" ? "circle" : (existing.style?.shape ?? "circle"),
        lineShape: existing.style?.shape ?? "curved", bend: existing.style?.bend ?? 0.5, linePattern: existing.style?.pattern ?? "solid",
        widthStart: existing.style?.widthStart ?? 3, widthEnd: existing.style?.widthEnd ?? 3,
        emoji: existing.style?.emoji ?? "", labelFont: existing.style?.labelFont ?? "", folder: existing.folder ?? "",
        labelMode: existing.style?.labelMode ?? "", labelScale: existing.style?.labelScale ?? 1
      };
    } else {
      const layerId = kind === "area" ? (this.typeById(this.zone.typeId)?.layerId ?? "terrain") : "";
      this.typeForm = {
        kind, id: null, name: "", color: nextZoneColor(this.states), icon: kind === "object" ? iconPath("castle") : "", layerId,
        pattern: "none", patternColor: "#1a1a1a", tint: true, iconQuery: "", iconCat: "settlements", shape: "circle",
        lineShape: "curved", bend: 0.5, linePattern: "solid", widthStart: 3, widthEnd: 3,
        emoji: "", labelFont: "", folder: kind === "object" ? (this.typeById(this.mark.typeId)?.folder ?? "") : "",
        labelMode: "", labelScale: 1
      };
    }
    this.changed("ui");
  }

  /** Выбрать значок формы типа. Значок библиотеки красится, своя картинка по умолчанию нет. */
  pickIcon(path) {
    if ( !this.typeForm ) return;
    this.typeForm.icon = path;
    this.typeForm.tint = isLibraryIcon(path);
    this.changed("ui");
  }

  /** Папки типов меток по порядку: без папки первыми. */
  typeFolders(kind = "object") {
    return [...new Set(this.typesOf(kind).map(t => t.folder ?? ""))].sort((a, b) => (a !== "") - (b !== "") || a.localeCompare(b));
  }

  canEditType(type) {
    return !!type && (this.backend.isGM || type.personal === this.backend.userId);
  }

  async saveTypeForm() {
    const f = this.typeForm;
    if ( !f ) return;
    const name = f.name.trim();
    if ( !name ) return this.backend.notify("warn", this.t("ART.Type.needName"));
    let type;
    if ( f.id ) {
      const old = this.typeById(f.id);
      if ( !this.canEditType(old) ) return this.backend.notify("warn", this.t("ART.Type.notYours"));
      type = plainClone(old);
      type.name = name;
      type.style = { ...(type.style ?? {}), color: f.color };
      if ( f.kind === "object" && f.icon ) type.style.icon = f.icon;
      if ( f.kind === "area" ) type.layerId = f.layerId;
    } else {
      type = makeType({ id: this.backend.newId(), kind: f.kind, name, color: f.color, icon: f.icon, layerId: f.layerId, layers: this.layers });
    }
    if ( f.kind === "area" ) {
      type.style = { ...(type.style ?? {}), pattern: f.pattern || "none", patternColor: f.patternColor || "#1a1a1a" };
      if ( f.labelMode ) type.style.labelMode = f.labelMode; else delete type.style.labelMode;
      const sc = Number(f.labelScale);
      if ( Number.isFinite(sc) && sc > 0 && sc !== 1 ) type.style.labelScale = Math.max(0.4, Math.min(3, sc)); else delete type.style.labelScale;
    }
    // Свою цветную картинку можно не красить цветом типа.
    if ( f.kind === "object" ) {
      type.style = { ...(type.style ?? {}), tint: f.tint !== false, shape: f.shape || "circle" };
      const emoji = String(f.emoji ?? "").trim().slice(0, 8);
      if ( emoji ) type.style.emoji = emoji; else delete type.style.emoji;
      const folder = String(f.folder ?? "").trim().slice(0, 40);
      if ( folder ) type.folder = folder; else delete type.folder;
    }
    if ( f.labelFont ) type.style = { ...(type.style ?? {}), labelFont: f.labelFont };
    else if ( type.style ) delete type.style.labelFont;
    if ( f.kind === "line" ) {
      const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(40, n) : d; };
      type.style = {
        ...(type.style ?? {}), shape: f.lineShape || "curved", bend: Math.max(0, Math.min(1, Number(f.bend) || 0)),
        pattern: f.linePattern || "solid", widthStart: num(f.widthStart, 3), widthEnd: num(f.widthEnd, 3)
      };
      // Узор задаёт штрих сам; старые dash/gap от него не мешают.
      delete type.style.dash; delete type.style.gap;
    }
    const prevType = f.id ? plainClone(this.typeById(f.id)) : null;
    await this.backend.saveType(type);
    const savedType = plainClone(type);
    this._remember({
      label: "type",
      undo: () => prevType ? this.backend.saveType(plainClone(prevType)) : this.backend.deleteType(savedType.id),
      redo: () => this.backend.saveType(plainClone(savedType))
    });
    const slot = { area: "zone", object: "mark", line: "line" }[f.kind];
    this[slot].typeId = type.id;
    if ( slot === "zone" ) this.zone.target = "new";
    this.typeForm = null;
    // Пришли из окна инструмента: настройки закрываются, новый тип уже выбран в инструменте.
    if ( this.settings.back ) return this.closeSettings();
    // В настройках сохранённый тип остаётся выбранным в списке.
    if ( this.settings.open && this.settings.section === f.kind ) return this.settingsPick(type.id);
    this.changed("ui");
  }

  async deleteType(id) {
    const type = this.typeById(id);
    if ( !this.canEditType(type) ) return;
    const used = [...this.states.values()].some(s => s.system.typeId === id);
    if ( used && !(await this.backend.confirm(this.t("ART.Type.deleteUsed", { name: type.name }))) ) return;
    const oldType = plainClone(type);
    await this.backend.deleteType(id);
    this._remember({ label: "type", undo: () => this.backend.saveType(plainClone(oldType)), redo: () => this.backend.deleteType(oldType.id) });
    this.typeForm = null;
    if ( this.settings.back ) return this.closeSettings();
    if ( this.settings.open && this.settings.section === type.kind ) return this.settingsPick(this.typesOf(type.kind)[0]?.id ?? null);
    this.changed("ui");
  }

  /**
   * Новый тип или правка типа из окна инструмента: правка идёт в окне настроек.
   * Если настройки были закрыты, после «Сохранить», «Отмена» или удаления они закроются сами.
   */
  editTypeInSettings(kind, id = "new") {
    this.settings.back = !this.settings.open || this.settings.back;
    this.settings.open = true;
    this.settings.section = kind;
    this.settingsPick(id);
  }

  /* ---------------------------------------------------------------- */
  /*  Настройки модуля                                                  */
  /* ---------------------------------------------------------------- */

  openSettings(section = this.settings.section) {
    this.settings.open = true;
    this.settings.back = false;
    this.settingsSection(section);
  }

  closeSettings() {
    this.settings.open = false;
    this.settings.back = false;
    this.typeForm = null;
    this.layerForm = null;
    this.changed("ui");
  }

  /** Раздел настроек; в списке сразу выбран первый элемент. */
  settingsSection(section) {
    const gm = this.backend.isGM;
    this.settings.back = false;
    if ( (section === "layers" || section === "world") && !gm ) section = "area";
    this.settings.section = section;
    this.typeForm = null;
    this.layerForm = null;
    const first = section === "layers" ? this.layers[0]?.id
      : ["area", "object", "line"].includes(section) ? this.typesOf(section)[0]?.id : null;
    this.settingsPick(first ?? null);
  }

  /** Выбрать элемент в списке настроек: справа открывается его правка. id "new" — новый. */
  settingsPick(id) {
    const sec = this.settings.section;
    this.settings.id = id;
    this.typeForm = null;
    this.layerForm = null;
    if ( sec === "layers" && id ) {
      const l = id === "new" ? null : this.layers.find(x => x.id === id);
      this.layerForm = l ? { id: l.id, name: l.name, exclusive: l.exclusive !== false }
        : { id: null, name: "", exclusive: true };
    } else if ( ["area", "object", "line"].includes(sec) && id ) {
      if ( id === "new" ) this.openTypeForm(sec);
      else this.openTypeForm(sec, id);
      return;
    }
    this.changed("ui");
  }

  async saveLayerForm() {
    const f = this.layerForm;
    if ( !f || !this.backend.isGM ) return;
    const name = f.name.trim();
    if ( !name ) return this.backend.notify("warn", this.t("ART.Layer.needName"));
    const layers = this.layers.map(({ visible, ...l }) => l);
    let id = f.id;
    if ( id ) {
      const l = layers.find(x => x.id === id);
      if ( l ) Object.assign(l, { name, exclusive: !!f.exclusive });
    } else {
      id = this.backend.newId();
      layers.push({ id, name, exclusive: !!f.exclusive, visible: true });
    }
    await this.backend.setLayers(layers);
    this.settingsPick(id);
  }

  async moveLayer(id, dir) {
    if ( !this.backend.isGM ) return;
    const layers = this.layers.map(({ visible, ...l }) => l);
    const n = layers.findIndex(l => l.id === id);
    const m = n + dir;
    if ( n < 0 || m < 0 || m >= layers.length ) return;
    [layers[n], layers[m]] = [layers[m], layers[n]];
    await this.backend.setLayers(layers);
    this.changed("ui");
  }

  /**
   * Удалить слой. Его типы и зоны переезжают в соседний слой («Прочее», иначе первый оставшийся).
   * Местность не удаляется: на ней держатся цвета гексов и генератор.
   */
  async deleteLayer(id) {
    if ( !this.backend.isGM || id === "terrain" ) return;
    const layers = this.layers.map(({ visible, ...l }) => l);
    const layer = layers.find(l => l.id === id);
    if ( !layer || layers.length < 2 ) return;
    const rest = layers.filter(l => l.id !== id);
    const to = rest.find(l => l.id === "overlay")?.id ?? rest[0].id;
    const types = this.types.filter(t => t.kind === "area" && (t.layerId ?? "overlay") === id);
    const zones = [...this.states.values()].filter(z => z.system.kind === "area" && z.system.layerId === id);
    const ask = this.t("ART.Layer.deleteAsk", { name: layer.name, n: types.length, to: rest.find(l => l.id === to).name });
    if ( !(await this.backend.confirm(ask)) ) return;
    for ( const t of types ) if ( this.canEditType(t) ) await this.backend.saveType({ ...t, layerId: to });
    if ( zones.length ) {
      await this._commit(zones.map(z => ({ action: "update", id: z.id, state: { ...z, system: { ...z.system, layerId: to } } })));
    }
    await this.backend.setLayers(rest);
    this.settingsPick(to);
  }

  pickType(kind, id) {
    const slot = { area: "zone", object: "mark", line: "line" }[kind];
    this[slot].typeId = id;
    if ( slot === "zone" ) this.zone.target = "new";
    this.typeForm = null;
    this.changed("ui");
  }

  /* ---------------------------------------------------------------- */
  /*  Карточка гекса                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Выбрать гекс: вокруг него встаёт панель кнопок. Окно с подробностями открывается
   * кнопкой на панели (или уже открыто — тогда показывает новый гекс).
   * toggle — щелчок по тому же гексу ещё раз убирает панель.
   */
  inspect(cell, { toggle = false, details = false } = {}) {
    const same = this.inspected && cellKey(this.inspected) === cellKey(cell);
    if ( toggle && same && this.hudOpen && !details ) return this.closeHud();
    this.inspected = cell;
    this.hudOpen = true;
    if ( details ) {
      this.rightOpen = true;
      this.rightTab = "tile";
    }
    const c = this.contents();
    if ( this.openId && ![...c.zones, ...c.marks, ...c.lines].some(s => s.id === this.openId) ) this.openId = null;
    this.changed("ui");
    this.changed("overlay");
  }

  /**
   * Shift-щелчок «Осмотром»: гекс добавляется в осмотр или убирается из него.
   * Первый Shift-щелчок забирает в набор и гекс, который уже осматривали.
   */
  inspectToggle(cell) {
    const k = cellKey(cell);
    if ( !this.selection.size && this.inspected && cellKey(this.inspected) !== k ) this.selection.set(cellKey(this.inspected), this.inspected);
    if ( this.selection.has(k) ) {
      this.selection.delete(k);
      if ( this.inspected && cellKey(this.inspected) === k ) this.inspected = this.selection.values().next().value ?? null;
      if ( this.selection.size === 1 ) this.selection.clear();
      if ( !this.inspected ) this.hudOpen = false;
    } else {
      this.selection.set(k, cell);
      this.inspected = cell;
      this.hudOpen = true;
    }
    this.changed("ui");
    this.changed("overlay");
  }

  /** Осматривают несколько гексов сразу: Shift-щелчки или протяжка «Осмотром». */
  get multi() {
    return this.tool === "select" && this.selection.size > 1;
  }

  /** Гексы осмотра: набор при осмотре нескольких, иначе один гекс. */
  inspectCells() {
    if ( this.multi ) return [...this.selection.values()];
    return this.inspected ? [this.inspected] : [];
  }

  closeRight() {
    this.rightOpen = false;
    if ( !this.hudOpen ) this.inspected = null;
    this.openId = null;
    this.changed("ui");
    this.changed("overlay");
  }

  /** Убрать панель на гексе. Открытое окно подробностей остаётся. */
  closeHud() {
    this.hudOpen = false;
    if ( !this.rightOpen || this.rightTab !== "tile" ) this.inspected = null;
    this.changed("ui");
    this.changed("overlay");
  }

  /** Подробности гекса в окне; id — сразу раскрыть этот элемент. */
  openDetails(id = null) {
    if ( !this.inspected ) return;
    this.rightOpen = true;
    this.rightTab = "tile";
    if ( id ) this.openId = id;
    this.changed("ui");
  }

  /** Поставить метку выбранного типа на осматриваемый гекс. */
  async markHere() {
    if ( !this.inspected ) return;
    this._ensureType("mark", "object");
    await this.placeMarks(this.inspectCells());
  }

  /** Добавить осматриваемый гекс в зону, выбранную в инструменте «Зона». */
  async zoneHere() {
    if ( !this.inspected ) return;
    this._ensureType("zone", "area");
    this.hudMenu = null;
    await this.attach(this.inspectCells());
  }

  /** Кнопка «Добавить в зону» на панели гекса: список уже созданных зон с поиском. */
  toggleZoneMenu() {
    this.hudMenu = this.hudMenu?.kind === "zone" ? null : { kind: "zone", q: "" };
    this.changed("ui");
  }

  /** Положить осматриваемые гексы в уже созданную зону (и дальше красить ею). */
  async addHereToZone(zoneId) {
    if ( !this.inspected || !this.states.has(zoneId) ) return;
    this.hudMenu = null;
    this.zone.target = zoneId;
    await this.attach(this.inspectCells());
  }

  /**
   * Перейти к гексу по координатам: «27:22», «27 22», «27,22» или слитно «2722».
   * Слитные цифры делятся пополам; при нечётной длине пробуются оба деления, берётся то, что внутри карты.
   */
  parseCoords(text) {
    const t = String(text ?? "").trim();
    const two = t.match(/^(\d+)\s*[:;,.\s]\s*(\d+)$/);
    const ok = c => this.grid.inBounds(c) ? c : null;
    if ( two ) return ok([Number(two[1]), Number(two[2])]);
    if ( !/^\d{2,}$/.test(t) ) return null;
    const half = Math.floor(t.length / 2);
    const cuts = t.length % 2 ? [half, half + 1] : [half];
    for ( const k of cuts ) {
      const c = ok([Number(t.slice(0, k)), Number(t.slice(k))]);
      if ( c ) return c;
    }
    return null;
  }

  /** Перейти к гексу: карта едет к нему, гекс открывается в осмотре. */
  goTo(text) {
    const cell = this.parseCoords(text);
    if ( !cell ) {
      this.backend.notify("warn", this.t("ART.Goto.bad", { text }));
      return false;
    }
    if ( !this.tool ) this.setTool("select", { toggle: false });
    this.selection.clear();
    this.inspect(cell);
    this.backend.panTo(this.grid.center(cell));
    return true;
  }

  /** Короткая сводка гекса для панели: координаты, местность, владение, хозяин. */
  summary() {
    if ( !this.inspected ) return null;
    const { zones, marks, lines } = this.contents();
    const types = this.types;
    const byLayer = id => zones.find(z => layerIdOf(z, types) === id);
    const terrain = byLayer("terrain");
    const realm = byLayer("politics");
    const region = byLayer("regions");
    const owner = demiurgesOf([realm, ...zones, ...marks].find(s => s && demiurgesOf(s).length))[0] ?? "";
    return { cell: this.inspected, terrain, realm, region, owner, zones, marks, lines, cells: this.multi ? this.selection.size : 1 };
  }

  /**
   * Что лежит на осматриваемых гексах. При осмотре нескольких — всё вместе, без повторов;
   * counts говорит, на скольких из них лежит элемент.
   */
  contents() {
    const cells = this.inspectCells();
    const counts = new Map();
    const out = { zones: [], marks: [], lines: [], counts };
    // Крупные метки (2 клетки и больше) лежат на всех гексах, которые накрывают.
    const big = [];
    for ( const s of this.states.values() ) {
      if ( s.system.kind !== "object" ) continue;
      const n = resolveStyleOf(s, this.types).cells ?? 1;
      if ( n > 1 ) big.push({ s, keys: new Set(markFootprint(s, this.grid, n).map(cellKey)) });
    }
    for ( const cell of cells ) {
      const c = tileContents({
        states: this.states, types: this.types, layers: this.layers, cell,
        center: this.grid.center(cell), radius: this.grid.radius, cellAt: this.grid.cellAt
      });
      const k = cellKey(cell);
      for ( const b of big ) if ( b.keys.has(k) && !c.marks.includes(b.s) ) c.marks.push(b.s);
      for ( const key of ["zones", "marks", "lines"] ) for ( const st of c[key] ) {
        if ( !counts.has(st.id) ) out[key].push(st);
        counts.set(st.id, (counts.get(st.id) ?? 0) + 1);
      }
    }
    out.marks.sort(groupOrder);
    if ( cells.length > 1 ) {
      const order = new Map(this.layers.map((l, n) => [l.id, n]));
      out.zones.sort((a, b) => (order.get(layerIdOf(a, this.types)) ?? 99) - (order.get(layerIdOf(b, this.types)) ?? 99));
    }
    return out;
  }

  toggleOpen(id) {
    this.openId = this.openId === id ? null : id;
    this.changed("ui");
    this.changed("overlay");
  }

  /** Поменять элемент: fn получает копию состояния и правит её. Запись с задержкой, чтобы не дёргать базу на каждую букву. */
  edit(id, fn, { now = false } = {}) {
    const base = this._pending?.get(id) ?? this.states.get(id);
    if ( !base ) return;
    const state = plainClone(base);
    fn(state);
    this._pending ??= new Map();
    this._pending.set(id, state);
    clearTimeout(this._saveTimer);
    if ( now ) return this.flush();
    this._saveTimer = setTimeout(() => this.flush(), 400);
  }

  /** Записать отложенные правки карточки. */
  async flush() {
    clearTimeout(this._saveTimer);
    if ( !this._pending?.size ) return;
    const ops = [...this._pending.values()].map(state => ({ action: "update", id: state.id, state }));
    this._pending.clear();
    await this._commit(ops);
    this.changed("ui");
  }

  /** Состояние для показа: отложенная правка, если есть. */
  stateOf(id) {
    return this._pending?.get(id) ?? this.states.get(id) ?? null;
  }

  async deleteFeature(id) {
    const s = this.stateOf(id);
    if ( !s ) return;
    // Без вопроса «точно удалить?»: Ctrl+Z вернёт.
    this._pending?.delete(id);
    this.markSel.delete(id);
    if ( this.openId === id ) this.openId = null;
    await this._commit([{ action: "delete", id, name: s.name }]);
    this.backend.notify("info", this.t("ART.Card.deleted", { name: s.name || this.t("ART.Card.unnamed") }));
    this.changed("ui");
    this.changed("overlay");
  }

  /** Кусок линии на осматриваемых гексах: [from, to] номера точек или null. */
  lineRangeHere(id) {
    const st = this.stateOf(id);
    const pts = st?.system.geometry?.points ?? [];
    if ( pts.length < 2 ) return null;
    return rangeForCells(pts, this.inspectCells(), c => this.grid.center(c));
  }

  /** Название участка линии на осматриваемых гексах. */
  segmentNameHere(id) {
    const st = this.stateOf(id);
    const r = this.lineRangeHere(id);
    if ( !r ) return "";
    const segs = st.system.geometry?.segments ?? [];
    const name = segmentNameAt(segs, r[0]);
    return name && segs.some(s => s.name === name && s.from <= r[0] && s.to >= r[1]) ? name : "";
  }

  /** Назвать участок линии, который проходит по осматриваемым гексам. Пустое имя снимает название. */
  nameSegmentHere(id, name) {
    const r = this.lineRangeHere(id);
    if ( !r ) return;
    this.edit(id, s => {
      const n = s.system.geometry.points.length;
      s.system.geometry = { ...s.system.geometry, segments: nameRange(s.system.geometry.segments, r[0], r[1], name, n) };
    });
  }

  /** Убрать осматриваемый гекс из зоны. */
  async removeCellFromZone(zoneId) {
    if ( !this.inspected ) return;
    await this._commit(detachOps({ states: this.states, types: this.types, cells: this.inspectCells(), zoneId }));
    this.changed("ui");
  }

  panTo(id) {
    const pt = this.pointOf(this.stateOf(id));
    if ( pt ) this.backend.panTo(pt);
  }

  /* Статусы и аспекты. path — "statuses" или "aspects.N.statuses". */

  _list(state, path) {
    const parts = path.split(".");
    let obj = state.system;
    for ( const p of parts ) obj = obj?.[p];
    return obj;
  }

  addStatus(id, path) {
    this.edit(id, s => this._list(s, path).push({ id: randomId(), name: "", value: null, max: null }), { now: true });
  }

  removeStatus(id, path, n) {
    this.edit(id, s => this._list(s, path).splice(n, 1), { now: true });
  }

  /** Шаг уровня статуса или аспекта. Пустой уровень становится 1. */
  stepLevel(id, path, n, delta) {
    this.edit(id, s => {
      const item = path === "aspects" ? s.system.aspects[n] : this._list(s, path)[n];
      if ( !item ) return;
      const v = (item.value ?? 0) + delta;
      item.value = item.max ? Math.max(0, Math.min(item.max, v)) : Math.max(0, v);
    }, { now: true });
  }

  /** Статус → аспект: статус исчезает, появляется аспект с тем же именем и уровнем. */
  statusToAspect(id, n) {
    this.edit(id, s => {
      const [st] = s.system.statuses.splice(n, 1);
      if ( st ) s.system.aspects.push(statusToAspect(st, randomId()));
    }, { now: true });
  }

  /** Базовый статус: «Осаждён», «Строится» (с уровнем)… path — "statuses" или "aspects.N.statuses". */
  addBaseStatus(id, path, key) {
    const st = baseStatus(key, randomId);
    if ( !st ) return;
    this.edit(id, s => {
      const list = this._list(s, path);
      if ( !list.some(x => x.key === key) ) list.push(st);
    }, { now: true });
  }

  /** Базовый аспект вместе с его статусами («Ассимилированный Хвонами»). */
  addBaseAspect(id, key) {
    const a = baseAspect(key, randomId);
    if ( !a ) return;
    this.edit(id, s => {
      s.system.aspects ??= [];
      if ( !s.system.aspects.some(x => x.key === key) ) s.system.aspects.push(a);
    }, { now: true });
  }

  /**
   * Кому виден элемент (метка, зона, линия): "all" — всем, "gm" — мастеру, автору и демиургам,
   * "some" — ещё выбранным игрокам. Игроки-демиурги всегда в списке: убрать их нельзя.
   */
  setVisibility(id, mode, users = null) {
    const st = this.stateOf(id);
    if ( !st || !this.canChangeVisibility(st) ) return;
    this.edit(id, s => {
      const cur = s.system.visibility ?? { mode: "all", users: [] };
      const m = mode ?? cur.mode ?? "all";
      const list = new Set(users ?? cur.users ?? []);
      for ( const u of this.lockedViewers(s) ) list.add(u);
      s.system.visibility = { mode: m, users: m === "some" ? [...list] : [] };
    }, { now: true });
  }

  /** Отметить или снять игрока в «Кто видит». Демиурга снять нельзя. */
  toggleViewer(id, userId) {
    const st = this.stateOf(id);
    if ( !st || !this.canChangeVisibility(st) || this.lockedViewers(st).includes(userId) ) return;
    const cur = new Set(st.system.visibility?.users ?? []);
    if ( cur.has(userId) ) cur.delete(userId); else cur.add(userId);
    this.setVisibility(id, "some", [...cur]);
  }

  /** Игроки, от которых элемент не спрятать: их персонажи — его демиурги. */
  lockedViewers(st) {
    return lockedViewers(st, this.backend.players?.() ?? []);
  }

  /** «Кто видит» меняет мастер или игрок, чей персонаж — демиург элемента. */
  canChangeVisibility(st) {
    return canEditVisibility(st, { isGM: this.backend.isGM, actorIds: this.backend.myActorIds?.() });
  }

  /** Демиурги элемента. У игрока такая правка уходит мастеру заявкой, даже у доверенного. */
  setDemiurges(id, ids) {
    this.edit(id, s => { setDemiurges(s.system, ids); }, { now: true });
  }

  /** Отметить или снять одного демиурга. */
  toggleDemiurge(id, actorId) {
    const st = this.stateOf(id);
    if ( !st || !actorId ) return;
    const cur = demiurgesOf(st);
    this.setDemiurges(id, cur.includes(actorId) ? cur.filter(x => x !== actorId) : [...cur, actorId]);
  }

  addAspect(id) {
    this.edit(id, s => s.system.aspects.push({ id: randomId(), name: "", description: "", value: null, max: null, statuses: [] }), { now: true });
  }

  removeAspect(id, n) {
    this.edit(id, s => s.system.aspects.splice(n, 1), { now: true });
  }

  /** Поле элемента из карточки. field — "name", "text", "demiurge", "color", "typeId" или путь статуса. */
  setField(id, field, value) {
    if ( field === "segment" ) return this.nameSegmentHere(id, value);
    // Тип зоны в окне гекса меняется у этого гекса, а не у всей зоны: «Пустыни» → «Лес» уводит в лес одну клетку.
    if ( field === "typeId" ) {
      const zone = this.stateOf(id);
      if ( zone?.system.kind === "area" ) {
        const own = new Set(zoneCells(zone).map(cellKey));
        const here = this.inspectCells().filter(c => own.has(cellKey(c)));
        if ( here.length && here.length < own.size ) return this.retypeCells(id, here, value);
      }
    }
    this.edit(id, s => {
      if ( field === "name" ) s.name = value;
      else if ( field === "text" ) s.text = value;
      else if ( field === "demiurge" ) setDemiurges(s.system, Array.isArray(value) ? value : (value ? [value] : []));
      else if ( field === "typeId" ) {
        s.system.typeId = value;
        if ( s.system.kind === "area" ) s.system.layerId = this.typeById(value)?.layerId ?? s.system.layerId;
      } else if ( field === "color" ) s.system.style = { ...(s.system.style ?? {}), color: value };
      else if ( field === "shape" ) s.system.style = { ...(s.system.style ?? {}), shape: value };
      else if ( field === "labelMode" || field === "labelScale" ) {
        const style = { ...(s.system.style ?? {}) };
        if ( value === "" || value === null ) delete style[field];
        else style[field] = field === "labelScale" ? Math.max(0.4, Math.min(3, Number(value) || 1)) : value;
        s.system.style = style;
      }
      else if ( field === "size" || field === "cells" ) {
        const style = { ...(s.system.style ?? {}) };
        const num = Number(value);
        if ( value === "" || !Number.isFinite(num) ) delete style[field];
        else style[field] = field === "cells" ? Math.max(1, Math.min(4, Math.round(num))) : Math.max(0.2, Math.min(2, num));
        s.system.style = style;
      }
      else {
        // statuses.N.name | aspects.N.value | aspects.N.statuses.M.max …
        const parts = field.split(".");
        const key = parts.pop();
        let obj = s.system;
        for ( const p of parts ) obj = obj?.[p];
        if ( !obj ) return;
        if ( key === "value" || key === "max" ) {
          const num = value === "" || value === null ? null : Math.trunc(Number(value));
          obj[key] = Number.isFinite(num) ? num : null;
        } else obj[key] = value;
      }
    }, { now: ["demiurge", "typeId", "color", "shape", "size", "cells", "labelMode", "labelScale"].includes(field) });
  }

  /**
   * Перевести один гекс из зоны в зону другого типа. Берётся соседняя зона нужного типа
   * (иначе самая большая такого типа), а если такой нет — создаётся новая с именем типа.
   */
  async retypeCell(zoneId, cell, typeId) {
    return this.retypeCells(zoneId, [cell], typeId);
  }

  /** То же для нескольких гексов зоны: они уходят вместе, к соседней зоне нужного типа или в новую. */
  async retypeCells(zoneId, cells, typeId) {
    const { states, types, layers } = this;
    const zone = states.get(zoneId);
    const type = this.typeById(typeId);
    if ( !zone || !type || zone.system.typeId === typeId ) return;
    const same = [...states.values()].filter(z => z.id !== zoneId && z.system.kind === "area" && z.system.typeId === typeId);
    const near = new Set(cells.flatMap(c => this.grid.neighbors?.(c) ?? []).map(cellKey));
    const target = same.find(z => zoneCells(z).some(c => near.has(cellKey(c))))
      ?? same.sort((a, b) => zoneCells(b).length - zoneCells(a).length)[0];
    const ops = target
      ? attachOps({ states, types, layers, cells, target: target.id })
      : attachOps({ states, types, layers, cells, newZone: {
        id: this.backend.newId(), typeId, name: type.name,
        color: type.layerId === "terrain" ? "" : nextZoneColor(states), demiurges: demiurgesOf(zone)
      } });
    // Если новый тип на другом слое, гекс из старой зоны attachOps не уберёт: убираем сами.
    if ( !ops.some(op => op.id === zoneId) ) ops.push(...detachOps({ states, types, cells, zoneId }));
    await this._commit(ops);
    this.changed("ui");
    this.changed("overlay");
  }

  /* ---------------------------------------------------------------- */
  /*  Заявки                                                            */
  /* ---------------------------------------------------------------- */

  openQueue() {
    this.rightOpen = true;
    this.rightTab = "queue";
    this.changed("ui");
  }

  setRightTab(tab) {
    this.rightTab = tab;
    this.rightOpen = true;
    this.changed("ui");
  }

  async submit() {
    await this.flush();
    const claim = await this.backend.submitDraft({ ...this.claimForm });
    if ( claim ) this.claimForm = { title: "", note: "" };
    this.changed("ui");
  }

  async undoDraftOp(id) {
    await this.backend.undoDraftOp(id);
    this.changed("ui");
  }

  togglePreview(claimId) {
    if ( this.previewIds.has(claimId) ) this.previewIds.delete(claimId);
    else this.previewIds.add(claimId);
    this.changed("ui");
    this.changed("overlay");
  }

  /** Точка элемента на карте: метка, середина линии или средний гекс зоны. */
  pointOf(s) {
    if ( !s?.system ) return null;
    const kind = s.system.kind;
    if ( kind === "object" ) return { x: s.system.geometry.x, y: s.system.geometry.y };
    if ( kind === "line" ) {
      const pts = s.system.geometry.points ?? [];
      const m = pts[Math.floor(pts.length / 2)];
      return m ? { x: m[0], y: m[1] } : null;
    }
    const cells = zoneCells(s);
    return cells.length ? this.grid.center(cells[Math.floor(cells.length / 2)]) : null;
  }

  /** Перейти к правкам заявки: камера в середину, заявка подсвечена. */
  goToClaim(claimId) {
    const [entry] = this._entries([claimId]);
    if ( !entry ) return false;
    const base = this.backend.atlasStates();
    const pts = (entry.claim.ops ?? []).map(op => this.pointOf(op.state ?? base.get(op.id))).filter(Boolean);
    if ( !pts.length ) return false;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    this.backend.panTo({ x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 });
    if ( !this.previewIds.has(claimId) ) this.togglePreview(claimId);
    return true;
  }

  toggleChecked(claimId) {
    if ( this.checkedIds.has(claimId) ) this.checkedIds.delete(claimId);
    else this.checkedIds.add(claimId);
    this.changed("ui");
  }

  checkAll() {
    const ids = this.backend.claims().map(e => e.claim.id);
    const all = ids.every(id => this.checkedIds.has(id));
    this.checkedIds = new Set(all ? [] : ids);
    this.changed("ui");
  }

  _entries(ids) {
    return this.backend.claims().filter(e => ids.includes(e.claim.id));
  }

  async applyClaims(ids) {
    await this.backend.applyClaims(this._entries(ids));
    for ( const id of ids ) { this.checkedIds.delete(id); this.previewIds.delete(id); }
    this.changed("ui");
    this.changed("overlay");
  }

  async rejectClaims(ids) {
    const entries = this._entries(ids);
    if ( !entries.length ) return;
    const comment = await this.backend.promptText?.(this.t("ART.Queue.rejectReason"));
    if ( comment === null ) return;
    await this.backend.rejectClaims(entries, comment ?? "");
    for ( const id of ids ) { this.checkedIds.delete(id); this.previewIds.delete(id); }
    this.changed("ui");
    this.changed("overlay");
  }

  async requestCheck(id) {
    const [entry] = this._entries([id]);
    if ( entry ) await this.backend.requestCheck(entry);
    this.changed("ui");
  }

  /** Призраки для слоя: черновик игрока и заявки, которые мастер смотрит. */
  ghosts() {
    return this.backend.ghosts?.([...this.previewIds]) ?? [];
  }

  /* ---------------------------------------------------------------- */

  /** Запомнить шаг для Ctrl+Z. Новый шаг стирает то, что можно было вернуть Ctrl+Shift+Z. */
  _remember(entry) {
    this._history.push(entry);
    if ( this._history.length > HISTORY_LIMIT ) this._history.shift();
    this._redo = [];
  }

  /** Новая сцена — новая история: шаги другой сцены отменять нельзя. */
  clearHistory() {
    this._history = [];
    this._redo = [];
  }

  get canUndo() { return this._history.length > 0; }
  get canRedo() { return this._redo.length > 0; }

  /** Ctrl+Z: отменить последний шаг (метки, зоны, линии, типы, статусы). */
  async undo() {
    await this.flush();
    const e = this._history.pop();
    if ( !e ) { this.backend.notify("info", this.t("ART.Undo.nothing")); return false; }
    await e.undo();
    this._redo.push(e);
    this.markSel.clear();
    this.changed("ui");
    this.changed("overlay");
    return true;
  }

  /** Ctrl+Shift+Z или Ctrl+Y: вернуть отменённое. */
  async redo() {
    const e = this._redo.pop();
    if ( !e ) return false;
    await e.redo();
    this._history.push(e);
    this.changed("ui");
    this.changed("overlay");
    return true;
  }

  async _commit(ops, { record = true, label = "" } = {}) {
    ops = (ops ?? []).filter(Boolean);
    if ( !ops.length ) return;
    // Новый элемент помнит автора: от этого зависят «чужое» в правах и кто видит скрытую метку.
    const me = this.backend.userId;
    // Созданное игроком получает демиургом его персонажа (нет персонажа — демиургов нет).
    const hero = this.backend.isGM ? "" : (this.backend.characterId?.() ?? "");
    for ( const op of ops ) {
      if ( op.action !== "create" || !op.state?.system || this.states.has(op.id) ) continue;
      if ( !op.state.system.author && me ) op.state.system.author = me;
      if ( hero && !demiurgesOf(op.state).length ) setDemiurges(op.state.system, [hero]);
    }
    // Права игрока: что нельзя, отбрасывается с объяснением.
    if ( !this.backend.isGM && this.backend.permissions ) {
      const { allowed, denied } = checkOps(ops, id => this.states.get(id), this.backend.permissions(), me, this.backend.myActorIds?.());
      if ( denied.length ) {
        const what = [...new Set(denied.map(d => this.t(`ART.Perm.${d.perm}`)))].join(", ");
        this.backend.notify("warn", this.t("ART.Perm.denied", { what }));
      }
      ops = allowed;
      if ( !ops.length ) return;
    }
    if ( record ) {
      // Обратные операции считаем до записи, пока прежнее состояние ещё на месте.
      const inverse = ops.map(op => {
        const before = this.states.get(op.id);
        if ( op.action === "create" ) return before ? { action: "update", id: op.id, state: plainClone(before) } : { action: "delete", id: op.id, name: op.state?.name };
        if ( !before ) return null;
        if ( op.action === "delete" ) return { action: "create", id: op.id, state: plainClone(before) };
        return { action: "update", id: op.id, state: plainClone(before) };
      }).filter(Boolean).reverse();
      const redo = ops.map(op => plainClone(op));
      this._remember({
        label,
        undo: () => this._commit(inverse.map(plainClone), { record: false }),
        redo: () => this._commit(redo.map(plainClone), { record: false })
      });
    }
    try {
      await this.backend.commitOps(ops);
    } catch(err) {
      // Запись не прошла: и отменять нечего.
      if ( record ) this._history.pop();
      console.error("artarius | commit", err);
      this.backend.notify("error", String(err?.message ?? err));
    }
  }
}

/** Сколько шагов помнит Ctrl+Z. */
const HISTORY_LIMIT = 100;

/** Глубокая копия без Foundry. */
function plainClone(x) {
  return x === undefined ? x : JSON.parse(JSON.stringify(x));
}

export { cellKey, parseKey, layerIdOf, zoneCells };
