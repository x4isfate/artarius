/**
 * Слой гекс-мира на холсте Foundry. Рисует мир и передаёт мышь студии.
 * Вся логика инструментов живёт в студии; здесь только перевод событий Foundry.
 */
import { MODULE_ID } from "../constants.mjs";
import HexRenderer from "./hex-renderer.mjs";

const { InteractionLayer } = foundry.canvas.layers;

export const LAYER_NAME = "artarius";

/** Инструменты в группе Артария в колонке слева. */
const CONTROL_TOOLS = [
  ["select", "fa-solid fa-arrow-pointer"],
  ["zone", "fa-solid fa-draw-polygon"],
  ["mark", "fa-solid fa-location-dot"],
  ["line", "fa-solid fa-route"]
];

/** Модуль кладёт сюда студию и backend при запуске. */
export const runtime = { studio: null, backend: null, isWorld: () => false };

/** Модификаторы клавиш из события PIXI или из клавиатуры Foundry. */
function mods(event) {
  const e = event?.nativeEvent ?? event ?? {};
  const km = game.keyboard;
  const M = foundry.helpers?.interaction?.KeyboardManager?.MODIFIER_KEYS ?? globalThis.KeyboardManager?.MODIFIER_KEYS ?? {};
  const active = k => !!(km?.isModifierActive?.(M[k]));
  return {
    shift: !!(e.shiftKey ?? active("SHIFT")),
    alt: !!(e.altKey ?? active("ALT")),
    ctrl: !!(e.ctrlKey || e.metaKey || active("CONTROL"))
  };
}

/** Точка события в координатах сцены. */
function point(event) {
  try {
    const p = event.getLocalPosition(canvas.stage);
    return { x: p.x, y: p.y };
  } catch {
    const m = canvas.mousePosition ?? { x: 0, y: 0 };
    return { x: m.x, y: m.y };
  }
}

export default class HexLayer extends InteractionLayer {
  constructor() {
    super();
    this.renderer = null;
    this._frame = null;
    this._unsub = null;
  }

  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, { name: LAYER_NAME, zIndex: 180 });
  }

  /**
   * Группа в колонке инструментов слева. Видна только на сцене Артария.
   * Четыре инструмента и кнопки: заявки, ход, генератор (мастер), справка, кнопки расширений.
   */
  static prepareSceneControls() {
    const tools = {};
    CONTROL_TOOLS.forEach(([name, icon], order) => {
      tools[name] = { name, order, icon, title: `ART.Tool.${name}` };
    });
    const gm = !!game.user?.isGM;
    const button = (name, icon, title, order, visible = true) => {
      tools[name] = {
        name, order, icon, title, button: true, visible,
        onChange: () => runtime.buttons?.[name]?.()
      };
    };
    button("queue", "fa-solid fa-scroll", "ART.Queue.title", 10);
    button("turn", "fa-solid fa-hourglass-half", "ART.Turn.title", 11);
    button("generator", "fa-solid fa-mountain-sun", "ART.Gen.title", 12, gm);
    button("guide", "fa-solid fa-circle-question", "ART.Guide.title", 13);
    let order = 20;
    for ( const a of runtime.extraButtons?.() ?? [] ) {
      if ( a.gmOnly && !gm ) continue;
      if ( a.visible && !a.visible() ) continue;
      const name = `x-${a.id}`;
      const ic = String(a.icon ?? "star");
      tools[name] = {
        name, order: order++, title: a.label ?? a.id, button: true,
        icon: ic.includes("fa-") ? ic : `fa-solid fa-${ic}`,
        onChange: () => a.onClick?.()
      };
    }
    return {
      name: LAYER_NAME,
      order: 2,
      title: "ART.Menu.open",
      icon: "fa-solid fa-dice-d6",
      layer: LAYER_NAME,
      visible: runtime.isWorld(),
      activeTool: "select",
      tools,
      onChange: (event, active) => {
        if ( !active ) runtime.studio?.layerDeactivated();
      },
      onToolChange: (event, tool) => {
        if ( tool?.name && runtime.studio && runtime.studio.tool !== tool.name ) {
          runtime.studio.setTool(tool.name, { toggle: false, fromCanvas: true });
        }
      }
    };
  }

  /* ------------------------------------------------------------ */

  /** @override */
  async _draw(options) {
    await super._draw(options);
    if ( !runtime.isWorld() || !runtime.studio ) return;
    // Сетка могла смениться вместе со сценой: кэш центров и вершин сбрасываем до первой отрисовки.
    runtime.backend.grid.reset();
    this.renderer = new HexRenderer(runtime.backend.grid);
    this.addChild(this.renderer.container);
    this._unsub = runtime.studio.subscribe(what => {
      if ( what === "overlay" ) this.refreshOverlay();
      else this.refresh();
    });
    this._listen();
    this.refresh(true);
  }

  /** @override */
  async _tearDown(options) {
    this._unlisten();
    this._unsub?.();
    this._unsub = null;
    if ( this._frame ) cancelAnimationFrame(this._frame);
    this._frame = null;
    if ( this.renderer ) {
      this.removeChild(this.renderer.container);
      this.renderer.destroy();
    }
    this.renderer = null;
    return super._tearDown(options);
  }

  /** Перерисовать всё в следующем кадре. Вызовы в одном кадре склеиваются. */
  refresh(base = false) {
    this._needBase ||= base;
    if ( this._frame ) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      if ( !this.renderer || !runtime.studio ) return;
      try {
        const s = runtime.studio;
        if ( this._needBase ) this.renderer.drawBase(runtime.backend.world());
        this._needBase = false;
        this.renderer.drawData(s.states, s.types, s.layers);
        this.renderer.drawOverlay(s);
      } catch(err) {
        console.error(`${MODULE_ID} | draw`, err);
      }
    });
  }

  refreshOverlay() {
    if ( !this.renderer || !runtime.studio ) return;
    try { this.renderer.drawOverlay(runtime.studio); }
    catch(err) { console.error(`${MODULE_ID} | overlay`, err); }
  }

  /* ------------------------------------------------------------ */
  /*  Мышь                                                          */
  /* ------------------------------------------------------------ */

  /**
   * Мышь ловим сами на canvas.stage, пока на сцене Артария выбран инструмент.
   * Колбэки слоя (_onClickLeft и т. п.) Foundry зовёт не во всех версиях и сборках
   * интерфейса, а события холста приходят всегда.
   */
  _listen() {
    this._unlisten();
    const stage = canvas.stage;
    let down = null;
    let last = null;
    const on = (type, fn) => { stage.on(type, fn); this._listeners.push([type, fn]); };
    this._listeners = [];
    on("pointerdown", ev => {
      const s = runtime.studio;
      if ( !s?.tool || !this._ownsEvent(ev) ) return;
      const p = point(ev);
      if ( ev.button === 2 ) { down = { right: true, x: ev.global.x, y: ev.global.y }; return; }
      if ( ev.button !== 0 ) return;
      // Двойной щелчок линией (тот же инструмент, то же место) заканчивает линию.
      const now = performance.now();
      const dbl = s.tool === "line" && last?.tool === "line" && (now - last.t) < 320
        && Math.hypot(ev.global.x - last.x, ev.global.y - last.y) < 8;
      last = dbl ? null : { t: now, tool: s.tool, x: ev.global.x, y: ev.global.y };
      if ( dbl ) {
        s.finishLine();
        return;
      }
      down = { right: false, x: ev.global.x, y: ev.global.y };
      s.pointerDown(p, mods(ev));
    });
    on("pointermove", ev => {
      const s = runtime.studio;
      if ( !s?.tool ) return;
      s.pointerMove(point(ev));
    });
    const up = ev => {
      const s = runtime.studio;
      const d = down;
      down = null;
      if ( !s?.tool || !d ) return;
      if ( d.right ) {
        // Правая кнопка без протяжки; протяжкой Foundry двигает карту.
        if ( Math.hypot(ev.global.x - d.x, ev.global.y - d.y) < 6 ) s.rightClick();
        return;
      }
      s.pointerUp();
    };
    on("pointerup", up);
    on("pointerupoutside", up);
    this._onKey = ev => {
      if ( ev.target?.matches?.("input, textarea, select, [contenteditable]") ) return;
      if ( !runtime.studio?.tool ) return;
      if ( ev.key === "Enter" && runtime.studio.tool === "line" ) {
        ev.preventDefault();
        runtime.studio.finishLine();
      }
    };
    window.addEventListener("keydown", this._onKey);
  }

  _unlisten() {
    for ( const [type, fn] of this._listeners ?? [] ) canvas.stage?.off(type, fn);
    this._listeners = [];
    if ( this._onKey ) window.removeEventListener("keydown", this._onKey);
    this._onKey = null;
  }

  /** Событие пришло в пустое место холста или в наш слой, а не в токен или окно поверх. */
  _ownsEvent(ev) {
    const t = ev.target;
    if ( !t || t === canvas.stage || t === this ) return true;
    for ( let o = t; o; o = o.parent ) if ( o === this ) return true;
    // Объекты других слоёв (токены, заметки) живут своей жизнью, пока наш слой не активен.
    return !!this.active;
  }

  /* ------------------------------------------------------------ */
  /*  Включение                                                     */
  /* ------------------------------------------------------------ */

  /** @override */
  _activate() {
    super._activate?.();
    // Слой включили из колонки инструментов: показать инструмент.
    const s = runtime.studio;
    if ( s && !s.tool ) {
      const name = ui.controls?.tool?.name;
      s.setTool(CONTROL_TOOLS.some(([n]) => n === name) ? name : "select", { toggle: false, fromCanvas: true });
    }
  }

  /** @override */
  _deactivate() {
    super._deactivate?.();
    runtime.studio?.layerDeactivated();
  }

  /** @override */
  _onDismissKey(event) {
    return runtime.studio?.dismiss() ?? false;
  }
}
