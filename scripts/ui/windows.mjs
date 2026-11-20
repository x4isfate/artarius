/**
 * Части интерфейса Артария в окнах Foundry. Окна обычные (ApplicationV2): двигаются,
 * растягиваются, сворачиваются, темы интерфейса вроде Carolingian UI оформляют их
 * как свои. Место и размер окна каждый пользователь хранит у себя.
 *
 * Содержимое окна — живой элемент панели: окно его только носит, перерисовывает
 * панель сама. Поэтому _renderHTML отдаёт тот же элемент, а не новую разметку.
 */
import { MODULE_ID } from "../constants.mjs";

const { ApplicationV2 } = foundry.applications.api;

/** Окна по частям: заголовок, значок, размер по умолчанию. */
const DEFS = {
  left: { icon: "fa-solid fa-dice-d6", width: 440, height: 560, at: () => ({ left: 120, top: 80 }) },
  right: { icon: "fa-solid fa-hexagon", width: 340, height: "auto", at: () => ({ left: Math.max(120, window.innerWidth - 760), top: 80 }) },
  settings: { icon: "fa-solid fa-gear", width: 620, height: 600, at: () => ({ left: Math.max(120, (window.innerWidth - 620) / 2), top: 70 }) },
  wheel: { icon: "fa-solid fa-dice-d6", width: 240, height: 240, at: () => ({ left: 120, top: 400 }) }
};

/** Окно, которое носит часть панели. Своих полей с именами ApplicationV2 не заводит. */
class PartWindow extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    classes: ["artarius-part"],
    window: { resizable: true, minimizable: true },
    position: { width: 320, height: "auto" }
  };

  constructor(partName, partEl, host, options) {
    super(options);
    this.artPart = partName;
    this.artEl = partEl;
    this.artHost = host;
  }

  /** @override */
  async _renderHTML() {
    return this.artEl;
  }

  /** @override */
  _replaceHTML(result, content) {
    if ( result.parentElement !== content ) content.replaceChildren(result);
  }

  /** @override */
  _onRender(context, options) {
    super._onRender?.(context, options);
    // Окно гекса подстраивается под содержимое, пока его не потянули за угол; потом держит размер пользователя.
    this.element?.classList.toggle("art-sized", !!this.artHost.sized[this.artPart]);
    const handle = this.element?.querySelector(".window-resize-handle");
    if ( handle && !handle.dataset.artBound ) {
      handle.dataset.artBound = "1";
      handle.addEventListener("pointerdown", () => this.artHost._userSized(this.artPart), { capture: true });
    }
  }

  /** @override */
  _onClose(options) {
    super._onClose?.(options);
    this.artHost._closed(this.artPart);
  }

  /** @override */
  _onPosition(position) {
    super._onPosition?.(position);
    this.artHost._moved(this.artPart, position);
  }
}

export default class FoundryHost {
  /** Круглого меню в Foundry нет: инструменты в колонке слева. */
  wheel = false;

  constructor({ onClose } = {}) {
    this.onClose = onClose;
    this.windows = {};
    this.titles = {};
    this.hidden = false;
    this._closing = new Set();
    this._want = {};
    this._busy = {};
    this._saveTimer = null;
    /** Окна, размер которых пользователь задал сам (окно гекса тогда не подстраивается под содержимое). */
    this.sized = {};
  }

  _userSized(name) {
    this.sized[name] = true;
    this.windows[name]?.element?.classList.add("art-sized");
  }

  _saved() {
    try { return game.settings.get(MODULE_ID, "windows") ?? {}; } catch { return {}; }
  }

  attach(name, el) {
    const def = DEFS[name] ?? DEFS.left;
    // Стили панелей висят на .artarius: класс на самой части, а не на окне, чтобы не задеть рамку окна.
    el.classList.add("artarius");
    const saved = this._saved()[name] ?? {};
    const position = { width: def.width, height: def.height, ...def.at(), ...saved };
    // Ход и подробности гекса — по содержимому. Старый сохранённый размер окна гекса (до 0.6 оно было на полэкрана) не берём.
    if ( name === "right" && !saved.sized ) {
      position.height = "auto";
      position.width = Math.min(position.width ?? def.width, 420);
    }
    if ( saved.sized ) this.sized[name] = true;
    this.windows[name] = new PartWindow(name, el, this, {
      id: `${MODULE_ID}-${name}`,
      classes: ["artarius-part", `artarius-part-${name}`],
      window: { title: "Artarius", icon: def.icon, resizable: true },
      position
    });
  }

  /** Показать или спрятать окно. Вызовы склеиваются: окно догоняет последнее желаемое состояние. */
  show(name, on, { title } = {}) {
    if ( !this.windows[name] ) return;
    this._want[name] = on && !this.hidden ? (title || "Artarius") : null;
    this._pump(name);
  }

  async _pump(name) {
    if ( this._busy[name] ) return;
    this._busy[name] = true;
    const w = this.windows[name];
    try {
      for ( let k = 0; k < 4; k++ ) {
        const want = this._want[name];
        if ( want === null ) {
          if ( w.rendered ) {
            this._closing.add(name);
            await w.close({ animate: false });
          }
        } else if ( !w.rendered || this.titles[name] !== want ) {
          this.titles[name] = want;
          w.options.window.title = want;
          await w.render({ force: true, window: { title: want } });
        } else if ( name === "right" && !this.sized.right ) w.setPosition({ height: "auto" });
        if ( this._want[name] === want ) break;
      }
    } catch(err) {
      console.error(`${MODULE_ID} | window ${name}`, err);
    } finally {
      this._busy[name] = false;
    }
  }

  setHidden(hidden) {
    this.hidden = hidden;
    if ( hidden ) for ( const name of Object.keys(this.windows) ) this.show(name, false);
  }

  _closed(name) {
    this.titles[name] = null;
    if ( this._closing.delete(name) ) return;
    this.onClose?.(name);
  }

  /** Запомнить место окна. Пишем не чаще раза в полсекунды: при перетаскивании событий много. */
  _moved(name, position) {
    const keep = { left: position.left, top: position.top };
    if ( name !== "right" || this.sized[name] ) Object.assign(keep, { width: position.width, height: position.height });
    if ( this.sized[name] ) keep.sized = true;
    this._pending = { ...(this._pending ?? {}), [name]: keep };
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      const all = { ...this._saved(), ...this._pending };
      this._pending = null;
      game.settings.set(MODULE_ID, "windows", all).catch(() => {});
    }, 500);
  }
}
