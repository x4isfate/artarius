/**
 * Маленький перевод Markdown в HTML для окна «Как играть»: заголовки, абзацы,
 * списки, таблицы, жирный, курсив, код и ссылки. Не зависит от Foundry.
 */

const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));

function inline(text) {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map(p => {
    if ( p.startsWith("`") && p.endsWith("`") && p.length > 1 ) return `<code>${esc(p.slice(1, -1))}</code>`;
    return esc(p)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "<a href=\"$2\" target=\"_blank\" rel=\"noopener\">$1</a>");
  }).join("");
}

const cells = line => line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());

export function markdownToHtml(src) {
  const lines = src.replace(/\r/g, "").split("\n");
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => { if ( para.length ) out.push(`<p>${inline(para.join(" "))}</p>`); para = []; };
  const flushList = () => {
    if ( !list ) return;
    out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for ( let n = 0; n < lines.length; n++ ) {
    const line = lines[n];
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if ( !line.trim() ) { flushPara(); flushList(); continue; }
    if ( h ) { flushPara(); flushList(); const lv = h[1].length; out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); continue; }
    if ( line.trim().startsWith("|") && lines[n + 1]?.match(/^\s*\|?\s*:?-{3,}/) ) {
      flushPara(); flushList();
      const head = cells(line);
      const rows = [];
      n += 2;
      while ( n < lines.length && lines[n].trim().startsWith("|") ) rows.push(cells(lines[n++]));
      n--;
      out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${
        rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if ( ul || ol ) {
      flushPara();
      const tag = ul ? "ul" : "ol";
      if ( list && list.tag !== tag ) flushList();
      list ??= { tag, items: [] };
      list.items.push((ul ?? ol)[1]);
      continue;
    }
    if ( list && /^\s{2,}\S/.test(line) ) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join("\n");
}
