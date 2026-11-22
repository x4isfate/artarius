import { MODULE_ID } from "../constants.mjs";
import { markdownToHtml } from "./markdown.mjs";

const { ApplicationV2 } = foundry.applications.api;

/**
 * Разбить CHANGELOG.md на версии: [{ version, html }], новые сверху.
 * Вступление до первой версии пропускается.
 */
export function changelogSections(md) {
  const parts = String(md ?? "").replace(/\r/g, "").split(/^## /m).slice(1);
  return parts.map(p => {
    const nl = p.indexOf("\n");
    const head = (nl < 0 ? p : p.slice(0, nl)).trim();
    const body = nl < 0 ? "" : p.slice(nl + 1).trim();
    return { version: head, html: markdownToHtml(body) };
  }).filter(s => s.version);
}

/**
 * «Artarius: что нового» (0.9.9). Видит только мастер, при входе в мир, пока не нажмёт «Понятно»
 * с галочкой «Не показывать до следующей версии». Внутри весь список изменений, новая версия раскрыта.
 */
export default class NewsApp extends ApplicationV2 {
  static #instance = null;
  static #sections = null;

  static open() {
    NewsApp.#instance ??= new NewsApp();
    return NewsApp.#instance.render({ force: true });
  }

  /** Показывать ли окно при входе: новая версия, которую мастер ещё не отметил. */
  static shouldShow() {
    const v = game.modules.get(MODULE_ID)?.version ?? "";
    return !!v && game.settings.get(MODULE_ID, "newsSeen") !== v;
  }

  static DEFAULT_OPTIONS = {
    id: "artarius-news",
    classes: ["vitruvium", "vmap-sheet", "artarius-news"],
    window: { title: "ART.News.title", resizable: true, icon: "fa-solid fa-scroll" },
    position: { width: 580, height: 640 },
    actions: {
      newsOk: NewsApp.#onOk
    }
  };

  /** «Понятно»: с галочкой окно молчит до следующей версии. */
  static async #onOk() {
    const box = this.element?.querySelector("input[name=newsHide]");
    if ( box?.checked ) await game.settings.set(MODULE_ID, "newsSeen", game.modules.get(MODULE_ID)?.version ?? "");
    return this.close();
  }

  /** @override */
  async _renderHTML() {
    if ( NewsApp.#sections === null ) {
      try {
        const res = await fetch(`modules/${MODULE_ID}/CHANGELOG.md`);
        NewsApp.#sections = res.ok ? changelogSections(await res.text()) : [];
      } catch(err) {
        console.error(`${MODULE_ID} | changelog`, err);
        NewsApp.#sections = [];
      }
    }
    const L = k => game.i18n.localize(k);
    const esc = foundry.utils.escapeHTML;
    const list = NewsApp.#sections.map((s, n) => `<details class="art-news-ver"${n === 0 ? " open" : ""}>
        <summary><b>${esc(s.version)}</b>${n === 0 ? ` <span class="art-news-new">${esc(L("ART.News.latest"))}</span>` : ""}</summary>
        <div class="art-news-body">${s.html}</div></details>`).join("");
    const div = document.createElement("div");
    div.className = "art-news";
    div.innerHTML = `<div class="art-news-list">${list || `<p>${esc(L("ART.News.missing"))}</p>`}</div>
      <footer class="art-news-foot">
        <label class="art-check"><input type="checkbox" name="newsHide" checked> ${esc(L("ART.News.hide"))}</label>
        <button type="button" class="art-btn art-accent" data-action="newsOk">${esc(L("ART.News.ok"))}</button>
      </footer>`;
    return div;
  }

  /** @override */
  _replaceHTML(result, content) {
    content.replaceChildren(result);
  }
}
