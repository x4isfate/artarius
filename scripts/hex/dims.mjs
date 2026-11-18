/**
 * Размеры гекс-поля: сколько гексов по ширине и высоте и какого они размера.
 * Чистый код без Foundry. Сетка «острым верхом» (HEXODDR): size — ширина гекса
 * от грани до грани, высота от вершины до вершины size·2/√3.
 */

export const DIM_LIMITS = { cols: [5, 300], rows: [5, 300], size: [30, 400] };

const clamp = (v, [lo, hi], d) => Math.max(lo, Math.min(hi, Math.round(Number(v) || d)));

/** Ширина и высота одного гекса. */
export function hexDims(size) {
  return { w: size, h: size * 2 / Math.sqrt(3) };
}

/** Привести размеры к допустимым целым. */
export function normalizeDims({ cols, rows, size } = {}) {
  return {
    cols: clamp(cols, DIM_LIMITS.cols, 40),
    rows: clamp(rows, DIM_LIMITS.rows, 28),
    size: clamp(size, DIM_LIMITS.size, 100)
  };
}

/** Ширина и высота сцены в пикселях под cols × rows гексов. */
export function sceneSizeFor(dims) {
  const { cols, rows, size } = normalizeDims(dims);
  const { w, h } = hexDims(size);
  return { width: Math.round((cols * w) + (w / 2)), height: Math.round(((rows - 1) * h * 0.75) + h) };
}

/** Обратно: сколько гексов помещается в сцену width × height с гексом size. */
export function dimsOf({ width, height, size }) {
  const { w, h } = hexDims(size);
  return {
    cols: Math.max(1, Math.round((width - (w / 2)) / w)),
    rows: Math.max(1, Math.round(((height - h) / (h * 0.75)) + 1)),
    size: Math.round(size)
  };
}

/** Число рядов, при котором поле cols гексов в ширину имеет пропорции aspect = высота / ширина. */
export function rowsForAspect(cols, aspect, size = 100) {
  const { width } = sceneSizeFor({ cols, rows: 5, size });
  const { h } = hexDims(size);
  const rows = Math.round((((aspect * width) - h) / (h * 0.75)) + 1);
  return clamp(rows, DIM_LIMITS.rows, 28);
}

const minCell = cells => cells.reduce((m, [i, j]) => [Math.min(m[0], i), Math.min(m[1], j)], [Infinity, Infinity]);

/**
 * Перенести элементы на поле нового размера.
 * Гексы зон и меток сдвигаются вместе с началом поля (первым гексом), точки линий
 * растягиваются вслед за размером гекса от угла поля. Гексы за краем нового поля
 * отбрасываются; зона без гексов удаляется.
 *
 * before / after: { rect: { x, y }, size, cells } — поле до и после.
 * center, inBounds — функции новой сетки.
 * Возвращает { update: [state], delete: [id] }.
 */
export function remapFeatures(states, { before, after, center, inBounds }) {
  const [i0, j0] = minCell(before.cells);
  const [n0, m0] = minCell(after.cells);
  const k = after.size / before.size;
  const mapCell = ([i, j]) => [i - i0 + n0, j - j0 + m0];
  const mapPoint = ([x, y]) => [
    Math.round(after.rect.x + ((x - before.rect.x) * k)),
    Math.round(after.rect.y + ((y - before.rect.y) * k))
  ];
  const update = [];
  const del = [];
  for ( const s of states.values() ) {
    const sys = s.system ?? {};
    const g = sys.geometry ?? {};
    if ( sys.kind === "area" ) {
      const seen = new Set();
      const cells = [];
      for ( const c of g.cells ?? [] ) {
        const n = mapCell(c);
        const key = `${n[0]},${n[1]}`;
        if ( seen.has(key) || !inBounds(n) ) continue;
        seen.add(key);
        cells.push(n);
      }
      if ( !cells.length ) del.push(s.id);
      else update.push({ ...s, system: { ...sys, geometry: { ...g, cells } } });
    } else if ( sys.kind === "object" ) {
      const cell = g.cell ? mapCell(g.cell) : null;
      if ( cell && !inBounds(cell) ) { del.push(s.id); continue; }
      const p = cell ? center(cell) : null;
      const [x, y] = p ? [Math.round(p.x), Math.round(p.y)] : mapPoint([g.x ?? 0, g.y ?? 0]);
      update.push({ ...s, system: { ...sys, geometry: { ...g, x, y, ...(cell ? { cell } : {}) } } });
    } else if ( sys.kind === "line" ) {
      update.push({ ...s, system: { ...sys, geometry: { ...g, points: (g.points ?? []).map(mapPoint) } } });
    }
  }
  return { update, delete: del };
}
