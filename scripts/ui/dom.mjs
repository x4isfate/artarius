/** Мелочи для панелей на чистом DOM. */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Экранировать текст для вставки в HTML. */
export const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ESC[c]);

/** HTML описания → простой текст для поля ввода. */
export function htmlToText(html) {
  const s = String(html ?? "");
  if ( !/[<&]/.test(s) ) return s;
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Атрибуты data-* из объекта. */
export function data(attrs) {
  return Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` data-${k}="${esc(v)}"`).join("");
}

/**
 * Заменить содержимое узла, если HTML поменялся. Фокус и курсор в поле ввода
 * сохраняются: поле находится заново по data-key.
 */
export function patch(node, html) {
  if ( node._html === html ) return false;
  node._html = html;
  const active = document.activeElement;
  const inside = active && node.contains(active) ? active : null;
  const key = inside?.dataset?.key;
  let sel = null;
  if ( inside && "selectionStart" in inside ) {
    try { sel = [inside.selectionStart, inside.selectionEnd]; } catch { sel = null; }
  }
  const scrolls = [...node.querySelectorAll("[data-scroll]")].map(el => [el.dataset.scroll, el.scrollTop]);
  node.innerHTML = html;
  for ( const [k, top] of scrolls ) {
    const el = node.querySelector(`[data-scroll="${k}"]`);
    if ( el ) el.scrollTop = top;
  }
  if ( key ) {
    const again = node.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if ( again ) {
      again.focus({ preventScroll: true });
      if ( sel && "setSelectionRange" in again ) {
        try { again.setSelectionRange(sel[0], sel[1]); } catch { /* не текстовое поле */ }
      }
    }
  }
  return true;
}

/** Иконка Font Awesome. */
/** Значок Font Awesome: короткое имя ("scroll") или полные классы ("fa-solid fa-scroll"). */
export const icon = (name, extra = "") => {
  const cls = String(name).includes("fa-") ? String(name) : `fa-solid fa-${name}`;
  return `<i class="${esc(cls)}${extra ? ` ${extra}` : ""}" aria-hidden="true"></i>`;
};
