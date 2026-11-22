// «Атлас» (0.9): бумажные цвета, вода у берега, значки рельефа, обводка берега.
import { test } from "node:test";
import assert from "node:assert/strict";
import HexMath from "../scripts/hex/hexmath.mjs";
import { ATLAS_PAPER, paperColor, paperTone, waterDistance, waterColor, glyphsFor, coastPairs, sharedEdge, mixColor } from "../scripts/canvas/atlas.mjs";
import { roughEdge, roughPolygon } from "../scripts/geometry/geometry.mjs";
import { WORLD_DEFAULTS, STARTER_TYPES } from "../scripts/constants.mjs";

const hm = new HexMath({ size: 60, rows: 12, cols: 12 });
const cells = hm.allCells();
const k = c => `${c[0]},${c[1]}`;
// Остров 3×3 в середине поля, остальное — пустая вода.
const land = new Set();
for ( let i = 4; i <= 6; i++ ) for ( let j = 4; j <= 6; j++ ) land.add(`${i},${j}`);
const terrainOf = key => (land.has(key) ? "plains" : undefined);

test("atlas is the default look; every starter terrain has a paper color", () => {
  assert.equal(WORLD_DEFAULTS.style, "atlas");
  for ( const t of STARTER_TYPES.filter(x => x.layerId === "terrain") ) assert.ok(ATLAS_PAPER[t.id], t.id);
  assert.equal(paperColor("custom", "#000000"), mixColor("#000000", "#e9dfc5", 0.55), "свой тип смешан с бумагой");
});

test("paper tone stays in a narrow band and comes in steps", () => {
  const tones = new Set();
  for ( const c of cells ) {
    const p = hm.center(c);
    const t = paperTone(p.x, p.y, hm.radius);
    assert.ok(t >= 0.9 && t <= 1.02, `${t}`);
    tones.add(t);
  }
  assert.ok(tones.size > 1 && tones.size <= 7, `${tones.size} тонов`);
});

test("water is lighter near the coast and deep far away", () => {
  const dist = waterDistance(cells, c => hm.neighbors(c), terrainOf, { inBounds: c => hm.inBounds(c) });
  assert.equal(dist.get("5,5"), 0);
  assert.equal(dist.get("5,3"), 1);
  assert.ok((dist.get("0,0") ?? 9) >= 3);
  assert.equal(waterColor(1), ATLAS_PAPER.shallow);
  assert.equal(waterColor(9), ATLAS_PAPER.deep);
});

test("glyphs: mountains get peaks, forests trees, deep water waves; layout is stable", () => {
  const c = hm.center([5, 5]), r = hm.radius;
  const m = glyphsFor("mountains", c, r, "5,5");
  assert.ok(m.length >= 1 && m.some(g => g.kind.startsWith("mountain")));
  assert.ok(Math.max(...m.map(g => g.s)) >= r * 0.4, "горы крупные");
  assert.deepEqual(glyphsFor("mountains", c, r, "5,5"), m, "одинаково при перерисовке");
  // 0.9.9: у гор, холмов, лесов, тайги и пустыни по шесть вариантов рисунка.
  const kinds = (terrain, ok) => {
    const seen = new Set();
    for ( let n = 0; n < 60; n++ ) {
      const list = glyphsFor(terrain, c, r, `${terrain}${n}`);
      assert.ok(list.length > 0, `${terrain}: пустой гекс`);
      for ( const g of list ) { assert.ok(ok.includes(g.kind), `${terrain}: ${g.kind}`); seen.add(JSON.stringify(list.map(x => x.kind))); }
    }
    return seen.size;
  };
  assert.ok(kinds("forest", ["tree", "conifer", "tuft", "birch"]) >= 4, "леса разные");
  assert.ok(kinds("taiga", ["conifer", "tuft", "snow"]) >= 4, "тайга разная");
  assert.ok(kinds("desert", ["dune", "cactus", "ripple", "stone"]) >= 4, "пустыня разная");
  assert.ok(kinds("mountains", ["mountain", "mountainRound", "mountainTwin", "tuft", "stone", "snow"]) >= 4, "горы разные");
  for ( const g of glyphsFor("forest", c, r, "y") ) assert.ok(Math.hypot(g.x - c.x, g.y - c.y) < r * 0.6, "значок внутри гекса");
  assert.equal(glyphsFor(undefined, c, r, "z", { deep: false }).length, 0, "у берега волн нет");
  let waves = 0;
  for ( let n = 0; n < 40; n++ ) waves += glyphsFor(undefined, c, r, `w${n}`, { deep: true }).length;
  assert.ok(waves > 10 && waves < 40, `волн ${waves}`);
});

test("coastline runs along every land–water edge and matches the wavy fill", () => {
  const pairs = coastPairs(cells, c => hm.neighbors(c), terrainOf, c => hm.inBounds(c));
  const edges = pairs.map(([a, b]) => sharedEdge(hm.vertices(a), hm.vertices(b)));
  assert.ok(edges.every(Boolean));
  assert.ok(pairs.every(([a, b]) => land.has(k(a)) && !land.has(k(b))));
  assert.ok(pairs.length >= 12, `${pairs.length}`);
  // Волна ребра одна для обоих гексов: у соседа те же точки в обратном порядке.
  const [a, b] = edges[0];
  assert.deepEqual(roughEdge(b, a, 9), roughEdge(a, b, 9).reverse());
  const poly = roughPolygon(hm.vertices(pairs[0][0]), 9);
  const flat = [];
  for ( let i = 0; i < poly.length; i += 2 ) flat.push(`${poly[i].toFixed(3)},${poly[i + 1].toFixed(3)}`);
  for ( const [x, y] of roughEdge(a, b, 9) ) assert.ok(flat.includes(`${x.toFixed(3)},${y.toFixed(3)}`), "обводка совпадает с заливкой");
});
