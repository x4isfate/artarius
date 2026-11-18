/**
 * Backend студии поверх Foundry: атлас сцены, черновики и заявки в флагах
 * пользователей, ходы в настройке мира, сетка из canvas.grid.
 */
import { MODULE_ID, WORLD_DEFAULTS, CLAIM_STATUS } from "./constants.mjs";
import * as store from "./data/store.mjs";
import {
  submitDraft, returnToDraft, dropClaim, allClaims, claimConflicts, applyClaims, rejectClaims,
  requestClaimCheck, ghostsFor
} from "./review/claims.mjs";
import { draftOps } from "./review/ops.mjs";
import { TURN_DEFAULT, cellKey } from "./data/world.mjs";
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

export default class FoundryBackend {
  constructor() {
    this.grid = new FoundryGrid();
    this.listeners = new Set();
    this._emitQueued = false;
  }

  /* Подписка ---------------------------------------------------------- */

  onChange(fn) { this.listeners.add(fn); }

  /** Данные поменялись: студия и панели перерисуются в следующем микрошаге. */
  emit() {
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

  players() {
    return game.users.filter(u => !u.isGM).map(u => ({
      id: u.id, name: u.name, color: u.color?.css ?? String(u.color ?? "#888"), active: u.active
    }));
  }

  actors() {
    const rank = a => (a.type === "character" ? 0 : 1);
    return game.actors.contents
      .filter(a => a.testUserPermission(game.user, "LIMITED") || game.user.isGM)
      .sort((a, b) => (rank(a) - rank(b)) || a.name.localeCompare(b.name))
      .map(a => ({ id: a.id, name: a.name }));
  }

  /* Данные ------------------------------------------------------------ */

  get atlas() { return store.getAtlas(canvas?.scene); }

  states() { return store.effectiveStates(canvas?.scene); }
  atlasStates() { return store.atlasStates(this.atlas); }
  types() { return store.getTypes(this.atlas); }

  /** Слои атласа; скрытые этим пользователем помечены visible: false. */
  layers() {
    const hidden = new Set(game.settings.get(MODULE_ID, "hiddenLayers") ?? []);
    return store.getLayers(this.atlas).map(l => ({ ...l, visible: !hidden.has(l.id) }));
  }

  async toggleLayer(id) {
    const hidden = new Set(game.settings.get(MODULE_ID, "hiddenLayers") ?? []);
    if ( hidden.has(id) ) hidden.delete(id); else hidden.add(id);
    await game.settings.set(MODULE_ID, "hiddenLayers", [...hidden]);
    this.emit();
  }

  commitOps(ops) { return store.commitOps(ops, canvas.scene); }
  saveType(type) { return store.saveType(type, canvas.scene); }
  deleteType(id) { return store.deleteType(id, canvas.scene); }
  newId() { return foundry.utils.randomID(); }

  /* Ходы -------------------------------------------------------------- */

  turn() { return { ...TURN_DEFAULT, ...(game.settings.get(MODULE_ID, "turn") ?? {}) }; }

  async setTurn(turn) {
    if ( !game.user.isGM ) return;
    await game.settings.set(MODULE_ID, "turn", turn);
  }

  /** Объявить ход в чате: остаётся в истории игры. */
  async announceTurn(userId, round) {
    const name = game.users.get(userId)?.name ?? "—";
    const turn = this.turn();
    const text = turn.index === 0 ? this.t("ART.Turn.announceRound", { round: turn.round, name }) : this.t("ART.Turn.announce", { name });
    await ChatMessage.implementation.create({
      content: `<div class="artarius-turn-msg"><i class="fa-solid fa-hourglass-half"></i> ${foundry.utils.escapeHTML(text)}</div>`,
      speaker: { alias: game.i18n.localize("VMAP.Check.speaker") }
    });
  }

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
      } else if ( canvas[LAYER_NAME]?.active ) {
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

  openGuide() { game.modules.get(MODULE_ID).api.openGuide(); }
  openWorldSettings() { game.modules.get(MODULE_ID).api.openWorldSettings(); }
  openAzgaar() { game.modules.get(MODULE_ID).api.openAzgaar(); }
}
