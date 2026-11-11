import { MODULE_ID, CLAIM_STATUS } from "../constants.mjs";
import { getClaims, getDraft } from "../data/store.mjs";

/**
 * Quick menu in the bottom-left corner. Always on screen, not tied to the map layer.
 * Buttons come from a registry: Artarius registers its own, add-on modules add theirs
 * through api.registerQuickAction. Each user picks and orders buttons; the GM can set
 * the default set for everyone. Macros can be added as buttons too ("macro:<uuid>").
 */

/** id → { id, label, icon, onClick, gmOnly, badge?, active?, visible?, module? } */
export const QUICK_ACTIONS = new Map();

const OPEN = [CLAIM_STATUS.pending, CLAIM_STATUS.check, CLAIM_STATUS.rolled];
const L = k => (k && game.i18n.has?.(k) ? game.i18n.localize(k) : k);
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const api = () => game.modules.get(MODULE_ID).api;

export const DEFAULT_ITEMS = ["layer", "object", "line", "area", "claims", "find", "atlas", "azgaar", "guide"];

/** Register a button. Returns the stored definition. */
export function registerQuickAction(def) {
  if ( !def?.id || typeof def.onClick !== "function" ) throw new Error(`${MODULE_ID} | quick action needs id and onClick`);
  const stored = { gmOnly: false, icon: "fa-solid fa-circle", label: def.id, ...def };
  QUICK_ACTIONS.set(def.id, stored);
  QuickMenu.render();
  return stored;
}

export function unregisterQuickAction(id) {
  QUICK_ACTIONS.delete(id);
  QuickMenu.render();
}

const toolAction = (id, icon) => ({
  id, icon, label: `VMAP.Tool.${id}`,
  onClick: () => api().activateLayer(id),
  active: () => {
    const layer = api().layer();
    return !!layer?.active && layer.tool === id;
  }
});

/** Artarius's own buttons. Called once on init. */
export function registerBuiltInActions() {
  registerQuickAction({
    id: "layer", icon: "fa-solid fa-map-location-dot", label: "VMAP.Quick.layer",
    onClick: () => api().activateLayer("select"),
    active: () => !!api().layer()?.active
  });
  registerQuickAction(toolAction("object", "fa-solid fa-location-dot"));
  registerQuickAction(toolAction("line", "fa-solid fa-route"));
  registerQuickAction(toolAction("area", "fa-solid fa-draw-polygon"));
  registerQuickAction(toolAction("erase", "fa-solid fa-eraser"));
  registerQuickAction({
    id: "claims", icon: "fa-solid fa-scroll", label: "VMAP.Tool.claims",
    onClick: () => api().openClaims(),
    badge: () => {
      if ( game.user.isGM ) return game.users.reduce((n, u) => n + getClaims(u).filter(c => OPEN.includes(c.status)).length, 0);
      return canvas?.scene ? Object.keys(getDraft(game.user, canvas.scene.id)).length : 0;
    }
  });
  registerQuickAction({ id: "find", icon: "fa-solid fa-magnifying-glass-location", label: "VMAP.Quick.find", onClick: () => api().findFeature() });
  registerQuickAction({ id: "atlas", icon: "fa-solid fa-swatchbook", label: "VMAP.Tool.atlas", gmOnly: true, onClick: () => api().openAtlasConfig() });
  registerQuickAction({ id: "azgaar", icon: "fa-solid fa-earth-europe", label: "VMAP.Azgaar.title", gmOnly: true, onClick: () => api().openAzgaar() });
  registerQuickAction({ id: "guide", icon: "fa-solid fa-circle-question", label: "VMAP.Tool.guide", onClick: () => api().openGuide() });
}

/** Ids of buttons this user sees, in order. */
export function currentItems() {
  const own = game.settings.get(MODULE_ID, "quickMenu")?.items;
  const def = game.settings.get(MODULE_ID, "quickMenuDefault");
  return Array.isArray(own) ? own : (Array.isArray(def) && def.length ? def : DEFAULT_ITEMS);
}

/** Resolve an item id to a button description, or null if it should not show. */
export function resolveItem(id) {
  if ( id.startsWith("macro:") ) {
    const macro = fromUuidSync(id.slice(6));
    if ( !macro || !macro.canExecute ) return null;
    return { id, icon: null, img: macro.img, label: macro.name, onClick: () => macro.execute() };
  }
  const def = QUICK_ACTIONS.get(id);
  if ( !def ) return null;
  if ( def.gmOnly && !game.user.isGM ) return null;
  try {
    if ( def.visible && !def.visible() ) return null;
  } catch(err) { console.error(`${MODULE_ID} | quick action ${id}`, err); return null; }
  return def;
}

export default class QuickMenu {
  static el = null;
  static #frame = null;

  /** Redraw on the next frame; calls within one frame merge. */
  static render() {
    if ( !game.ready || QuickMenu.#frame ) return;
    QuickMenu.#frame = requestAnimationFrame(() => {
      QuickMenu.#frame = null;
      QuickMenu.#draw();
    });
  }

  static #mount() {
    if ( QuickMenu.el?.isConnected ) return QuickMenu.el;
    const el = document.createElement("nav");
    el.id = "artarius-quick-menu";
    el.className = "vitruvium vmap-quick";
    el.addEventListener("click", ev => QuickMenu.#onClick(ev));
    const players = document.getElementById("players");
    if ( players?.parentElement ) {
      el.classList.add("docked");
      players.before(el);
    } else {
      el.classList.add("floating");
      (document.getElementById("interface") ?? document.body).appendChild(el);
    }
    QuickMenu.el = el;
    return el;
  }

  static #draw() {
    const el = QuickMenu.#mount();
    const collapsed = !!game.settings.get(MODULE_ID, "quickMenu")?.collapsed;
    el.classList.toggle("collapsed", collapsed);
    const parts = [];
    parts.push(`<button type="button" class="vmap-qm-btn vmap-qm-toggle" data-qm="toggle" data-tooltip="${esc(L(collapsed ? "VMAP.Quick.expand" : "VMAP.Quick.collapse"))}">
      <i class="fa-solid ${collapsed ? "fa-angles-right" : "fa-angles-left"}"></i></button>`);
    if ( !collapsed ) {
      for ( const id of currentItems() ) {
        const def = resolveItem(id);
        if ( !def ) continue;
        let badge = null, active = false;
        try {
          badge = def.badge?.() ?? null;
          active = !!def.active?.();
        } catch(err) { console.error(`${MODULE_ID} | quick action ${id}`, err); }
        const icon = def.img ? `<img src="${esc(def.img)}" alt="">` : `<i class="${esc(def.icon)}"></i>`;
        const b = badge ? `<span class="vmap-qm-badge">${esc(badge)}</span>` : "";
        parts.push(`<button type="button" class="vmap-qm-btn ${active ? "active" : ""}" data-qm="${esc(id)}" data-tooltip="${esc(L(def.label))}" aria-label="${esc(L(def.label))}">${icon}${b}</button>`);
      }
      parts.push(`<button type="button" class="vmap-qm-btn vmap-qm-config" data-qm="config" data-tooltip="${esc(L("VMAP.Quick.configure"))}"><i class="fa-solid fa-sliders"></i></button>`);
    }
    el.innerHTML = parts.join("");
  }

  static async #onClick(ev) {
    const id = ev.target.closest("[data-qm]")?.dataset.qm;
    if ( !id ) return;
    ev.preventDefault();
    if ( id === "toggle" ) {
      const cur = game.settings.get(MODULE_ID, "quickMenu") ?? {};
      await game.settings.set(MODULE_ID, "quickMenu", { ...cur, collapsed: !cur.collapsed });
      return QuickMenu.render();
    }
    if ( id === "config" ) return api().openQuickMenuConfig();
    const def = resolveItem(id);
    if ( !def ) return;
    await def.onClick(ev);
    QuickMenu.render();
  }
}
