// 1.0: кнопки и поля ни в одном окне не наезжают друг на друга и не вылезают за свою рамку.
// Обходит окна «Зоны», «Метки», «Линии», «Слои», «Статусы и аспекты», «Настройки», карточку гекса и плашку осмотра
// в обычной ширине окна и в узкой (как если окно Foundry сжать). Запуск: npm run e2e (или node tests/harness/layout.cjs).
const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..", "..");
const TYPES = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
function serve() {
  const server = http.createServer((req, res) => {
    const raw = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const pathname = raw.replace(/^.*\/modules\/artarius\//, "/");
    if ( pathname.includes("/icons/") && !pathname.startsWith("/assets/") ) {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#fff"/></svg>');
    }
    const file = path.join(root, pathname);
    if ( !file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory() ) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, () => r(server)));
}

/**
 * В браузере: видимые кнопки, поля и списки части. Пары, которые пересекаются больше чем на 2 px,
 * и кнопки, чей текст не помещается и не обрезан многоточием.
 */
function audit(selector) {
  const part = document.querySelector(selector);
  if ( !part || part.hidden || !part.offsetParent && getComputedStyle(part).position !== "fixed" ) return { skipped: true };
  const clipOf = el => {
    let r = { left: -1e9, top: -1e9, right: 1e9, bottom: 1e9 };
    for ( let p = el.parentElement; p && p !== document.body; p = p.parentElement ) {
      const cs = getComputedStyle(p);
      if ( /(auto|scroll|hidden)/.test(cs.overflow + cs.overflowX + cs.overflowY) ) {
        const b = p.getBoundingClientRect();
        r = { left: Math.max(r.left, b.left), top: Math.max(r.top, b.top), right: Math.min(r.right, b.right), bottom: Math.min(r.bottom, b.bottom) };
      }
    }
    return r;
  };
  const els = [...part.querySelectorAll("button, input:not([type=hidden]), select, textarea, .art-pill, .art-chip")].filter(el => {
    if ( el.closest("[hidden], details:not([open]) > :not(summary)") ) return false;
    const b = el.getBoundingClientRect();
    if ( b.width < 2 || b.height < 2 ) return false;
    const c = clipOf(el);
    // Только то, что видно целиком внутри своих прокручиваемых рамок.
    return b.left >= c.left - 1 && b.right <= c.right + 1 && b.top >= c.top - 1 && b.bottom <= c.bottom + 1;
  });
  const name = el => `${el.tagName.toLowerCase()}${el.dataset.action ? `[${el.dataset.action}]` : ""}${el.dataset.model ? `{${el.dataset.model}}` : ""}${el.dataset.key ? `<${el.dataset.key}>` : ""} «${(el.textContent || el.value || el.placeholder || el.title || "").trim().slice(0, 24)}»`;
  const overlaps = [];
  for ( let i = 0; i < els.length; i++ ) {
    const a = els[i].getBoundingClientRect();
    for ( let j = i + 1; j < els.length; j++ ) {
      if ( els[i].contains(els[j]) || els[j].contains(els[i]) ) continue;
      // Карандаш правки стоит в углу плитки выбранного типа: так задумано (макет 0.9.9).
      if ( [els[i], els[j]].some(e => e.classList.contains("art-ut-pen")) ) continue;
      const b = els[j].getBoundingClientRect();
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if ( w > 2 && h > 2 ) overlaps.push(`${name(els[i])} × ${name(els[j])} (${Math.round(w)}×${Math.round(h)})`);
    }
  }
  const spills = [];
  for ( const el of els.filter(e => e.tagName === "BUTTON") ) {
    const cs = getComputedStyle(el);
    if ( cs.overflow !== "visible" && cs.textOverflow === "ellipsis" ) continue;
    if ( el.scrollWidth > el.clientWidth + 2 ) spills.push(`${name(el)} (${el.scrollWidth}>${el.clientWidth})`);
    // Текст, вылезающий из кнопки (дети шире кнопки и не обрезаны).
    const b = el.getBoundingClientRect();
    for ( const ch of el.children ) {
      const c = ch.getBoundingClientRect();
      const cc = getComputedStyle(ch);
      if ( c.width && (c.right > b.right + 2 || c.left < b.left - 2) && cc.textOverflow !== "ellipsis" && cc.position !== "absolute" ) { spills.push(`${name(el)}: ${ch.className || ch.tagName} шире кнопки`); break; }
    }
  }
  // Части окна, вылезающие за правый край своей колонки (горизонтальной прокрутки быть не должно).
  const wide = [...part.querySelectorAll(".art-ucol-right, .art-ucol-left, .art-body")].filter(c => c.scrollWidth > c.clientWidth + 2)
    .map(c => `${c.className}: ${c.scrollWidth}>${c.clientWidth}`);
  return { n: els.length, overlaps, spills, wide };
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`http://localhost:${server.address().port}/tests/harness/index.html`);
  await page.waitForFunction(() => window.art);
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const problems = [];
  let checked = 0;
  const look = async (label, selector) => {
    await page.waitForTimeout(60);
    const r = await ev(audit, selector);
    if ( r.skipped ) { problems.push(`${label}: окно не открылось (${selector})`); return; }
    checked++;
    for ( const o of r.overlaps ) problems.push(`${label}: наезжают ${o}`);
    for ( const o of r.spills ) problems.push(`${label}: текст не влезает ${o}`);
    for ( const o of r.wide ) problems.push(`${label}: шире окна ${o}`);
  };
  const widths = [null, 440];
  const setWidth = w => ev(w => {
    for ( const el of document.querySelectorAll("#artarius-ui > .art-panel") ) el.style.width = w ? `${w}px` : "";
  }, w);

  await page.click(".art-wheel-hub");
  // Данные: базовые статусы, зоны, метка со статусами, линия.
  await ev(async () => {
    const s = window.art.studio;
    await s.seedAspects();
    s.setTool("zone", { toggle: false });
    for ( const [t, cells, name] of [["forest", [[3, 3], [3, 4]], "Лес у реки"], ["realm", [[3, 3], [4, 4]], "Очень длинное название державы, которое не помещается в строку"]] ) {
      s.zone.target = "new"; s.zone.typeId = t; s.zone.name = name;
      await s.attach(cells);
    }
    s.setTool("mark", { toggle: false });
    s.mark.typeId = s.typesOf("object")[0].id;
    await s.placeMarks([[3, 3]]);
    const m = [...s.states.values()].find(x => x.system.kind === "object");
    for ( const it of s.aspects().slice(0, 4) ) await s.attachAspect(m.id, it.id);
  });

  for ( const w of widths ) {
    const tag = w ? ` (${w} px)` : "";
    await setWidth(w);
    for ( const mode of ["zones", "marks", "lines"] ) {
      await ev(m => window.art.studio.setMode(m), mode);
      await look(`окно ${mode}${tag}`, "#artarius-ui > .art-left");
      // Форма нового типа (у меток — с выбором значка).
      await ev(m => window.art.studio.openTypeForm({ zones: "area", marks: "object", lines: "line" }[m]), mode);
      await look(`окно ${mode}, новый тип${tag}`, "#artarius-ui > .art-left");
      await ev(() => { window.art.studio.typeForm = null; window.art.studio.changed("ui"); });
      // Выбор аспекта в форме нового элемента.
      await ev(m => window.art.studio.toggleAspectPick({ slot: { zones: "zone", marks: "mark", lines: "line" }[m] }), mode);
      await look(`окно ${mode}, выбор аспекта${tag}`, "#artarius-ui > .art-left");
      await ev(() => window.art.studio.toggleAspectPick({ slot: null }));
      await ev(() => { window.art.studio.aspectPick = null; window.art.studio.changed("ui"); });
    }
    await ev(() => window.art.studio.setMode("select"));
    await ev(() => window.art.studio.toggleLayers(true));
    for ( const id of ["terrain", "@coast", "@heights"] ) {
      await ev(id => window.art.studio.pickLayer(id), id);
      await look(`окно «Слои» ${id}${tag}`, "#artarius-ui > .art-layerwin");
    }
    await ev(() => window.art.studio.toggleLayers(false));
    await ev(() => window.art.studio.toggleAspects(true));
    const kinds = await ev(() => { const s = window.art.studio; return [s.aspects().find(i => i.system.kind === "aspect").id, s.aspects().find(i => i.system.kind === "status").id]; });
    for ( const id of kinds ) {
      await ev(id => window.art.studio.pickAspect(id), id);
      await look(`окно «Статусы и аспекты»${tag}`, "#artarius-ui > .art-aspectwin");
    }
    await ev(() => { const s = window.art.studio; s.pickAspect(s.aspects().find(i => i.system.kind === "aspect").id); s.toggleAspectPick({ form: true }); });
    await look(`окно «Статусы и аспекты», статусы аспекта${tag}`, "#artarius-ui > .art-aspectwin");
    await ev(() => { const s = window.art.studio; s.aspectPick = null; s.newAspect("", "status"); s.aspectForm.icon = "modules/artarius/assets/icons/castle.svg"; s.changed("ui"); });
    await look(`окно «Статусы и аспекты», новый статус${tag}`, "#artarius-ui > .art-aspectwin");
    await ev(() => window.art.studio.toggleAspects(false));
    // Карточка гекса: раскрытая строка и правка метки.
    const mid = await ev(() => { const s = window.art.studio; s.setTool("select", { toggle: false }); s.inspect([3, 3]); s.openDetails(); return s.contents().marks[0].id; });
    await ev(id => window.art.studio.openItem?.(id), mid);
    await look(`карточка гекса${tag}`, "#artarius-ui > .art-right");
    await page.locator(`#artarius-ui [data-action="editItem"][data-id="${mid}"]`).click();
    await look(`карточка гекса, правка метки${tag}`, "#artarius-ui > .art-right");
    await page.locator(`#artarius-ui .art-entries [data-action="aspectPickOpen"]`).first().click();
    await page.fill('#artarius-ui [data-key="apick-q"]', "Новое");
    await look(`карточка гекса, выбор статуса${tag}`, "#artarius-ui > .art-right");
    await ev(() => { const s = window.art.studio; s.aspectPick = null; s.editId = null; s.changed("ui"); });
    await look(`плашка осмотра${tag}`, "#artarius-hud");
    await ev(() => window.art.studio.openSettings?.());
    await look(`настройки${tag}`, "#artarius-ui > .art-settings");
    await ev(() => window.art.studio.closeSettings?.());
  }
  await browser.close();
  server.close();
  for ( const p of problems ) console.log("✗", p);
  assert.deepEqual(errors, [], "ошибок в консоли нет");
  assert.equal(problems.length, 0, `в окнах ${problems.length} мест, где кнопки наезжают или не влезают`);
  console.log(`✓ раскладка: ${checked} состояний окон, кнопки не наезжают друг на друга`);
})().catch(err => { console.error("✗", err.message); process.exit(1); });
