// Сквозная проверка интерфейса на стенде: каждый инструмент и каждая кнопка панели.
// Запуск: npm run e2e (поднимает свой статический сервер).
const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..", "..");
const TYPES = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

function serve() {
  const server = http.createServer((req, res) => {
    // Foundry отдаёт модуль по modules/artarius/…: здесь это корень репозитория.
    const raw = decodeURIComponent(new URL(req.url, "http://x").pathname);
    // Путь, посчитанный от файла стилей (…/styles/modules/artarius/…), в Foundry даёт 404: здесь тоже.
    if ( /\/styles\/.*modules\/artarius\//.test(raw) ) { res.writeHead(404); return res.end(); }
    const pathname = raw.replace(/^.*\/modules\/artarius\//, "/");
    // Значков Foundry на стенде нет: отдаём простой кружок.
    if ( pathname.includes("/icons/") ) {
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

const shots = process.env.ART_SHOTS;
let step = 0;
async function shot(page, name) {
  if ( shots ) await page.screenshot({ path: path.join(shots, `${String(++step).padStart(2, "0")}-${name}.png`) });
}

(async () => {
  const server = await serve();
  const url = `http://localhost:${server.address().port}/tests/harness/index.html`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if ( m.type() === "error" ) errors.push(m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => window.art);

  const ev = (fn, arg) => page.evaluate(fn, arg);
  const atlas = () => ev(() => [...window.art.backend.atlas.values()].map(s => ({
    id: s.id, name: s.name, kind: s.system.kind, typeId: s.system.typeId, cells: s.system.geometry.cells?.length ?? 0,
    statuses: s.system.statuses, aspects: s.system.aspects, demiurge: s.system.demiurge
  })));
  /** Экранная точка центра гекса [i, j]. */
  const at = async cell => ev(([i, j]) => {
    const { backend } = window.art;
    const c = backend.grid.center([i, j]);
    const svg = document.getElementById("map");
    const p = svg.createSVGPoint(); p.x = c.x; p.y = c.y;
    const r = p.matrixTransform(svg.getScreenCTM());
    return { x: r.x, y: r.y };
  }, cell);
  const click = async (cell, mods = []) => {
    const p = await at(cell);
    for ( const m of mods ) await page.keyboard.down(m);
    await page.mouse.click(p.x, p.y);
    for ( const m of mods ) await page.keyboard.up(m);
  };
  const drag = async (a, b) => {
    const pa = await at(a), pb = await at(b);
    await page.mouse.move(pa.x, pa.y);
    await page.mouse.down();
    await page.mouse.move(pb.x, pb.y, { steps: 12 });
    await page.mouse.up();
  };
  const act = async (action, extra = "") => {
    const sel = `#artarius-ui [data-action="${action}"]${extra}`;
    await page.locator(sel).first().click();
  };
  const hud = async (action, extra = "") => {
    await page.locator(`#artarius-hud [data-action="${action}"]${extra}`).first().click();
  };
  const user = async id => { await page.click(`#who button[data-u="${id}"]`); };
  const check = (cond, msg) => { assert.ok(cond, msg); console.log("✓", msg); };

  /* 1. Меню и зона ------------------------------------------------- */
  await page.click(".art-wheel-hub");
  check(await page.locator(".art-left").isVisible(), "центр меню открывает инструменты");
  await act("tool", '[data-tool="zone"]');
  await act("pickType", '[data-id="forest"]');
  await drag([3, 3], [3, 8]);
  check((await ev(() => window.art.studio.selection.size)) === 6, "протяжка выбирает 6 гексов");
  await click([3, 4], ["Shift"]);
  check((await ev(() => window.art.studio.selection.size)) === 5, "Shift-щелчок снимает гекс");
  await act("attach");
  let a = await atlas();
  check(a.length === 1 && a[0].cells === 5 && a[0].typeId === "forest", "мастер создал зону «Лес» из 5 гексов");
  await shot(page, "zone");

  /* 2. Держава поверх леса: другой слой ---------------------------- */
  await act("zoneTarget", '[data-id="new"]');
  await act("pickType", '[data-id="realm"]');
  await page.fill('#artarius-ui [data-key="zone-name"]', "Огненное царство");
  await drag([2, 3], [4, 5]);
  await act("attach");
  a = await atlas();
  const realm = a.find(z => z.typeId === "realm");
  check(realm?.name === "Огненное царство" && a.find(z => z.typeId === "forest").cells === 5, "держава легла поверх леса, лес цел");

  /* 3. Горы забирают гексы у леса ---------------------------------- */
  await act("zoneTarget", '[data-id="new"]');
  await act("pickType", '[data-id="mountains"]');
  await click([3, 7]);
  await click([3, 8]);
  await act("attach");
  a = await atlas();
  check(a.find(z => z.typeId === "forest").cells === 3 && a.find(z => z.typeId === "mountains").cells === 2, "горы забрали у леса 2 гекса");

  /* 4. Рисовать сразу в выбранную зону ----------------------------- */
  const forestId = a.find(z => z.typeId === "forest").id;
  await act("zoneTarget", `[data-id="${forestId}"]`);
  await page.locator('#artarius-ui input[data-model="zone.paint"]').check();
  await drag([6, 10], [6, 14]);
  a = await atlas();
  check(a.find(z => z.id === forestId).cells === 8, "в режиме «рисовать сразу» протяжка ушла в лес");
  await page.locator('#artarius-ui input[data-model="zone.paint"]').uncheck();

  /* 5. Убрать гексы из слоя --------------------------------------- */
  await click([6, 10]); await click([6, 11]);
  await page.selectOption('#artarius-ui select[data-model="zone.detachLayer"]', "terrain");
  await act("detach");
  a = await atlas();
  check(a.find(z => z.id === forestId).cells === 6, "кнопка «Убрать» сняла 2 гекса со слоя местности");
  await click([1, 12]);
  await act("clearSelection");
  check((await ev(() => window.art.studio.selection.size)) === 0, "«снять выбор» очищает выделение");
  await page.fill('#artarius-ui [data-key="zone-filter"]', "огнен");
  check((await page.locator("#artarius-ui .art-zone-list .art-zone").count()) === 1, "поиск зоны фильтрует список");
  await page.fill('#artarius-ui [data-key="zone-filter"]', "");

  /* 6. Метки ------------------------------------------------------- */
  await act("tool", '[data-tool="mark"]');
  await act("pickType", '[data-id="fortress"]');
  await click([3, 5]); await click([8, 10]);
  await page.fill('#artarius-ui [data-key="mark-name"]', "Винтерфол");
  await act("placeMarks");
  a = await atlas();
  check(a.filter(x => x.kind === "object" && x.name === "Винтерфол").length === 2, "на 2 гекса встали 2 метки");
  await page.locator('#artarius-ui input[data-model="mark.paint"]').check();
  await click([10, 3]);
  a = await atlas();
  check(a.filter(x => x.kind === "object").length === 3, "«ставить сразу» ставит метку щелчком");
  await page.locator('#artarius-ui input[data-model="mark.paint"]').uncheck();

  /* 7. Новый тип метки: создать, изменить, удалить ------------------ */
  await act("newType", '[data-kind="object"]');
  await page.fill('#artarius-ui [data-key="tf-name"]', "Маяк");
  await act("pickIcon", '[data-icon$="/lighthouse.svg"]');
  await act("browseIcon");
  await act("saveType");
  let types = await ev(() => window.art.backend.atlasTypes);
  const beacon = types.find(t => t.name === "Маяк");
  check(beacon && beacon.style.icon === "icons/svg/tower.svg" && beacon.style.tint === false && (await ev(() => window.art.studio.mark.typeId)) === beacon.id, "новый тип «Маяк» сохранён и выбран");
  await act("editType", `[data-id="${beacon.id}"]`);
  await page.fill('#artarius-ui [data-key="tf-name"]', "Большой маяк");
  await act("saveType");
  types = await ev(() => window.art.backend.atlasTypes);
  check(types.some(t => t.name === "Большой маяк"), "тип переименован");
  await act("editType", `[data-id="${beacon.id}"]`);
  await act("cancelType");
  await act("editType", `[data-id="${beacon.id}"]`);
  await act("deleteType", `[data-id="${beacon.id}"]`);
  types = await ev(() => window.art.backend.atlasTypes);
  check(!types.some(t => t.id === beacon.id), "тип удалён");

  /* 8. Линия ------------------------------------------------------- */
  await act("tool", '[data-tool="line"]');
  await act("pickType", '[data-id="river"]');
  await click([3, 5]); await click([5, 10]); await click([9, 12]); await click([11, 17]);
  await act("undoPoint");
  check((await ev(() => window.art.studio.line.points.length)) === 3, "кнопка отмены точки убирает последнюю");
  await page.fill('#artarius-ui [data-key="line-name"]', "Быстрая");
  await act("finishLine");
  a = await atlas();
  check(a.some(x => x.kind === "line" && x.name === "Быстрая"), "линия «Быстрая» создана");
  await click([2, 12]); await click([3, 13]);
  await act("clearLine");
  check((await ev(() => window.art.studio.line.points.length)) === 0, "сброс линии работает");
  await shot(page, "line");

  /* 9. Карточка гекса ---------------------------------------------- */
  await act("tool", '[data-tool="select"]');
  await page.click('#artarius-layerbar [data-action="toggleLayerPanel"]');
  check(await page.locator("#artarius-layerbar .art-lb-grid").isVisible(), "кнопка «Слои» у сцены открывает панель слоёв");
  await page.click('#artarius-layerbar [data-action="toggleLayer"][data-id="politics"]');
  check((await ev(() => window.art.backend.atlasLayers.find(l => l.id === "politics").visible)) === false, "кнопка слоя скрывает слой");
  check(!(await page.locator('#artarius-layerbar [data-id="politics"]').getAttribute("class")).includes(" on"), "выключенный слой виден на кнопке");
  check(await page.locator('#artarius-layerbar [data-id="@temp"]').isDisabled(), "слой без данных (температура) недоступен");
  await page.click('#artarius-layerbar [data-action="toggleLayer"][data-id="politics"]');
  await page.keyboard.press("Escape");
  check(!(await page.locator("#artarius-layerbar .art-lb-panel").count()), "Esc закрывает панель слоёв");
  await click([3, 5]);
  check(await page.locator("#artarius-hud .art-hud-left").isVisible() && !(await page.locator(".art-right").isVisible()),
    "щелчок осмотром ставит панель на гекс, большое окно не открывается");
  {
    const hb = await page.locator("#artarius-hud .art-hud-left").boundingBox();
    const hr = await page.locator("#artarius-hud .art-hud-right").boundingBox();
    const c = await at([3, 5]);
    check(hb && hr && hb.x + hb.width < c.x && hr.x > c.x && Math.abs((hb.y + (hb.height / 2)) - c.y) < 4,
      "кнопки панели стоят слева и справа от гекса");
    const plate = await page.locator("#artarius-hud .art-hud-plate").textContent();
    check(plate.includes("3:5"), `сводка гекса над клеткой: ${plate.trim().replace(/\s+/g, " ")}`);
  }
  await shot(page, "hud");
  await hud("hudDetails");
  check(await page.locator(".art-right").isVisible(), "кнопка «Подробно» открывает карточку гекса");
  const sections = await page.locator(".art-right .art-block h4").allTextContents();
  check(sections.length === 3, `в карточке зоны, метки и линии: ${sections.join(" | ")}`);
  const markId = await ev(() => window.art.studio.contents().marks[0].id);
  await act("openItem", `[data-id="${markId}"]`);
  await page.fill(`#artarius-ui [data-key="${markId}:name"]`, "Винтерфол-на-Скале");
  await page.selectOption(`#artarius-ui select[data-key="${markId}:demiurge"]`, "a-ice");
  check(!(await page.locator(`#artarius-ui [data-action="addStatus"][data-id="${markId}"]`).count()), "статусы сначала только для чтения");
  await act("editStatuses", `[data-id="${markId}"]`);
  await act("addStatus", `[data-id="${markId}"][data-path="statuses"]`);
  await page.fill(`#artarius-ui [data-key="${markId}:statuses.0.name"]`, "Голод");
  await page.fill(`#artarius-ui [data-key="${markId}:statuses.0.max"]`, "10");
  await page.locator(`#artarius-ui [data-key="${markId}:statuses.0.max"]`).blur();
  await act("stepLevel", `[data-id="${markId}"][data-path="statuses"][data-delta="1"]`);
  await act("stepLevel", `[data-id="${markId}"][data-path="statuses"][data-delta="1"]`);
  await act("stepLevel", `[data-id="${markId}"][data-path="statuses"][data-delta="-1"]`);
  await ev(() => window.art.studio.flush());
  a = await atlas();
  let m = a.find(x => x.id === markId);
  check(m.name === "Винтерфол-на-Скале" && m.demiurge === "a-ice" && m.statuses[0].name === "Голод" && m.statuses[0].value === 1 && m.statuses[0].max === 10, "имя, демиург и статус «Голод (1/10)» сохранены");
  await act("addStatus", `[data-id="${markId}"][data-path="statuses"]`);
  await page.fill(`#artarius-ui [data-key="${markId}:statuses.1.name"]`, "Защищённая крепость");
  await act("toAspect", `[data-id="${markId}"][data-n="1"]`);
  await act("addAspect", `[data-id="${markId}"]`);
  await act("addStatus", `[data-id="${markId}"][data-path="aspects.0.statuses"]`);
  await page.fill(`#artarius-ui [data-key="${markId}:aspects.0.statuses.0.name"]`, "Осада");
  await act("stepLevel", `[data-id="${markId}"][data-path="aspects"][data-n="0"][data-delta="1"]`);
  await act("removeStatus", `[data-id="${markId}"][data-path="aspects.0.statuses"]`);
  await act("removeAspect", `[data-id="${markId}"][data-n="1"]`);
  await ev(() => window.art.studio.flush());
  a = await atlas();
  m = a.find(x => x.id === markId);
  check(m.statuses.length === 1 && m.aspects.length === 1 && m.aspects[0].name === "Защищённая крепость" && m.aspects[0].value === 1, "статус стал аспектом, уровни аспекта и его статусы работают");
  await act("editStatuses", '[data-id=""]');
  check(await page.locator(`#artarius-ui .art-view-block .art-chip`).count() >= 2, "после «Готово» статусы и аспекты видны значками");
  await act("editStatuses", `[data-id="${markId}"]`);
  await act("removeStatus", `[data-id="${markId}"][data-path="statuses"]`);
  await page.fill(`#artarius-ui textarea[data-key="${markId}:text"]`, "Северная твердыня.");
  await page.locator(`#artarius-ui textarea[data-key="${markId}:text"]`).blur();
  await act("pan", `[data-id="${markId}"]`);
  check((await ev(() => window.art.backend.log.some(l => l[0] === "pan"))), "«Показать» наводит камеру");
  await shot(page, "card");
  const zoneId = await ev(() => window.art.studio.contents().zones[0].id);
  const before = (await atlas()).find(x => x.id === zoneId).cells;
  await act("openItem", `[data-id="${zoneId}"]`);
  if ( await page.locator(`#artarius-ui input[type="color"][data-key="${zoneId}:color"]`).count() ) {
    await page.locator(`#artarius-ui input[type="color"][data-key="${zoneId}:color"]`).fill("#3355aa");
  }
  await act("removeCell", `[data-id="${zoneId}"]`);
  a = await atlas();
  check(a.find(x => x.id === zoneId).cells === before - 1, "«Убрать гекс из зоны» убирает осматриваемый гекс");
  await act("openItem", `[data-id="${markId}"]`);
  await act("deleteFeature", `[data-id="${markId}"]`);
  a = await atlas();
  check(!a.some(x => x.id === markId), "метка удалена из карточки");
  await act("closeRight");
  check(!(await page.locator(".art-right").isVisible()), "крестик закрывает карточку");

  /* 9б. Панель на гексе и метки как в Civ 5 ------------------------ */
  await act("tool", '[data-tool="mark"]');
  await act("tool", '[data-tool="select"]');
  await click([6, 6]);
  const marksAt = async cell => ev(([i, j]) => window.art.studio.markSlots().cells.get(`${i},${j}`)?.count ?? 0, cell);
  const before6 = await marksAt([6, 6]);
  await hud("hudMark");
  check(await page.locator("#artarius-hud .art-hud-menu").isVisible(), "кнопка метки на панели открывает выбор типа");
  const secondType = await ev(() => window.art.studio.typesOf("object")[1].id);
  await hud("quickMark", `[data-id="${secondType}"]`);
  check(!(await page.locator("#artarius-hud .art-hud-menu").count()), "после выбора типа меню закрывается");
  check((await ev(() => window.art.studio.markTypesForMenu()[0].id)) === secondType, "недавний тип встаёт первым в меню");
  await hud("hudMark");
  await hud("quickMark");
  await hud("hudMark");
  await hud("quickMark");
  check((await marksAt([6, 6])) === before6 + 3, "кнопка метки на панели ставит метку на этот гекс");
  check(await page.locator('#map [data-count="6,6"]').count() === 1, "на гексе со многими метками виден счётчик");
  {
    const slots = await ev(() => window.art.studio.markSlots().slots.filter(s => s.key === "6,6"));
    const r = await ev(() => window.art.backend.grid.radius);
    const c = await ev(() => window.art.backend.grid.center([6, 6]));
    const apart = slots.every((a1, n) => slots.every((b1, k) => k === n || Math.hypot(a1.x - b1.x, a1.y - b1.y) >= Math.min(a1.d, b1.d) * 0.95));
    const inside = slots.every(s1 => Math.hypot(s1.x - c.x, s1.y - c.y) + (s1.d / 2) <= r * 0.95);
    const big = slots.every(s1 => s1.d >= r * 0.6);
    check(apart && inside && big, "метки в гексе не налезают друг на друга, остаются в клетке и не мельчают");
  }
  await shot(page, "civ-marks");
  // Тащим одну метку из группы на соседний гекс.
  {
    const slot = await ev(() => window.art.studio.markSlots().slots.find(s => s.key === "6,6" && s.id));
    const from = await ev(pt => window.art.view.project(pt), { x: slot.x, y: slot.y });
    const to = await at([8, 7]);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    check(await page.locator("#map .drop").count() === 1, "при перетаскивании подсвечен гекс, куда ляжет метка");
    await page.mouse.up();
    const moved = await ev(id => window.art.backend.atlas.get(id).system.geometry, slot.id);
    check(moved.cell.join() === "8,7" && (await marksAt([6, 6])) === before6 + 2, "метка перетащена зажатой кнопкой на другой гекс");
    const inspected = await ev(() => window.art.studio.inspected?.join());
    check(inspected === "6,6", "перетаскивание не переключает осматриваемый гекс");
  }
  await hud("hudDetails", '[data-id]');
  check(await page.locator(".art-right .art-item.open").count() === 1, "значок на панели открывает свой элемент в карточке");
  await act("closeRight");
  await act("tool", '[data-tool="zone"]');
  await act("tool", '[data-tool="select"]');
  await click([6, 6]);
  const zonesBefore = await ev(() => window.art.studio.contents().zones.length);
  await hud("hudZone");
  check((await ev(() => window.art.studio.contents().zones.length)) >= Math.max(1, zonesBefore), "кнопка зоны на панели добавляет гекс в зону");
  await hud("hudPan");
  {
    // Щелчок по метке выбирает её и панель не трогает, поэтому щёлкаем по краю гекса, мимо меток.
    const edge = await ev(() => { const { backend, view } = window.art; const c = backend.grid.center([6, 6]); return view.project({ x: c.x, y: c.y + backend.grid.radius * 0.82 }); });
    await page.mouse.click(edge.x, edge.y);
  }
  check(!(await page.locator("#artarius-hud .art-hud-left").isVisible()), "повторный щелчок по гексу убирает панель");
  await click([6, 6]);
  await hud("hudClose");
  check(!(await page.locator("#artarius-hud .art-hud-left").isVisible()), "крестик убирает панель");

  /* 11. Игрок рисует и отправляет заявку --------------------------- */
  await user("fire");
  await act("tool", '[data-tool="zone"]');
  await act("zoneTarget", '[data-id="new"]');
  await act("pickType", '[data-id="realm"]');
  await page.fill('#artarius-ui [data-key="zone-name"]', "Пепельный край");
  await drag([9, 12], [9, 15]);
  await act("attach");
  check((await ev(() => window.art.backend.flags.fire.draft && Object.keys(window.art.backend.flags.fire.draft).length)) === 1, "правка игрока ушла в черновик");
  check((await atlas()).every(x => x.name !== "Пепельный край"), "атлас без одобрения не меняется");
  await act("zoneTarget", '[data-id="new"]');
  await act("newType", '[data-kind="area"]');
  await page.fill('#artarius-ui [data-key="tf-name"]', "Пепел");
  await page.selectOption('#artarius-ui select[data-model="typeForm.layerId"]', "terrain");
  await act("saveType");
  await click([10, 12]);
  await act("attach");
  await act("openQueue");
  const ashOp = await ev(() => Object.values(window.art.backend.flags.fire.draft).find(op => op.state?.name === "Пепел").id);
  await act("undoOp", `[data-id="${ashOp}"]`);
  check((await ev(() => Object.keys(window.art.backend.flags.fire.draft).length)) === 1, "отмена правки в черновике");
  await click([10, 12]);
  await act("attach");
  await page.fill('#artarius-ui [data-key="claim-title"]', "Огонь занимает пустоши");
  await act("submit");
  check((await ev(() => window.art.backend.flags.fire.claims.length)) === 1, "игрок отправил заявку");
  await shot(page, "player");

  await user("ice");
  await act("tool", '[data-tool="mark"]');
  await click([12, 12]);
  await act("placeMarks");
  await act("openQueue");
  check(!(await page.locator('#artarius-ui [data-action="submit"]').isDisabled()), "кнопка отправки доступна без очереди ходов");

  /* 12. Мастер решает --------------------------------------------- */
  await user("gm");
  await act("openQueue");
  const claimId = await ev(() => window.art.backend.claims()[0].claim.id);
  await act("preview", `[data-id="${claimId}"]`);
  check((await ev(() => window.art.studio.ghosts().length)) >= 2, "предпросмотр показывает правки на карте");
  const pans = await ev(() => window.art.backend.log.filter(([k]) => k === "pan").length);
  await act("claimGoTo", `[data-id="${claimId}"]`);
  check((await ev(() => window.art.backend.log.filter(([k]) => k === "pan").length)) === pans + 1, "«Перейти» ведёт камеру к заявке");
  await page.locator("#artarius-ui .art-diff summary").first().click();
  check(await page.locator("#artarius-ui .art-diff[open] table").count() === 1, "«было/стало» раскрывается под стрелкой");
  await shot(page, "queue");
  await act("checkAll");
  await act("applyChecked");
  a = await atlas();
  check(a.some(x => x.name === "Пепельный край") && (await ev(() => window.art.backend.atlasTypes.some(t => t.name === "Пепел"))), "пакетное принятие внесло заявку и личный тип игрока");
  await user("ice");
  await act("openQueue");
  await page.fill('#artarius-ui [data-key="claim-title"]', "Лёд");
  await act("submit");
  await user("gm");
  await act("openQueue");
  const iceClaim = await ev(() => window.art.backend.claims()[0].claim.id);
  await act("requestCheck", `[data-id="${iceClaim}"]`);
  await ev(() => { window.art.backend.promptAnswer = "Рано"; });
  await act("check", `[data-id="${iceClaim}"]`);
  await act("rejectChecked");
  check((await ev(() => window.art.backend.flags.ice.claims[0].status)) === "rejected", "отклонение с причиной");
  await user("ice");
  await act("openQueue");
  await act("returnToDraft");
  check((await ev(() => window.art.backend.flags.ice.claims.length)) === 0 && (await ev(() => Object.keys(window.art.backend.flags.ice.draft).length)) === 1, "отклонённая заявка вернулась в черновик");
  await user("fire");
  await act("openQueue");
  await act("dropClaim");
  check((await ev(() => window.art.backend.flags.fire.claims.length)) === 0, "принятую заявку можно убрать из списка");

  /* 13. Прочие кнопки меню ---------------------------------------- */
  await user("gm");
  await act("tool", '[data-tool="select"]');
  await act("help");

  /* 14. Окно настроек: свои слои, мир (0.7.0) ----------------------- */
  await act("openSettings");
  check(await page.locator("#artarius-ui .art-settings").isVisible(), "кнопка «Настройки» открывает окно настроек");
  await act("settingsPick", '[data-id="new"]');
  await page.fill('#artarius-ui [data-key="lf-name"]', "Магия");
  await page.locator('#artarius-ui input[data-model="layerForm.exclusive"]').uncheck();
  await act("saveLayer");
  let layers = await ev(() => window.art.backend.layers());
  const magic = layers.find(l => l.name === "Магия");
  check(magic && magic.exclusive === false && layers.at(-1).id === magic.id, "новый слой «Магия» добавлен в конец, зоны накладываются");
  await act("layerUp", `[data-id="${magic.id}"]`);
  layers = await ev(() => window.art.backend.layers());
  check(layers.at(-2).id === magic.id, "слой поднимается выше");
  await page.fill('#artarius-ui [data-key="lf-name"]', "Чары");
  await page.press('#artarius-ui [data-key="lf-name"]', "Enter");
  check((await ev(() => window.art.backend.layers())).some(l => l.name === "Чары"), "слой переименован");
  await act("settingsSection", '[data-section="area"]');
  await act("settingsPick", '[data-id="new"]');
  await page.fill('#artarius-ui [data-key="tf-name"]', "Аура");
  await page.selectOption('#artarius-ui select[data-model="typeForm.layerId"]', magic.id);
  await act("saveType");
  check((await ev(id => window.art.backend.atlasTypes.find(t => t.name === "Аура")?.layerId === id, magic.id)), "тип зоны лёг в свой слой");
  check((await ev(() => window.art.studio.settings.open)), "окно настроек остаётся открытым после сохранения типа");
  await act("settingsSection", '[data-section="layers"]');
  await act("settingsPick", `[data-id="${magic.id}"]`);
  await act("deleteLayer", `[data-id="${magic.id}"]`);
  layers = await ev(() => window.art.backend.layers());
  check(!layers.some(l => l.id === magic.id) && (await ev(() => window.art.backend.atlasTypes.find(t => t.name === "Аура")?.layerId)) === "overlay", "слой удалён, его типы переехали в «Прочее»");
  check(!(await page.locator('#artarius-ui [data-action="deleteLayer"][data-id="terrain"]').count()), "местность удалить нельзя");
  await act("settingsSection", '[data-section="world"]');
  check(await page.locator('#artarius-ui details[data-fold="settings"][open]').count() === 1, "во вкладке «Мир» настройки раскрыты, остальное свёрнуто");
  await page.fill('#artarius-ui [data-wf="settings.cols"]', "40");
  await ev(() => window.art.studio.changed("ui"));
  check((await page.inputValue('#artarius-ui [data-wf="settings.cols"]')) === "40", "набранное в полях «Мира» не стирается перерисовкой");
  await act("wfSettings");
  const saved = await ev(() => JSON.parse(window.art.backend.log.find(l => l[0] === "applyWorldSettings")[1]));
  check(saved.dims.cols === 40 && saved.world.baseColor === "#1f3b57", "«Сохранить» пишет размер поля и цвета");
  await page.click('#artarius-ui details[data-fold="azgaar"] > summary');
  await page.setInputFiles('#artarius-ui [data-wf-file="azgaar"]', { name: "map.json", mimeType: "application/json", buffer: Buffer.from('{"info":{}}') });
  await page.waitForTimeout(150);
  check(await page.locator('#artarius-ui details[data-fold="azgaar"][open]').count() === 1, "раскрытый раздел остаётся раскрытым");
  await page.click('#artarius-ui details[data-fold="azgaar"] [data-wf="azgaar.part.provinces"]');
  await act("wfImport");
  const imp = await ev(() => JSON.parse(window.art.backend.log.find(l => l[0] === "importAzgaar")[1]));
  check(imp.name === "map.json" && imp.options.parts.provinces === true && imp.options.parts.cultures === true, "импорт Azgaar берёт файл и галочки частей прямо из вкладки");
  await page.click('#artarius-ui details[data-fold="gen"] > summary');
  await page.fill('#artarius-ui [data-wf="gen.seed"]', "abc");
  await act("wfGenerate");
  const g = await ev(() => JSON.parse(window.art.backend.log.find(l => l[0] === "generateWorld")[1]));
  check(g.seed === "abc" && g.water === 0.35 && g.realmCount === 2, "генератор запускается из вкладки с набранным зерном");
  await act("azgaar");
  check((await ev(() => ["azgaar", "guide"].every(k => window.art.backend.log.some(l => l[0] === k)))), "Azgaar открывается и отдельным окном, справка — своим");
  await act("closeSettings");
  check(!(await page.locator("#artarius-ui .art-settings").isVisible()), "крестик закрывает настройки");
  await act("rightTab", '[data-tab="tile"]');
  await act("tool", '[data-tool="select"]');
  check(await page.locator(".art-left").isVisible(), "повторный щелчок по инструменту его не выключает");
  await act("toggleMenu", ".art-icon-btn");
  check(!(await page.locator(".art-left").isVisible()), "крестик в шапке убирает панель инструмента");
  await shot(page, "end");

  // 0.6.2: значки-маски (палитра, панель на гексе, карточки) грузятся по полному адресу.
  await ev(() => window.art.studio.setTool("mark", { toggle: false }));
  await page.waitForTimeout(100);
  const masks = await ev(async () => {
    const urls = [...document.querySelectorAll(".art-mask")]
      .map(el => (getComputedStyle(el).webkitMaskImage || getComputedStyle(el).maskImage || "").match(/url\("?(.*?)"?\)/)?.[1])
      .filter(Boolean);
    const bad = [];
    for ( const u of new Set(urls) ) if ( !(await fetch(u)).ok ) bad.push(u);
    return { n: urls.length, bad };
  });
  check(masks.n > 0 && !masks.bad.length, `значки-маски загружаются (${masks.n}, битых: ${masks.bad.join(", ")})`);

  // 0.6.3: палитра цвета не закрывается на каждом шаге, значок перекрашивается сразу, код цвета рядом.
  await act("newType", '[data-kind="object"]');
  const live = await ev(() => {
    const el = document.querySelector('#artarius-ui input[type="color"][data-model="typeForm.color"]');
    el.value = "#ff0000";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    const big = document.querySelector("#artarius-ui .art-icon-big");
    return { same: el.isConnected, c: big?.style.getPropertyValue("--c"), hex: el.nextElementSibling?.value };
  });
  check(live.same && live.c === "#ff0000" && live.hex === "#ff0000", "палитра остаётся открытой, значок и код меняются сразу");
  await ev(() => {
    const el = document.querySelector('#artarius-ui input[type="color"][data-model="typeForm.color"]');
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  check((await ev(() => window.art.studio.typeForm.color)) === "#ff0000", "цвет записан, когда палитру закрыли");
  await page.fill('#artarius-ui .art-color-hex[data-model="typeForm.color"]', "00ff00");
  await page.press('#artarius-ui .art-color-hex[data-model="typeForm.color"]', "Tab");
  check((await ev(() => window.art.studio.typeForm.color)) === "#00ff00", "код цвета вводится руками");
  await act("cancelType");

  /* 15. 0.8.0: осмотр нескольких гексов, порядок и форма меток ---- */
  await act("tool", '[data-tool="select"]');
  await click([2, 12]);
  await click([3, 12], ["Shift"]);
  await click([4, 12], ["Shift"]);
  check((await ev(() => window.art.studio.inspectCells().length)) === 3, "Shift-щелчки осматривают три гекса");
  check((await page.locator("#artarius-hud .art-hud-plate").innerText()).includes("Гексов: 3"), "панель гекса пишет, сколько гексов в осмотре");
  await click([2, 12]);
  check((await ev(() => window.art.studio.multi)) === false, "простой щелчок возвращает осмотр одного гекса");
  await ev(async () => {
    const s = window.art.studio;
    const types = s.typesOf("object");
    for ( const t of types.slice(0, 2) ) { s.mark.typeId = t.id; s.mark.name = t.name; await s.placeMarks([[2, 12]]); }
  });
  await click([2, 12]);
  await click([2, 12]);
  const ids = await ev(() => window.art.studio.contents().marks.map(m => m.id));
  check(ids.length === 2 && (await page.locator("#artarius-hud [data-drag-mark]").count()) === 2, "метки гекса можно тянуть на панели");
  await hud("hudDetails", `[data-id="${ids[1]}"]`);
  await act("markUp", `[data-id="${ids[1]}"]`);
  check((await ev(() => window.art.studio.contents().marks.map(m => m.id).join())) === [ids[1], ids[0]].join(), "кнопка «Раньше» меняет порядок меток");
  await act("setShape", `[data-id="${ids[1]}"][data-shape="shield"]`);
  check((await page.locator(`#map [data-mark="${ids[1]}"] [data-shape="shield"]`).count()) === 1, "форма метки «щит» видна на карте");

  /* 16. 0.9.0: линии соединяются, подсказка, края гексов, вид ------ */
  await act("closeRight");
  await act("tool", '[data-tool="line"]');
  await act("pickType", '[data-id="road"]');
  await act("lineMode", '[data-mode="hex"]');
  await click([10, 2]); await click([10, 5]);
  await page.fill('#artarius-ui [data-key="line-name"]', "Тракт");
  await act("finishLine");
  await click([10, 5]); await click([12, 8]);
  await act("finishLine");
  const roads = await ev(() => [...window.art.backend.atlas.values()].filter(s => s.system.typeId === "road"));
  check(roads.length === 1 && roads[0].name === "Тракт", "вторая дорога от конца первой стала её продолжением");
  // Между центрами гексов: на линии, но мимо меток (метка под курсором показала бы свою карточку).
  const m3 = await at([10, 3]), m4 = await at([10, 4]);
  const mid = { x: (m3.x + m4.x) / 2, y: (m3.y + m4.y) / 2 };
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.move(mid.x + 1, mid.y);
  check((await page.locator("#artarius-tip").isVisible()) && (await page.locator("#artarius-tip .art-hc-title").innerText()) === "Тракт", "наведение на линию показывает её название");
  check((await page.locator("#artarius-tip .art-hc-sub").innerText()).includes("Дорога"), "в карточке при наведении виден тип");
  await page.mouse.move(m3.x, m3.y);
  await page.mouse.move(m3.x + 1, m3.y);
  check((await page.locator("#artarius-tip .art-hc-sub").innerText()).length > 0 && (await page.locator("#artarius-tip .art-hc-title").innerText()) !== "Тракт", "наведение на метку показывает её карточку, а не линию под ней");
  await act("lineMode", '[data-mode="edge"]');
  await click([6, 12]); await click([6, 15]);
  check((await ev(() => window.art.studio.line.points.length)) > 4, "по краям гексов линия идёт по рёбрам клеток");
  await act("clearLine");
  await act("editType", '[data-id="road"]');
  await act("lineShape", '[data-v="rounded"]');
  await act("linePattern", '[data-v="dot"]');
  check((await page.locator("#artarius-ui .art-line-preview path[stroke-dasharray]").count()) === 1, "образец линии показывает точки");
  await act("saveType");
  check((await ev(() => window.art.backend.atlasTypes.find(t => t.id === "road").style.shape)) === "rounded", "вид типа линии сохранён");
  check((await page.locator('#map [data-line][data-shape="rounded"]').count()) >= 1, "линия на карте перерисована по новому виду");

  // 0.5.0: щелчок выбирает метку, Delete удаляет, Ctrl+Z возвращает, Ctrl+Shift+Z снова удаляет. Правая кнопка не удаляет.
  await act("closeRight").catch(() => {});
  await ev(() => { const s = window.art.studio; s.setTool("mark", { toggle: false }); s.mark.typeId = s.typesOf("object")[0].id; return s.placeMarks([[9, 9]]); });
  await ev(() => window.art.studio.setTool("select", { toggle: false }));
  const marksN = () => ev(() => [...window.art.backend.atlas.values()].filter(s => s.system.kind === "object").length);
  const marksBefore = await marksN();
  const mk = await ev(() => { const s = window.art.studio; const sl = s.markSlots().slots.find(x => x.cell[0] === 9 && x.cell[1] === 9); return { x: sl.x, y: sl.y }; });
  const scr = await ev(p => { const svg = document.querySelector("#map svg") ?? document.querySelector("svg"); const q = svg.createSVGPoint(); q.x = p.x; q.y = p.y; const r = q.matrixTransform(svg.getScreenCTM()); return { x: r.x, y: r.y }; }, mk);
  await page.mouse.click(scr.x, scr.y, { button: "right" });
  await page.waitForTimeout(100);
  check((await marksN()) === marksBefore, "правая кнопка метку не удаляет");
  await page.mouse.click(scr.x, scr.y);
  await page.waitForTimeout(100);
  check((await ev(() => window.art.studio.markSel.size)) === 1, "щелчок по метке выбирает её");
  check(await page.locator("#artarius-bar:not([hidden]) .art-bar-count").isVisible(), "внизу видна панель выбранных меток");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(100);
  check((await marksN()) === marksBefore - 1, "Delete удаляет выбранную метку");
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  check((await marksN()) === marksBefore, "Ctrl+Z возвращает удалённую метку");
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(150);
  check((await marksN()) === marksBefore - 1, "Ctrl+Shift+Z снова удаляет");
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  await page.keyboard.press("Shift+Space");
  await page.waitForTimeout(100);
  check(await page.locator("#art-goto-field").isVisible(), "Shift+Пробел открывает «Перейти к гексу»");
  await page.fill("#art-goto-field", "9 9");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  check((await ev(() => window.art.studio.inspected?.join(":"))) === "9:9", "переход по «9 9» открывает гекс 9:9");
  await ev(() => {
    const st = document.createElement("style");
    st.textContent = "#artarius-ui button{display:flex;align-items:center;justify-content:center;flex:1 1 auto}";
    document.head.appendChild(st);
    const s = window.art.studio; s.openSettings("object"); s.openTypeForm("object");
  });
  await page.waitForTimeout(200);
  const iw = await ev(() => document.querySelector(".art-icon-pick .art-icon-img")?.getBoundingClientRect().width ?? 0);
  check(iw >= 30, `значок в выборе виден под кнопками в стиле Foundry (${iw}px)`);
  const ac = await ev(() => { const b = document.querySelector(".art-icon-cats .art-btn.active"); const c = getComputedStyle(b); return [c.color, c.borderColor]; });
  check(ac[0] !== ac[1], "текст выбранной кнопки не красится в цвет рамки");

  /* 17. Игра с игроками: права и видимость -------------------------- */
  await ev(() => window.art.studio.openSettings("rights"));
  await page.waitForTimeout(150);
  await page.locator('#artarius-ui [data-change="permRole"][data-role="1"][data-perm="draw"]').uncheck();
  check((await ev(() => window.art.backend.permConfig?.roles?.[1]?.draw)) === false, "галочка права у роли пишет настройку");
  await shot(page, "rights");
  await ev(async () => {
    const s = window.art.studio; s.closeSettings?.();
    s.setTool("mark", { toggle: false }); await s.placeMarks([[3, 9]]); s.setTool("select", { toggle: false });
    s.inspect([3, 9], { toggle: false }); s.openDetails();
    s.openId = s.contents().marks.at(-1).id; s.changed("ui");
  });
  await page.waitForTimeout(150);
  const vis = page.locator('#artarius-ui [data-change="visMode"]').first();
  check(await vis.count() === 1, "в карточке метки есть «Кто видит»");
  await vis.selectOption("gm");
  await page.waitForTimeout(150);
  check((await ev(() => [...window.art.backend.atlas.values()].some(x => x.system.visibility?.mode === "gm"))), "метку можно спрятать");
  await shot(page, "visibility");

  const pageErrors = await ev(() => window.artErrors);
  assert.deepEqual([...errors, ...pageErrors], [], "ошибок в консоли нет");
  console.log("✓ ошибок в консоли нет");
  await browser.close();
  server.close();
})().catch(err => { console.error("✗", err.message); process.exit(1); });
