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
  wheel: { icon: "fa-solid fa-dice-d6", width: 240, height: 240, at: () => ({ left: 120, top: 400 }) },
  layers: { icon: "fa-solid fa-layer-group", width: 380, height: 460, at: () => ({ left: Math.max(10, Math.round(window.innerWidth / 2 - 190)), top: Math.max(10, window.innerHeight - 460 - 140) }) }
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
    /**
     * Окна у правого края, вплотную к боковой панели Foundry (макет Б): правая панель по умолчанию.
     * Потянул окно за шапку — оно открепилось; кнопка с булавкой прикрепляет снова.
     */
    this.docked = { right: this._saved().right?.docked ?? true };
    this._onResize = () => { for ( const n of Object.keys(this.docked) ) if ( this.docked[n] ) this._dock(n); };
    window.addEventListener("resize", this._onResize);
  }

  /** Место прикреплённого окна: вся высота, справа до боковой панели Foundry. */
  _dockPos(name) {
    const w = this.windows[name];
    const sb = document.getElementById("sidebar")?.getBoundingClientRect?.();
    const edge = sb && sb.width ? sb.left : window.innerWidth;
    const width = Math.round(w?.position?.width && Number.isFinite(w.position.width) ? w.position.width : (DEFS[name]?.width ?? 360));
    return { left: Math.max(0, Math.round(edge - width - 6)), top: 6, width, height: Math.max(200, window.innerHeight - 12) };
  }

  _dock(name) {
    const w = this.windows[name];
    if ( !w?.rendered ) return;
    this._docking = true;
    try { w.setPosition(this._dockPos(name)); } finally { this._docking = false; }
    w.element?.classList.add("art-docked");
  }

  /** Прикрепить окно к правому краю или открепить. */
  dock(name, on = true) {
    this.docked[name] = !!on;
    this.windows[name]?.element?.classList.toggle("art-docked", !!on);
    if ( on ) this._dock(name);
    this._pending = { ...(this._pending ?? {}), [name]: { ...(this._saved()[name] ?? {}), ...(this._pending?.[name] ?? {}), docked: !!on } };
    this._flushSave();
  }

  isDocked(name) { return !!this.docked[name]; }

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
    // В ApplicationV2 объект position запечатан: лишние ключи (sized, docked) роняют конструктор окна.
    // Из сохранённого берём только место и размер.
    const pos = {};
    for ( const k of ["left", "top", "width", "height"] ) if ( saved[k] !== undefined && saved[k] !== null ) pos[k] = saved[k];
    const position = { width: def.width, height: def.height, ...def.at(), ...pos };
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
          if ( this.docked[name] ) this._dock(name);
        } else if ( this.docked[name] ) this._dock(name);
        else if ( name === "right" && !this.sized.right ) w.setPosition({ height: "auto" });
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
    // Своё перемещение к краю не в счёт; если окно утащили от края — оно открепилось.
    if ( this.docked[name] && !this._docking ) {
      const at = this._dockPos(name);
      if ( Math.abs((position.left ?? at.left) - at.left) > 8 || Math.abs((position.top ?? at.top) - at.top) > 8 ) {
        this.docked[name] = false;
        this.windows[name]?.element?.classList.remove("art-docked");
        this.onDockChange?.(name, false);
      } else return;
    }
    const keep = { left: position.left, top: position.top };
    if ( name !== "right" || this.sized[name] ) Object.assign(keep, { width: position.width, height: position.height });
    if ( this.sized[name] ) keep.sized = true;
    if ( name in this.docked ) keep.docked = !!this.docked[name];
    this._pending = { ...(this._pending ?? {}), [name]: keep };
    this._flushSave();
  }

  _flushSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      const all = { ...this._saved(), ...this._pending };
      this._pending = null;
      game.settings.set(MODULE_ID, "windows", all).catch(() => {});
    }, 500);
  }
}
