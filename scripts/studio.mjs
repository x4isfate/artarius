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
  makeType, nextZoneColor, layerIdOf, zoneCells, markCell
} from "./data/world.mjs";
import { randomId, statusToAspect } from "./review/ops.mjs";
import { simplify } from "./geometry/geometry.mjs";
import { viewOf, activePreset, BUILTIN_PRESETS } from "./data/view.mjs";
import { ICON_LIBRARY, iconPath, isLibraryIcon } from "./data/icons.mjs";
import { layoutMarks, markAt, groupOrder } from "./data/mark-layout.mjs";
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
    this.listeners = new Set();
    this._drag = null;
    this._busy = false;
    backend.onChange?.(() => this.changed("data"));
  }

  t(key, data) { return this.backend.t(key, data); }

  /* ---------------------------------------------------------------- */
  /*  Подписка                                                          */
  /* ---------------------------------------------------------------- */

  /** fn(what): what — "data" | "ui" | "overlay" | "hover" (только подсказка линии). */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed(what = "ui") {
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
  activePreset() { return activePreset(this.hidden(), this.presets()); }

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

  /* ---------------------------------------------------------------- */
  /*  Инструменты                                                       */
  /* ---------------------------------------------------------------- */

  /** Выбрать инструмент. Повторный выбор того же убирает инструменты (toggle), если не сказано иначе. */
  setTool(tool, { toggle = true, fromCanvas = false } = {}) {
    if ( tool && !TOOLS.includes(tool) ) return;
    const prev = this.tool;
    this.tool = toggle && tool === prev ? null : tool;
    if ( this.tool === prev && fromCanvas ) return;
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
    if ( shift && this.tool === "select" && !alt ) {
      if ( inside ) {
        this.inspectToggle(cell);
        // Если кнопку не отпустили и повели, гексы по пути добавляются в осмотр.
        this._drag = { last: cell, erase: false, added: new Map(), inspect: true };
      }
      return;
    }
    if ( alt || this.tool === "select" ) {
      // Метку под курсором можно утащить на другой гекс; щелчок без протяжки — осмотр гекса.
      const hit = !alt && this.tool === "select" ? markAt(this.markSlots().slots, point) : null;
      if ( hit ) {
        this.markDrag = { id: hit.id, from: hit.cell, at: point, start: point, moved: false };
        return "grab";
      }
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
    if ( hoverChanged || this.tool === "line" ) this.changed("overlay");
  }

  async pointerUp() {
    if ( this.markDrag ) {
      const d = this.markDrag;
      this.markDrag = null;
      if ( !d.moved ) {
        this.inspect(d.from, { toggle: true });
        return;
      }
      const to = this.grid.cellAt(d.at);
      if ( this.grid.inBounds(to) && cellKey(to) !== cellKey(d.from) ) await this.moveMark(d.id, to);
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
    const hit = !this._drag && view.lines !== false
      ? lineAt(this.states, [point.x, point.y], Math.max(6, this.grid.radius * 0.18))
      : null;
    const next = hit?.name ? { id: hit.state.id, name: hit.name, at: point } : null;
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
    this.changed("overlay");
    this.changed("ui");
  }

  /** Правая кнопка: убрать последнюю точку линии, удалить метку под курсором или снять выделение. */
  rightClick(point) {
    const hit = point && this.tool === "select" && !this.line.points.length ? markAt(this.markSlots().slots, point) : null;
    if ( hit ) return this.quickDeleteMark(hit.id);
    if ( this.tool === "line" && this.line.points.length ) this.undoPoint();
    else this.selection.clear();
    this.changed("ui");
    this.changed("overlay");
  }

  /** Esc: сбросить начатое. Возвращает true, если было что сбрасывать. */
  dismiss() {
    if ( this.markDrag ) { this.markDrag = null; this.changed("overlay"); return true; }
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
    const view = this.view();
    const types = this.types;
    const marks = [...this.states.values()].filter(s => s.system.kind === "object"
      && (isResourceType(s.system.typeId) ? view.resources : view.marks));
    return layoutMarks(marks, this.grid, m => resolveStyleOf(m, types).size);
  }

  /** Перенести метку в центр другого гекса. У игрока перенос уходит в черновик, как любая правка. */
  async moveMark(id, cell) {
    const st = this.stateOf(id);
    if ( !st || st.system.kind !== "object" || !this.grid.inBounds(cell) ) return;
    const { x, y } = this.grid.center(cell);
    await this.edit(id, s => {
      s.system.geometry = { ...(s.system.geometry ?? {}), x: Math.round(x), y: Math.round(y), cell: [...cell] };
    }, { now: true });
    this.changed("ui");
    this.changed("overlay");
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
      const next = foundry_clone(s);
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
      const keep = foundry_clone(this.stateOf(join.keep.id) ?? join.keep);
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
        widthStart: existing.style?.widthStart ?? 3, widthEnd: existing.style?.widthEnd ?? 3
      };
    } else {
      const layerId = kind === "area" ? (this.typeById(this.zone.typeId)?.layerId ?? "terrain") : "";
      this.typeForm = {
        kind, id: null, name: "", color: nextZoneColor(this.states), icon: kind === "object" ? iconPath("castle") : "", layerId,
        pattern: "none", patternColor: "#1a1a1a", tint: true, iconQuery: "", iconCat: "settlements", shape: "circle",
        lineShape: "curved", bend: 0.5, linePattern: "solid", widthStart: 3, widthEnd: 3
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
      type = foundry_clone(old);
      type.name = name;
      type.style = { ...(type.style ?? {}), color: f.color };
      if ( f.kind === "object" && f.icon ) type.style.icon = f.icon;
      if ( f.kind === "area" ) type.layerId = f.layerId;
    } else {
      type = makeType({ id: this.backend.newId(), kind: f.kind, name, color: f.color, icon: f.icon, layerId: f.layerId, layers: this.layers });
    }
    if ( f.kind === "area" ) {
      type.style = { ...(type.style ?? {}), pattern: f.pattern || "none", patternColor: f.patternColor || "#1a1a1a" };
    }
    // Свою цветную картинку можно не красить цветом типа.
    if ( f.kind === "object" ) type.style = { ...(type.style ?? {}), tint: f.tint !== false, shape: f.shape || "circle" };
    if ( f.kind === "line" ) {
      const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(40, n) : d; };
      type.style = {
        ...(type.style ?? {}), shape: f.lineShape || "curved", bend: Math.max(0, Math.min(1, Number(f.bend) || 0)),
        pattern: f.linePattern || "solid", widthStart: num(f.widthStart, 3), widthEnd: num(f.widthEnd, 3)
      };
      // Узор задаёт штрих сам; старые dash/gap от него не мешают.
      delete type.style.dash; delete type.style.gap;
    }
    await this.backend.saveType(type);
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
    await this.backend.deleteType(id);
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
    await this.attach(this.inspectCells());
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
    const owner = [realm, ...zones, ...marks].find(s => s?.system?.demiurge)?.system.demiurge ?? "";
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
    for ( const cell of cells ) {
      const c = tileContents({
        states: this.states, types: this.types, layers: this.layers, cell,
        center: this.grid.center(cell), radius: this.grid.radius, cellAt: this.grid.cellAt
      });
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
    const state = foundry_clone(base);
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
    if ( !(await this.backend.confirm(this.t("ART.Card.deleteConfirm", { name: s.name || this.t("ART.Card.unnamed") }))) ) return;
    this._pending?.delete(id);
    if ( this.openId === id ) this.openId = null;
    await this._commit([{ action: "delete", id, name: s.name }]);
    this.changed("ui");
  }

  /** Быстрое удаление метки (ПКМ): без вопроса, но Ctrl+Z возвращает её. */
  async quickDeleteMark(id) {
    const s = this.stateOf(id);
    if ( !s ) return;
    this._pending?.delete(id);
    if ( this.openId === id ) this.openId = null;
    this.lastDeleted = foundry_clone(s);
    const name = s.name || this.t("ART.Card.unnamed");
    await this._commit([{ action: "delete", id, name: s.name }]);
    this.backend.notify("info", this.t("ART.Mark.quickDeleted", { name }));
    this.changed("ui");
    this.changed("overlay");
  }

  /** Вернуть метку, удалённую правой кнопкой. Возвращает true, если было что возвращать. */
  async restoreDeleted() {
    const state = this.lastDeleted;
    if ( !state ) return false;
    this.lastDeleted = null;
    await this._commit([{ action: "create", id: state.id, state }]);
    this.backend.notify("info", this.t("ART.Mark.restored", { name: state.name || this.t("ART.Card.unnamed") }));
    this.changed("ui");
    this.changed("overlay");
    return true;
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
    const s = this.stateOf(id);
    if ( !s ) return;
    const kind = s.system.kind;
    let pt;
    if ( kind === "object" ) pt = { x: s.system.geometry.x, y: s.system.geometry.y };
    else if ( kind === "line" ) {
      const pts = s.system.geometry.points ?? [];
      const m = pts[Math.floor(pts.length / 2)] ?? [0, 0];
      pt = { x: m[0], y: m[1] };
    } else {
      const cells = zoneCells(s);
      if ( !cells.length ) return;
      pt = this.grid.center(cells[Math.floor(cells.length / 2)]);
    }
    this.backend.panTo(pt);
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
      else if ( field === "demiurge" ) s.system.demiurge = value;
      else if ( field === "typeId" ) {
        s.system.typeId = value;
        if ( s.system.kind === "area" ) s.system.layerId = this.typeById(value)?.layerId ?? s.system.layerId;
      } else if ( field === "color" ) s.system.style = { ...(s.system.style ?? {}), color: value };
      else if ( field === "shape" ) s.system.style = { ...(s.system.style ?? {}), shape: value };
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
    }, { now: field === "demiurge" || field === "typeId" || field === "color" || field === "shape" });
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
        color: type.layerId === "terrain" ? "" : nextZoneColor(states), demiurge: zone.system.demiurge ?? ""
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

  async _commit(ops) {
    ops = (ops ?? []).filter(Boolean);
    if ( !ops.length ) return;
    try {
      await this.backend.commitOps(ops);
    } catch(err) {
      console.error("artarius | commit", err);
      this.backend.notify("error", String(err?.message ?? err));
    }
  }
}

/** Глубокая копия без Foundry. */
function foundry_clone(x) {
  return x === undefined ? x : JSON.parse(JSON.stringify(x));
}

export { cellKey, parseKey, layerIdOf, zoneCells };
