// Test-world generator: terrain shares, resources on proper terrain, realms with capitals, determinism.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateWorld, generateTerrain, oddRNeighbors, RESOURCE_TYPES, withResourceTypes } from "../scripts/gen/mapgen.mjs";
import HexMath from "../scripts/hex/hexmath.mjs";

const hm = new HexMath({ size: 100, rows: 24, cols: 32 });
const cells = hm.allCells();
const center = c => hm.center(c);
const ids = () => { let n = 0; return () => `g${++n}`; };
const k = ([i, j]) => `${i},${j}`;

test("соседи HEXODDR совпадают с HexMath", () => {
  for ( const c of [[0, 0], [1, 1], [4, 7], [5, 7]] ) {
    assert.deepEqual(oddRNeighbors(c).map(k).sort(), hm.neighbors(c).map(k).sort());
  }
});

test("доля воды и гор близка к заданной, края поля — вода", () => {
  const t = generateTerrain({ cells, center, seed: "a", water: 0.4, mountains: 0.1 });
  const share = id => [...t.values()].filter(x => x === id).length / cells.length;
  assert.ok(Math.abs(share("water") - 0.4) < 0.05, `вода ${share("water")}`);
  assert.ok(share("mountains") + share("snow") > 0.03);
  const corner = [[0, 0], [0, 31], [23, 0], [23, 31]].map(c => t.get(k(c)));
  assert.ok(corner.filter(x => x === "water").length >= 3, `углы: ${corner}`);
  for ( const id of ["plains", "forest", "hills"] ) assert.ok(share(id) > 0, `нет ${id}`);
});

test("один и тот же seed даёт тот же мир", () => {
  const a = generateWorld({ cells, center, seed: "x1", newId: ids(), realms: [{ name: "А" }, { name: "Б" }] });
  const b = generateWorld({ cells, center, seed: "x1", newId: ids(), realms: [{ name: "А" }, { name: "Б" }] });
  assert.deepEqual(a.features, b.features);
  const c = generateWorld({ cells, center, seed: "x2", newId: ids() });
  assert.notDeepEqual(a.terrain, c.terrain);
});

test("каждый гекс в одной зоне местности", () => {
  const { features, stats } = generateWorld({ cells, center, seed: "s", newId: ids() });
  const terrain = features.filter(f => f.system.ext.artariusGen.kind === "terrain");
  assert.equal(terrain.length, stats.terrain);
  const seen = terrain.flatMap(f => f.system.geometry.cells.map(k));
  assert.equal(seen.length, cells.length);
  assert.equal(new Set(seen).size, cells.length);
  for ( const f of terrain ) assert.equal(f.system.layerId, "terrain");
});

test("ресурсы стоят на подходящей местности, рыба у берега", () => {
  const { features, terrain } = generateWorld({ cells, center, seed: "r", resources: 0.5, newId: ids() });
  const res = features.filter(f => f.system.ext.artariusGen.kind === "resource");
  assert.ok(res.length > 20, `ресурсов ${res.length}`);
  const allowed = {
    "res-grain": ["plains", "savanna"], "res-wood": ["forest", "swamp", "jungle", "taiga", "mangrove"],
    "res-stone": ["hills", "mountains", "desert", "savanna", "tundra"],
    "res-iron": ["hills", "mountains", "taiga", "tundra"], "res-gold": ["mountains", "desert", "jungle"], "res-fish": ["water"]
  };
  for ( const f of res ) {
    const t = terrain.get(k(f.system.geometry.cell));
    assert.ok(allowed[f.system.typeId].includes(t), `${f.system.typeId} на ${t}`);
    if ( f.system.typeId === "res-fish" ) {
      assert.ok(oddRNeighbors(f.system.geometry.cell).some(nb => terrain.get(k(nb)) && terrain.get(k(nb)) !== "water"), "рыба в открытом море");
    }
  }
  const perHex = new Set(res.map(f => k(f.system.geometry.cell)));
  assert.equal(perHex.size, res.length, "на гексе не больше одного ресурса");
});

test("стартовые державы: столица на суше внутри своей державы, державы не пересекаются", () => {
  const realms = [{ name: "Огонь", demiurge: "actor1" }, { name: "Вода" }, { name: "Камень" }];
  const { features, stats, terrain } = generateWorld({ cells, center, seed: "p", realms, newId: ids() });
  assert.equal(stats.realms, 3);
  const zones = features.filter(f => f.system.typeId === "realm");
  const caps = features.filter(f => f.system.ext.artariusGen.kind === "capital");
  assert.equal(zones.length, 3);
  assert.equal(caps.length, 3);
  const owned = new Map();
  for ( const z of zones ) {
    assert.equal(z.system.layerId, "politics");
    assert.ok(z.system.geometry.cells.length >= 3);
    for ( const c of z.system.geometry.cells ) {
      assert.ok(!owned.has(k(c)), "державы пересекаются");
      assert.notEqual(terrain.get(k(c)), "water");
      owned.set(k(c), z.id);
    }
  }
  for ( const cap of caps ) {
    const realm = cap.system.links[0].target;
    assert.equal(owned.get(k(cap.system.geometry.cell)), realm, "столица вне своей державы");
  }
  assert.equal(zones[0].system.demiurge, "actor1");
  assert.equal(zones[0].name, "Огонь");
  const resCells = features.filter(f => f.system.ext.artariusGen.kind === "resource").map(f => k(f.system.geometry.cell));
  for ( const cap of caps ) assert.ok(!resCells.includes(k(cap.system.geometry.cell)), "ресурс на столице");
});

test("типы ресурсов добавляются один раз", () => {
  const once = withResourceTypes([]);
  assert.equal(once.length, RESOURCE_TYPES.length);
  assert.equal(withResourceTypes(once).length, RESOURCE_TYPES.length);
});
