// Быстрая проверка без Foundry: синтаксис JS, валидность JSON, компиляция шаблонов,
// один корневой элемент у шаблонов окон, все ключи перевода на месте в обоих языках.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Handlebars from "handlebars";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const walk = dir => readdirSync(dir).flatMap(n => {
  const p = path.join(dir, n);
  if ( ["node_modules", ".git", "dist"].includes(n) ) return [];
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const files = walk(root);
let bad = 0;
const fail = (file, msg) => { bad++; console.error("✗", path.relative(root, file), msg); };

for ( const file of files ) {
  try {
    if ( file.endsWith(".mjs") || file.endsWith(".js") ) execFileSync(process.execPath, ["--check", file]);
    else if ( file.endsWith(".json") ) JSON.parse(readFileSync(file, "utf8"));
    else if ( file.endsWith(".hbs") ) Handlebars.precompile(readFileSync(file, "utf8"));
  } catch(err) {
    fail(file, String(err.stderr ?? err.message).slice(0, 400));
  }
}

// Шаблон части окна ApplicationV2 должен давать ровно один корневой элемент.
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
function topLevelCount(html) {
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  let depth = 0, count = 0;
  for ( const [, close, tag, self] of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g) ) {
    if ( close ) { depth--; continue; }
    if ( depth === 0 ) count++;
    if ( !VOID.has(tag.toLowerCase()) && !self ) depth++;
  }
  return count;
}
const hb = Handlebars.create();
hb.registerHelper("localize", k => k);
hb.registerHelper("eq", (a, b) => a === b);
hb.registerHelper("helperMissing", () => "");
for ( const file of files.filter(f => f.endsWith(".hbs")) ) {
  const n = topLevelCount(hb.compile(readFileSync(file, "utf8"))({}).replace(/\{\{>[^}]*\}\}/g, ""));
  if ( n !== 1 ) fail(file, `корневых элементов ${n}, нужен 1`);
}

// Ключи VMAP.* из кода и шаблонов есть в ru.json и en.json, языки совпадают.
const flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) => typeof v === "object" ? flat(v, `${p}${k}.`) : [`${p}${k}`]);
const langs = Object.fromEntries(["ru", "en"].map(l => [l, new Set(flat(JSON.parse(readFileSync(path.join(root, "lang", `${l}.json`), "utf8"))))]));
for ( const k of langs.ru ) if ( !langs.en.has(k) ) fail(path.join(root, "lang/en.json"), `нет ключа ${k}`);
for ( const k of langs.en ) if ( !langs.ru.has(k) ) fail(path.join(root, "lang/ru.json"), `нет ключа ${k}`);
const prefixes = [...langs.ru].map(k => k.split(".").slice(0, -1).join("."));
for ( const file of files.filter(f => /\.(mjs|hbs)$/.test(f) && !f.includes(`${path.sep}tools${path.sep}`)) ) {
  for ( const [key] of readFileSync(file, "utf8").matchAll(/VMAP\.[A-Za-z]+(?:\.[A-Za-z]+)*/g) ) {
    if ( !langs.ru.has(key) && !prefixes.includes(key) ) fail(file, `нет перевода ${key}`);
  }
}

console.log(bad ? `${bad} ошибок` : "lint ok");
process.exit(bad ? 1 : 0);
