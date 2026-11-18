// Built-in icon library: files, tinting, search, credits, migration of 0.3 resource icons.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { allIcons, searchIcons, iconPath, isLibraryIcon, ICON_ROOT } from "../scripts/data/icons.mjs";
import { RESOURCE_TYPES, withResourceTypes } from "../scripts/gen/mapgen.mjs";
import { STARTER_TYPES } from "../scripts/constants.mjs";
import Studio from "../scripts/studio.mjs";
import MemoryBackend from "./harness/memory-backend.mjs";

const local = path => path.replace(`${ICON_ROOT}/`, "assets/icons/").replace("modules/artarius/", "");

test("every library icon is a white SVG on disk", () => {
  const icons = allIcons();
  assert.ok(icons.length >= 60, `значков ${icons.length}`);
  assert.equal(new Set(icons.map(i => i.path)).size, icons.length, "повторы");
  for ( const i of icons ) {
    const svg = fs.readFileSync(local(i.path), "utf8");
    assert.ok(svg.startsWith("<svg"), i.name);
    assert.ok(!svg.includes("currentColor"), `${i.name}: currentColor`);
    const fills = [...svg.matchAll(/fill="([^"]+)"/g)].map(m => m[1]).filter(f => f !== "none");
    assert.ok(fills.every(f => f === "#ffffff"), `${i.name}: ${fills}`);
  }
});

test("default types use icons that ship with the module", () => {
  for ( const t of [...STARTER_TYPES, ...RESOURCE_TYPES].filter(x => x.kind === "object") ) {
    assert.ok(isLibraryIcon(t.style.icon), `${t.id}: ${t.style.icon}`);
    assert.ok(fs.existsSync(local(t.style.icon)), t.style.icon);
  }
});

test("credits file names the source and license", () => {
  const credits = fs.readFileSync("assets/icons/CREDITS.md", "utf8");
  assert.match(credits, /game-icons\.net/);
  assert.match(credits, /CC BY 3\.0/);
  assert.match(credits, /Lorc/);
  assert.match(credits, /Delapouite/);
});

test("search matches Russian labels and file names", () => {
  assert.ok(searchIcons("замок").some(i => i.name === "castle"));
  assert.ok(searchIcons("ORE").some(i => i.name === "ore"));
  assert.equal(searchIcons("").length, allIcons().length);
  assert.equal(searchIcons("нет-такого").length, 0);
});

test("resource types from 0.3 move to library icons", () => {
  const old = [{ id: "res-gold", kind: "object", name: "Золото", style: { icon: "modules/artarius/assets/res/gold.svg", color: "#000" } }];
  const out = withResourceTypes(old);
  assert.equal(out.find(t => t.id === "res-gold").style.icon, iconPath("gold-bar"));
  assert.equal(out.find(t => t.id === "res-gold").style.color, "#000");
  assert.equal(out.filter(t => t.id.startsWith("res-")).length, RESOURCE_TYPES.length);
});

test("own image is not tinted by default, library icon is", async () => {
  const backend = new MemoryBackend();
  const studio = new Studio(backend);
  studio.setTool("mark");
  studio.openTypeForm("object");
  assert.equal(studio.typeForm.icon, iconPath("castle"));
  studio.pickIcon("worlds/test/banner.webp");
  assert.equal(studio.typeForm.tint, false);
  studio.typeForm.name = "Знамя";
  await studio.saveTypeForm();
  const t = backend.types().find(x => x.name === "Знамя");
  assert.equal(t.style.icon, "worlds/test/banner.webp");
  assert.equal(t.style.tint, false);
  studio.openTypeForm("object", t.id);
  studio.pickIcon(iconPath("dragon-head"));
  assert.equal(studio.typeForm.tint, true);
});
