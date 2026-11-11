import { MODULE_ID, FEATURE_TYPE } from "../constants.mjs";
import { getAtlas, ensureAtlas, getTypes, getLayers, setTypes, setLayers, applyPlan } from "../data/store.mjs";
import { AZGAAR_URL, AZGAAR_PARTS, validateAzgaar, buildAzgaarFeatures, mergeTypesAndLayers } from "../import/azgaar.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const L = k => game.i18n.localize(k);

/** Azgaar's generator inside Foundry, in an iframe. The map is exported from there as JSON. */
export class AzgaarGenerator extends ApplicationV2 {
  static #instance = null;

  static open() {
    AzgaarGenerator.#instance ??= new AzgaarGenerator();
    return AzgaarGenerator.#instance.render({ force: true });
  }

  static DEFAULT_OPTIONS = {
    id: "vmap-azgaar-generator",
    classes: ["vmap-azgaar-frame"],
    window: { title: "VMAP.Azgaar.generator", resizable: true, icon: "fa-solid fa-earth-europe" },
    position: { width: Math.min(1400, window.innerWidth - 120), height: Math.min(900, window.innerHeight - 80) }
  };

  /** @override */
  async _renderHTML() {
    const frame = document.createElement("iframe");
    frame.src = AZGAAR_URL;
    frame.setAttribute("allow", "clipboard-write; fullscreen");
    frame.referrerPolicy = "no-referrer";
    return frame;
  }

  /** @override */
  _replaceHTML(result, content) {
    // Keep the generator alive between re-renders: the map lives in the iframe.
    if ( !content.querySelector("iframe") ) content.replaceChildren(result);
  }
}

/**
 * Generate or import a world from Azgaar's Fantasy Map Generator. GM only.
 * Import reads "Export → JSON → Full" and turns states, provinces, burgs, rivers and
 * routes into Artarius features on the current scene. The exported picture can become
 * the scene background.
 */
export default class AzgaarApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;

  static open() {
    if ( !game.user.isGM ) return ui.notifications.warn(L("VMAP.Azgaar.gmOnly"));
    AzgaarApp.#instance ??= new AzgaarApp();
    return AzgaarApp.#instance.render({ force: true });
  }

  static DEFAULT_OPTIONS = {
    id: "vmap-azgaar",
    classes: ["vitruvium", "vmap-sheet"],
    tag: "form",
    window: { title: "VMAP.Azgaar.title", resizable: true, icon: "fa-solid fa-earth-europe" },
    position: { width: 520, height: "auto" },
    actions: {
      generator: () => AzgaarGenerator.open(),
      browser: () => window.open(AZGAAR_URL, "_blank", "noopener"),
      pickImage: AzgaarApp.#onPickImage,
      import: AzgaarApp.#onImport
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/azgaar.hbs` }
  };

  /** Form state survives re-renders. */
  form = { parts: { ...AZGAAR_PARTS }, image: "", setBackground: true, replace: true };
  busy = false;

  /** @override */
  async _prepareContext() {
    return {
      form: this.form,
      busy: this.busy,
      scene: canvas.scene?.name ?? "—",
      parts: Object.keys(AZGAAR_PARTS).map(k => ({ key: k, label: L(`VMAP.Azgaar.part.${k}`), on: !!this.form.parts[k] }))
    };
  }

  /** @override */
  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    this.element.addEventListener("change", ev => {
      const el = ev.target;
      if ( el.dataset.part ) this.form.parts[el.dataset.part] = el.checked;
      else if ( el.name === "image" ) this.form.image = el.value.trim();
      else if ( el.name === "setBackground" ) this.form.setBackground = el.checked;
      else if ( el.name === "replace" ) this.form.replace = el.checked;
    });
  }

  static #onPickImage() {
    const FP = foundry.applications.apps.FilePicker.implementation;
    new FP({
      type: "image",
      current: this.form.image || "",
      callback: path => {
        this.form.image = path;
        const input = this.element.querySelector("[name=image]");
        if ( input ) input.value = path;
      }
    }).browse();
  }

  static async #onImport() {
    const file = this.element.querySelector("[name=file]")?.files?.[0];
    if ( !file ) return ui.notifications.warn(L("VMAP.Azgaar.noFile"));
    const scene = canvas.scene;
    if ( !scene ) return ui.notifications.warn(L("VMAP.Azgaar.noScene"));
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return ui.notifications.error(L("VMAP.Azgaar.error.notJson"));
    }
    const problem = validateAzgaar(data);
    if ( problem ) return ui.notifications.error(L(`VMAP.Azgaar.error.${problem}`));

    this.busy = true;
    this.render();
    try {
      const result = await importAzgaar(data, scene, this.form);
      ui.notifications.info(game.i18n.format("VMAP.Azgaar.done", result.stats));
    } finally {
      this.busy = false;
      this.render();
    }
  }
}

/**
 * Import an Azgaar export into a scene. Exposed through the API for macros.
 * options: { parts, image, setBackground, replace }.
 */
export async function importAzgaar(data, scene = canvas.scene, { parts = AZGAAR_PARTS, image = "", setBackground = true, replace = true } = {}) {
  if ( !game.user.isGM ) throw new Error(L("VMAP.Azgaar.gmOnly"));
  if ( image && setBackground ) {
    const tex = await foundry.canvas.loadTexture(image);
    const width = tex?.width ?? data.info.width;
    const height = tex?.height ?? data.info.height;
    await scene.update({ "background.src": image, width, height });
  }
  const rect = scene.getDimensions?.().sceneRect ?? canvas.dimensions.sceneRect;
  const atlas = getAtlas(scene) ?? await ensureAtlas(scene);
  const merged = mergeTypesAndLayers(getTypes(atlas), getLayers(atlas));
  await setTypes(atlas, merged.types);
  await setLayers(atlas, merged.layers);

  const built = buildAzgaarFeatures(data, { rect, parts, newId: () => foundry.utils.randomID() });
  const old = replace
    ? atlas.pages.filter(p => p.type === FEATURE_TYPE && p._source.system?.ext?.azgaar).map(p => p.id)
    : [];
  const create = built.features.map(f => ({ ...f, system: { ...f.system, rev: 1 } }));
  // Крупная карта даёт тысячи страниц: пишем частями, чтобы не упереться в размер одного запроса.
  if ( old.length ) await applyPlan(atlas, { create: [], update: [], delete: old, skipped: [] });
  for ( let i = 0; i < create.length; i += 250 ) {
    await applyPlan(atlas, { create: create.slice(i, i + 250), update: [], delete: [], skipped: [] });
  }
  if ( built.name && !atlas.getFlag(MODULE_ID, "azgaarName") ) await atlas.setFlag(MODULE_ID, "azgaarName", built.name);
  Hooks.callAll("artarius.importAzgaar", { scene, atlas, data, built, removed: old.length });
  return { ...built, removed: old.length };
}
