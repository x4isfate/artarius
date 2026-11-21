// Замер скорости в поддельном Foundry: npm run perf. Падает, если превышен предел.
const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const TYPES = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

(async () => {
  const server = http.createServer((req, res) => {
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
  await page.goto(`http://localhost:${server.address().port}/tests/perf/index.html`);
  await page.waitForFunction(() => window.__done, null, { timeout: 120000 }).catch(() => errors.push("замер не дошёл до конца"));
  const out = await page.evaluate(() => window.__perf ?? {});
  const fails = [...(await page.evaluate(() => window.__fails ?? [])), ...errors];
  for ( const [k, v] of Object.entries(out) ) console.log(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
  for ( const f of fails ) console.log(`✗ ${f}`);
  if ( !fails.length ) console.log("✓ скорость в пределах");
  await browser.close();
  server.close();
  process.exit(fails.length ? 1 : 0);
})();
