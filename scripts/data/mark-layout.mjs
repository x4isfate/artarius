/**
 * Раскладка меток по гексам, как значки на клетках в Civilization V.
 * Одна метка стоит там, где её поставили. Если в гексе меток несколько, они
 * собираются в аккуратную группу вокруг центра гекса и на гексе виден их счётчик.
 * Чистый код без Foundry и PIXI: этим пользуются и слой холста, и студия (захват мышью).
 */
import { cellKey, markCell } from "./world.mjs";
import { isResourceType } from "./view.mjs";

/** Места в группе, в долях радиуса гекса: [dx, dy], и диаметр значка в долях радиуса. */
const SLOTS = {
  2: { d: 0.78, at: [[-0.42, 0], [0.42, 0]] },
  3: { d: 0.72, at: [[-0.4, -0.24], [0.4, -0.24], [0, 0.44]] },
  4: { d: 0.66, at: [[-0.36, -0.36], [0.36, -0.36], [-0.36, 0.36], [0.36, 0.36]] }
};

/** Больше четырёх меток: три значка и плашка «+N» на четвёртом месте. */
export const MAX_SHOWN = 4;

/**
 * Порядок в группе: по sort (его задаёт перетаскивание на панели гекса), при равном sort
 * обычные метки раньше ресурсов, дальше по id. Пока порядок не трогали, у всех sort 0.
 */
export function groupOrder(a, b) {
  const ra = isResourceType(a.system.typeId) ? 1 : 0, rb = isResourceType(b.system.typeId) ? 1 : 0;
  return ((a.system.sort ?? 0) - (b.system.sort ?? 0)) || (ra - rb) || String(a.id).localeCompare(String(b.id));
}

/**
 * Места меток на карте.
 * marks — видимые метки; grid — { center(cell), cellAt(point), radius }; sizeOf(mark) — доля гекса из стиля (0.6 по умолчанию).
 * Возвращает { slots, cells }:
 *  slots — [{ id, x, y, d, cell, key, n, count, more }] (more > 0 у плашки «+N», id у неё null);
 *  cells — Map ключ гекса → { cell, ids, count, x, y } для счётчика.
 */
export function layoutMarks(marks, grid, sizeOf = () => 0.6, cellsOf = () => 1) {
  const r = grid.radius;
  const groups = new Map();
  const solo = [];
  for ( const m of marks ) {
    // Метка, поставленная в свою точку (Alt), или крупная (2 клетки и больше) стоит отдельно, не в группе гекса.
    const n = cellsOf(m) ?? 1;
    if ( m.system.geometry?.free || n > 1 ) { solo.push(m); continue; }
    const cell = markCell(m, grid.cellAt);
    const key = cellKey(cell);
    if ( !groups.has(key) ) groups.set(key, { cell, list: [] });
    groups.get(key).list.push(m);
  }
  const slots = [];
  const cells = new Map();
  for ( const [key, { cell, list }] of groups ) {
    list.sort(groupOrder);
    const count = list.length;
    const c = grid.center(cell);
    cells.set(key, { cell, ids: list.map(m => m.id), count, x: c.x, y: c.y });
    if ( count === 1 ) {
      const m = list[0];
      const { x = c.x, y = c.y } = m.system.geometry ?? {};
      slots.push({ id: m.id, x, y, d: r * 2 * (sizeOf(m) ?? 0.6), cell, key, n: 0, count, more: 0 });
      continue;
    }
    const plan = SLOTS[Math.min(count, MAX_SHOWN)];
    const shown = count > MAX_SHOWN ? MAX_SHOWN - 1 : count;
    for ( let n = 0; n < plan.at.length; n++ ) {
      const [dx, dy] = plan.at[n];
      // Значок в группе не крупнее одиночного, чтобы мелкие метки не раздувало.
      const own = n < shown ? r * 2 * (sizeOf(list[n]) ?? 0.6) : Infinity;
      const d = Math.min(r * plan.d, own);
      const base = { x: c.x + (dx * r), y: c.y + (dy * r), d, cell, key, n, count };
      if ( n < shown ) slots.push({ ...base, id: list[n].id, more: 0 });
      else slots.push({ ...base, id: null, more: count - shown });
    }
  }
  for ( const m of solo ) {
    const cell = markCell(m, grid.cellAt);
    const c = grid.center(cell);
    const g = m.system.geometry ?? {};
    const x = g.free ? (g.x ?? c.x) : c.x, y = g.free ? (g.y ?? c.y) : c.y;
    slots.push({ id: m.id, x, y, d: markDiameter(r, sizeOf(m), cellsOf(m)), cell, key: cellKey(cell), n: 0, count: 1, more: 0, solo: true });
  }
  return { slots, cells };
}

/**
 * Диаметр значка метки. size — масштаб вида (доля гекса, 0.6 по умолчанию), cells — сколько клеток метка
 * занимает в поперечнике, как размер токена 1×1, 2×2: при 2 значок примерно на две ширины гекса.
 */
export function markDiameter(radius, size = 0.6, cells = 1) {
  const k = (cells ?? 1) > 1 ? cells * 1.45 : 1;
  return radius * 2 * (size ?? 0.6) * k;
}

/** Гексы, которые занимает крупная метка: центр гекса внутри её круга. Для 1 клетки — только свой гекс. */
export function markFootprint(mark, grid, cells = 1) {
  const home = markCell(mark, grid.cellAt);
  if ( (cells ?? 1) <= 1 ) return [home];
  const c = grid.center(home);
  const reach = grid.radius * 2 * 0.6 * cells * 1.45 / 2;
  const out = [];
  const span = cells + 1;
  for ( let di = -span; di <= span; di++ ) for ( let dj = -span; dj <= span; dj++ ) {
    const cell = [home[0] + di, home[1] + dj];
    if ( grid.inBounds && !grid.inBounds(cell) ) continue;
    const p = grid.center(cell);
    if ( Math.hypot(p.x - c.x, p.y - c.y) <= reach ) out.push(cell);
  }
  return out;
}

/** Где на гексе рисовать счётчик меток: сверху по центру, внутри клетки. */
export function counterAt(group, radius) {
  return { x: group.x, y: group.y - (radius * 0.66), r: Math.max(8, radius * 0.21) };
}

/** Метка под точкой: верхняя из перекрывающихся. Плашку «+N» не берёт. */
export function markAt(slots, point) {
  for ( let n = slots.length - 1; n >= 0; n-- ) {
    const s = slots[n];
    if ( !s.id ) continue;
    if ( Math.hypot(point.x - s.x, point.y - s.y) <= s.d / 2 ) return s;
  }
  return null;
}
