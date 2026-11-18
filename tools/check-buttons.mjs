// Every button has a handler:
//  - data-action in templates → actions of the owning window;
//  - data-action / data-enter / action: "…" in the panels → keys of ArtariusUI#actions;
//  - api.X() calls → keys of the module API in main.mjs.
// Plus: no class field in an ApplicationV2 subclass may shadow a getter of the base class
// (0.2.0 broke every window this way: a `form` field hid ApplicationV2#form).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = p => readFileSync(path.join(root, p), "utf8");
let bad = 0;
const fail = msg => { bad++; console.error("✗", msg); };
const walk = dir => readdirSync(path.join(root, dir), { withFileTypes: true })
  .flatMap(d => d.isDirectory() ? walk(`${dir}/${d.name}`) : [`${dir}/${d.name}`]);
const scripts = walk("scripts").filter(f => f.endsWith(".mjs"));

/* Templates ----------------------------------------------------------- */

/** Template → the window class file whose DEFAULT_OPTIONS.actions handle its buttons. */
const OWNERS = {
  "feature-page.hbs": ["scripts/sheets/feature-page-sheet.mjs"]
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

/* Windows built from strings: data-action → DEFAULT_OPTIONS.actions --- */

for ( const file of ["scripts/apps/azgaar-app.mjs"] ) {
  const src = read(file);
  const keys = actionKeys(src);
  for ( const [, a] of src.matchAll(/data-action="([^"$]+)"/g) ) {
    if ( !keys.has(a) ) fail(`${file}: data-action="${a}" не обработан`);
  }
}

/* Panels -------------------------------------------------------------- */

{
  const file = "scripts/ui/panels.mjs";
  const src = read(file);
  const block = src.match(/get actions\(\) \{[\s\S]*?return \{([\s\S]*?)\n {4}\};/)?.[1] ?? "";
  const keys = new Set([...block.matchAll(/^\s*([A-Za-z]\w*)\s*:/gm)].map(m => m[1]));
  if ( !keys.size ) fail(`${file}: не найден get actions()`);
  const used = new Set([
    ...[...src.matchAll(/data-(?:action|enter)="([A-Za-z]\w*)"/g)].map(m => m[1]),
    ...[...src.matchAll(/\baction:\s*"([A-Za-z]\w*)"/g)].map(m => m[1])
  ]);
  for ( const a of used ) if ( !keys.has(a) ) fail(`${file}: действие "${a}" без обработчика в get actions()`);
  for ( const k of keys ) if ( !used.has(k) ) console.warn(`  ${file}: обработчик "${k}" ни к чему не привязан`);
}

/* Module API ---------------------------------------------------------- */

const main = read("scripts/main.mjs");
const apiBlock = main.match(/\.api = \{([\s\S]*?)\n {2}\};/)?.[1] ?? "";
if ( !apiBlock ) fail("scripts/main.mjs: не найден объект api");
const apiKeys = new Set([...apiBlock.matchAll(/^\s*([A-Za-z]\w*)\s*[:,]/gm), ...apiBlock.matchAll(/,\s*([A-Za-z]\w*)\s*(?=,|\n)/g)].map(m => m[1]));
for ( const file of scripts ) {
  const src = read(file);
  for ( const [, name] of src.matchAll(/\bapi(?:\(\))?\.([A-Za-z]\w*)\(/g) ) {
    if ( !apiKeys.has(name) ) fail(`${file}: api.${name}() нет в API модуля`);
  }
}

/* ApplicationV2: reserved names ---------------------------------------- */

const RESERVED = ["form", "element", "window", "position", "options", "state", "id", "title", "rendered", "minimized", "hasFrame", "classList"];
for ( const file of scripts ) {
  const src = read(file);
  if ( !/extends\s+[\w.()\s]*(ApplicationV2|DocumentSheetV2|JournalEntryPageSheet|HandlebarsApplicationMixin)/.test(src) ) continue;
  for ( const [line, name] of src.matchAll(/^ {2}(?:#)?([A-Za-z]\w*)\s*=(?!=)/gm) ) {
    if ( RESERVED.includes(name) ) fail(`${file}: поле класса "${line.trim()}" перекрывает ApplicationV2#${name}`);
  }
}

console.log(bad ? `${bad} ошибок в кнопках` : "buttons ok");
process.exit(bad ? 1 : 0);
