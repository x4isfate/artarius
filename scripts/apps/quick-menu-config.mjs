import { MODULE_ID } from "../constants.mjs";
import QuickMenu, { QUICK_ACTIONS, currentItems, resolveItem } from "./quick-menu.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const L = k => (k && game.i18n.has?.(k) ? game.i18n.localize(k) : k);

/**
 * Which buttons the quick menu shows and in what order. Each user keeps their own set.
 * The GM can save their set as the default for everyone who has not changed theirs.
 */
export default class QuickMenuConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;

  static open() {
    QuickMenuConfig.#instance ??= new QuickMenuConfig();
    return QuickMenuConfig.#instance.render({ force: true });
  }

  static DEFAULT_OPTIONS = {
    id: "vmap-quick-config",
    classes: ["vitruvium", "vmap-sheet"],
    tag: "form",
    window: { title: "VMAP.Quick.configure", resizable: true, icon: "fa-solid fa-sliders" },
    position: { width: 440, height: 600 },
    actions: {
      move: QuickMenuConfig.#onMove,
      toggle: QuickMenuConfig.#onToggle,
      addMacro: QuickMenuConfig.#onAddMacro,
      reset: QuickMenuConfig.#onReset,
      saveDefault: QuickMenuConfig.#onSaveDefault
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/quick-menu-config.hbs`, scrollable: [".vmap-scroll"] }
  };

  /** @override */
  async _prepareContext() {
    const items = currentItems();
    const shown = items.map(id => ({ id, def: resolveItem(id) })).filter(x => x.def);
    const row = (id, def, on, index, count) => ({
      id, on, index,
      label: L(def.label),
      icon: def.icon, img: def.img,
      module: def.module && def.module !== MODULE_ID ? (game.modules.get(def.module)?.title ?? def.module) : "",
      first: index === 0, last: index === count - 1
    });
    const rows = shown.map((x, i) => row(x.id, x.def, true, i, shown.length));
    for ( const def of QUICK_ACTIONS.values() ) {
      if ( items.includes(def.id) ) continue;
      const d = resolveItem(def.id);
      if ( d ) rows.push(row(def.id, d, false, -1, 0));
    }
    const macros = game.macros.filter(m => m.canExecute && !items.includes(`macro:${m.uuid}`))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(m => ({ uuid: m.uuid, name: m.name }));
    return { rows, macros, isGM: game.user.isGM };
  }

  async #save(items) {
    const cur = game.settings.get(MODULE_ID, "quickMenu") ?? {};
    await game.settings.set(MODULE_ID, "quickMenu", { ...cur, items });
    QuickMenu.render();
    this.render();
  }

  static #onMove(event, target) {
    const items = currentItems().filter(id => resolveItem(id));
    const i = items.indexOf(target.dataset.id);
    const j = i + Number(target.dataset.dir);
    if ( i < 0 || j < 0 || j >= items.length ) return;
    [items[i], items[j]] = [items[j], items[i]];
    return this.#save(items);
  }

  static #onToggle(event, target) {
    const id = target.dataset.id;
    const items = currentItems().slice();
    return this.#save(items.includes(id) ? items.filter(x => x !== id) : [...items, id]);
  }

  static #onAddMacro() {
    const uuid = this.element.querySelector("[name=macro]")?.value;
    if ( !uuid ) return;
    return this.#save([...currentItems(), `macro:${uuid}`]);
  }

  static async #onReset() {
    const cur = game.settings.get(MODULE_ID, "quickMenu") ?? {};
    await game.settings.set(MODULE_ID, "quickMenu", { ...cur, items: null });
    QuickMenu.render();
    this.render();
  }

  static async #onSaveDefault() {
    if ( !game.user.isGM ) return;
    await game.settings.set(MODULE_ID, "quickMenuDefault", currentItems().slice());
    ui.notifications.info(L("VMAP.Quick.defaultSaved"));
  }
}

