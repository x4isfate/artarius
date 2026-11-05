import { MODULE_ID } from "../constants.mjs";
import { markdownToHtml } from "./markdown.mjs";

const { ApplicationV2 } = foundry.applications.api;

/** Окно «Как играть»: показывает docs/GUIDE.md из папки модуля. */
export default class GuideApp extends ApplicationV2 {
  static #instance = null;
  static #html = null;

  static open() {
    GuideApp.#instance ??= new GuideApp();
    return GuideApp.#instance.render({ force: true });
  }

  static DEFAULT_OPTIONS = {
    id: "artarius-guide",
    classes: ["vitruvium", "vmap-sheet", "vmap-guide"],
    window: { title: "VMAP.Guide.title", resizable: true, icon: "fa-solid fa-circle-question" },
    position: { width: 720, height: 760 }
  };

  /** @override */
  async _renderHTML() {
    if ( GuideApp.#html === null ) {
      try {
        const res = await fetch(`modules/${MODULE_ID}/docs/GUIDE.md`);
        GuideApp.#html = res.ok ? markdownToHtml(await res.text()) : null;
      } catch(err) {
        console.error(`${MODULE_ID} | guide`, err);
      }
    }
    const div = document.createElement("div");
    div.className = "vmap-guide-body";
    div.innerHTML = GuideApp.#html ?? `<p>${game.i18n.localize("VMAP.Guide.missing")}</p>`;
    return div;
  }

  /** @override */
  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }
}
