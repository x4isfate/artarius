/**
 * Студия: состояние интерфейса гекс-мира и все действия игрока.
 * Не знает ни про Foundry, ни про PIXI: данные и запись идут через backend,
 * поэтому студию целиком можно гонять на стенде в браузере.
 *
 * backend — см. docs/API.md, раздел «Backend». Главное:
 *   states(), atlasStates(), types(), layers(), grid, commitOps(ops), saveType(t), deleteType(id),
 *   newId(), isGM, userId, players(), actors(), turn(), setTurn(t), draftOps(), submitDraft(),
 *   claims(), applyClaims(), rejectClaims(), requestCheck(), returnToDraft(), dropClaim(),
 *   panTo(point), notify(level, text), t(key, data), onChange(fn).
 */
import { TOOL_KIND } from "./constants.mjs";
import {
  cellKey, parseKey, attachOps, detachOps, markOps, lineOp, tileContents, cellsAlong,
  makeType, nextZoneColor, layerIdOf, zoneCells, currentTurnUserId, nextTurn, canSubmit, setTurnOrder
} from "./data/world.mjs";
import { randomId, statusToAspect } from "./review/ops.mjs";
import { simplify } from "./geometry/geometry.mjs";
import { viewOf, activePreset, BUILTIN_PRESETS } from "./data/view.mjs";
import { ICON_LIBRARY, iconPath, isLibraryIcon } from "./data/icons.mjs";

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
    /** Настройки инструментов. */
    this.zone = { target: "new", typeId: "forest", name: "", text: "", color: "", paint: false, detachLayer: "terrain", filter: "" };
    this.mark = { typeId: "city", name: "", text: "", paint: false };
    /** mode: "free" — точки где угодно, "hex" — путь через центры гексов, "draw" — от руки протяжкой. */
    this.line = { typeId: "river", name: "", text: "", points: [], snap: false, mode: "free", cells: [] };
    /** Форма нового или изменяемого типа: { kind, id?, name, color, icon, layerId } или null. */
    this.typeForm = null;
    /** Форма заявки игрока. */
    this.claimForm = { title: "", note: "" };
    /** Заявки, которые мастер смотрит на карте, и отмеченные галочкой. */
    this.previewIds = new Set();
    this.checkedIds = new Set();
    /** Курсор над гексом (для подсветки). */
    this.hover = null;
    this.listeners = new Set();
    this._drag = null;
    this._busy = false;
    backend.onChange?.(() => this.changed("data"));
  }

  t(key, data) { return this.backend.t(key, data); }

  /* ---------------------------------------------------------------- */
  /*  Подписка                                                          */
  /* ---------------------------------------------------------------- */

  /** fn(what): what — "data" | "ui" | "overlay". */
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
    if ( dragStart && (alt || this.tool === "select" || this.tool === "line") ) return;
    if ( alt || this.tool === "select" ) {
      if ( inside ) this.inspect(cell);
      return;
    }
    if ( this.tool === "line" ) {
      const l = this.line;
      if ( l.mode === "draw" ) {
        // От руки: линия пишется протяжкой и заканчивается, когда кнопку отпустили.
        l.points = [[Math.round(point.x), Math.round(point.y)]];
        this._sketch = true;
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

  _touch(cell) {
    const k = cellKey(cell);
    if ( this._drag.erase ) this.selection.delete(k);
    else {
      this.selection.set(k, cell);
      this._drag.added.set(k, cell);
    }
    this.changed("overlay");
    this.changed("ui");
  }

  /** Правая кнопка: убрать последнюю точку линии или снять выделение. */
  rightClick() {
    if ( this.tool === "line" && this.line.points.length ) this.undoPoint();
    else this.selection.clear();
    this.changed("ui");
    this.changed("overlay");
  }

  /** Esc: сбросить начатое. Возвращает true, если было что сбрасывать. */
  dismiss() {
    if ( this.typeForm ) { this.typeForm = null; this.changed("ui"); return true; }
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

  /* ---------------------------------------------------------------- */
  /*  Линия                                                             */
  /* ---------------------------------------------------------------- */

  setLineMode(mode) {
    if ( !["free", "hex", "draw"].includes(mode) ) return;
    this.line.mode = mode;
    this.clearLine();
  }

  async finishLine() {
    if ( this.line.points.length < 2 ) return this.backend.notify("warn", this.t("ART.Line.needTwo"));
    if ( !this.typeById(this.line.typeId) ) return this.backend.notify("warn", this.t("ART.Line.noType"));
    const points = this.line.mode === "draw" ? simplify(this.line.points, this.grid.radius * 0.06) : this.line.points;
    const op = lineOp({
      points, typeId: this.line.typeId, name: this.line.name.trim(),
      types: this.types, newId: () => this.backend.newId()
    });
    if ( this.line.text?.trim() ) op.state.text = this.line.text.trim();
    // Линии по гексам и от руки не виляют сами: их форму задал игрок.
    if ( this.line.mode !== "free" ) op.state.system.style = { ...(op.state.system.style ?? {}), meander: 0 };
    this.line.points = [];
    this.line.cells = [];
    this.line.name = "";
    this.line.text = "";
    await this._commit([op]);
    this.changed("ui");
    this.changed("overlay");
  }

  undoPoint() {
    // По гексам шаг назад убирает последний гекс пути.
    this.line.points.pop();
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
        tint: existing.style?.tint !== false, iconQuery: "", iconCat: iconCategory(existing.style?.icon)
      };
    } else {
      const layerId = kind === "area" ? (this.typeById(this.zone.typeId)?.layerId ?? "terrain") : "";
      this.typeForm = {
        kind, id: null, name: "", color: nextZoneColor(this.states), icon: kind === "object" ? iconPath("castle") : "", layerId,
        pattern: "none", patternColor: "#1a1a1a", tint: true, iconQuery: "", iconCat: "settlements"
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
    if ( f.kind === "object" ) type.style = { ...(type.style ?? {}), tint: f.tint !== false };
    await this.backend.saveType(type);
    const slot = { area: "zone", object: "mark", line: "line" }[f.kind];
    this[slot].typeId = type.id;
    if ( slot === "zone" ) this.zone.target = "new";
    this.typeForm = null;
    this.changed("ui");
  }

  async deleteType(id) {
    const type = this.typeById(id);
    if ( !this.canEditType(type) ) return;
    const used = [...this.states.values()].some(s => s.system.typeId === id);
    if ( used && !(await this.backend.confirm(this.t("ART.Type.deleteUsed", { name: type.name }))) ) return;
    await this.backend.deleteType(id);
    this.typeForm = null;
    this.changed("ui");
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

  inspect(cell) {
    this.inspected = cell;
    this.rightOpen = true;
    this.rightTab = "tile";
    const c = this.contents();
    if ( this.openId && ![...c.zones, ...c.marks, ...c.lines].some(s => s.id === this.openId) ) this.openId = null;
    this.changed("ui");
    this.changed("overlay");
  }

  closeRight() {
    this.rightOpen = false;
    this.inspected = null;
    this.openId = null;
    this.changed("ui");
    this.changed("overlay");
  }

  contents() {
    if ( !this.inspected ) return { zones: [], marks: [], lines: [] };
    return tileContents({
      states: this.states, types: this.types, layers: this.layers, cell: this.inspected,
      center: this.grid.center(this.inspected), radius: this.grid.radius, cellAt: this.grid.cellAt
    });
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

  /** Убрать осматриваемый гекс из зоны. */
  async removeCellFromZone(zoneId) {
    if ( !this.inspected ) return;
    await this._commit(detachOps({ states: this.states, types: this.types, cells: [this.inspected], zoneId }));
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
    this.edit(id, s => {
      if ( field === "name" ) s.name = value;
      else if ( field === "text" ) s.text = value;
      else if ( field === "demiurge" ) s.system.demiurge = value;
      else if ( field === "typeId" ) {
        s.system.typeId = value;
        if ( s.system.kind === "area" ) s.system.layerId = this.typeById(value)?.layerId ?? s.system.layerId;
      } else if ( field === "color" ) s.system.style = { ...(s.system.style ?? {}), color: value };
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
    }, { now: field === "demiurge" || field === "typeId" || field === "color" });
  }

  /* ---------------------------------------------------------------- */
  /*  Ходы                                                              */
  /* ---------------------------------------------------------------- */

  turn() { return this.backend.turn(); }

  currentPlayerId() { return currentTurnUserId(this.turn()); }

  canSubmit() { return canSubmit(this.turn(), this.backend.userId, this.backend.isGM); }

  async passTurn() {
    if ( !this.backend.isGM ) return;
    const turn = nextTurn(this.turn());
    await this.backend.setTurn(turn);
    const id = currentTurnUserId(turn);
    this.backend.announceTurn?.(id, turn.round);
    this.changed("ui");
  }

  async toggleTurns() {
    if ( !this.backend.isGM ) return;
    const turn = this.turn();
    let order = turn.order?.length ? turn.order : this.backend.players().map(p => p.id);
    await this.backend.setTurn({ ...setTurnOrder(turn, order), enabled: !turn.enabled });
    this.changed("ui");
  }

  /** Сдвинуть игрока в порядке ходов или убрать (dir = 0). */
  async moveInOrder(userId, dir) {
    if ( !this.backend.isGM ) return;
    const turn = this.turn();
    const order = [...(turn.order ?? [])];
    const n = order.indexOf(userId);
    if ( n < 0 ) order.push(userId);
    else if ( dir === 0 ) order.splice(n, 1);
    else {
      const m = n + dir;
      if ( m < 0 || m >= order.length ) return;
      [order[n], order[m]] = [order[m], order[n]];
    }
    await this.backend.setTurn(setTurnOrder(turn, order));
    this.changed("ui");
  }

  async setTurnTo(userId) {
    if ( !this.backend.isGM ) return;
    const turn = this.turn();
    const index = (turn.order ?? []).indexOf(userId);
    if ( index < 0 ) return;
    await this.backend.setTurn({ ...turn, index });
    this.backend.announceTurn?.(userId, turn.round);
    this.changed("ui");
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
    if ( !this.canSubmit() ) return this.backend.notify("warn", this.t("ART.Turn.notYourTurn"));
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
