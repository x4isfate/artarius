/**
 * Студия 0.9.9 «единый интерфейс»: папки, аспекты-предметы, окно слоёв со стилем слоя и берега,
 * быстрый осмотр, сжатая карточка гекса. Методы примешиваются к Studio (см. studio.mjs, внизу).
 * Как и студия, этот код не знает ни про Foundry, ни про PIXI.
 */
import { COAST_DEFAULTS } from "./constants.mjs";
import { groupByFolders, nextFolderColor, materialize } from "./data/folders.mjs";
import { attachItem, detachItem, hostsOf, searchItems, baseItems } from "./data/aspects.mjs";
import { cellKey, zoneCells, layerIdOf, lineLayerOf } from "./data/world.mjs";
import { markAt } from "./data/mark-layout.mjs";
import { lineAt } from "./data/lines.mjs";
import { isShown } from "./data/view.mjs";

const clone = x => JSON.parse(JSON.stringify(x));
const SLOT_KIND = { zone: "area", mark: "object", line: "line" };

export const StudioKit = {

  /* ---------------------------------------------------------------- */
  /*  Окна «Слои» и «Аспекты»                                          */
  /* ---------------------------------------------------------------- */

  toggleLayers(force = null) {
    this.layersOpen = force ?? !this.layersOpen;
    if ( this.layersOpen && !this.layerSel ) this.pickLayer(this.layers[0]?.id ?? "@coast");
    this.changed("ui");
  },

  toggleAspects(force = null) {
    this.aspectsOpen = force ?? !this.aspectsOpen;
    if ( this.aspectsOpen && !this.aspectForm ) {
      const first = this.aspects()[0];
      if ( first ) this.pickAspect(first.id);
    }
    this.changed("ui");
  },

  /* ---------------------------------------------------------------- */
  /*  Новая зона, метка, линия: аспекты и подпись прямо в форме        */
  /* ---------------------------------------------------------------- */

  _resetForm(slot) {
    const f = this[slot];
    f.name = "";
    f.text = "";
    if ( slot === "zone" ) f.color = "";
    f.aspects = [];
    f.label = {};
    if ( this.aspectPick?.slot === slot ) this.aspectPick = null;
  },

  /** Новый элемент получает аспекты и подпись из формы. */
  _decorate(state, slot) {
    const f = this[slot] ?? {};
    let st = clone(state);
    for ( const id of f.aspects ?? [] ) {
      const item = this.aspectById(id);
      if ( item ) st = attachItem(st, item, () => this.backend.newId()) ?? st;
    }
    const lb = f.label ?? {};
    const style = { ...(st.system.style ?? {}) };
    if ( lb.labelMode ) style.labelMode = lb.labelMode;
    const sc = Number(lb.labelScale);
    if ( Number.isFinite(sc) && sc > 0 && sc !== 1 ) style.labelScale = Math.max(0.4, Math.min(3, sc));
    if ( lb.labelFont ) style.labelFont = lb.labelFont;
    st.system.style = style;
    return st;
  },

  /** Подпись в форме нового элемента. */
  setFormLabel(slot, key, value) {
    if ( !this[slot] ) return;
    this[slot].label = { ...(this[slot].label ?? {}), [key]: value };
    this.changed("ui");
  },

  addPending(slot, itemId) {
    const f = this[slot];
    if ( !f || !this.aspectById(itemId) ) return;
    f.aspects = [...new Set([...(f.aspects ?? []), itemId])];
    this.changed("ui");
  },

  removePending(slot, itemId) {
    const f = this[slot];
    if ( !f ) return;
    f.aspects = (f.aspects ?? []).filter(id => id !== itemId);
    this.changed("ui");
  },

  /** Открыть или закрыть выбор аспекта: для формы (slot) или для элемента карточки (featureId). */
  toggleAspectPick({ slot = null, featureId = null } = {}) {
    const same = this.aspectPick && this.aspectPick.slot === slot && this.aspectPick.featureId === featureId;
    this.aspectPick = same ? null : { slot, featureId, q: "" };
    this.changed("ui");
  },

  /** Щелчок в списке выбора: в форму или сразу на элемент. */
  async pickFromList(itemId) {
    const p = this.aspectPick;
    if ( !p ) return;
    if ( p.slot ) this.addPending(p.slot, itemId);
    else if ( p.featureId ) await this.attachAspect(p.featureId, itemId);
    this.aspectPick = null;
    this.changed("ui");
  },

  /** Предметы для списка выбора: поиск, без уже выбранных. */
  pickList() {
    const p = this.aspectPick;
    if ( !p ) return [];
    const have = new Set(p.slot ? (this[p.slot]?.aspects ?? []) : []);
    const st = p.featureId ? this.stateOf(p.featureId) : null;
    return searchItems(this.aspects(), p.q).filter(i => !have.has(i.id) && !(st && hostsOf(new Map([[st.id, st]]), i.id).length));
  },

  /* ---------------------------------------------------------------- */
  /*  Папки                                                             */
  /* ---------------------------------------------------------------- */

  folders() { return this.backend.folders?.() ?? []; },

  /** Папки вида с содержимым: kind — area, object, line, layer или aspect. */
  folderGroups(kind) {
    if ( kind === "aspect" ) return groupByFolders("aspect", this.aspects(), this.backend.aspectFolders?.() ?? []);
    if ( kind === "layer" ) {
      return groupByFolders("layer", this.layers, this.folders(), () => ({ id: "@world", name: this.t("ART.Folder.world"), sort: 0 }));
    }
    const layers = this.layers;
    const fallback = kind === "area"
      ? t => {
        const n = layers.findIndex(l => l.id === (t.layerId ?? "overlay"));
        const l = layers[n];
        return l ? { id: `@layer:${l.id}`, name: l.name, color: l.color ?? "", sort: n } : null;
      }
      : () => null;
    return groupByFolders(kind, this.typesOf(kind), this.folders(), fallback);
  },

  canFolders(kind) {
    return kind === "aspect" ? this.canEditAspects() : !!this.backend.isGM;
  },

  async newFolder(kind) {
    if ( !this.canFolders(kind) ) return this.backend.notify("warn", this.t("ART.Folder.gmOnly"));
    const name = String(await this.backend.prompt?.(this.t("ART.Folder.newTitle"), "") ?? "").trim();
    if ( !name ) return;
    if ( kind === "aspect" ) {
      await this.backend.saveAspectFolder?.({ name, color: nextFolderColor("aspect", this.backend.aspectFolders?.() ?? []) });
    } else {
      const list = this.folders();
      list.push({ id: this.backend.newId(), kind, name: name.slice(0, 60), color: nextFolderColor(kind, list) });
      await this.backend.setFolders?.(list);
    }
    this.changed("ui");
  },

  toggleFolderMenu(kind, id) {
    const same = this.folderMenu?.kind === kind && this.folderMenu?.id === id;
    this.folderMenu = same ? null : { kind, id };
    this.changed("ui");
  },

  _group(kind, id) { return this.folderGroups(kind).find(g => g.id === id) ?? null; },

  /** Поменять папку. Запасная (по слою) или старая (по названию) сначала становится настоящей. */
  async _patchFolder(kind, id, patch) {
    const g = this._group(kind, id);
    if ( !g || !this.canFolders(kind) ) return;
    if ( kind === "aspect" ) {
      if ( !g.virtual ) await this.backend.saveAspectFolder?.({ id, ...patch });
      return;
    }
    const list = this.folders();
    const real = list.find(f => f.kind === kind && f.id === id);
    if ( real ) {
      Object.assign(real, patch);
      await this.backend.setFolders?.(list);
      return;
    }
    const { folder, moved } = materialize(kind, g, () => this.backend.newId(), patch);
    list.push(folder);
    await this.backend.setFolders?.(list);
    await this._moveToFolder(kind, moved, folder.id);
  },

  /** Записать элементам папку (пусто — без папки). */
  async _moveToFolder(kind, items, folderId) {
    if ( !items.length ) return;
    if ( kind === "layer" ) {
      const ids = new Set(items.map(i => i.id));
      const layers = this.layers.map(({ visible, ...l }) => {
        if ( !ids.has(l.id) ) return l;
        const next = { ...l };
        if ( folderId ) next.folder = folderId; else delete next.folder;
        return next;
      });
      return this.backend.setLayers(layers);
    }
    if ( kind === "aspect" ) {
      for ( const a of items ) await this.backend.saveAspect?.({ ...clone(a), folder: folderId });
      return;
    }
    for ( const t of items ) {
      if ( !this.canEditType(t) ) continue;
      const next = clone(t);
      delete next.personal;
      if ( folderId ) next.folder = folderId; else delete next.folder;
      await this.backend.saveType(next);
    }
  },

  async renameFolder(kind, id) {
    const g = this._group(kind, id);
    if ( !g ) return;
    const name = String(await this.backend.prompt?.(this.t("ART.Folder.renameTitle"), g.name) ?? "").trim();
    if ( !name ) return;
    await this._patchFolder(kind, id, { name: name.slice(0, 60) });
    this.folderMenu = null;
    this.changed("ui");
  },

  async colorFolder(kind, id, color) {
    if ( !/^#[0-9a-f]{6}$/i.test(color ?? "") ) return;
    await this._patchFolder(kind, id, { color });
    this.changed("ui");
  },

  /** Убрать папку: её содержимое уходит в корень (зоны — в группу своего слоя). */
  async removeFolder(kind, id) {
    const g = this._group(kind, id);
    if ( !g || (g.virtual && !g.legacy) || !this.canFolders(kind) ) return;
    if ( kind === "aspect" ) await this.backend.deleteAspectFolder?.(id);
    else {
      await this.backend.setFolders?.(this.folders().filter(f => !(f.kind === kind && f.id === id)));
      await this._moveToFolder(kind, g.items, "");
    }
    this.folderMenu = null;
    this.changed("ui");
  },

  /** «Новый тип в папке». У запасной папки зон по слою — новый тип этого слоя. */
  newInFolder(kind, id) {
    this.folderMenu = null;
    const g = this._group(kind, id);
    const real = g && (!g.virtual || g.legacy) ? g.id : "";
    if ( kind === "aspect" ) return this.newAspect(real);
    if ( kind === "layer" ) return this.newLayer(real);
    this.openTypeForm(kind, null, { folder: real });
    if ( kind === "area" && String(id).startsWith("@layer:") && this.typeForm ) this.typeForm.layerId = id.slice(7);
    this.changed("ui");
  },

  /** Сколько элементов этого типа на карте. */
  typeCount(typeId) {
    let n = 0;
    for ( const st of this.states.values() ) if ( st.system.typeId === typeId ) n++;
    return n;
  },

  /** Элементы этого типа на карте, по названию. */
  featuresOfType(typeId) {
    return [...this.states.values()].filter(st => st.system.typeId === typeId)
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  },

  /* ---------------------------------------------------------------- */
  /*  Аспекты и статусы: предметы Foundry                               */
  /* ---------------------------------------------------------------- */

  aspects() { return this.backend.aspects?.() ?? []; },
  aspectById(id) { return this.aspects().find(a => a.id === id) ?? null; },
  canEditAspects() { return !!(this.backend.isGM || this.backend.canCreateAspects?.()); },

  pickAspect(id) {
    const a = this.aspectById(id);
    this.aspectSel = a ? id : null;
    this.aspectForm = a ? { id: a.id, name: a.name, folder: a.folder ?? "", ...clone(a.system ?? {}) } : null;
    this.changed("ui");
  },

  newAspect(folder = "") {
    if ( !this.canEditAspects() ) return this.backend.notify("warn", this.t("ART.Aspect.cantCreate"));
    this.aspectSel = "new";
    this.aspectForm = { id: null, name: "", folder, kind: "status", icon: "star", color: "#c9a45c", description: "", steps: 0, parentId: "", key: "" };
    this.changed("ui");
  },

  setAspectSteps(n) {
    if ( !this.aspectForm ) return;
    this.aspectForm.steps = Math.max(0, Math.min(20, Number(n) || 0));
    this.changed("ui");
  },

  setAspectKind(kind) {
    if ( !this.aspectForm || !["aspect", "status"].includes(kind) ) return;
    this.aspectForm.kind = kind;
    if ( kind === "aspect" ) this.aspectForm.parentId = "";
    this.changed("ui");
  },

  async saveAspectForm() {
    const f = this.aspectForm;
    if ( !f ) return;
    const name = String(f.name ?? "").trim();
    if ( !name ) return this.backend.notify("warn", this.t("ART.Aspect.needName"));
    const data = {
      id: f.id, name: name.slice(0, 80), folder: f.folder || "",
      system: {
        kind: f.kind === "aspect" ? "aspect" : "status", icon: f.icon || "", color: f.color || "#c9a45c",
        description: String(f.description ?? ""), steps: Math.max(0, Math.min(20, Number(f.steps) || 0)),
        parentId: f.kind === "status" ? (f.parentId || "") : "", key: f.key || ""
      }
    };
    const id = await this.backend.saveAspect?.(data);
    this.pickAspect(id ?? f.id);
  },

  async deleteAspect(id) {
    const a = this.aspectById(id);
    if ( !a || !this.canEditAspects() ) return;
    const n = hostsOf(this.states, id).length;
    if ( !(await this.backend.confirm(this.t(n ? "ART.Aspect.deleteUsed" : "ART.Aspect.deleteAsk", { name: a.name, n }))) ) return;
    await this.backend.deleteAspect?.(id);
    this.aspectSel = null;
    this.aspectForm = null;
    this.changed("ui");
  },

  /** Завести базовые статусы и аспекты модуля предметами (кнопка в пустом окне аспектов). */
  async seedAspects() {
    if ( !this.canEditAspects() ) return;
    const folder = await this.backend.saveAspectFolder?.({ name: this.t("ART.Aspect.baseFolder"), color: "#c9a45c" });
    const byKey = new Map();
    const list = baseItems();
    for ( const it of list.filter(x => x.system.kind === "aspect") ) {
      byKey.set(it.system.key, await this.backend.saveAspect?.({ name: it.name, folder: folder ?? "", system: it.system }));
    }
    for ( const it of list.filter(x => x.system.kind === "status") ) {
      await this.backend.saveAspect?.({ name: it.name, folder: folder ?? "", system: { ...it.system, parentId: byKey.get(it.parentKey) ?? "" } });
    }
    const first = this.aspects()[0];
    if ( first ) this.pickAspect(first.id);
    this.changed("ui");
  },

  /** Где висит предмет. */
  aspectHosts(id) { return hostsOf(this.states, id); },

  /** Повесить предмет на зону, метку или линию. */
  async attachAspect(featureId, itemId) {
    const item = this.aspectById(itemId);
    const st = this.stateOf(featureId);
    if ( !item || !st ) return false;
    const next = attachItem(st, item, () => this.backend.newId());
    if ( !next ) {
      this.backend.notify("info", this.t("ART.Aspect.already", { name: item.name }));
      return false;
    }
    await this.flush();
    await this._commit([{ action: "update", id: featureId, state: next }]);
    this.showToast?.(this.t("ART.Aspect.attached", { name: item.name, to: st.name || this.t("ART.Card.unnamed") }), { undo: true });
    this.changed("ui");
    return true;
  },

  async detachAspect(featureId, itemId) {
    const st = this.stateOf(featureId);
    const next = detachItem(st, itemId);
    if ( !next ) return;
    await this.flush();
    await this._commit([{ action: "update", id: featureId, state: next }]);
    this.changed("ui");
  },

  /**
   * Что лежит под точкой карты: метка, иначе линия, иначе верхняя видимая зона гекса.
   * Сюда бросают аспект, перетащенный из окна «Аспекты» или из списка предметов Foundry.
   */
  featureAt(point) {
    const mark = markAt(this.markSlots().slots, point);
    if ( mark ) return mark.id;
    const hidden = this.hidden();
    const view = this.view();
    const line = lineAt(this.states, [point.x, point.y], Math.max(6, this.grid.radius * 0.18), s => {
      const lid = lineLayerOf(s, this.types);
      return (!lid || isShown(lid, hidden)) && view.lines !== false;
    });
    if ( line ) return line.state.id;
    const cell = this.grid.cellAt(point);
    if ( !this.grid.inBounds(cell) ) return null;
    const k = cellKey(cell);
    const order = new Map(this.layers.map((l, n) => [l.id, n]));
    const zones = this.zones().filter(z => isShown(layerIdOf(z, this.types), hidden) && zoneCells(z).some(c => cellKey(c) === k))
      .sort((a, b) => (order.get(layerIdOf(b, this.types)) ?? 0) - (order.get(layerIdOf(a, this.types)) ?? 0));
    return zones[0]?.id ?? null;
  },

  async dropAspect(itemId, point) {
    const id = this.featureAt(point);
    if ( !id ) {
      this.backend.notify("warn", this.t("ART.Aspect.dropNothing"));
      return false;
    }
    return this.attachAspect(id, itemId);
  },

  /* ---------------------------------------------------------------- */
  /*  Окно слоёв: слой, вид, стиль слоя и берега                        */
  /* ---------------------------------------------------------------- */

  pickLayer(id) {
    this.layerSel = id;
    this.layerForm = null;
    this.coastForm = null;
    const l = this.layers.find(x => x.id === id);
    if ( l ) this.layerForm = { id: l.id, name: l.name, exclusive: l.exclusive !== false, color: l.color ?? "", folder: l.folder ?? "" };
    if ( id === "@coast" ) this.coastForm = { ...COAST_DEFAULTS, ...(this.backend.world?.()?.coast ?? {}) };
    this.changed("ui");
  },

  newLayer(folder = "") {
    if ( !this.backend.isGM ) return;
    this.layerSel = "new";
    this.coastForm = null;
    this.layerForm = { id: null, name: "", exclusive: true, color: "", folder };
    this.changed("ui");
  },

  /** Прозрачность и размытие слоя (мастер, видят все). Пустое значение — как было. */
  async setLayerLook(id, key, value) {
    if ( !this.backend.isGM || !["opacity", "blur"].includes(key) ) return;
    const layers = this.layers.map(({ visible, ...l }) => {
      if ( l.id !== id ) return l;
      const next = { ...l };
      const v = Number(value);
      if ( value === null || value === "" || !Number.isFinite(v) ) delete next[key];
      else next[key] = key === "opacity" ? Math.max(0, Math.min(1, v)) : Math.max(0, Math.min(20, v));
      if ( next.opacity === 1 ) delete next.opacity;
      if ( next.blur === 0 ) delete next.blur;
      return next;
    });
    await this.backend.setLayers(layers);
    this.changed("ui");
  },

  /** Стиль берега: поле формы. Сохраняется сразу, чтобы мастер видел карту. */
  async setCoast(key, value) {
    if ( !this.backend.isGM ) return;
    const f = this.coastForm ?? { ...COAST_DEFAULTS, ...(this.backend.world?.()?.coast ?? {}) };
    const num = ["width", "alpha", "blur"];
    f[key] = num.includes(key) ? Number(value) : key === "shallow" ? !!value : value;
    this.coastForm = f;
    await this.backend.setCoast?.({ ...f });
    this.changed("ui");
  },

  /** «Как было»: берег по умолчанию. */
  async resetCoast() {
    if ( !this.backend.isGM ) return;
    this.coastForm = { ...COAST_DEFAULTS };
    await this.backend.setCoast?.(null);
    this.changed("ui");
  },

  /** Сколько типов зон и линий в слое. */
  layerContents(id) {
    const zones = this.typesOf("area").filter(t => (t.layerId ?? "overlay") === id);
    const lines = this.typesOf("line").filter(t => t.layerId === id);
    const nZones = this.zones().filter(z => layerIdOf(z, this.types) === id).length;
    const nLines = [...this.states.values()].filter(s => s.system.kind === "line" && lineLayerOf(s, this.types) === id).length;
    return { zones, lines, nZones, nLines };
  },

  /* ---------------------------------------------------------------- */
  /*  Быстрый осмотр (вариант 7А «Плашка») и карточка                  */
  /* ---------------------------------------------------------------- */

  /** Метки для меню «Поставить метку»: недавние сверху, поиск по всем типам и папкам. */
  markTypesFor(q = "") {
    const f = String(q ?? "").trim().toLowerCase();
    const list = this.markTypesForMenu();
    if ( !f ) return list;
    const folders = new Map(this.folders().map(x => [x.id, x.name]));
    return list.filter(t => t.name.toLowerCase().includes(f) || String(folders.get(t.folder) ?? t.folder ?? "").toLowerCase().includes(f));
  },

  /** «+» в меню быстрого осмотра: открыть полное окно зон или меток с этим гексом. */
  openToolHere(kind) {
    const cells = this.inspectCells();
    this.hudMenu = null;
    this.setMode(kind === "zone" ? "zones" : "marks");
    this.selection.clear();
    for ( const c of cells ) this.selection.set(cellKey(c), c);
    if ( kind === "zone" ) this.zone.target = "new";
    this.changed("ui");
    this.changed("overlay");
  },

  /** Кнопка «Линия» быстрого осмотра: линия начинается в центре этого гекса. */
  lineFromHere() {
    const cell = this.inspected;
    if ( !cell ) return;
    this.hudMenu = null;
    this.setMode("lines");
    const c = this.grid.center(cell);
    this.line.points = [[c.x, c.y]];
    if ( this.line.mode === "hex" ) this.line.cells = [cell];
    this.changed("ui");
    this.changed("overlay");
  },

  /** Двойной щелчок по метке открывает её карточку в окне «Гекс». */
  doubleClick(point) {
    const hit = markAt(this.markSlots().slots, point);
    if ( !hit ) return false;
    this.markDrag = null;
    this.openMarkCard(hit.id, hit.cell);
    return true;
  },

  /** Карандаш в карточке: правка элемента. Ещё раз — снова просмотр. */
  editItem(id) {
    this.editId = this.editId === id ? null : id;
    this.openId = id;
    this.changed("ui");
  }
};
