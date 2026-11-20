/**
 * Данные гексов для слоёв как в Azgaar: высота, температура, осадки, население, лёд.
 * Хранятся во флаге сцены одним объектом: { i0, j0, cols, rows, height: [], temp: [], prec: [], pop: [] },
 * индекс гекса [i, j] — (i - i0) * cols + (j - j0). В Foundry ряды поля начинаются не с нуля (отступ сцены).
 * Приходят из импорта Azgaar и из генератора.
 * Чистый код без Foundry.
 */

export const FIELD_IDS = ["height", "temp", "prec", "pop"];

/** Высота воды по шкале Azgaar: ниже 20 — море. */
export const SEA_LEVEL = 20;
/** Лёд: гекс холоднее этого (°C). */
export const ICE_TEMP = -6;

/** Рамка поля по списку гексов: { i0, j0, cols, rows }. */
export function fieldBox(cells) {
  if ( !cells.length ) return { i0: 0, j0: 0, cols: 0, rows: 0 };
  let i0 = Infinity, j0 = Infinity, i1 = -Infinity, j1 = -Infinity;
  for ( const [i, j] of cells ) {
    if ( i < i0 ) i0 = i; if ( i > i1 ) i1 = i;
    if ( j < j0 ) j0 = j; if ( j > j1 ) j1 = j;
  }
  return { i0, j0, cols: j1 - j0 + 1, rows: i1 - i0 + 1 };
}

/** Собрать поля из значений по гексам. values(cell) → { height, temp, prec, pop } или null. */
export function buildFields(cells, values) {
  const box = fieldBox(cells);
  const out = { ...box };
  for ( const id of FIELD_IDS ) out[id] = new Array(box.cols * box.rows).fill(null);
  for ( const c of cells ) {
    const v = values(c);
    if ( !v ) continue;
    const n = ((c[0] - box.i0) * box.cols) + (c[1] - box.j0);
    for ( const id of FIELD_IDS ) {
      const x = v[id] === null || v[id] === undefined || v[id] === "" ? NaN : Number(v[id]);
      out[id][n] = Number.isFinite(x) ? Math.round(x * 10) / 10 : null;
    }
  }
  return out;
}

/** Подходят ли поля к этому полю сцены (после смены размера — нет). */
export function fieldsFit(fields, cells) {
  if ( !fields ) return false;
  const b = fieldBox(cells);
  return fields.cols === b.cols && fields.rows === b.rows && (fields.i0 ?? 0) === b.i0 && (fields.j0 ?? 0) === b.j0;
}

/** Значение поля в гексе или null. */
export function fieldAt(fields, id, [i, j]) {
  if ( !fields?.[id] ) return null;
  const r = i - (fields.i0 ?? 0), c = j - (fields.j0 ?? 0);
  if ( r < 0 || c < 0 || r >= fields.rows || c >= fields.cols ) return null;
  return fields[id][(r * fields.cols) + c] ?? null;
}

/** Есть ли в поле хоть одно значение. */
export function hasField(fields, id) {
  return !!fields?.[id]?.some(v => v !== null && v !== undefined);
}

const lerp = (a, b, t) => a + ((b - a) * t);
const hex = n => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");

/** Цвет по шкале: stops = [[значение, "#rrggbb"], …] по возрастанию. */
export function rampColor(stops, value) {
  if ( value <= stops[0][0] ) return stops[0][1];
  for ( let n = 1; n < stops.length; n++ ) {
    const [v1, c1] = stops[n];
    if ( value > v1 ) continue;
    const [v0, c0] = stops[n - 1];
    const t = (value - v0) / ((v1 - v0) || 1);
    const p = s => [1, 3, 5].map(k => parseInt(s.slice(k, k + 2), 16));
    const a = p(c0), b = p(c1);
    return `#${hex(lerp(a[0], b[0], t))}${hex(lerp(a[1], b[1], t))}${hex(lerp(a[2], b[2], t))}`;
  }
  return stops.at(-1)[1];
}

/** Шкалы как в Azgaar: высота от зелёного к бурому и белому, температура от синего к красному, осадки к синему. */
export const RAMPS = {
  height: [[0, "#0d2f5e"], [19, "#4a86c5"], [20, "#5a9a4c"], [40, "#b5c46a"], [60, "#c79a52"], [80, "#8a6a52"], [100, "#f4f4f4"]],
  temp: [[-30, "#3a4fd6"], [-10, "#7fb4ee"], [0, "#e2f1f2"], [12, "#f6e58d"], [24, "#f0913c"], [35, "#c4221d"]],
  prec: [[0, "#f7f2e2"], [20, "#bfe0e8"], [50, "#4f9fd2"], [100, "#16407e"]],
  pop: [[0, "#f3e3f4"], [5, "#c98bd3"], [30, "#7a2e93"], [100, "#3b0b52"]]
};

/** Подпись значения для подсказки. */
export function fieldLabel(id, value) {
  if ( value === null || value === undefined ) return "";
  if ( id === "temp" ) return `${Math.round(value)} °C`;
  if ( id === "pop" ) return value >= 1 ? `${Math.round(value)} тыс.` : `${Math.round(value * 1000)}`;
  return String(Math.round(value));
}

/**
 * Поля для генератора: высота 0–100 (море ниже 20), температура от широты и высоты,
 * осадки из влажности, население по местности.
 */
export function generatedFields({ cells, height, moist, lat, seaLevel, terrain, key }) {
  const land = [...height.values()].filter(h => h >= seaLevel);
  const top = land.length ? Math.max(...land) : seaLevel + 1;
  const bottom = Math.min(...height.values());
  const ms = [...moist.values()];
  const mMin = Math.min(...ms), mMax = Math.max(...ms);
  const POP = { plains: 12, forest: 5, hills: 6, swamp: 2, desert: 1, mountains: 1, snow: 0, water: 0 };
  return buildFields(cells, c => {
    const k = key(c);
    const ht = height.get(k);
    const h = ht < seaLevel
      ? (SEA_LEVEL - 1) * (ht - bottom) / ((seaLevel - bottom) || 1)
      : SEA_LEVEL + ((100 - SEA_LEVEL) * (ht - seaLevel) / ((top - seaLevel) || 1));
    const la = lat.get(k);
    const temp = 28 - (la * 48) - (Math.max(0, h - SEA_LEVEL) * 0.35);
    const prec = 100 * (moist.get(k) - mMin) / ((mMax - mMin) || 1);
    const t = terrain.get(k);
    const pop = (POP[t] ?? 0) * (0.5 + (prec / 100)) * (temp < -5 ? 0.2 : 1);
    return { height: h, temp, prec, pop };
  });
}
