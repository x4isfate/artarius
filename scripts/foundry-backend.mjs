/**
 * Backend студии поверх Foundry: атлас сцены, черновики и заявки в флагах
 * пользователей, ходы в настройке мира, сетка из canvas.grid.
 */
import { MODULE_ID, WORLD_DEFAULTS, CLAIM_STATUS, ASPECT_TYPE } from "./constants.mjs";
import * as store from "./data/store.mjs";
import { visibleStates, permsFor } from "./data/access.mjs";
import {
  submitDraft, returnToDraft, dropClaim, allClaims, claimConflicts, applyClaims, rejectClaims,
  requestClaimCheck, ghostsFor
} from "./review/claims.mjs";
import { draftOps } from "./review/ops.mjs";
import { cellKey } from "./data/world.mjs";
import { LAYER_NAME } from "./canvas/hex-layer.mjs";
import { oddRNeighbors } from "./gen/mapgen.mjs";

const OPEN = [CLAIM_STATUS.pending, CLAIM_STATUS.check, CLAIM_STATUS.rolled];

/** Настройки мира сцены: флаг artarius.world поверх умолчаний. */
export function worldOf(scene = canvas?.scene) {
  return { ...WORLD_DEFAULTS, ...(scene?.getFlag(MODULE_ID, "world") ?? {}) };
}

export const isWorldScene = (scene = canvas?.scene) => !!scene && worldOf(scene).enabled === true;

/** Сетка студии поверх canvas.grid. Вершины и центры кэшируются до смены сцены. */
export class FoundryGrid {
  constructor() { this.reset(); }

  reset() {
    this._v = new Map();
    this._c = new Map();
    this._radius = null;
    this._cells = null;
  }

  cellAt = p => {
    const o = canvas.grid.getOffset({ x: p.x, y: p.y });
    return [o.i, o.j];
  };

  center = c => {
    const k = cellKey(c);
    let v = this._c.get(k);
    if ( !v ) {
      const p = canvas.grid.getCenterPoint({ i: c[0], j: c[1] });
      v = { x: p.x, y: p.y };
      this._c.set(k, v);
    }
    return v;
  };

  vertices = c => {
    const k = cellKey(c);
    let v = this._v.get(k);
    if ( !v ) {
      v = canvas.grid.getVertices({ i: c[0], j: c[1] }).map(p => ({ x: p.x, y: p.y }));
      this._v.set(k, v);
    }
    return v;
  };

  /** Соседние гексы: из сетки Foundry, иначе по правилу HEXODDR. */
  neighbors = c => {
    try {
      const list = canvas.grid.getAdjacentOffsets?.({ i: c[0], j: c[1] });
      if ( list?.length ) return list.map(o => [o.i, o.j]);
    } catch { /* старый Foundry */ }
    return oddRNeighbors(c);
  };

  /** Гекс на поле, если его центр внутри прямоугольника сцены. */
  inBounds = c => {
    const r = canvas.dimensions?.sceneRect;
    if ( !r ) return false;
    const p = this.center(c);
    return p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height;
  };

  get radius() {
    if ( this._radius === null ) {
      const c = this.allCells()[0] ?? [0, 0];
      const p = this.center(c);
      const v = this.vertices(c)[0] ?? { x: p.x + (canvas.grid.size / 2), y: p.y };
      this._radius = Math.hypot(v.x - p.x, v.y - p.y) || (canvas.grid.size / 2);
    }
    return this._radius;
  }

  allCells = () => {
    if ( this._cells ) return this._cells;
    const r = canvas.dimensions.sceneRect;
    const [i0, j0, i1, j1] = canvas.grid.getOffsetRange(r);
    const out = [];
    for ( let i = i0; i < i1; i++ ) {
      for ( let j = j0; j < j1; j++ ) if ( this.inBounds([i, j]) ) out.push([i, j]);
    }
    this._cells = out;
    return out;
  };
}

/** Персонажи пользователя (см. store.ownedActorIds). */
export const ownedActorIds = store.ownedActorIds;

export default class FoundryBackend {
  constructor() {
    this.grid = new FoundryGrid();
    this.listeners = new Set();
    this._emitQueued = false;
    /** Номер версии данных: растёт при каждой перемене. По нему кэшируются состояния, типы и слои. */
    this.version = 0;
    this._cache = {};
    this._cacheScene = null;
    /** Правки, которые уже видны на карте, пока сервер их записывает: id → состояние или null (удалено). */
    this._optimistic = new Map();
  }

  /** Данные поменялись: кэш сбрасывается сразу, а подписчики узнают об этом в следующем микрошаге. */
  invalidate() {
    this.version++;
    this._cache = {};
  }

  /** Значение из кэша текущей версии данных. Другая сцена — другой кэш. */
  _cached(key, fn) {
    const sid = canvas?.scene?.id ?? null;
    if ( sid !== this._cacheScene ) { this._cache = {}; this._cacheScene = sid; this.version++; }
    if ( !(key in this._cache) ) this._cache[key] = fn();
    return this._cache[key];
  }

  /* Подписка ---------------------------------------------------------- */

  onChange(fn) { this.listeners.add(fn); }

  /** Данные поменялись: студия и панели перерисуются в следующем микрошаге. */
  emit() {
    this.invalidate();
    if ( this._emitQueued ) return;
    this._emitQueued = true;
    queueMicrotask(() => {
      this._emitQueued = false;
      for ( const fn of this.listeners ) {
        try { fn(); } catch(err) { console.error(`${MODULE_ID} | backend listener`, err); }
      }
    });
  }

  /* Кто я ------------------------------------------------------------- */

  get isGM() { return game.user.isGM; }
  get userId() { return game.user.id; }

  t(key, data) {
    return data ? game.i18n.format(key, data) : game.i18n.localize(key);
  }

  isWorld() { return isWorldScene(); }
  world() { return worldOf(); }
  /** Данные гексов для слоёв климата (импорт Azgaar, генератор). */
  fields() { return canvas?.scene?.getFlag?.(MODULE_ID, "fields") ?? null; }

  /** Игроки: actorIds — их персонажи, через них игрок демиург (и его не спрятать от своих элементов). */
  players() {
    return this._cached("players", () => game.users.filter(u => !u.isGM).map(u => ({
      id: u.id, name: u.name, color: u.color?.css ?? String(u.color ?? "#888"), active: u.active,
      actorIds: ownedActorIds(u)
    })));
  }

  /** Персонаж, закреплённый за этим пользователем: он становится демиургом того, что создаёт игрок. */
  characterId() { return game.user.isGM ? "" : (game.user.character?.id ?? ""); }

  actors() {
    const rank = a => (a.type === "character" ? 0 : 1);
    return game.actors.contents
      .filter(a => a.testUserPermission(game.user, "LIMITED") || game.user.isGM)
      .sort((a, b) => (rank(a) - rank(b)) || a.name.localeCompare(b.name))
      .map(a => ({ id: a.id, name: a.name }));
  }

  /* Данные ------------------------------------------------------------ */

  get atlas() { return store.getAtlas(canvas?.scene); }

  /**
   * Что видит этот пользователь: скрытое от него прячется, мастер видит всё.
   * Снимок общий до следующей перемены данных: его не меняют, а копируют (см. studio.edit).
   */
  states() {
    return this._cached("states", () => {
      const all = store.effectiveStates(canvas?.scene);
      for ( const [id, st] of this._optimistic ) {
        if ( st ) all.set(id, st); else all.delete(id);
      }
      return visibleStates(all, game.user.id, game.user.isGM, this.myActorIds());
    });
  }

  /** Персонажи, которыми владеет этот пользователь: через них он демиург. */
  myActorIds() {
    return this._cached("myActors", () => new Set(ownedActorIds(game.user)));
  }
  /** Права этого пользователя: place, draw, editOthers, statuses. */
  permissions() { return permsFor(game.settings.get(MODULE_ID, "permissions"), { id: game.user.id, role: game.user.role, isGM: game.user.isGM }); }
  permissionConfig() { return foundry.utils.deepClone(game.settings.get(MODULE_ID, "permissions") ?? {}); }
  async setPermissionConfig(config) {
    if ( !game.user.isGM ) return;
    await game.settings.set(MODULE_ID, "permissions", config);
    this.emit();
  }
  /** Пользователи для настройки прав: игроки с ролью. */
  /** Шрифты Foundry и подключённые модулями: для подписей типов. */
  fonts() { return Object.keys(CONFIG.fontDefinitions ?? {}).sort((a, b) => a.localeCompare(b)); }
  roster() { return game.users.filter(u => !u.isGM).map(u => ({ id: u.id, name: u.name, role: u.role })); }
  atlasStates() { return this._cached("atlas", () => store.atlasStates(this.atlas)); }
  types() { return this._cached("types", () => store.getTypes(this.atlas)); }

  /** Слои атласа; скрытые этим пользователем помечены visible: false. */
  layers() {
    return this._cached("layers", () => {
      const hidden = new Set(game.settings.get(MODULE_ID, "hiddenLayers") ?? []);
      return store.getLayers(this.atlas).map(l => ({ ...l, visible: !hidden.has(l.id) }));
    });
  }

  /** Слои атласа целиком: добавить, переименовать, переставить, удалить (только мастер). */
  async setLayers(layers) {
    if ( !game.user.isGM ) return;
    const atlas = this.atlas ?? await store.ensureAtlas(canvas.scene);
    await store.setLayers(atlas, layers.map(({ visible, ...l }) => l));
  }

  async toggleLayer(id) {
    const hidden = this.hiddenIds();
    if ( hidden.has(id) ) hidden.delete(id); else hidden.add(id);
    await this.setHidden([...hidden]);
  }

  /** Скрытые этим пользователем слои и виды элементов (@marks, @lines…). */
  hiddenIds() { return new Set(game.settings.get(MODULE_ID, "hiddenLayers") ?? []); }

  async setHidden(ids) {
    await game.settings.set(MODULE_ID, "hiddenLayers", [...new Set(ids)]);
    this.emit();
  }

  /* Папки (0.9.9) ------------------------------------------------------ */

  folders() { return this._cached("folders", () => store.getFolders(this.atlas)); }

  async setFolders(list) {
    if ( !game.user.isGM ) return;
    const atlas = this.atlas ?? await store.ensureAtlas(canvas.scene);
    await store.setFolders(atlas, list);
  }

  /* Аспекты и статусы: предметы «Аспект Artarius» (0.9.9) --------------- */

  aspects() {
    return this._cached("aspects", () => (game.items?.contents ?? []).filter(i => i.type === ASPECT_TYPE)
      .sort((a, b) => ((a.sort ?? 0) - (b.sort ?? 0)) || a.name.localeCompare(b.name))
      .map(i => ({ id: i.id, name: i.name, folder: i.folder?.id ?? "", system: foundry.utils.deepClone(i._source.system ?? {}) })));
  }

  /** Папки предметов, где лежат аспекты или которые заведены в окне «Аспекты». */
  aspectFolders() {
    return this._cached("aspectFolders", () => {
      const used = new Set(this.aspects().map(a => a.folder).filter(Boolean));
      return (game.folders?.contents ?? []).filter(f => f.type === "Item" && (used.has(f.id) || f.getFlag(MODULE_ID, "aspects")))
        .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
        .map(f => ({ id: f.id, kind: "aspect", name: f.name, color: f.color?.css ?? String(f.color ?? "") }));
    });
  }

  canCreateAspects() { return game.user.isGM || !!game.user.can?.("ITEM_CREATE"); }

  async saveAspect({ id, name, folder = "", system }) {
    if ( id ) {
      await game.items.get(id)?.update({ name, folder: folder || null, system });
      return id;
    }
    const item = await Item.implementation.create({
      name, type: ASPECT_TYPE, img: "icons/svg/aura.svg", folder: folder || null, system,
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }
    });
    return item?.id ?? null;
  }

  async deleteAspect(id) { await game.items.get(id)?.delete(); }

  async saveAspectFolder({ id, name, color }) {
    if ( id ) {
      const patch = {};
      if ( name !== undefined ) patch.name = name;
      if ( color !== undefined ) patch.color = color;
      await game.folders.get(id)?.update(patch);
      return id;
    }
    const f = await Folder.implementation.create({ type: "Item", name, color, flags: { [MODULE_ID]: { aspects: true } } });
    return f?.id ?? null;
  }

  /** Убрать папку: предметы из неё уходят в корень, сами не удаляются. */
  async deleteAspectFolder(id) {
    const f = game.folders.get(id);
    if ( !f ) return;
    const items = game.items.filter(i => i.folder?.id === id).map(i => ({ _id: i.id, folder: null }));
    if ( items.length ) await Item.implementation.updateDocuments(items);
    await f.delete({ deleteSubfolders: false, deleteContents: false });
  }

  /* Берег (0.9.9): стиль в настройках мира сцены, видят все -------------- */

  async setCoast(style) {
    const scene = canvas?.scene;
    if ( !game.user.isGM || !scene ) return;
    if ( style ) await scene.setFlag(MODULE_ID, "world.coast", style);
    else await scene.unsetFlag(MODULE_ID, "world.coast");
    this.emit();
  }

  /** Свои наборы слоёв этого пользователя: [{ id, name, hidden }]. */
  customPresets() { return foundry.utils.deepClone(game.settings.get(MODULE_ID, "layerPresets") ?? []); }
  async setCustomPresets(list) {
    await game.settings.set(MODULE_ID, "layerPresets", list);
    this.emit();
  }

  /** Спросить название у пользователя. */
  async prompt(title, value = "") {
    const { DialogV2 } = foundry.applications.api;
    return DialogV2.prompt({
      window: { title },
      content: `<input type="text" name="value" value="${String(value).replace(/"/g, "&quot;")}" autofocus>`,
      ok: { callback: (ev, button) => button.form.elements.value.value.trim() },
      rejectClose: false
    });
  }

  /**
   * Записать правки. Пока сервер их пишет, карта уже показывает новое состояние:
   * кисть не ждёт ответа. Не получилось — карта возвращается как была.
   */
  async commitOps(ops) {
    const mine = new Map();
    for ( const op of ops ?? [] ) {
      if ( !op?.id ) continue;
      const st = op.action === "delete" ? null : op.state;
      mine.set(op.id, st);
      this._optimistic.set(op.id, st);
    }
    if ( mine.size ) this.emit();
    try {
      return await store.commitOps(ops, canvas.scene);
    } finally {
      for ( const [id, st] of mine ) if ( this._optimistic.get(id) === st ) this._optimistic.delete(id);
      if ( mine.size ) this.emit();
    }
  }
  saveType(type) { return store.saveType(type, canvas.scene); }
  deleteType(id) { return store.deleteType(id, canvas.scene); }
  newId() { return foundry.utils.randomID(); }

  /* Черновик и заявки ------------------------------------------------- */

  draftOps() {
    if ( game.user.isGM || !canvas?.scene ) return [];
    return draftOps(store.getDraft(game.user, canvas.scene.id));
  }

  async undoDraftOp(id) {
    const draft = store.getDraft(game.user, canvas.scene.id);
    delete draft[id];
    await store.setDraft(draft, game.user, canvas.scene.id);
  }

  submitDraft(form) { return submitDraft(form, canvas.scene); }
  returnToDraft(id) { return returnToDraft(id); }
  dropClaim(id) { return dropClaim(id); }

  /** Открытые заявки всех игроков. */
  claims() { return allClaims(); }

  myClaims() {
    return store.getClaims(game.user).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  conflicts(claim) { return claimConflicts(claim); }
  applyClaims(entries) { return applyClaims(entries); }
  rejectClaims(entries, comment) { return rejectClaims(entries, comment); }

  /** Мастер назначает проверку: спросить сложность и пояснение. */
  async requestCheck(entry) {
    const L = k => game.i18n.localize(k);
    const result = await foundry.applications.api.DialogV2.prompt({
      window: { title: L("VMAP.Check.title") },
      content: `<div class="form-group"><label>${L("VMAP.Check.difficulty")}</label>
          <input type="number" name="difficulty" value="3" min="1" max="6" step="1"></div>
        <p class="hint">${L("VMAP.Check.difficultyHint")}</p>
        <div class="form-group stacked"><label>${L("VMAP.Check.note")}</label><textarea name="note" rows="2"></textarea></div>`,
      ok: {
        label: L("VMAP.Check.send"),
        callback: (ev, button) => ({
          difficulty: Number(button.form.elements.difficulty.value) || 3,
          note: button.form.elements.note.value
        })
      },
      rejectClose: false
    });
    if ( !result ) return;
    return requestClaimCheck(entry, result.difficulty, result.note);
  }

  /** Призраки: у мастера — заявки на предпросмотре, у игрока — свои открытые заявки и черновик. */
  ghosts(previewIds = []) {
    return this._cached(`ghosts:${previewIds.join(",")}`, () => this._ghosts(previewIds));
  }

  _ghosts(previewIds) {
    const scene = canvas?.scene;
    if ( !scene ) return [];
    const atlas = this.atlas;
    if ( game.user.isGM ) {
      const entries = allClaims().filter(e => previewIds.includes(e.claim.id) && e.claim.sceneId === scene.id);
      return ghostsFor(entries, atlas);
    }
    const mine = store.getClaims(game.user).filter(c => c.sceneId === scene.id && OPEN.includes(c.status));
    const draft = { claim: { ops: draftOps(store.getDraft(game.user, scene.id)) } };
    return ghostsFor([...mine.map(claim => ({ claim })), draft], atlas);
  }

  /* Интерфейс Foundry ------------------------------------------------- */

  notify(level, text) {
    const fn = { warn: "warn", error: "error" }[level] ?? "info";
    ui.notifications?.[fn](text);
  }

  async confirm(text) {
    try {
      return !!(await foundry.applications.api.DialogV2.confirm({
        window: { title: "Artarius" },
        content: `<p>${foundry.utils.escapeHTML(text)}</p>`,
        rejectClose: false
      }));
    } catch { return false; }
  }

  /** Спросить строку. null — отказ. */
  async promptText(label) {
    const value = await foundry.applications.api.DialogV2.prompt({
      window: { title: "Artarius" },
      content: `<div class="form-group stacked"><label>${foundry.utils.escapeHTML(label)}</label><textarea name="text" rows="3"></textarea></div>`,
      ok: { label: game.i18n.localize("ART.Save"), callback: (ev, button) => button.form.elements.text.value },
      rejectClose: false
    });
    return value ?? null;
  }

  panTo(pt) {
    canvas.animatePan({ x: pt.x, y: pt.y, duration: 400 });
  }

  /** Включить слой Артария с инструментом или вернуть мышь токенам. */
  activateLayer(tool) {
    try {
      if ( tool ) {
        if ( ui.controls?.control?.name === LAYER_NAME && ui.controls?.tool?.name === tool ) return;
        if ( ui.controls?.controls?.[LAYER_NAME] ) ui.controls.activate({ control: LAYER_NAME, tool });
        else canvas[LAYER_NAME]?.activate({ tool });
      } else if ( canvas[LAYER_NAME]?.active || canvas.activeLayer === canvas[LAYER_NAME] || ui.controls?.control?.name === LAYER_NAME ) {
        if ( ui.controls?.controls?.tokens ) ui.controls.activate({ control: "tokens", tool: "select" });
        else canvas.tokens?.activate();
      }
    } catch(err) {
      console.warn(`${MODULE_ID} | activate layer`, err);
      if ( tool ) canvas[LAYER_NAME]?.activate();
    }
  }

  pickFile(current, callback) {
    const FP = foundry.applications.apps.FilePicker.implementation ?? foundry.applications.apps.FilePicker;
    new FP({ type: "image", current, callback }).render({ force: true });
  }

  /**
   * Превью сцены в списке сцен: снимок слоя Артария. Без него у сцены мира нет фона, и Foundry рисует чёрный квадрат.
   * Сервер Foundry сам сохраняет картинку из data URL в папку мира. Если не вышло, грузим файл через FilePicker.
   */
  async updateThumb({ quiet = true } = {}) {
    const scene = canvas.scene;
    const renderer = canvas[LAYER_NAME]?.renderer;
    if ( !game.user.isGM || !scene || !renderer || !canvas.app?.renderer ) return false;
    try {
      const data = await renderer.snapshot(canvas.app.renderer, canvas.dimensions.sceneRect, 600);
      try {
        await scene.update({ thumb: data });
      } catch(err) {
        const FP = foundry.applications.apps.FilePicker.implementation ?? foundry.applications.apps.FilePicker;
        const dir = `worlds/${game.world.id}/assets/artarius`;
        await FP.createDirectory("data", dir).catch(() => null);
        const blob = await (await fetch(data)).blob();
        const file = new File([blob], `${scene.id}-thumb.webp`, { type: "image/webp" });
        const res = await FP.upload("data", dir, file, {}, { notify: false });
        if ( !res?.path ) throw err;
        await scene.update({ thumb: `${res.path}?v=${Date.now()}` });
      }
      if ( !quiet ) ui.notifications.info(game.i18n.localize("ART.World.thumbDone"));
      return true;
    } catch(err) {
      console.warn(`${MODULE_ID} | scene thumbnail`, err);
      if ( !quiet ) ui.notifications.warn(game.i18n.localize("ART.World.thumbFail"));
      return false;
    }
  }

  openGuide() { game.modules.get(MODULE_ID).api.openGuide(); }
  openWorldSettings() { game.modules.get(MODULE_ID).api.openWorldSettings(); }
  openAzgaar() { game.modules.get(MODULE_ID).api.openAzgaar(); }
  openGenerator() { game.modules.get(MODULE_ID).api.openGenerator(); }
  openAzgaarGenerator() { game.modules.get(MODULE_ID).api.openAzgaarGenerator(); }

  /* Вкладка «Мир»: настройки, импорт и генератор без отдельных окон. */
  worldInfo() { return game.modules.get(MODULE_ID).api.worldInfo(); }
  applyWorldSettings(values) { return game.modules.get(MODULE_ID).api.applyWorldSettings(values); }
  importAzgaarText(text, fileName, options) { return game.modules.get(MODULE_ID).api.importAzgaarText(text, fileName, options); }
  async generateWorld(options) {
    const out = await game.modules.get(MODULE_ID).api.generateTestWorld(options);
    if ( out ) ui.notifications.info(game.i18n.format("ART.Gen.done", { ...out.stats, seed: out.seed }));
    return out;
  }
}
