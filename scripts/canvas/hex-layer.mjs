/**
 * Слой гекс-мира на холсте Foundry. Рисует мир и передаёт мышь студии.
 * Вся логика инструментов живёт в студии; здесь только перевод событий Foundry.
 */
import { MODULE_ID } from "../constants.mjs";
import HexRenderer from "./hex-renderer.mjs";

const { InteractionLayer } = foundry.canvas.layers;

export const LAYER_NAME = "artarius";

/** Инструменты в группе слева (запасной вход, основной — круглое меню). */
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

function point(event, key = "origin") {
  const p = event?.interactionData?.[key] ?? event?.interactionData?.destination;
  if ( p ) return { x: p.x, y: p.y };
  try { return event.getLocalPosition(canvas.stage); } catch { return canvas.mousePosition; }
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

  /** Группа в панели слева. Видна только на сцене Артария. */
  static prepareSceneControls() {
    const tools = {};
    CONTROL_TOOLS.forEach(([name, icon], order) => {
      tools[name] = { name, order, icon, title: `ART.Tool.${name}` };
    });
    return {
      name: LAYER_NAME,
      order: 2,
      title: "ART.Menu.open",
      icon: "fa-solid fa-dice-d6",
      layer: LAYER_NAME,
      visible: runtime.isWorld(),
      activeTool: "select",
      tools,
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
    this.renderer = new HexRenderer(runtime.backend.grid);
    this.addChild(this.renderer.container);
    this._unsub = runtime.studio.subscribe(what => {
      if ( what === "overlay" ) this.refreshOverlay();
      else this.refresh();
    });
    this.refresh(true);
  }

  /** @override */
  async _tearDown(options) {
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
  /*  Включение                                                     */
  /* ------------------------------------------------------------ */

  /** @override */
  _activate() {
    super._activate?.();
    this._onMove = ev => {
      if ( !runtime.studio?.tool ) return;
      runtime.studio.pointerMove(point(ev));
    };
    canvas.stage.on("pointermove", this._onMove);
    this._onKey = ev => {
      if ( ev.target?.matches?.("input, textarea, select, [contenteditable]") ) return;
      if ( ev.key === "Enter" && runtime.studio?.tool === "line" ) {
        ev.preventDefault();
        runtime.studio.finishLine();
      }
    };
    window.addEventListener("keydown", this._onKey);
    // Слой включили из панели слева: показать инструменты в меню.
    const s = runtime.studio;
    if ( s && !s.tool ) {
      const name = ui.controls?.tool?.name;
      s.setTool(CONTROL_TOOLS.some(([n]) => n === name) ? name : "select", { toggle: false, fromCanvas: true });
    }
  }

  /** @override */
  _deactivate() {
    super._deactivate?.();
    if ( this._onMove ) canvas.stage.off("pointermove", this._onMove);
    if ( this._onKey ) window.removeEventListener("keydown", this._onKey);
    runtime.studio?.layerDeactivated();
  }

  /* ------------------------------------------------------------ */
  /*  Мышь                                                          */
  /* ------------------------------------------------------------ */

  /** @override */
  _onClickLeft(event) {
    const s = runtime.studio;
    if ( !s?.tool ) return;
    s.pointerDown(point(event), mods(event));
    s.pointerUp();
  }

  /** @override */
  _onClickLeft2(event) {
    if ( runtime.studio?.tool === "line" ) runtime.studio.finishLine();
  }

  /** @override */
  _canDragLeftStart(user, event) {
    return !!runtime.studio?.tool;
  }

  /** @override */
  _onDragLeftStart(event) {
    runtime.studio?.pointerDown(point(event, "origin"), { ...mods(event), dragStart: true });
  }

  /** @override */
  _onDragLeftMove(event) {
    runtime.studio?.pointerMove(point(event, "destination"));
  }

  /** @override */
  _onDragLeftDrop(event) {
    const s = runtime.studio;
    if ( !s ) return;
    s.pointerMove(point(event, "destination"));
    s.pointerUp();
  }

  /** @override */
  _onDragLeftCancel(event) {
    runtime.studio?.pointerUp();
  }

  /** @override */
  _onClickRight(event) {
    runtime.studio?.rightClick();
  }

  /** @override */
  _onDismissKey(event) {
    return runtime.studio?.dismiss() ?? false;
  }
}
