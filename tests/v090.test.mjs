// 0.9.0: lines join at their ends, hover names, named parts, hex-edge drawing, line style.
import { test } from "node:test";
import assert from "node:assert/strict";
import Studio from "../scripts/studio.mjs";
import MemoryBackend from "./harness/memory-backend.mjs";
import { joinTwo, joinLine, nameRange, segmentNameAt, lineAt, edgePath, nearestVertex } from "../scripts/data/lines.mjs";
import { roundCorners } from "../scripts/geometry/geometry.mjs";
import { lineCurve, lineDash } from "../scripts/canvas/style.mjs";

const setup = () => {
  const backend = new MemoryBackend();
  const studio = new Studio(backend);
  return { backend, studio, grid: backend.grid };
};
const lines = studio => [...studio.states.values()].filter(s => s.system.kind === "line");
const draw = async (studio, pts, { typeId = "river", name = "", mode = "free" } = {}) => {
  studio.setTool("line", { toggle: false });
  studio.line.typeId = typeId;
  studio.line.mode = mode;
  studio.line.points = pts.map(p => [...p]);
  studio.line.name = name;
  await studio.finishLine();
};

test("joinTwo attaches B at the right end and flips it when needed", () => {
  const A = { points: [[0, 0], [10, 0]], segments: [] };
  assert.deepEqual(joinTwo(A, { points: [[10, 1], [20, 0]] }, 3).points, [[0, 0], [10, 0], [20, 0]]);
  assert.deepEqual(joinTwo(A, { points: [[20, 0], [10, 1]] }, 3).points, [[0, 0], [10, 0], [20, 0]]);
  assert.deepEqual(joinTwo(A, { points: [[-10, 0], [0, 1]] }, 3).points, [[-10, 0], [0, 1], [10, 0]]);
  assert.deepEqual(joinTwo(A, { points: [[0, 1], [-10, 0]] }, 3).points, [[-10, 0], [0, 1], [10, 0]]);
  assert.equal(joinTwo(A, { points: [[50, 0], [60, 0]] }, 3), null);
});

test("a new line of the same type joins an existing one; another type does not", async () => {
  const { studio } = setup();
  await draw(studio, [[100, 100], [200, 100]], { name: "Быстрая" });
  await draw(studio, [[202, 101], [300, 120]]);
  assert.equal(lines(studio).length, 1, "линии слились");
  assert.equal(lines(studio)[0].system.geometry.points.length, 3);
  assert.equal(lines(studio)[0].name, "Быстрая");
  await draw(studio, [[300, 121], [400, 160]], { typeId: "road" });
  assert.equal(lines(studio).length, 2, "дорога к реке не прилипает");
});

test("a piece that bridges two lines merges all three; its own name becomes a part", async () => {
  const { studio } = setup();
  await draw(studio, [[100, 100], [200, 100]], { name: "Быстрая" });
  await draw(studio, [[400, 100], [500, 100]], { name: "Тихая" });
  await draw(studio, [[201, 100], [399, 100]], { name: "Порог" });
  const all = lines(studio);
  assert.equal(all.length, 1, "три куска стали одной линией");
  const g = all[0].system.geometry;
  assert.equal(g.points.length, 4, "общие концы не дублируются");
  assert.equal(all[0].name, "Быстрая");
  assert.equal(segmentNameAt(g.segments, 1), "Порог");
  assert.equal(segmentNameAt(g.segments, 2), "Тихая", "название второй линии стало участком");
  assert.equal(segmentNameAt(g.segments, 0), "");
});

test("the join can be switched off", async () => {
  const { studio } = setup();
  await draw(studio, [[100, 100], [200, 100]]);
  studio.line.join = false;
  await draw(studio, [[200, 100], [300, 100]]);
  assert.equal(lines(studio).length, 2);
});

test("nameRange cuts overlapping parts; lineAt reports the part name", () => {
  let segs = nameRange([], 0, 4, "Верховье", 6);
  segs = nameRange(segs, 2, 5, "Устье", 6);
  assert.deepEqual(segs, [{ from: 0, to: 2, name: "Верховье" }, { from: 2, to: 5, name: "Устье" }]);
  segs = nameRange(segs, 2, 5, "", 6);
  assert.deepEqual(segs, [{ from: 0, to: 2, name: "Верховье" }]);
  const states = new Map([["l", { id: "l", name: "Река", system: { kind: "line", geometry: { points: [[0, 0], [10, 0], [20, 0], [30, 0]], segments: [{ from: 1, to: 3, name: "Устье" }] } } }]]);
  assert.equal(lineAt(states, [5, 2], 4).name, "Река");
  assert.equal(lineAt(states, [25, 2], 4).name, "Устье");
  assert.equal(lineAt(states, [25, 20], 4), null);
});

test("naming the part of a line on inspected hexes", async () => {
  const { studio, grid } = setup();
  studio.line.mode = "hex";
  const cells = [[3, 2], [3, 3], [3, 4], [3, 5], [3, 6]];
  await draw(studio, cells.map(c => { const p = grid.center(c); return [p.x, p.y]; }), { name: "Река", mode: "hex" });
  const id = lines(studio)[0].id;
  studio.setTool("select", { toggle: false });
  studio.pointerDown(grid.center([3, 5]));
  studio.pointerDown(grid.center([3, 6]), { shift: true });
  studio.setField(id, "segment", "Устье");
  await studio.flush();
  const g = studio.stateOf(id).system.geometry;
  assert.equal(segmentNameAt(g.segments, 3), "Устье");
  assert.equal(segmentNameAt(g.segments, 0), "");
  assert.equal(studio.segmentNameHere(id), "Устье");
});

test("hovering a line sets hoverLine with its name", async () => {
  const { studio } = setup();
  await draw(studio, [[100, 100], [300, 100]], { name: "Быстрая" });
  studio.setTool("select", { toggle: false });
  const seen = [];
  studio.subscribe(w => seen.push(w));
  studio.pointerMove({ x: 200, y: 103 });
  assert.equal(studio.hoverLine?.name, "Быстрая");
  assert.ok(seen.includes("hover"));
  studio.pointerMove({ x: 200, y: 300 });
  assert.equal(studio.hoverLine, null);
});

test("edge mode walks along hex edges between corners", async () => {
  const { studio, grid } = setup();
  const a = nearestVertex(grid, grid.center([4, 4]));
  const b = nearestVertex(grid, grid.center([4, 8]));
  const path = edgePath(grid, a, b);
  assert.ok(path.length > 2);
  const edge = grid.radius;
  for ( let i = 1; i < path.length; i++ ) {
    assert.ok(Math.abs(Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y) - edge) < 0.5, "каждый шаг — ребро гекса");
  }
  studio.setTool("line", { toggle: false });
  studio.setLineMode("edge");
  studio.pointerDown(grid.center([4, 4]));
  studio.pointerDown(grid.center([4, 8]));
  const n = studio.line.points.length;
  assert.ok(n > 2);
  studio.undoPoint();
  assert.equal(studio.line.points.length, 1, "отмена убирает весь путь последнего щелчка");
});

test("line style: straight, elbow with bend, curved; dash and dots", () => {
  const pts = [[0, 0], [10, 10], [20, 0]];
  assert.deepEqual(lineCurve(pts, { shape: "straight" }), pts);
  assert.ok(lineCurve(pts, { shape: "rounded", bend: 0.5 }).length > 3);
  assert.deepEqual(roundCorners(pts, 0), pts);
  assert.ok(lineCurve(pts, { shape: "curved", meander: 0 }).length > 3);
  assert.deepEqual(lineDash({ pattern: "dash" }, 4), [12, 8]);
  assert.equal(lineDash({ pattern: "dot" }, 4)[1], 8);
  assert.deepEqual(lineDash({ pattern: "solid" }, 4), [0, 0]);
  assert.deepEqual(lineDash({ dash: 5, gap: 3, pattern: "dot" }, 4), [5, 3], "старые dash/gap важнее");
});

test("line type form saves shape, bend, pattern and widths", async () => {
  const { studio } = setup();
  studio.editTypeInSettings("line", "new");
  Object.assign(studio.typeForm, { name: "Тракт", lineShape: "rounded", bend: "0.3", linePattern: "dash", widthStart: "2", widthEnd: "6" });
  await studio.saveTypeForm();
  const t = studio.typesOf("line").find(x => x.name === "Тракт");
  assert.deepEqual([t.style.shape, t.style.bend, t.style.pattern, t.style.widthStart, t.style.widthEnd], ["rounded", 0.3, "dash", 2, 6]);
});
