/**
 * Backend стенда: всё в памяти, несколько пользователей, без Foundry.
 * Повторяет поведение настоящего: мастер пишет в атлас, игрок — в черновик,
 * заявки ждут решения мастера, ходы передаёт мастер.
 */
import { STARTER_TYPES, STARTER_LAYERS, CLAIM_STATUS } from "../../scripts/constants.mjs";
import { addToDraft, draftOps, applyOps, buildApplyPlan, conflictOf, randomId } from "../../scripts/review/ops.mjs";
import { mergeTypes, personalTypesUsed } from "../../scripts/data/world.mjs";
import HexMath from "../../scripts/hex/hexmath.mjs";
import { visibleStates, permsFor } from "../../scripts/data/access.mjs";

const clone = x => JSON.parse(JSON.stringify(x));

function format(str, data = {}) {
  return String(str).replace(/\{(\w+)\}/g, (m, k) => (k in data ? String(data[k]) : m));
}

export default class MemoryBackend {
  constructor({ lang = {}, grid = new HexMath({ size: 60, rows: 14, cols: 22, x0: 20, y0: 20 }) } = {}) {
    this.lang = lang;
    this.grid = adapter(grid);
    this.hex = grid;
    this.users = [
      { id: "gm", name: "Мастер", color: "#ffffff", isGM: true },
      { id: "fire", name: "Огонь", color: "#e0604f", isGM: false },
      { id: "ice", name: "Лёд", color: "#5bb8d6", isGM: false },
      { id: "sun", name: "Солнце", color: "#e8c27a", isGM: false }
    ];
    this.actorsList = [
      { id: "a-fire", name: "Демиург Огня" }, { id: "a-ice", name: "Демиург Льда" }, { id: "a-sun", name: "Демиург Солнца" }
    ];
    this.atlas = new Map();       // id → state (с rev)
    this.atlasTypes = clone(STARTER_TYPES);
    this.atlasLayers = clone(STARTER_LAYERS);
    this.flags = {};              // userId → { draft: {}, claims: [], types: [] }
    for ( const u of this.users ) this.flags[u.id] = { draft: {}, claims: [], types: [] };
    this.me = "gm";
    this.listeners = new Set();
    this.log = [];
    this.confirmAnswer = true;
    this.promptAnswer = "";
  }

  /* Пользователь ---------------------------------------------------- */

  get user() { return this.users.find(u => u.id === this.me); }
  get isGM() { return !!this.user.isGM; }
  get userId() { return this.me; }
  switchUser(id) { this.me = id; this.emit(); }

  onChange(fn) { this.listeners.add(fn); }
  emit() { for ( const fn of this.listeners ) fn(); }

  t(key, data) {
    const v = key.split(".").reduce((o, k) => o?.[k], this.lang);
    return typeof v === "string" ? format(v, data) : key;
  }

  notify(level, text) { this.log.push([level, text]); }
  confirm() { return Promise.resolve(this.confirmAnswer); }
  promptText() { return Promise.resolve(this.promptAnswer); }
  newId() { return randomId(); }
  panTo(pt) { this.log.push(["pan", `${Math.round(pt.x)},${Math.round(pt.y)}`]); }

  players() {
    return this.users.filter(u => !u.isGM).map(u => ({ id: u.id, name: u.name, color: u.color, active: true }));
  }
  actors() { return this.actorsList; }

  /* Данные ----------------------------------------------------------- */

  atlasStates() { return new Map([...this.atlas].map(([k, v]) => [k, clone(v)])); }

  states() {
    const base = this.atlasStates();
    if ( this.isGM ) return base;
    const f = this.flags[this.me];
    const open = f.claims.filter(c => ["pending", "check", "rolled"].includes(c.status)).flatMap(c => c.ops);
    return visibleStates(applyOps(applyOps(base, open), draftOps(f.draft)), this.me, false);
  }

  permissions() { return permsFor(this.permConfig ?? {}, { id: this.me, role: this.isGM ? 4 : 1, isGM: this.isGM }); }
  permissionConfig() { return clone(this.permConfig ?? {}); }
  setPermissionConfig(config) { this.permConfig = clone(config); this.emit(); }
  roster() { return this.users.filter(u => !u.isGM).map(u => ({ id: u.id, name: u.name, role: 1 })); }

  types() {
    const personal = this.users.map(u => ({ userId: u.id, types: this.flags[u.id].types })).filter(p => p.types.length);
    return mergeTypes(clone(this.atlasTypes), clone(personal));
  }
  layers() { return clone(this.atlasLayers); }

  toggleLayer(id) {
    const l = this.atlasLayers.find(x => x.id === id);
    if ( l ) l.visible = l.visible === false;
    else {
      this._hiddenParts ??= new Set();
      if ( this._hiddenParts.has(id) ) this._hiddenParts.delete(id); else this._hiddenParts.add(id);
    }
    this.emit();
  }

  hiddenIds() {
    return new Set([...this.atlasLayers.filter(l => l.visible === false).map(l => l.id), ...(this._hiddenParts ?? [])]);
  }

  setHidden(ids) {
    const h = new Set(ids);
    for ( const l of this.atlasLayers ) l.visible = !h.has(l.id);
    this._hiddenParts = new Set([...h].filter(id => id.startsWith("@")));
    this.emit();
  }

  customPresets() { return clone(this._presets ?? []); }
  setCustomPresets(list) { this._presets = clone(list); this.emit(); }
  prompt(title, value = "") { return Promise.resolve(globalThis.prompt?.(title, value) ?? value); }

  revOf(id) { return this.atlas.get(id)?.system?.rev; }

  async commitOps(ops) {
    if ( this.isGM ) {
      const plan = buildApplyPlan(ops.map(op => ({ ...op, baseRev: this.revOf(op.id) })), id => this.revOf(id), { force: true });
      this._applyPlan(plan);
    } else {
      let d = this.flags[this.me].draft;
      for ( const op of ops ) d = addToDraft(d, { ...op, baseRev: d[op.id]?.baseRev ?? this.revOf(op.id) ?? null });
      this.flags[this.me].draft = d;
    }
    this.emit();
  }

  _applyPlan(plan) {
    for ( const s of [...plan.create, ...plan.update] ) this.atlas.set(s.id, clone(s));
    for ( const id of plan.delete ) this.atlas.delete(id);
  }

  async saveType(type) {
    const { personal, ...clean } = type;
    const list = this.isGM ? this.atlasTypes : this.flags[this.me].types;
    const n = list.findIndex(t => t.id === clean.id);
    if ( n >= 0 ) list[n] = clean; else list.push(clean);
    this.emit();
  }

  async deleteType(id) {
    if ( this.isGM ) this.atlasTypes = this.atlasTypes.filter(t => t.id !== id);
    else this.flags[this.me].types = this.flags[this.me].types.filter(t => t.id !== id);
    this.emit();
  }

  /** Слои атласа целиком (мастер). Видимость у слоя хранит каждый сам, в атлас она не идёт. */
  async setLayers(layers) {
    if ( !this.isGM ) return;
    const vis = new Map(this.atlasLayers.map(l => [l.id, l.visible]));
    this.atlasLayers = layers.map(({ visible, ...l }, i) => ({ ...l, sort: i, visible: vis.get(l.id) ?? true }));
    this.emit();
  }

  /* Черновик и заявки ------------------------------------------------ */

  draftOps() { return this.isGM ? [] : draftOps(this.flags[this.me].draft); }

  async undoDraftOp(id) {
    delete this.flags[this.me].draft[id];
    this.emit();
  }

  async submitDraft({ title = "", note = "" }) {
    const f = this.flags[this.me];
    const ops = draftOps(f.draft);
    if ( !ops.length ) return null;
    const claim = { id: randomId(), sceneId: "s", title: title.trim() || "Заявка", note, ops, status: CLAIM_STATUS.pending, createdAt: Date.now() };
    f.claims.push(claim);
    f.draft = {};
    this.emit();
    return claim;
  }

  claims() {
    const out = [];
    for ( const u of this.users ) {
      for ( const c of this.flags[u.id].claims ) {
        if ( ["pending", "check", "rolled"].includes(c.status) ) out.push({ user: u, claim: clone(c) });
      }
    }
    return out.sort((a, b) => a.claim.createdAt - b.claim.createdAt);
  }

  myClaims() { return clone(this.flags[this.me].claims); }

  conflicts(claim) {
    const out = {};
    for ( const op of claim.ops ) {
      const c = conflictOf(op, this.revOf(op.id));
      if ( c ) out[op.id] = c;
    }
    return out;
  }

  _patch(userId, claimId, patch) {
    const c = this.flags[userId].claims.find(x => x.id === claimId);
    if ( c ) Object.assign(c, patch);
  }

  async applyClaims(entries) {
    let merged = {};
    for ( const { claim } of entries ) for ( const op of claim.ops ) merged = addToDraft(merged, op);
    const ops = draftOps(merged);
    const used = personalTypesUsed(ops, this.types());
    this.atlasTypes.push(...used);
    this._applyPlan(buildApplyPlan(ops, id => this.revOf(id), { force: true }));
    for ( const { user, claim } of entries ) this._patch(user.id, claim.id, { status: "applied" });
    this.emit();
  }

  async rejectClaims(entries, comment) {
    for ( const { user, claim } of entries ) this._patch(user.id, claim.id, { status: "rejected", comment });
    this.emit();
  }

  async requestCheck({ user, claim }) {
    this._patch(user.id, claim.id, { status: "check", difficulty: 3 });
    this.emit();
  }

  async returnToDraft(id) {
    const f = this.flags[this.me];
    const claim = f.claims.find(c => c.id === id);
    if ( !claim ) return;
    for ( const op of claim.ops ) f.draft = addToDraft(f.draft, op);
    f.claims = f.claims.filter(c => c.id !== id);
    this.emit();
  }

  async dropClaim(id) {
    const f = this.flags[this.me];
    f.claims = f.claims.filter(c => c.id !== id);
    this.emit();
  }

  /** Призраки: черновик и открытые заявки игрока, у мастера — заявки на предпросмотре. */
  ghosts(previewIds = []) {
    const base = this.atlasStates();
    const out = [];
    const push = ops => {
      for ( const op of ops ) {
        const state = op.action === "delete" ? base.get(op.id) : op.state;
        if ( state ) out.push({ state: { ...state, id: op.id }, mode: op.action });
      }
    };
    if ( this.isGM ) push(this.claims().filter(e => previewIds.includes(e.claim.id)).flatMap(e => e.claim.ops));
    else {
      const f = this.flags[this.me];
      push(f.claims.filter(c => ["pending", "check", "rolled"].includes(c.status)).flatMap(c => c.ops));
      push(draftOps(f.draft));
    }
    return out;
  }

  activateLayer() {}
  openGuide() { this.log.push(["guide", ""]); }
  openWorldSettings() { this.log.push(["worldSettings", ""]); }
  openAzgaar() { this.log.push(["azgaar", ""]); }
  openGenerator() { this.log.push(["generator", ""]); }
  openAzgaarGenerator() { this.log.push(["azgaarGenerator", ""]); }
  worldInfo() {
    return { dims: { cols: this.grid.cols, rows: this.grid.rows, size: 60 }, world: { baseColor: "#1f3b57", gridColor: "#000000", gridAlpha: 0.15, rough: false }, roughDefault: true, players: 2 };
  }
  applyWorldSettings(values) { this.log.push(["applyWorldSettings", JSON.stringify(values)]); }
  importAzgaarText(text, name, options) { this.log.push(["importAzgaar", JSON.stringify({ name, size: text.length, options })]); return true; }
  generateWorld(options) { this.log.push(["generateWorld", JSON.stringify(options)]); return { stats: {} }; }
  pickFile(cur, cb) { cb("icons/svg/tower.svg"); }
}

/** HexMath → интерфейс сетки студии. */
export function adapter(h) {
  return {
    cellAt: p => h.cellAt(p),
    center: c => h.center(c),
    vertices: c => h.vertices(c),
    neighbors: c => h.neighbors(c),
    inBounds: c => h.inBounds(c),
    get radius() { return h.radius; },
    allCells: () => h.allCells()
  };
}
