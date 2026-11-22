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
    position: { width: 900, height: 700 },
    actions: {
      guideGo: GuideApp.#onGo,
      guideNews: GuideApp.#onNews
    }
  };

  /** Раздел из списка слева: прокрутить к заголовку. */
  static #onGo(event, target) {
    const h = this.element?.querySelector(`#${CSS.escape(target.dataset.id)}`);
    h?.scrollIntoView({ block: "start", behavior: "smooth" });
    for ( const b of this.element?.querySelectorAll(".art-guide-nav button") ?? [] ) b.classList.toggle("active", b === target);
  }

  /** «Что нового» в списке разделов открывает окно со списком изменений. */
  static async #onNews() {
    const { default: NewsApp } = await import("./news-app.mjs");
    NewsApp.open();
  }

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
    const L = k => game.i18n.localize(k);
    const esc = foundry.utils.escapeHTML;
    const body = document.createElement("div");
    body.className = "vmap-guide-body";
    body.innerHTML = GuideApp.#html ?? `<p>${esc(L("VMAP.Guide.missing"))}</p>`;
    // Слева разделы руководства (0.9.9): каждый заголовок второго уровня — кнопка.
    const nav = [...body.querySelectorAll("h2")].map((h, n) => {
      h.id = `art-guide-${n + 1}`;
      const name = h.textContent.replace(/^\d+\.\s*/, "");
      return `<button type="button" data-action="guideGo" data-id="${h.id}">${esc(name)}</button>`;
    }).join("");
    const div = document.createElement("div");
    div.className = "art-guide artarius";
    div.innerHTML = `<nav class="art-guide-nav" aria-label="${esc(L("ART.Guide.sections"))}">${nav}
      <button type="button" data-action="guideNews"><i class="fa-solid fa-scroll"></i> ${esc(L("ART.News.title"))}</button></nav>`;
    div.appendChild(body);
    return div;
  }

  /** @override */
  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }
}
