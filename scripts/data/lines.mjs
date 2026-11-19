/**
 * Линии: склейка концов, участки со своими названиями, линия под курсором и путь по краям гексов.
 * Чистый код без Foundry: им пользуются студия, холст и тесты.
 *
 * Участки хранятся в system.geometry.segments: [{ from, to, name }], from и to — номера точек линии.
 */
import { distToSegment } from "../geometry/geometry.mjs";

const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Сдвинуть участки на k точек; reverse(n) — перевернуть для линии из n точек. */
const shiftSegs = (segs, k) => segs.map(s => ({ ...s, from: s.from + k, to: s.to + k }));
const flipSegs = (segs, n) => segs.map(s => ({ ...s, from: n - 1 - s.to, to: n - 1 - s.from }));

/**
 * Склеить две линии A и B, если конец одной рядом с концом другой (ближе tol).
 * a, b — { points, segments }. Порядок точек A сохраняется, B пристраивается к нему.
 * Возвращает { points, segments, bRange: [from, to] } или null.
 */
export function joinTwo(a, b, tol) {
  const A = a.points, B = b.points;
  const sa = a.segments ?? [], sb = b.segments ?? [];
  const n = A.length, m = B.length;
  if ( n < 2 || m < 2 ) return null;
  const tries = [
    // конец A — начало B
    [d2(A[n - 1], B[0]), () => ({ points: [...A, ...B.slice(1)], segments: [...sa, ...shiftSegs(sb, n - 1)], bRange: [n - 1, n + m - 2] })],
    // конец A — конец B: B переворачивается
    [d2(A[n - 1], B[m - 1]), () => ({ points: [...A, ...B.slice().reverse().slice(1)], segments: [...sa, ...shiftSegs(flipSegs(sb, m), n - 1)], bRange: [n - 1, n + m - 2] })],
    // начало A — конец B: B встаёт впереди
    [d2(A[0], B[m - 1]), () => ({ points: [...B, ...A.slice(1)], segments: [...sb, ...shiftSegs(sa, m - 1)], bRange: [0, m - 1] })],
    // начало A — начало B: B переворачивается и встаёт впереди
    [d2(A[0], B[0]), () => ({ points: [...B.slice().reverse(), ...A.slice(1)], segments: [...flipSegs(sb, m), ...shiftSegs(sa, m - 1)], bRange: [0, m - 1] })]
  ].filter(([d]) => d <= tol).sort((x, y) => x[0] - y[0]);
  return tries.length ? tries[0][1]() : null;
}

/**
 * Склеить новую линию с линиями того же типа, к концам которых она подходит.
 * Возвращает null (склеивать не с чем) или { keep, remove, points, segments, name }:
 * keep — линия, которая остаётся (в ней всё вместе), remove — ещё одна линия, которую новая соединила с keep.
 * Если у нового куска своё название, отличное от названия линии, он становится участком с этим названием.
 */
export function joinLine({ states, points, typeId, name = "", tol }) {
  const lines = [...states.values()].filter(s => s.system?.kind === "line" && s.system.typeId === typeId
    && (s.system.geometry?.points?.length ?? 0) >= 2);
  const ends = l => { const p = l.system.geometry.points; return [p[0], p.at(-1)]; };
  const touches = (l, pt) => ends(l).some(e => d2(e, pt) <= tol);
  const first = lines.find(l => touches(l, points[0]) || touches(l, points.at(-1)));
  if ( !first ) return null;
  const g = first.system.geometry;
  const piece = { points, segments: [] };
  let res = joinTwo({ points: g.points, segments: g.segments ?? [] }, piece, tol);
  if ( !res ) return null;
  const mainName = first.name ?? "";
  if ( name && name !== mainName ) res.segments.push({ from: res.bRange[0], to: res.bRange[1], name });
  // Второй конец нового куска может подойти к другой линии того же типа: тогда она тоже вливается.
  let remove = null;
  const free = res.bRange[0] === 0 ? res.points[0] : res.points.at(-1);
  const second = lines.find(l => l.id !== first.id && touches(l, free));
  if ( second ) {
    const g2 = second.system.geometry;
    const segs2 = [...(g2.segments ?? [])];
    if ( second.name && second.name !== mainName ) segs2.push({ from: 0, to: g2.points.length - 1, name: second.name });
    const res2 = joinTwo({ points: res.points, segments: res.segments }, { points: g2.points, segments: segs2 }, tol);
    if ( res2 ) { res = res2; remove = second; }
  }
  return { keep: first, remove, points: res.points, segments: tidySegments(res.segments, res.points.length) };
}

/** Убрать пустые и вырожденные участки, обрезать по длине линии, отсортировать. */
export function tidySegments(segs, n) {
  return (segs ?? [])
    .map(s => ({ from: Math.max(0, Math.min(s.from, s.to)), to: Math.min(n - 1, Math.max(s.from, s.to)), name: String(s.name ?? "").trim() }))
    .filter(s => s.name && s.to > s.from)
    .sort((a, b) => a.from - b.from);
}

/** Название участка, в который входит отрезок i (между точками i и i+1), или пусто. */
export function segmentNameAt(segments, i) {
  // Позже добавленный участок важнее: ищем с конца.
  const list = segments ?? [];
  for ( let n = list.length - 1; n >= 0; n-- ) if ( i >= list[n].from && i < list[n].to ) return list[n].name;
  return "";
}

/**
 * Назвать участок from..to. Перекрытые части старых участков обрезаются,
 * пустое имя просто снимает название с этого куска.
 */
export function nameRange(segments, from, to, name, n) {
  const out = [];
  for ( const s of segments ?? [] ) {
    if ( s.to <= from || s.from >= to ) { out.push(s); continue; }
    if ( s.from < from ) out.push({ ...s, to: from });
    if ( s.to > to ) out.push({ ...s, from: to });
  }
  if ( name?.trim() ) out.push({ from, to, name: name.trim() });
  return tidySegments(out, n);
}

/** Отрезок линии, ближайший к точке: { index, dist }. */
export function nearestSegment(points, p) {
  let best = { index: -1, dist: Infinity };
  for ( let i = 1; i < points.length; i++ ) {
    const d = distToSegment(p, points[i - 1], points[i]);
    if ( d < best.dist ) best = { index: i - 1, dist: d };
  }
  return best;
}

/** Линия под точкой (ближе tol): { state, index, name } — name участка или всей линии. */
export function lineAt(states, p, tol, isVisible = () => true) {
  let best = null;
  for ( const s of states.values() ) {
    if ( s.system?.kind !== "line" || !isVisible(s) ) continue;
    const pts = s.system.geometry?.points ?? [];
    if ( pts.length < 2 ) continue;
    const hit = nearestSegment(pts, p);
    if ( hit.dist <= tol && (!best || hit.dist < best.dist) ) best = { state: s, index: hit.index, dist: hit.dist };
  }
  if ( !best ) return null;
  const seg = segmentNameAt(best.state.system.geometry.segments, best.index);
  return { state: best.state, index: best.index, segment: seg, name: seg || best.state.name || "" };
}

/** Кусок линии вдоль гексов: от первого до последнего отрезка, ближайших к центрам гексов. */
export function rangeForCells(points, cells, center) {
  let lo = Infinity, hi = -Infinity;
  for ( const c of cells ) {
    const { x, y } = center(c);
    const hit = nearestSegment(points, [x, y]);
    if ( hit.index < 0 ) continue;
    lo = Math.min(lo, hit.index);
    hi = Math.max(hi, hit.index + 1);
  }
  return Number.isFinite(lo) ? [lo, hi] : null;
}

/* Путь по краям гексов --------------------------------------------- */

const vkey = v => `${Math.round(v.x * 10)},${Math.round(v.y * 10)}`;

/** Вершина гекса, ближайшая к точке. */
export function nearestVertex(grid, p) {
  const cell = grid.cellAt(p);
  let best = null;
  for ( const c of [cell, ...(grid.neighbors?.(cell) ?? [])] ) {
    for ( const v of grid.vertices(c) ) {
      const d = Math.hypot(v.x - p.x, v.y - p.y);
      if ( !best || d < best.d ) best = { x: v.x, y: v.y, d };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

/** Соседние вершины по краям гексов. */
function vertexNeighbors(grid, v) {
  const cell = grid.cellAt(v);
  const out = new Map();
  const k = vkey(v);
  for ( const c of [cell, ...(grid.neighbors?.(cell) ?? [])] ) {
    const vs = grid.vertices(c);
    const n = vs.findIndex(x => vkey(x) === k);
    if ( n < 0 ) continue;
    for ( const w of [vs[(n + 1) % 6], vs[(n + 5) % 6]] ) out.set(vkey(w), w);
  }
  return [...out.values()];
}

/**
 * Путь от вершины a до вершины b по краям гексов (A* по сетке вершин).
 * Возвращает вершины пути от a до b включительно или прямой отрезок, если путь длиннее limit шагов.
 */
export function edgePath(grid, a, b, limit = 4000) {
  const goal = vkey(b);
  const h = v => Math.hypot(v.x - b.x, v.y - b.y);
  const open = [{ v: a, g: 0, f: h(a) }];
  const came = new Map([[vkey(a), null]]);
  const cost = new Map([[vkey(a), 0]]);
  let steps = 0;
  while ( open.length && steps++ < limit ) {
    open.sort((x, y) => x.f - y.f);
    const { v, g } = open.shift();
    const k = vkey(v);
    if ( k === goal ) {
      const path = [];
      for ( let cur = v; cur; cur = came.get(vkey(cur)) ) path.push(cur);
      return path.reverse();
    }
    for ( const w of vertexNeighbors(grid, v) ) {
      const wk = vkey(w);
      const ng = g + Math.hypot(w.x - v.x, w.y - v.y);
      if ( ng >= (cost.get(wk) ?? Infinity) ) continue;
      cost.set(wk, ng);
      came.set(wk, v);
      open.push({ v: w, g: ng, f: ng + h(w) });
    }
  }
  return [a, b];
}
