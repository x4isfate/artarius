import { MODULE_ID, FEATURE_TYPE } from "../constants.mjs";
import { getAtlas, ensureAtlas, getAtlasTypes, getLayers, setTypes, setLayers, applyPlan } from "../data/store.mjs";
import { AZGAAR_URL, AZGAAR_PARTS, validateAzgaar, buildAzgaarFeatures, mergeTypesAndLayers } from "../import/azgaar.mjs";
import { esc } from "../ui/dom.mjs";
import { resizeWorld, sceneDims } from "./world-size.mjs";
import { rowsForAspect } from "../hex/dims.mjs";

const { ApplicationV2 } = foundry.applications.api;
const L = k => game.i18n.localize(k);

/** Генератор Azgaar прямо в Foundry, во фрейме. Карту оттуда выгружают в JSON. */
export class AzgaarGenerator extends ApplicationV2 {
  static #instance = null;

  static open() {
    AzgaarGenerator.#instance ??= new AzgaarGenerator();
    return AzgaarGenerator.#instance.render({ force: true });
  }

  static DEFAULT_OPTIONS = {
    id: "artarius-azgaar-generator",
    classes: ["artarius-azgaar-frame"],
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
    // Генератор живёт во фрейме: при перерисовке окна фрейм не трогаем.
    if ( !content.querySelector("iframe") ) content.replaceChildren(result);
  }
}

/**
 * Генерация и импорт мира из Azgaar. Только мастер.
 * Окно собрано без шаблона: HTML строкой, события через data-action.
 * Свои настройки окно держит в importOptions: имя form в ApplicationV2 занято.
 */
export default class AzgaarApp extends ApplicationV2 {
  static #instance = null;

  static open() {
    if ( !game.user.isGM ) return ui.notifications.warn(L("VMAP.Azgaar.gmOnly"));
    AzgaarApp.#instance ??= new AzgaarApp();
    return AzgaarApp.#instance.render({ force: true });
  }

  static DEFAULT_OPTIONS = {
    id: "artarius-azgaar",
    classes: ["artarius-window"],
    window: { title: "VMAP.Azgaar.title", resizable: true, icon: "fa-solid fa-earth-europe" },
    position: { width: 480, height: "auto" },
    actions: {
      generator: () => AzgaarGenerator.open(),
      browser: () => window.open(AZGAAR_URL, "_blank", "noopener"),
      import: AzgaarApp.#onImport
    }
  };

  importOptions = { parts: { ...AZGAAR_PARTS }, replace: true, fit: true, cols: null };
  busy = false;

  /** @override */
  async _renderHTML() {
    const o = this.importOptions;
    const parts = Object.keys(AZGAAR_PARTS).map(k => `<label class="art-check"><input type="checkbox" data-part="${k}" ${o.parts[k] ? "checked" : ""}> ${esc(L(`VMAP.Azgaar.part.${k}`))}</label>`).join("");
    const div = document.createElement("div");
    div.className = "artarius-azgaar";
    div.innerHTML = `
      <section>
        <h3>${esc(L("VMAP.Azgaar.generate"))}</h3>
        <p class="hint">${esc(L("VMAP.Azgaar.generateHint"))}</p>
        <div class="art-row">
          <button type="button" data-action="generator"><i class="fa-solid fa-wand-magic-sparkles"></i> ${esc(L("VMAP.Azgaar.openGenerator"))}</button>
          <button type="button" data-action="browser"><i class="fa-solid fa-arrow-up-right-from-square"></i> ${esc(L("VMAP.Azgaar.openBrowser"))}</button>
        </div>
      </section>
      <section>
        <h3>${esc(L("VMAP.Azgaar.import"))}</h3>
        <p class="hint">${esc(L("VMAP.Azgaar.importHint"))}</p>
        <label class="art-file">${esc(L("VMAP.Azgaar.file"))} <input type="file" name="file" accept=".json,application/json"></label>
        <div class="art-parts">${parts}</div>
        <label class="art-check"><input type="checkbox" name="replace" ${o.replace ? "checked" : ""}> ${esc(L("VMAP.Azgaar.replace"))}</label>
        <label class="art-check"><input type="checkbox" name="fit" ${o.fit ? "checked" : ""}> ${esc(L("VMAP.Azgaar.fit"))}</label>
        <label class="art-field art-inline"><span>${esc(L("VMAP.Azgaar.cols"))}</span>
          <input type="number" name="cols" value="${o.cols ?? (canvas.scene ? sceneDims(canvas.scene).cols : 60)}" min="5" max="300"></label>
        <p class="hint">${esc(L("VMAP.Azgaar.fitHint"))}</p>
        <p class="hint">${esc(L("VMAP.Azgaar.scene"))}: <b>${esc(canvas.scene?.name ?? "—")}</b></p>
        <button type="button" data-action="import" ${this.busy ? "disabled" : ""}>
          <i class="fa-solid ${this.busy ? "fa-spinner fa-spin" : "fa-file-import"}"></i> ${esc(L("VMAP.Azgaar.doImport"))}</button>
      </section>`;
    div.addEventListener("change", ev => {
      const el = ev.target;
      if ( el.dataset.part ) this.importOptions.parts[el.dataset.part] = el.checked;
      else if ( el.name === "replace" ) this.importOptions.replace = el.checked;
      else if ( el.name === "fit" ) this.importOptions.fit = el.checked;
      else if ( el.name === "cols" ) this.importOptions.cols = Number(el.value) || null;
    });
    return div;
  }

  /** @override */
  _replaceHTML(result, content) {
    content.replaceChildren(result);
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
      // Чаще всего это сохранение .map: оно не JSON, нужен «Export → Export to JSON → Full».
      const key = /\.map$/i.test(file.name) ? "isMap" : "notJson";
      return ui.notifications.error(L(`VMAP.Azgaar.error.${key}`), { permanent: true });
    }
    const problem = validateAzgaar(data);
    if ( problem ) return ui.notifications.error(L(`VMAP.Azgaar.error.${problem}`));
    this.busy = true;
    this.render();
    try {
      const result = await importAzgaar(data, scene, this.importOptions);
      ui.notifications.info(game.i18n.format("VMAP.Azgaar.done", result.stats));
    } finally {
      this.busy = false;
      this.render();
    }
  }
}

/**
 * Импорт выгрузки Azgaar на гексы сцены. Есть в API для макросов.
 * options: { parts, replace, fit, cols }. fit — подогнать поле сцены под пропорции карты,
 * cols — сколько гексов по ширине (по умолчанию как сейчас).
 */
export async function importAzgaar(data, scene = canvas.scene, { parts = AZGAAR_PARTS, replace = true, fit = false, cols = null } = {}) {
  if ( !game.user.isGM ) throw new Error(L("VMAP.Azgaar.gmOnly"));
  if ( scene !== canvas.scene ) throw new Error(L("VMAP.Azgaar.noScene"));
  // Поле под пропорции карты: ширина в гексах как задано, высота по карте.
  if ( fit && data?.info?.width && data?.info?.height ) {
    const d = sceneDims(scene);
    const c = Math.round(cols || d.cols);
    await resizeWorld(scene, { cols: c, rows: rowsForAspect(c, data.info.height / data.info.width, d.size), size: d.size });
  }
  const api = game.modules.get(MODULE_ID).api;
  const grid = api.backend.grid;
  const rect = canvas.dimensions.sceneRect;
  const atlas = getAtlas(scene) ?? await ensureAtlas(scene);
  const merged = mergeTypesAndLayers(getAtlasTypes(atlas), getLayers(atlas));
  await setTypes(atlas, merged.types);
  await setLayers(atlas, merged.layers);

  const built = buildAzgaarFeatures(data, {
    rect, parts, hexes: grid.allCells(), center: grid.center, cellAt: grid.cellAt,
    newId: () => foundry.utils.randomID()
  });
  const old = replace
    ? atlas.pages.filter(p => p.type === FEATURE_TYPE && p._source.system?.ext?.azgaar).map(p => p.id)
    : [];
  const create = built.features.map(f => ({ ...f, system: { ...f.system, rev: 1 } }));
  // Большая карта даёт сотни страниц: пишем частями, чтобы не упереться в размер запроса.
  if ( old.length ) await applyPlan(atlas, { create: [], update: [], delete: old, skipped: [] });
  for ( let i = 0; i < create.length; i += 200 ) {
    await applyPlan(atlas, { create: create.slice(i, i + 200), update: [], delete: [], skipped: [] });
  }
  if ( built.name && !atlas.getFlag(MODULE_ID, "azgaarName") ) await atlas.setFlag(MODULE_ID, "azgaarName", built.name);
  Hooks.callAll("artarius.importAzgaar", { scene, atlas, data, built, removed: old.length });
  return { ...built, removed: old.length };
}
