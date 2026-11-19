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

/** Модификаторы клавиш из DOM-события. */
function mods(e = {}) {
  return { shift: !!e.shiftKey, alt: !!e.altKey, ctrl: !!(e.ctrlKey || e.metaKey) };
}

/** Элемент <canvas> Foundry. PIXI 7 зовёт его view, PIXI 8 — canvas. */
export function boardElement() {
  return canvas.app?.canvas ?? canvas.app?.view ?? document.getElementById("board");
}

/**
 * Точка DOM-события в координатах сцены.
 * Глобальные координаты PIXI — это CSS-пиксели относительно элемента холста.
 */
export function scenePoint(ev, el = boardElement()) {
  const r = el.getBoundingClientRect();
  const p = canvas.stage.worldTransform.applyInverse(new PIXI.Point(ev.clientX - r.left, ev.clientY - r.top));
  return { x: p.x, y: p.y };
}

/** Отладка ввода: api.debugInput(true) пишет в консоль каждое нажатие. */
export const inputDebug = { on: false, warned: false };
const dlog = (...args) => { if ( inputDebug.on ) console.log(`${MODULE_ID} | ввод:`, ...args); };

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
   * Четыре инструмента и кнопки: слои, заявки, настройки, генератор (мастер), справка, кнопки расширений.
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
    button("layers", "fa-solid fa-layer-group", "ART.Layer.title", 9);
    button("queue", "fa-solid fa-scroll", "ART.Queue.title", 10);
    button("generator", "fa-solid fa-mountain-sun", "ART.Gen.title", 12, gm);
    button("settings", "fa-solid fa-gear", "ART.Settings.title", 11);
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
        if ( active === false ) runtime.studio?.layerDeactivated();
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
      if ( what === "hover" ) return;
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
        this.renderer.drawData(s.states, s.types, s.layers, runtime.backend.world(), s.view());
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
   * Мышь ловим DOM-событиями элемента <canvas> в фазе перехвата на window.
   * Колбэки слоя и события PIXI на canvas.stage в Foundry 14 (сборка 370) до нас не доходят,
   * а DOM-событие элемента холста приходит при любой раскладке слоёв и тем интерфейса.
   */
  _listen() {
    this._unlisten();
    const el = boardElement();
    if ( !el ) return console.warn(`${MODULE_ID} | нет элемента холста, мышь не подключена`);
    let down = null;
    let last = null;
    const add = (target, type, fn) => {
      target.addEventListener(type, fn, true);
      this._listeners.push([target, type, fn]);
    };
    this._listeners = [];

    // Перехват на window срабатывает раньше всех обработчиков страницы, в том числе PIXI.
    add(window, "pointerdown", ev => {
      if ( ev.target !== el ) return;
      const s = runtime.studio;
      const owned = this._owns();
      dlog(ev.type, { button: ev.button, tool: s?.tool, owned, activeLayer: canvas.activeLayer?.options?.name, control: ui.controls?.control?.name });
      if ( !s ) return;
      // Группа Артария активна, а инструмент студии погас (окно закрыли, Foundry сбросил слой):
      // щелчок по карте снова включает инструмент, выбранный в колонке Foundry, вместо «мёртвого» холста.
      if ( !s.tool && owned && ev.button === 0 ) this._restoreTool();
      if ( !s.tool ) return;
      if ( !owned ) {
        if ( !inputDebug.warned && ev.button === 0 ) {
          inputDebug.warned = true;
          console.warn(`${MODULE_ID} | инструмент «${s.tool}» выбран, но активна не группа Артария (${ui.controls?.control?.name ?? "?"}). Щелчок отдан Foundry.`);
        }
        return;
      }
      const p = scenePoint(ev, el);
      if ( ev.button === 2 ) { down = { right: true, x: ev.clientX, y: ev.clientY }; return; }
      if ( ev.button !== 0 ) return;
      // Двойной щелчок линией (тот же инструмент, то же место) заканчивает линию.
      const now = performance.now();
      const dbl = s.tool === "line" && last?.tool === "line" && (now - last.t) < 320
        && Math.hypot(ev.clientX - last.x, ev.clientY - last.y) < 8;
      last = dbl ? null : { t: now, tool: s.tool, x: ev.clientX, y: ev.clientY };
      down = { right: false, x: ev.clientX, y: ev.clientY };
      dlog("точка", p, "гекс", runtime.backend?.grid.cellAt(p));
      try {
        if ( dbl ) s.finishLine();
        else if ( s.pointerDown(p, mods(ev)) === "grab" ) {
          // Метку взяли мышью: Foundry не должен начинать свою протяжку (рамку выделения).
          ev.stopPropagation();
          ev.preventDefault();
        }
      } catch(err) {
        console.error(`${MODULE_ID} | щелчок`, err);
      }
    });

    add(window, "pointermove", ev => {
      const s = runtime.studio;
      if ( !s?.tool || !this._owns() ) return;
      if ( ev.target !== el && !down ) {
        // Курсор ушёл с холста на окно: подсветку гекса снять.
        if ( s.hover ) s.pointerMove({ x: -1e9, y: -1e9 });
        return;
      }
      try { s.pointerMove(scenePoint(ev, el)); }
      catch(err) { console.error(`${MODULE_ID} | мышь`, err); }
    });

    add(window, "pointerup", ev => {
      const s = runtime.studio;
      const d = down;
      down = null;
      if ( !s?.tool || !d ) return;
      if ( d.right ) {
        // Правая кнопка без протяжки; протяжкой Foundry двигает карту.
        if ( Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 6 ) s.rightClick(scenePoint(ev, el));
        return;
      }
      s.pointerUp();
    });

    add(window, "keydown", ev => {
      if ( ev.target?.matches?.("input, textarea, select, [contenteditable]") ) return;
      if ( !runtime.studio?.tool ) return;
      if ( (ev.ctrlKey || ev.metaKey) && ev.code === "KeyZ" && runtime.studio.lastDeleted ) {
        // Ctrl+Z после удаления метки правой кнопкой возвращает её; остальное Ctrl+Z — у Foundry.
        ev.preventDefault();
        ev.stopPropagation();
        runtime.studio.restoreDeleted();
        return;
      }
      if ( ev.key === "Enter" && runtime.studio.tool === "line" ) {
        ev.preventDefault();
        runtime.studio.finishLine();
      }
    });
    dlog("подключено к", el);
  }

  _unlisten() {
    for ( const [target, type, fn] of this._listeners ?? [] ) target.removeEventListener(type, fn, true);
    this._listeners = [];
  }

  /** Мышь наша, когда в колонке слева выбрана группа Артария (или наш слой активен). */
  _owns() {
    return !!(this.active || canvas.activeLayer === this || ui.controls?.control?.name === LAYER_NAME);
  }

  /* ------------------------------------------------------------ */
  /*  Включение                                                     */
  /* ------------------------------------------------------------ */

  /** @override */
  _activate() {
    super._activate?.();
    // Слой включили из колонки инструментов: показать инструмент.
    if ( runtime.studio && !runtime.studio.tool ) this._restoreTool();
  }

  /** Включить инструмент студии по кнопке, выбранной в колонке Foundry («Осмотр», если не наша). */
  _restoreTool() {
    const name = ui.controls?.tool?.name;
    runtime.studio?.setTool(CONTROL_TOOLS.some(([n]) => n === name) ? name : "select", { toggle: false, fromCanvas: true });
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
