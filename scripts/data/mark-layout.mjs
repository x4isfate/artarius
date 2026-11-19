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

/** Порядок в группе: сначала обычные метки, ресурсы после; дальше по sort и id. */
export function groupOrder(a, b) {
  const ra = isResourceType(a.system.typeId) ? 1 : 0, rb = isResourceType(b.system.typeId) ? 1 : 0;
  return (ra - rb) || ((a.system.sort ?? 0) - (b.system.sort ?? 0)) || String(a.id).localeCompare(String(b.id));
}

/**
 * Места меток на карте.
 * marks — видимые метки; grid — { center(cell), cellAt(point), radius }; sizeOf(mark) — доля гекса из стиля (0.6 по умолчанию).
 * Возвращает { slots, cells }:
 *  slots — [{ id, x, y, d, cell, key, n, count, more }] (more > 0 у плашки «+N», id у неё null);
 *  cells — Map ключ гекса → { cell, ids, count, x, y } для счётчика.
 */
export function layoutMarks(marks, grid, sizeOf = () => 0.6) {
  const r = grid.radius;
  const groups = new Map();
  for ( const m of marks ) {
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
  return { slots, cells };
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
