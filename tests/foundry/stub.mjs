/**
 * Поддельный Foundry 14 для дымового теста: ровно столько API, сколько трогает модуль.
 * Документы держат _source и флаги, обновления идут через expandObject и зовут хуки
 * как настоящий Foundry. Сетка — HexMath с интерфейсом canvas.grid (HEXODDR).
 * PIXI настоящий (pixi.js 7), его грузит страница до этого файла.
 */
import HexMath from "../../scripts/hex/hexmath.mjs";

/* Хуки ---------------------------------------------------------------- */

const hooks = new Map();
const add = (name, fn, once) => {
  if ( !hooks.has(name) ) hooks.set(name, []);
  hooks.get(name).push({ fn, once });
};
export const pending = [];
globalThis.Hooks = {
  on: (n, fn) => add(n, fn, false),
  once: (n, fn) => add(n, fn, true),
  callAll(n, ...args) {
    for ( const h of [...(hooks.get(n) ?? [])] ) {
      if ( h.once ) hooks.set(n, hooks.get(n).filter(x => x !== h));
      const r = h.fn(...args);
      if ( r instanceof Promise ) pending.push(r);
    }
    return true;
  },
  call(n, ...args) {
    for ( const h of [...(hooks.get(n) ?? [])] ) if ( h.fn(...args) === false ) return false;
    return true;
  }
};

/* Утилиты ------------------------------------------------------------- */

const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const getProperty = (o, k) => String(k).split(".").reduce((a, p) => a?.[p], o);
const setProperty = (o, k, v) => {
  const parts = String(k).split(".");
  let a = o;
  for ( const p of parts.slice(0, -1) ) a = (isObj(a[p]) ? a[p] : (a[p] = {}));
  a[parts.at(-1)] = v;
};
const expandObject = o => {
  const out = {};
  for ( const [k, v] of Object.entries(o) ) setProperty(out, k, isObj(v) ? expandObject(v) : v);
  return out;
};
function mergeObject(target, src, { inplace = true, recursive = true } = {}) {
  const t = inplace ? target : structuredClone(target);
  for ( const [k, v] of Object.entries(src ?? {}) ) {
    if ( recursive && isObj(v) && isObj(t[k]) ) mergeObject(t[k], v, { inplace: true, recursive });
    else t[k] = isObj(v) || Array.isArray(v) ? structuredClone(v) : v;
  }
  return t;
}
let idn = 0;
const randomID = () => `id${(++idn).toString().padStart(14, "0")}`;

class Color {
  constructor(n) { this.n = n; }
  static from(v) {
    if ( typeof v === "number" ) return new Color(v);
    const s = String(v ?? "#000").replace("#", "");
    const full = s.length === 3 ? s.split("").map(c => c + c).join("") : s.slice(0, 6);
    return new Color(parseInt(full || "0", 16) || 0);
  }
  valueOf() { return this.n; }
  get css() { return `#${this.n.toString(16).padStart(6, "0")}`; }
  toString() { return this.css; }
}

/* Документы ----------------------------------------------------------- */

class Collection extends Map {
  get contents() { return [...this.values()]; }
  filter(fn) { return this.contents.filter(fn); }
  find(fn) { return this.contents.find(fn); }
  map(fn) { return this.contents.map(fn); }
  some(fn) { return this.contents.some(fn); }
  [Symbol.iterator]() { return this.values(); }
}

class Doc {
  static documentName = "Document";
  constructor(data, parent = null) {
    this._source = structuredClone({ flags: {}, ...data });
    this._source._id ??= randomID();
    this.parent = parent;
    this._sync();
  }
  get id() { return this._source._id; }
  get documentName() { return this.constructor.documentName; }
  _sync() {
    for ( const [k, v] of Object.entries(this._source) ) {
      if ( k === "_id" ) continue;
      try { this[k] = v; } catch { /* свойство только для чтения */ }
    }
  }
  getFlag(scope, key) { return structuredClone(getProperty(this._source.flags?.[scope], key)); }
  async setFlag(scope, key, value) { return this.update({ [`flags.${scope}.${key}`]: value }); }
  async update(diff, options = {}) {
    const changes = expandObject(diff);
    delete changes._id;
    mergeObject(this._source, changes, { recursive: options.recursive !== false });
    this._sync();
    Hooks.callAll(`update${this.documentName}`, this, changes, options, game.user.id);
    return this;
  }
}

class Page extends Doc {
  static documentName = "JournalEntryPage";
  get system() { return this._source.system; }
  set system(v) { /* берётся из _source */ }
}

class Journal extends Doc {
  static documentName = "JournalEntry";
  constructor(data) {
    const pages = data.pages ?? [];
    super({ ...data, pages: undefined });
    this.pages = new Collection();
    for ( const p of pages ) this.pages.set(p._id, new Page(p, this));
  }
  _sync() {
    for ( const [k, v] of Object.entries(this._source) ) {
      if ( k === "_id" || k === "pages" ) continue;
      try { this[k] = v; } catch { /* свойство только для чтения */ }
    }
  }
  async createEmbeddedDocuments(name, list) {
    const out = list.map(d => {
      const p = new Page(d, this);
      this.pages.set(p.id, p);
      return p;
    });
    for ( const p of out ) Hooks.callAll("createJournalEntryPage", p, {}, game.user.id);
    return out;
  }
  async updateEmbeddedDocuments(name, list, options = {}) {
    const out = [];
    for ( const d of list ) {
      const p = this.pages.get(d._id);
      if ( !p ) throw new Error(`no page ${d._id}`);
      out.push(await p.update(d, options));
    }
    return out;
  }
  async deleteEmbeddedDocuments(name, ids) {
    for ( const id of ids ) {
      const p = this.pages.get(id);
      this.pages.delete(id);
      if ( p ) Hooks.callAll("deleteJournalEntryPage", p, {}, game.user.id);
    }
    return ids;
  }
}

class User extends Doc {
  static documentName = "User";
  get isGM() { return this._source.role >= 4; }
  get isSelf() { return this === game.user; }
  get color() { return Color.from(this._source.color ?? "#888888"); }
}

class Scene extends Doc {
  static documentName = "Scene";
  async view() { this.viewed = true; return this; }
}

class ChatMessage extends Doc { static documentName = "ChatMessage"; }

const created = { scenes: [], messages: [] };
export { created, Journal, Scene, User, Page };

globalThis.JournalEntry = { implementation: { create: async data => {
  const j = new Journal(data);
  game.journal.set(j.id, j);
  Hooks.callAll("createJournalEntry", j, {}, game.user.id);
  return j;
} } };
globalThis.Scene = { implementation: { create: async data => {
  const s = new Scene(data);
  game.scenes.set(s.id, s);
  created.scenes.push(s);
  return s;
} } };
globalThis.ChatMessage = { implementation: { create: async data => {
  const m = new ChatMessage(data);
  created.messages.push(m);
  return m;
} } };
globalThis.JournalEntryPage = Page;

/* Сетка ------------------------------------------------------------- */

export function makeGrid({ size = 100, rows = 10, cols = 14 } = {}) {
  const hm = new HexMath({ size: size * 2 / Math.sqrt(3), rows, cols });
  return {
    hm,
    type: 2,
    size,
    getOffset: ({ x, y }) => { const [i, j] = hm.cellAt({ x, y }); return { i, j }; },
    getCenterPoint: ({ i, j }) => hm.center([i, j]),
    getVertices: ({ i, j }) => hm.vertices([i, j]),
    getOffsetRange: () => [0, 0, rows, cols],
    rect: { x: 0, y: 0, width: hm.width, height: hm.height }
  };
}

/* foundry.* ----------------------------------------------------------- */

const field = kind => class { constructor(...a) { this.kind = kind; this.args = a; } };
const fields = Object.fromEntries(["SchemaField", "StringField", "NumberField", "ArrayField", "ObjectField", "BooleanField", "HTMLField", "DocumentIdField", "ForeignDocumentField", "SetField"].map(k => [k, field(k)]));

class ApplicationV2 {
  static DEFAULT_OPTIONS = {};
  constructor(options = {}) {
    // Как в Foundry v14: position запечатан, Object.assign с чужим ключом бросает TypeError.
    const position = Object.seal({ top: null, left: null, width: null, height: null, scale: 1, zIndex: null });
    Object.assign(position, options.position ?? {});
    this.options = { ...options, window: { ...(options.window ?? {}) }, position };
    this.rendered = false;
  }
  get element() { return this._el ?? null; }
  get form() { return this.element?.querySelector("form") ?? null; }
  get title() { return this.options.window.title ?? ""; }
  async render(options = {}) {
    if ( options.window?.title ) this.options.window.title = options.window.title;
    const html = await this._renderHTML?.({}, options);
    if ( !this._el ) {
      this._el = document.createElement("div");
      this._el.className = ["application", ...(this.options.classes ?? [])].join(" ");
      if ( this.options.id ) this._el.id = this.options.id;
      this._el.innerHTML = '<header class="window-header"><h1 class="window-title"></h1></header><section class="window-content"></section>';
    }
    this._el.querySelector(".window-title").textContent = this.title;
    if ( !this._el.isConnected ) document.body.appendChild(this._el);
    if ( html ) this._replaceHTML?.(html, this._el.querySelector(".window-content"), options);
    this.rendered = true;
    return this;
  }
  get position() { return this.options.position; }
  setPosition(p = {}) { Object.assign(this.options.position, p); this._onPosition?.(this.options.position); return this.options.position; }
  async close() {
    this.rendered = false;
    this._el?.remove();
    this._onClose?.({});
    return this;
  }
}

export const dialogs = [];
class DialogV2 extends ApplicationV2 {
  static async prompt(o) { dialogs.push(["prompt", o]); return null; }
  static async confirm(o) { dialogs.push(["confirm", o]); return true; }
}

class InteractionLayer extends PIXI.Container {
  static get layerOptions() { return { name: "", zIndex: 0 }; }
  async draw(options = {}) { await this._tearDown(options); await this._draw(options); return this; }
  async _draw() {}
  async _tearDown() { this.removeChildren(); }
  activate({ tool } = {}) { this.active = true; this._activate(); return this; }
  deactivate() { this.active = false; this._deactivate(); return this; }
  _activate() {}
  _deactivate() {}
}

class HexagonalGrid {
  constructor({ size, columns }) {
    this.size = size;
    this.sizeX = columns ? size * 2 / Math.sqrt(3) : size;
    this.sizeY = columns ? size : size * 2 / Math.sqrt(3);
  }
}
class SquareGrid {
  constructor({ size }) { this.size = size; }
  getCenterPoint({ i, j }) { return { x: (j + 0.5) * this.size, y: (i + 0.5) * this.size }; }
}

class PreciseText extends PIXI.Text {
  static getTextStyle(o = {}) { return new PIXI.TextStyle(o); }
}

globalThis.foundry = {
  utils: {
    deepClone: v => (v === undefined ? v : structuredClone(v)), mergeObject, getProperty, setProperty, expandObject,
    hasProperty: (o, k) => getProperty(o, k) !== undefined, randomID, Color,
    escapeHTML: s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    isNewerVersion: (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }) > 0
  },
  abstract: { TypeDataModel: class { static defineSchema() { return {}; } } },
  data: { fields },
  applications: {
    api: { ApplicationV2, DialogV2, HandlebarsApplicationMixin: B => class extends B {} },
    apps: {
      DocumentSheetConfig: { registerSheet: (...a) => { globalThis.__sheets = a; } },
      FilePicker: class { static implementation = null; constructor(o) { this.o = o; } render() { return this; } }
    },
    sheets: { journal: { JournalEntryPageHandlebarsSheet: class extends ApplicationV2 { static EDIT_PARTS = {}; } } },
    handlebars: { renderTemplate: async () => "" },
    ux: { TextEditor: { implementation: { enrichHTML: async s => s } } }
  },
  canvas: {
    layers: { InteractionLayer },
    containers: { PreciseText },
    getTexture: () => null,
    loadTexture: async () => null
  },
  grid: { HexagonalGrid, SquareGrid }
};

globalThis.CONFIG = { JournalEntryPage: { dataModels: {} }, Canvas: { layers: {} } };
globalThis.CONST = {
  GRID_TYPES: { GRIDLESS: 0, SQUARE: 1, HEXODDR: 2, HEXEVENR: 3, HEXODDQ: 4, HEXEVENQ: 5 },
  DOCUMENT_OWNERSHIP_LEVELS: { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 },
  JOURNAL_ENTRY_PAGE_FORMATS: { HTML: 1, MARKDOWN: 2 }
};

/* game, ui, canvas ------------------------------------------------------ */

export const controlCalls = [];
export const notes = [];

export async function makeGame(lang) {
  const settings = new Map();
  const values = new Map();
  const get = (o, k) => getProperty(o, k);
  const gm = new User({ _id: "gm", name: "Мастер", role: 4, color: "#ff8800" });
  const p1 = new User({ _id: "p1", name: "Огонь", role: 1, color: "#cc3333" });
  const p2 = new User({ _id: "p2", name: "Вода", role: 1, color: "#3366cc" });
  const users = new Collection([[gm.id, gm], [p1.id, p1], [p2.id, p2]]);
  globalThis.game = {
    user: gm,
    users,
    journal: new Collection(),
    scenes: new Collection(),
    actors: new Collection(),
    keyboard: null,
    socket: { on() {}, emit() {} },
    i18n: {
      has: k => typeof get(lang, k) === "string",
      localize: k => (typeof get(lang, k) === "string" ? get(lang, k) : k),
      format: (k, d = {}) => String(typeof get(lang, k) === "string" ? get(lang, k) : k).replace(/\{(\w+)\}/g, (m, n) => d[n] ?? m)
    },
    settings: {
      register: (scope, key, data) => { settings.set(key, data); if ( !values.has(key) ) values.set(key, structuredClone(data.default)); },
      get: (scope, key) => {
        if ( !settings.has(key) ) throw new Error(`setting ${key} is not registered`);
        return structuredClone(values.get(key));
      },
      set: async (scope, key, v) => {
        if ( !settings.has(key) ) throw new Error(`setting ${key} is not registered`);
        values.set(key, structuredClone(v));
        settings.get(key).onChange?.(v);
        return v;
      }
    },
    modules: new Map([["artarius", { id: "artarius", version: "0.3.0", active: true }]])
  };
  globalThis.ui = {
    notifications: {
      info: (t) => notes.push(["info", t]), warn: (t) => notes.push(["warn", t]), error: (t) => notes.push(["error", t])
    },
    controls: {
      controls: { tokens: {}, artarius: {} },
      control: null,
      tool: null,
      render() {},
      activate(o) { controlCalls.push(o); this.control = { name: o.control }; this.tool = { name: o.tool }; }
    }
  };
  return { gm, p1, p2 };
}

export function makeCanvas(scene, grid) {
  globalThis.canvas = {
    ready: true,
    scene,
    grid,
    dimensions: { sceneRect: grid.rect },
    stage: (() => {
      // Камера сдвинута и уменьшена, чтобы перевод координат щелчка проверялся по-настоящему.
      const st = new PIXI.Container();
      st.scale.set(0.5);
      st.position.set(30, 20);
      st.transform.updateTransform(PIXI.Transform.IDENTITY);
      return st;
    })(),
    app: { view: (() => {
      const el = document.createElement("canvas");
      el.id = "board";
      el.width = 1400; el.height = 900;
      el.style.cssText = "position:fixed;left:0;top:0;width:1400px;height:900px;z-index:0";
      document.body.prepend(el);
      return el;
    })() },
    activeLayer: null,
    mousePosition: { x: 0, y: 0 },
    animatePan: o => { globalThis.canvas.panned = o; },
    draw: async () => { globalThis.canvas.redrawn = (globalThis.canvas.redrawn ?? 0) + 1; },
    tokens: { activate() {} }
  };
  return globalThis.canvas;
}

/** Дождаться асинхронных обработчиков хуков и микрошагов. */
export async function settle() {
  for ( let k = 0; k < 5; k++ ) {
    const list = pending.splice(0);
    await Promise.all(list);
    await new Promise(r => setTimeout(r, 0));
  }
}
