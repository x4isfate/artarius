// Every button has a handler: data-action in templates → actions of the owning window,
// data-act in the palette → its click switch, api.X() calls → keys of the module API.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = p => readFileSync(path.join(root, p), "utf8");
let bad = 0;
const fail = msg => { bad++; console.error("✗", msg); };

/** Template → the window class file whose DEFAULT_OPTIONS.actions handle its buttons. */
const OWNERS = {
  "atlas-config.hbs": ["scripts/apps/atlas-config.mjs"],
  "azgaar.hbs": ["scripts/apps/azgaar-app.mjs"],
  "claims.hbs": ["scripts/apps/claims-app.mjs"],
  "claim-card.hbs": ["scripts/apps/claims-app.mjs"],
  "op-row.hbs": ["scripts/apps/claims-app.mjs"],
  "feature-sheet.hbs": ["scripts/apps/feature-sheet.mjs"],
  "status-row.hbs": ["scripts/apps/feature-sheet.mjs"],
  "feature-page.hbs": ["scripts/sheets/feature-page-sheet.mjs"],
  "quick-menu-config.hbs": ["scripts/apps/quick-menu-config.mjs"]
};

/** Keys of the `actions: { … }` block in DEFAULT_OPTIONS. */
function actionKeys(src) {
  const m = src.match(/actions:\s*\{([\s\S]*?)\n\s*\}/);
  if ( !m ) return new Set();
  return new Set([...m[1].matchAll(/^\s*([A-Za-z]\w*)\s*:/gm)].map(x => x[1]));
}

for ( const tpl of readdirSync(path.join(root, "templates")) ) {
  const html = read(`templates/${tpl}`);
  const used = new Set([...html.matchAll(/data-action="([^"{]+)"/g)].map(m => m[1]));
  if ( !used.size ) continue;
  const owners = OWNERS[tpl];
  if ( !owners ) { fail(`templates/${tpl}: кнопки есть, а окно-владелец не указано в tools/check-buttons.mjs`); continue; }
  const keys = new Set(owners.flatMap(f => [...actionKeys(read(f))]));
  for ( const a of used ) if ( !keys.has(a) ) fail(`templates/${tpl}: data-action="${a}" не обработан в ${owners.join(", ")}`);
}

// Палитра: data-act → ветка в _onClick.
const palette = read("scripts/canvas/palette.mjs");
for ( const [, act] of palette.matchAll(/data-act="([^"]+)"/g) ) {
  if ( !palette.includes(`act === "${act}"`) ) fail(`palette.mjs: data-act="${act}" без обработчика`);
}

// Вызовы API модуля: api.X(…) и api().X(…) должны быть ключами объекта api в main.mjs.
const main = read("scripts/main.mjs");
const apiBlock = main.match(/\.api = \{([\s\S]*?)\n {2}\};/)?.[1] ?? "";
const apiKeys = new Set([...apiBlock.matchAll(/^\s*([A-Za-z]\w*)\s*[:,]/gm), ...apiBlock.matchAll(/,\s*([A-Za-z]\w*)\s*(?=,|\n)/g)].map(m => m[1]));
const walk = dir => readdirSync(path.join(root, dir), { withFileTypes: true })
  .flatMap(d => d.isDirectory() ? walk(`${dir}/${d.name}`) : [`${dir}/${d.name}`]);
for ( const file of walk("scripts").filter(f => f.endsWith(".mjs")) ) {
  const src = read(file);
  for ( const [, name] of src.matchAll(/\bapi(?:\(\))?\.([A-Za-z]\w*)\(/g) ) {
    if ( !apiKeys.has(name) ) fail(`${file}: api.${name}() нет в API модуля`);
  }
}

console.log(bad ? `${bad} кнопок без обработчика` : "buttons ok");
process.exit(bad ? 1 : 0);
