/**
 * Студия 0.9.9 «единый интерфейс»: папки, аспекты-предметы, окно слоёв со стилем слоя и берега,
 * быстрый осмотр, сжатая карточка гекса. Методы примешиваются к Studio (см. studio.mjs, внизу).
 * Как и студия, этот код не знает ни про Foundry, ни про PIXI.
 */
import { COAST_DEFAULTS } from "./constants.mjs";
import { groupByFolders, nextFolderColor, materialize } from "./data/folders.mjs";
import { attachItem, attachInto, detachItem, hostsOf, searchItems, rankItems, baseItems, statusIdsOf, cleanSteps, stepsOf,
  itemByName, looseEntries, linkEntries, isImageIcon } from "./data/aspects.mjs";
import { isLibraryIcon } from "./data/icons.mjs";
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
    const items = this.aspects();
    for ( const id of f.aspects ?? [] ) {
      const item = items.find(i => i.id === id);
      if ( item ) st = attachItem(st, item, () => this.backend.newId(), items) ?? st;
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

  /**
   * Открыть или закрыть выбор аспекта. Куда кладётся выбранное:
   * slot — форма нового элемента, featureId — элемент карточки, featureId + aspectN — внутрь его аспекта,
   * form — статусы аспекта в окне «Статусы и аспекты».
   */
  toggleAspectPick({ slot = null, featureId = null, aspectN = null, form = false } = {}) {
    const n = aspectN === null || aspectN === undefined || aspectN === "" ? null : Number(aspectN);
    const p = this.aspectPick;
    const same = p && p.slot === slot && p.featureId === featureId && p.aspectN === n && !!p.form === !!form;
    this.aspectPick = same ? null : { slot, featureId, aspectN: n, form: !!form, q: "" };
    this.changed("ui");
  },

  /** Щелчок в списке выбора: в форму, на элемент, внутрь аспекта элемента или в статусы аспекта. */
  async pickFromList(itemId) {
    const p = this.aspectPick;
    if ( !p ) return;
    if ( p.form ) this.addFormStatus(itemId);
    else if ( p.slot ) this.addPending(p.slot, itemId);
    else if ( p.featureId && p.aspectN !== null ) await this.attachIntoAspect(p.featureId, p.aspectN, itemId);
    else if ( p.featureId ) await this.attachAspect(p.featureId, itemId);
    this.aspectPick = null;
    this.changed("ui");
  },

  /** Только статусы: внутрь аспекта и в статусы аспекта аспект не кладётся. */
  _pickOnlyStatus(p = this.aspectPick) { return !!(p && (p.form || p.aspectN !== null)); },

  /** Предметы для списка выбора: поиск, сначала точные совпадения, без уже выбранных. */
  pickList() {
    const p = this.aspectPick;
    if ( !p ) return [];
    const st = p.featureId ? this.stateOf(p.featureId) : null;
    let have = new Set();
    if ( p.form ) have = new Set([...(this.aspectForm?.statusIds ?? []), this.aspectForm?.id].filter(Boolean));
    else if ( p.slot ) have = new Set(this[p.slot]?.aspects ?? []);
    const items = this.aspects();
    return rankItems(searchItems(items, p.q), p.q).filter(i => !have.has(i.id)
      && !(st && hostsOf(new Map([[st.id, st]]), i.id).length)
      && (!this._pickOnlyStatus(p) || i.system?.kind === "status"));
  },

  /** Что можно завести прямо из списка выбора по набранному названию: [] или ["status", "aspect"]. */
  pickCreateKinds() {
    const p = this.aspectPick;
    const name = String(p?.q ?? "").trim();
    if ( !p || !name ) return [];
    const kinds = this._pickOnlyStatus(p) ? ["status"] : ["status", "aspect"];
    const items = this.aspects();
    const free = kinds.filter(k => !itemByName(items, name, k));
    // Без права заводить предметы: свой статус ложится только на элемент, в общий список не попадает.
    if ( !this.canEditAspects() ) return p.featureId ? free : [];
    return free;
  },

  /** Завести статус или аспект с набранным названием и сразу положить его туда же, куда и выбранный. */
  async createFromPick(kind) {
    const p = this.aspectPick;
    const name = String(p?.q ?? "").trim().slice(0, 80);
    if ( !p || !name || !["status", "aspect"].includes(kind) ) return;
    if ( !this.canEditAspects() ) {
      if ( !p.featureId ) return;
      // Игрок без права на предметы: запись только на элементе, мастер потом перенесёт её в список.
      const entry = { id: this.backend.newId(), name, value: null, max: null };
      this.edit(p.featureId, s => {
        if ( kind === "aspect" ) (s.system.aspects ??= []).push({ ...entry, description: "", statuses: [] });
        else if ( p.aspectN !== null && s.system.aspects?.[p.aspectN] ) (s.system.aspects[p.aspectN].statuses ??= []).push(entry);
        else (s.system.statuses ??= []).push(entry);
      }, { now: true });
      this.aspectPick = null;
      this.changed("ui");
      return;
    }
    const id = await this.backend.saveAspect?.({
      name, folder: "",
      system: { kind, icon: kind === "aspect" ? "star" : "circle-dot", emoji: "", tint: true, color: kind === "aspect" ? "#8f7bb5" : "#c9a45c",
        description: "", steps: 0, start: null, statusIds: [], parentId: "", key: "" }
    });
    if ( !id ) return;
    this.showToast?.(this.t("ART.Aspect.created", { name }));
    await this.pickFromList(id);
  },

  /** Статус внутрь аспекта, который уже висит на элементе. */
  async attachIntoAspect(featureId, aspectN, itemId) {
    const st = this.stateOf(featureId);
    const item = this.aspectById(itemId);
    const next = attachInto(st, Number(aspectN), item, () => this.backend.newId());
    if ( !next ) {
      if ( item ) this.backend.notify("info", this.t("ART.Aspect.already", { name: item.name }));
      return false;
    }
    await this.flush();
    await this._commit([{ action: "update", id: featureId, state: next }]);
    this.changed("ui");
    return true;
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
    if ( !a ) { this.aspectForm = null; this.changed("ui"); return; }
    const sys = clone(a.system ?? {});
    const { max, start } = stepsOf(a);
    this.aspectForm = {
      id: a.id, name: a.name, folder: a.folder ?? "", ...sys,
      emoji: sys.emoji ?? "", tint: sys.tint !== false, steps: max ? String(max) : "", start: max ? String(start) : "",
      statusIds: statusIdsOf(a, this.aspects()), iconQuery: "", iconCat: "", iconMore: isImageIcon(sys.icon)
    };
    if ( this.aspectPick?.form ) this.aspectPick = null;
    this.changed("ui");
  },

  /** Новый аспект или статус. kind — что заводим, folder — папка. */
  newAspect(folder = "", kind = "status") {
    if ( !this.canEditAspects() ) return this.backend.notify("warn", this.t("ART.Aspect.cantCreate"));
    this.aspectSel = "new";
    this.aspectForm = {
      id: null, name: "", folder, kind: kind === "aspect" ? "aspect" : "status", icon: kind === "aspect" ? "star" : "circle-dot",
      emoji: "", tint: true, color: kind === "aspect" ? "#8f7bb5" : "#c9a45c", description: "", steps: "", start: "",
      statusIds: [], parentId: "", key: "", iconQuery: "", iconCat: "", iconMore: false
    };
    if ( this.aspectPick?.form ) this.aspectPick = null;
    this.changed("ui");
  },

  setAspectKind(kind) {
    if ( !this.aspectForm || !["aspect", "status"].includes(kind) ) return;
    this.aspectForm.kind = kind;
    if ( kind === "aspect" ) this.aspectForm.parentId = "";
    if ( this.aspectPick?.form ) this.aspectPick = null;
    this.changed("ui");
  },

  /** Значок формы аспекта: имя Font Awesome или путь к картинке. Картинка библиотеки красится, своя нет. */
  setAspectIcon(icon) {
    const f = this.aspectForm;
    if ( !f ) return;
    f.icon = String(icon ?? "");
    f.emoji = "";
    if ( isImageIcon(f.icon) ) f.tint = isLibraryIcon(f.icon);
    this.changed("ui");
  },

  /** Статус в список статусов аспекта (форма, до «Сохранить»). */
  addFormStatus(itemId) {
    const f = this.aspectForm;
    const item = this.aspectById(itemId);
    if ( !f || !item || item.system?.kind !== "status" || itemId === f.id ) return;
    f.statusIds = [...new Set([...(f.statusIds ?? []), itemId])];
    this.changed("ui");
  },

  removeFormStatus(itemId) {
    const f = this.aspectForm;
    if ( !f ) return;
    f.statusIds = (f.statusIds ?? []).filter(id => id !== itemId);
    this.changed("ui");
  },

  /** Предметы с похожим названием для подсказки под полем «Название» новой формы. */
  similarAspects(name, limit = 6) {
    const f = String(name ?? "").trim().toLowerCase();
    if ( f.length < 2 ) return [];
    return rankItems(this.aspects().filter(i => i.name.toLowerCase().includes(f)), f).slice(0, limit);
  },

  async saveAspectForm() {
    const f = this.aspectForm;
    if ( !f ) return;
    const name = String(f.name ?? "").trim();
    if ( !name ) return this.backend.notify("warn", this.t("ART.Aspect.needName"));
    const aspect = f.kind === "aspect";
    const { steps, start } = cleanSteps(f.start, f.steps);
    const items = this.aspects();
    const ids = aspect ? (f.statusIds ?? []).filter(id => items.some(i => i.id === id && i.system?.kind === "status")) : [];
    const data = {
      id: f.id, name: name.slice(0, 80), folder: f.folder || "",
      system: {
        kind: aspect ? "aspect" : "status", icon: f.icon || "", emoji: String(f.emoji ?? "").trim().slice(0, 16),
        tint: f.tint !== false, color: f.color || "#c9a45c", description: String(f.description ?? ""), steps, start,
        statusIds: ids, parentId: aspect ? "" : (f.parentId || ""), key: f.key || ""
      }
    };
    const id = await this.backend.saveAspect?.(data);
    // Статус, убранный из аспекта, теряет и старую ссылку parentId на него.
    if ( aspect && id ) {
      for ( const st of items.filter(i => i.system?.kind === "status" && i.system?.parentId === id && !ids.includes(i.id)) ) {
        await this.backend.saveAspect?.({ id: st.id, name: st.name, folder: st.folder ?? "", system: { ...clone(st.system), parentId: "" } });
      }
    }
    this.pickAspect(id ?? f.id);
  },

  async deleteAspect(id) {
    const a = this.aspectById(id);
    if ( !a || !this.canEditAspects() ) return;
    const n = hostsOf(this.states, id).length;
    if ( !(await this.backend.confirm(this.t(n ? "ART.Aspect.deleteUsed" : "ART.Aspect.deleteAsk", { name: a.name, n }))) ) return;
    await this.backend.deleteAspect?.(id);
    // Удалённый статус пропадает из списков аспектов.
    for ( const x of this.aspects().filter(i => (i.system?.statusIds ?? []).includes(id)) ) {
      await this.backend.saveAspect?.({ id: x.id, name: x.name, folder: x.folder ?? "", system: { ...clone(x.system), statusIds: x.system.statusIds.filter(s => s !== id) } });
    }
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

  /** Свои статусы и аспекты на карте, которых нет в общем списке. */
  looseAspects() { return looseEntries(this.states, this.aspects()); },

  /**
   * Перенести в общий список статусы и аспекты, заведённые прямо на элементах карты (до 1.0 так делали в карточке гекса).
   * Каждое название становится предметом в папке «С карты», записи на карте получают ссылку на него.
   */
  async collectLoose() {
    if ( !this.backend.isGM ) return this.backend.notify("warn", this.t("ART.Aspect.collectGm"));
    const loose = this.looseAspects();
    if ( loose.length ) {
      const folder = await this.backend.saveAspectFolder?.({ name: this.t("ART.Aspect.fromMapFolder"), color: "#7fa9c4" });
      for ( const x of loose ) {
        const icon = x.icon || (x.kind === "aspect" ? "star" : "circle-dot");
        await this.backend.saveAspect?.({
          name: x.name, folder: folder ?? "",
          system: { kind: x.kind, icon, emoji: "", tint: true, color: x.kind === "aspect" ? "#8f7bb5" : "#c9a45c", description: "",
            steps: Math.max(0, Math.min(999, x.max || 0)), start: x.max ? 1 : null, statusIds: [], parentId: "", key: x.key || "" }
        });
      }
    }
    const items = this.aspects();
    const ops = [];
    for ( const st of this.states.values() ) {
      const next = linkEntries(st, items);
      if ( next ) ops.push({ action: "update", id: st.id, state: next });
    }
    await this.flush();
    if ( ops.length ) await this._commit(ops, { label: this.t("ART.Aspect.collect") });
    this.showToast?.(this.t("ART.Aspect.collected", { n: loose.length, m: ops.length }), { undo: ops.length > 0 });
    this.changed("ui");
  },

  /** Где висит предмет. */
  aspectHosts(id) { return hostsOf(this.states, id); },

  /** Повесить предмет на зону, метку или линию. */
  async attachAspect(featureId, itemId) {
    const item = this.aspectById(itemId);
    const st = this.stateOf(featureId);
    if ( !item || !st ) return false;
    const next = attachItem(st, item, () => this.backend.newId(), this.aspects());
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
