// Дымовой тест в поддельном Foundry: npm run smoke.
const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const TYPES = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

(async () => {
  const server = http.createServer((req, res) => {
    // Foundry отдаёт модуль по modules/artarius/…: здесь это корень репозитория.
    const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^.*\/modules\/artarius\//, "/");
    const file = path.join(root, pathname);
    if ( !file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory() ) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, r));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.stack ?? e.message));
  page.on("console", m => { if ( m.type() === "error" && !m.text().startsWith("Failed to load resource") ) errors.push(m.text()); });
  // Значков и файлов Foundry здесь нет: 404 на них не ошибка модуля. Остальные 404 — ошибка.
  page.on("response", r => {
    if ( r.status() === 404 && !/\/icons\//.test(r.url()) ) errors.push(`404 ${r.url()}`);
  });
  await page.goto(`http://localhost:${server.address().port}/tests/foundry/index.html`);
  await page.waitForFunction(() => window.__done || window.__steps?.some(s => !s[1]), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(300);
  const steps = await page.evaluate(() => window.__steps ?? []);
  let bad = 0;
  for ( const [name, ok, err] of steps ) {
    console.log(`${ok ? "✓" : "✗"} ${name}`);
    if ( !ok ) { bad++; console.log(`  ${String(err).split("\n").slice(0, 6).join("\n  ")}`); }
  }
  const done = await page.evaluate(() => !!window.__done);
  if ( !done ) { bad++; console.log("✗ сценарий не дошёл до конца"); }
  const extra = errors.filter(e => !steps.some(s => !s[1] && e.includes(s[0])));
  if ( extra.length ) { bad++; console.log("✗ ошибки в консоли:\n  " + extra.join("\n  ")); }
  else console.log("✓ ошибок в консоли нет");
  await browser.close();
  server.close();
  process.exit(bad ? 1 : 0);
})();
