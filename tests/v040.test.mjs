// 0.4: map size, rough coastlines, patterns, line modes, layer presets, descriptions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sceneSizeFor, dimsOf, rowsForAspect, remapFeatures, normalizeDims } from "../scripts/hex/dims.mjs";
import { roughPolygon } from "../scripts/geometry/geometry.mjs";
import { hatchSegments } from "../scripts/canvas/hex-renderer.mjs";
import { viewOf, activePreset, BUILTIN_PRESETS, isResourceType } from "../scripts/data/view.mjs";
import HexMath from "../scripts/hex/hexmath.mjs";
import Studio from "../scripts/studio.mjs";
import MemoryBackend from "./harness/memory-backend.mjs";

test("scene size and hex count round-trip", () => {
  for ( const d of [{ cols: 40, rows: 28, size: 100 }, { cols: 77, rows: 51, size: 60 }, { cols: 5, rows: 5, size: 30 }] ) {
    const { width, height } = sceneSizeFor(d);
    assert.deepEqual(dimsOf({ width, height, size: d.size }), d);
  }
  assert.deepEqual(normalizeDims({ cols: 9999, rows: 1, size: 5 }), { cols: 300, rows: 5, size: 30 });
});

test("rows follow the map aspect ratio", () => {
  const cols = 60, size = 100;
  const rows = rowsForAspect(cols, 0.5, size);
  const { width, height } = sceneSizeFor({ cols, rows, size });
  assert.ok(Math.abs((height / width) - 0.5) < 0.02, `aspect ${height / width}`);
});

test("remap keeps zones relative to the field origin and scales lines", () => {
  const before = new HexMath({ size: 100, rows: 6, cols: 6, x0: 50, y0: 50 });
  const after = new HexMath({ size: 50, rows: 4, cols: 4, x0: 20, y0: 20 });
  const all = h => { const out = []; for ( let i = 0; i < h.rows; i++ ) for ( let j = 0; j < h.cols; j++ ) out.push([i, j]); return out; };
  const inBounds = ([i, j]) => i >= 0 && j >= 0 && i < after.rows && j < after.cols;
  const states = new Map([
    ["z", { id: "z", system: { kind: "area", geometry: { cells: [[0, 0], [1, 1], [5, 5]] } } }],
    ["gone", { id: "gone", system: { kind: "area", geometry: { cells: [[5, 5]] } } }],
    ["m", { id: "m", system: { kind: "object", geometry: { x: 0, y: 0, cell: [2, 3] } } }],
    ["l", { id: "l", system: { kind: "line", geometry: { points: [[50, 50], [250, 150]] } } }]
  ]);
  const plan = remapFeatures(states, {
    before: { rect: { x: 50, y: 50 }, size: 100, cells: all(before) },
    after: { rect: { x: 20, y: 20 }, size: 50, cells: all(after) },
    center: c => after.center(c), inBounds
  });
  const by = Object.fromEntries(plan.update.map(s => [s.id, s.system.geometry]));
  assert.deepEqual(by.z.cells, [[0, 0], [1, 1]]);
  assert.deepEqual(plan.delete, ["gone"]);
  assert.deepEqual(by.m.cell, [2, 3]);
  assert.deepEqual([by.m.x, by.m.y], [Math.round(after.center([2, 3]).x), Math.round(after.center([2, 3]).y)]);
  assert.deepEqual(by.l.points, [[20, 20], [120, 70]]);
});

test("rough hexes share identical wavy edges", () => {
  const hm = new HexMath({ size: 100, rows: 4, cols: 4 });
  const a = roughPolygon(hm.vertices([1, 1]), 10);
  const b = roughPolygon(hm.vertices([1, 2]), 10);
  const pts = arr => { const out = []; for ( let k = 0; k < arr.length; k += 2 ) out.push(`${arr[k].toFixed(3)},${arr[k + 1].toFixed(3)}`); return out; };
  const shared = pts(a).filter(p => pts(b).includes(p));
  // Две общие вершины и семь общих точек изгиба между ними.
  assert.equal(shared.length, 9);
  assert.equal(a.length, 6 * 8 * 2);
});

test("hatching stays inside the hex", () => {
  const hm = new HexMath({ size: 100, rows: 2, cols: 2 });
  const ring = hm.vertices([0, 0]).map(v => [v.x, v.y]);
  const segs = hatchSegments(ring, [1, -1], 20);
  assert.ok(segs.length >= 3);
  const c = hm.center([0, 0]);
  for ( const [p, q] of segs ) for ( const [x, y] of [p, q] ) assert.ok(Math.hypot(x - c.x, y - c.y) <= 50.01);
});

test("layer presets and view parts", () => {
  assert.deepEqual(viewOf(["@lines"]), { marks: true, resources: true, lines: false, labels: true });
  assert.equal(activePreset(["@resources", "regions"], BUILTIN_PRESETS), "political");
  assert.equal(activePreset(["@lines"], BUILTIN_PRESETS), null);
  assert.ok(isResourceType("res-gold") && !isResourceType("city"));
});

const makeStudio = () => {
  const backend = new MemoryBackend();
  const studio = new Studio(backend);
  return { backend, studio };
};

test("line by hexes runs through every hex center between clicks", async () => {
  const { backend, studio } = makeStudio();
  studio.setTool("line");
  studio.setLineMode("hex");
  const g = backend.grid;
  studio.pointerDown(g.center([2, 2]));
  studio.pointerDown(g.center([2, 6]));
  assert.equal(studio.line.points.length, 5);
  for ( const [n, j] of [2, 3, 4, 5, 6].entries() ) {
    const c = g.center([2, j]);
    assert.deepEqual(studio.line.points[n], [Math.round(c.x), Math.round(c.y)]);
  }
  studio.rightClick();
  assert.equal(studio.line.points.length, 4);
  assert.equal(studio.line.cells.length, 4);
  await studio.finishLine();
  const line = [...backend.atlas.values()].find(s => s.system.kind === "line");
  assert.equal(line.system.geometry.points.length, 4);
  assert.equal(line.system.style.meander, 0);
});

test("freehand line is saved on release", async () => {
  const { backend, studio } = makeStudio();
  studio.setTool("line");
  studio.setLineMode("draw");
  studio.line.text = "Старый тракт";
  studio.pointerDown({ x: 100, y: 100 });
  for ( let x = 110; x <= 400; x += 10 ) studio.pointerMove({ x, y: 100 + ((x % 40) ? 3 : 0) });
  await studio.pointerUp();
  const line = [...backend.atlas.values()].find(s => s.system.kind === "line");
  assert.ok(line, "линия не записана");
  assert.ok(line.system.geometry.points.length >= 2);
  assert.equal(line.text, "Старый тракт");
  assert.equal(studio.line.points.length, 0);
});

test("description is set when a zone or mark is created", async () => {
  const { backend, studio } = makeStudio();
  studio.setTool("zone");
  studio.zone.typeId = "forest";
  studio.zone.text = "Тёмный лес";
  studio.pointerDown(backend.grid.center([3, 3]));
  await studio.pointerUp();
  await studio.attach();
  studio.setTool("mark");
  studio.mark.text = "Город мастеров";
  studio.pointerDown(backend.grid.center([4, 4]));
  await studio.pointerUp();
  await studio.placeMarks();
  const states = [...backend.atlas.values()];
  assert.equal(states.find(s => s.system.kind === "area").text, "Тёмный лес");
  assert.equal(states.find(s => s.system.kind === "object").text, "Город мастеров");
});

test("zone type keeps its pattern", async () => {
  const { backend, studio } = makeStudio();
  studio.setTool("zone");
  studio.openTypeForm("area");
  Object.assign(studio.typeForm, { name: "Болотная хмарь", pattern: "cross", patternColor: "#223344" });
  await studio.saveTypeForm();
  const t = backend.types().find(x => x.name === "Болотная хмарь");
  assert.equal(t.style.pattern, "cross");
  assert.equal(t.style.patternColor, "#223344");
});

test("presets switch hidden layers in the backend", async () => {
  const { backend, studio } = makeStudio();
  await studio.applyPreset("physical");
  assert.equal(studio.activePreset(), "physical");
  assert.deepEqual(studio.view(), { marks: true, resources: false, lines: true, labels: false });
  backend.prompt = async () => "Мой вид";
  await studio.savePreset();
  assert.ok(studio.presets().some(p => p.custom && p.name === "Мой вид"));
});
