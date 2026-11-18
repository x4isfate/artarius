/**
 * Правила гекс-мира как чистые функции: без Foundry, проверяются в Node и на стенде.
 *
 * Состояние элемента: { id, name, text, system }, см. ops.mjs.
 * Зона (kind "area"): system.geometry.cells = [[i, j], …].
 * Метка (kind "object"): system.geometry = { x, y, cell: [i, j] }.
 * Линия (kind "line"): system.geometry.points = [[x, y], …].
 */
import { REALM_COLORS, STARTER_LAYERS } from "../constants.mjs";
import { distToPolyline, pointInRings } from "../geometry/geometry.mjs";

export const cellKey = ([i, j]) => `${i},${j}`;
export const parseKey = k => k.split(",").map(Number);

/** Ячейки зоны как массив [i, j]. */
export function zoneCells(state) {
  return (state?.system?.geometry?.cells ?? []).map(c => [Number(c[0]), Number(c[1])]);
}

/** Слой зоны: свой, иначе слой типа, иначе «Прочее». */
export function layerIdOf(state, types) {
  if ( state.system?.layerId ) return state.system.layerId;
  return types.find(t => t.id === state.system?.typeId)?.layerId ?? "overlay";
}

export function layerById(layers, id) {
  return layers.find(l => l.id === id) ?? STARTER_LAYERS.find(l => l.id === id) ?? { id, name: id, exclusive: false };
}

const isExclusive = (layers, id) => layerById(layers, id).exclusive !== false;

const zonesOf = states => [...states.values()].filter(s => s.system?.kind === "area");

const withCells = (state, cells) => ({
  ...state,
  system: { ...state.system, geometry: { ...(state.system.geometry ?? {}), cells } }
});

/** Следующий цвет для новой державы: первый из набора, которого ещё нет у зон. */
export function nextZoneColor(states) {
  const used = new Set(zonesOf(states).map(z => String(z.system.style?.color ?? "").toLowerCase()));
  return REALM_COLORS.find(c => !used.has(c)) ?? REALM_COLORS[used.size % REALM_COLORS.length];
}

/** Пустое состояние нового элемента. */
export function blankState({ id, kind, name = "", typeId = "", layerId = "", geometry = {}, style = {}, demiurge = "" }) {
  return {
    id, name, text: "",
    system: {
      kind, typeId, demiurge, statuses: [], aspects: [], style, geometry,
      layerId, blend: "replace", sort: 0, links: [], ext: {}, rev: 0
    }
  };
}

/**
 * Прикрепить гексы к зоне.
 * target — id существующей зоны, или newZone — { id, typeId, name, color?, demiurge? }.
 * В исключающем слое гексы уходят из других зон этого слоя; зона без гексов удаляется.
 * Возвращает список операций { action, id, state? , name? } без baseRev.
 */
export function attachOps({ states, types, layers, cells, target = null, newZone = null }) {
  if ( !cells.length ) return [];
  let zone;
  const ops = [];
  if ( target ) {
    zone = states.get(target);
    if ( !zone || zone.system.kind !== "area" ) return [];
  } else if ( newZone ) {
    const type = types.find(t => t.id === newZone.typeId);
    zone = blankState({
      id: newZone.id, kind: "area", name: newZone.name || type?.name || "",
      typeId: newZone.typeId, layerId: type?.layerId ?? "overlay",
      style: newZone.color ? { color: newZone.color } : {},
      demiurge: newZone.demiurge ?? ""
    });
  } else return [];

  const layerId = layerIdOf(zone, types);
  const adding = new Set(cells.map(cellKey));
  const have = new Set(zoneCells(zone).map(cellKey));
  const merged = [...have, ...[...adding].filter(k => !have.has(k))].map(parseKey);
  if ( isExclusive(layers, layerId) ) {
    for ( const other of zonesOf(states) ) {
      if ( other.id === zone.id || layerIdOf(other, types) !== layerId ) continue;
      const left = zoneCells(other).filter(c => !adding.has(cellKey(c)));
      if ( left.length === zoneCells(other).length ) continue;
      if ( left.length ) ops.push({ action: "update", id: other.id, state: withCells(other, left) });
      else ops.push({ action: "delete", id: other.id, name: other.name });
    }
  }
  const changed = !target || merged.length !== have.size;
  if ( changed ) ops.unshift({ action: target ? "update" : "create", id: zone.id, state: withCells(zone, merged) });
  return ops;
}

/**
 * Убрать гексы из зон. zoneId — из одной зоны, layerId — из всех зон слоя,
 * без них — из всех зон вообще.
 */
export function detachOps({ states, types, cells, zoneId = null, layerId = null }) {
  const removing = new Set(cells.map(cellKey));
  const ops = [];
  for ( const z of zonesOf(states) ) {
    if ( zoneId && z.id !== zoneId ) continue;
    if ( layerId && layerIdOf(z, types) !== layerId ) continue;
    const all = zoneCells(z);
    const left = all.filter(c => !removing.has(cellKey(c)));
    if ( left.length === all.length ) continue;
    if ( left.length ) ops.push({ action: "update", id: z.id, state: withCells(z, left) });
    else ops.push({ action: "delete", id: z.id, name: z.name });
  }
  return ops;
}

/**
 * Свободный контур из 0.2 → гексы: гекс входит, если его центр внутри контура.
 * shapes — кольца [[x, y], …] (дыры обходом в обратную сторону), cells — все гексы поля.
 */
export function cellsInShapes(shapes, cells, center) {
  const rings = (shapes ?? []).filter(r => Array.isArray(r) && r.length >= 3);
  if ( !rings.length ) return [];
  return cells.filter(c => {
    const p = center(c);
    return pointInRings([p.x, p.y], rings);
  }).map(c => [c[0], c[1]]);
}

/** Метки на гексы: по одной на гекс. center(cell) → { x, y }. */
export function markOps({ cells, typeId, name = "", types, center, newId, demiurge = "" }) {
  const type = types.find(t => t.id === typeId);
  return cells.map(cell => {
    const { x, y } = center(cell);
    const id = newId();
    return {
      action: "create", id,
      state: blankState({
        id, kind: "object", name: name || type?.name || "", typeId, demiurge,
        geometry: { x: Math.round(x), y: Math.round(y), cell: [...cell] }
      })
    };
  });
}

/** Новая линия по точкам. */
export function lineOp({ points, typeId, name = "", types, newId, demiurge = "" }) {
  if ( points.length < 2 ) return null;
  const type = types.find(t => t.id === typeId);
  const id = newId();
  return {
    action: "create", id,
    state: blankState({
      id, kind: "line", name: name || type?.name || "", typeId, demiurge,
      geometry: { points: points.map(([x, y]) => [Math.round(x), Math.round(y)]) }
    })
  };
}

/** Гекс метки: записанный при создании или вычисленный по точке. */
export function markCell(state, cellAt) {
  const g = state.system?.geometry ?? {};
  if ( Array.isArray(g.cell) ) return [Number(g.cell[0]), Number(g.cell[1])];
  return cellAt({ x: g.x ?? 0, y: g.y ?? 0 });
}

/**
 * Что лежит на гексе. center — центр гекса, radius — расстояние от центра до вершины.
 * Линия считается проходящей через гекс, если она ближе к центру, чем 0.8 радиуса.
 */
export function tileContents({ states, types, layers, cell, center, radius, cellAt }) {
  const k = cellKey(cell);
  const order = new Map(layers.map((l, n) => [l.id, n]));
  const zones = [], marks = [], lines = [];
  for ( const s of states.values() ) {
    const kind = s.system?.kind;
    if ( kind === "area" ) {
      if ( zoneCells(s).some(c => cellKey(c) === k) ) zones.push(s);
    } else if ( kind === "object" ) {
      if ( cellKey(markCell(s, cellAt)) === k ) marks.push(s);
    } else if ( kind === "line" ) {
      const pts = s.system.geometry?.points ?? [];
      if ( pts.length >= 2 && distToPolyline([center.x, center.y], pts) <= radius * 0.8 ) lines.push(s);
    }
  }
  zones.sort((a, b) => (order.get(layerIdOf(a, types)) ?? 99) - (order.get(layerIdOf(b, types)) ?? 99));
  return { zones, marks, lines };
}

/**
 * Какие гексы зоны видны. В исключающем слое гекс достаётся одной зоне:
 * той, что выше по sort, при равенстве — с большим id. Так старые или
 * импортированные данные с перекрытием рисуются без каши.
 */
export function visibleZoneCells(zones, types, layers) {
  const owner = new Map();       // `${layer}|${cell}` → zone
  const rank = z => [z.system.sort ?? 0, z.id];
  const better = (a, b) => {
    const [sa, ia] = rank(a), [sb, ib] = rank(b);
    return sa !== sb ? sa > sb : ia > ib;
  };
  for ( const z of zones ) {
    const layerId = layerIdOf(z, types);
    if ( !isExclusive(layers, layerId) ) continue;
    for ( const c of zoneCells(z) ) {
      const k = `${layerId}|${cellKey(c)}`;
      const cur = owner.get(k);
      if ( !cur || better(z, cur) ) owner.set(k, z);
    }
  }
  const out = new Map();
  for ( const z of zones ) {
    const layerId = layerIdOf(z, types);
    const excl = isExclusive(layers, layerId);
    out.set(z.id, zoneCells(z).filter(c => !excl || owner.get(`${layerId}|${cellKey(c)}`) === z));
  }
  return out;
}

/**
 * Граница набора гексов: рёбра, которые есть только у одного гекса набора.
 * vertices(cell) → [{x, y}, …]. Возвращает отрезки [[x1, y1], [x2, y2]].
 */
export function boundaryEdges(cells, vertices) {
  const r = v => `${Math.round(v.x * 10)},${Math.round(v.y * 10)}`;
  const edges = new Map();
  for ( const c of cells ) {
    const vs = vertices(c);
    for ( let n = 0; n < vs.length; n++ ) {
      const a = vs[n], b = vs[(n + 1) % vs.length];
      const ka = r(a), kb = r(b);
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const e = edges.get(k);
      if ( e ) e.count++;
      else edges.set(k, { count: 1, seg: [[a.x, a.y], [b.x, b.y]] });
    }
  }
  return [...edges.values()].filter(e => e.count === 1).map(e => e.seg);
}

/** Гекс для подписи зоны: ближайший к среднему центру. */
export function labelCell(cells, center) {
  if ( !cells.length ) return null;
  let sx = 0, sy = 0;
  const pts = cells.map(c => center(c));
  for ( const p of pts ) { sx += p.x; sy += p.y; }
  const mx = sx / pts.length, my = sy / pts.length;
  let best = 0, bd = Infinity;
  pts.forEach((p, n) => {
    const d = ((p.x - mx) ** 2) + ((p.y - my) ** 2);
    if ( d < bd ) { bd = d; best = n; }
  });
  return cells[best];
}

/** Гексы на отрезке между двумя гексами (для протяжки мышью без пропусков). */
export function cellsAlong(a, b, center, cellAt) {
  const pa = center(a), pb = center(b);
  const d = Math.hypot(pb.x - pa.x, pb.y - pa.y);
  const step = Math.max(1, Math.ceil(d / 20));
  const out = new Map();
  for ( let n = 0; n <= step; n++ ) {
    const t = n / step;
    const c = cellAt({ x: pa.x + ((pb.x - pa.x) * t), y: pa.y + ((pb.y - pa.y) * t) });
    out.set(cellKey(c), c);
  }
  return [...out.values()];
}

/* ---------------------------------------------------------------- */
/*  Типы                                                             */
/* ---------------------------------------------------------------- */

/** Новый тип с разумным видом для своего вида и слоя. */
export function makeType({ id, kind, name, color, icon = "", layerId = "", layers = STARTER_LAYERS }) {
  if ( kind === "area" ) {
    const lid = layerId || "overlay";
    const terrain = lid === "terrain";
    const style = terrain
      ? { color, alpha: 1, borderWidth: 0, labelSize: 0 }
      : { color, alpha: lid === "politics" ? 0.28 : 0.15, borderWidth: lid === "politics" ? 4 : 2 };
    return { id, kind, name, layerId: layerById(layers, lid).id, style };
  }
  if ( kind === "object" ) return { id, kind, name, style: { color, icon: icon || "icons/svg/hanging-sign.svg" } };
  return { id, kind: "line", name, style: { color, widthStart: 3, widthEnd: 3, meander: 0.1 } };
}

/**
 * Все типы: атлас плюс личные типы игроков. При совпадении id побеждает атлас.
 * personal — [{ userId, types: [...] }].
 */
export function mergeTypes(atlasTypes, personal = []) {
  const out = [...atlasTypes];
  const ids = new Set(out.map(t => t.id));
  for ( const { userId, types } of personal ) {
    for ( const t of types ?? [] ) {
      if ( ids.has(t.id) ) continue;
      ids.add(t.id);
      out.push({ ...t, personal: userId });
    }
  }
  return out;
}

/** Личные типы, которыми пользуются правки: их мастер переносит в атлас при принятии. */
export function personalTypesUsed(ops, types) {
  const used = new Set(ops.map(op => op.state?.system?.typeId).filter(Boolean));
  return types.filter(t => t.personal && used.has(t.id)).map(({ personal, ...t }) => t);
}

/* ---------------------------------------------------------------- */
/*  Ходы                                                             */
/* ---------------------------------------------------------------- */

/** turn = { enabled, order: [userId], index, round }. */
export const TURN_DEFAULT = { enabled: false, order: [], index: 0, round: 1 };

export function currentTurnUserId(turn) {
  if ( !turn?.enabled || !turn.order?.length ) return null;
  return turn.order[Math.min(turn.index ?? 0, turn.order.length - 1)] ?? null;
}

/** Передать ход следующему по порядку. После последнего начинается новый круг. */
export function nextTurn(turn) {
  const order = turn.order ?? [];
  if ( !order.length ) return { ...turn, index: 0 };
  const index = ((turn.index ?? 0) + 1) % order.length;
  return { ...turn, index, round: (turn.round ?? 1) + (index === 0 ? 1 : 0) };
}

/** Может ли пользователь отправить заявку сейчас. */
export function canSubmit(turn, userId, isGM = false) {
  if ( isGM || !turn?.enabled ) return true;
  return currentTurnUserId(turn) === userId;
}

/** Порядок ходов после правки списка: убрать ушедших, индекс держится за того же игрока. */
export function setTurnOrder(turn, order) {
  const cur = currentTurnUserId(turn);
  const index = Math.max(0, order.indexOf(cur));
  return { ...turn, order: [...order], index: order.length ? index : 0 };
}
