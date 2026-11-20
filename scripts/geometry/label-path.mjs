/**
 * Изогнутые подписи зон, как названия государств в Azgaar: надпись идёт вдоль
 * главной оси зоны и повторяет её изгиб. Чистый код без Foundry.
 */

/** Самый большой связный кусок зоны: острова державы подпись не тянут. */
export function largestComponent(cells, neighbors) {
  const key = c => `${c[0]},${c[1]}`;
  const all = new Map(cells.map(c => [key(c), c]));
  const seen = new Set();
  let best = [];
  for ( const c of cells ) {
    if ( seen.has(key(c)) ) continue;
    const part = [];
    const stack = [c];
    seen.add(key(c));
    while ( stack.length ) {
      const x = stack.pop();
      part.push(x);
      for ( const nb of neighbors(x) ) {
        const k = key(nb);
        if ( all.has(k) && !seen.has(k) ) { seen.add(k); stack.push(all.get(k)); }
      }
    }
    if ( part.length > best.length ) best = part;
  }
  return best;
}

/**
 * Путь подписи по точкам зоны (центрам гексов).
 * Главная ось — по разбросу точек, наклон не круче maxTilt, чтобы текст читался.
 * Ось режется на bins отрезков, в каждом берётся середина зоны поперёк оси — так путь изгибается вместе с зоной.
 * Возвращает { path: [[x, y]…], length } или null, если точек мало.
 */
export function labelPath(points, { bins = 7, trim = 0.12, maxTilt = Math.PI / 4, bend = 1 } = {}) {
  if ( points.length < 2 ) return null;
  const n = points.length;
  const mx = points.reduce((s, p) => s + p[0], 0) / n, my = points.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for ( const [x, y] of points ) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  let angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  // Текст слева направо и не вверх ногами.
  if ( angle > Math.PI / 2 ) angle -= Math.PI;
  if ( angle < -Math.PI / 2 ) angle += Math.PI;
  angle = Math.max(-maxTilt, Math.min(maxTilt, angle));
  const d = [Math.cos(angle), Math.sin(angle)], nrm = [-d[1], d[0]];
  const proj = points.map(([x, y]) => [((x - mx) * d[0]) + ((y - my) * d[1]), ((x - mx) * nrm[0]) + ((y - my) * nrm[1])]);
  let amin = Math.min(...proj.map(p => p[0])), amax = Math.max(...proj.map(p => p[0]));
  const span = amax - amin;
  if ( span <= 0 ) return null;
  amin += span * trim; amax -= span * trim;
  const step = (amax - amin) / (bins - 1);
  const off = [];
  for ( let i = 0; i < bins; i++ ) {
    const a = amin + (i * step);
    const near = proj.filter(p => Math.abs(p[0] - a) <= step * 0.75);
    off.push(near.length ? (Math.min(...near.map(p => p[1])) + Math.max(...near.map(p => p[1]))) / 2 : null);
  }
  // Пустые отрезки берут соседей, потом два прохода сглаживания.
  for ( let i = 0; i < bins; i++ ) if ( off[i] === null ) off[i] = off[i - 1] ?? off.slice(i).find(v => v !== null) ?? 0;
  let sm = off;
  for ( let pass = 0; pass < 3; pass++ ) sm = sm.map((v, i) => ((sm[i - 1] ?? v) + (2 * v) + (sm[i + 1] ?? v)) / 4);
  // Изгиб не больше пятой части длины, bend ослабляет или выключает его.
  const lim = (amax - amin) / 5;
  const path = sm.map((b, i) => {
    const bb = Math.max(-lim, Math.min(lim, b)) * bend;
    const a = amin + (i * step);
    return [mx + (a * d[0]) + (bb * nrm[0]), my + (a * d[1]) + (bb * nrm[1])];
  });
  return { path, length: pathLength(path) };
}

export function pathLength(path) {
  let L = 0;
  for ( let i = 1; i < path.length; i++ ) L += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return L;
}

/** Точка и направление на расстоянии s от начала пути. */
export function pointAt(path, s) {
  // До начала и после конца путь продолжается прямо.
  if ( s < 0 && path.length > 1 ) {
    const [x0, y0] = path[0], [x1, y1] = path[1];
    const a = Math.atan2(y1 - y0, x1 - x0);
    return { x: x0 + (Math.cos(a) * s), y: y0 + (Math.sin(a) * s), angle: a };
  }
  let left = s;
  for ( let i = 1; i < path.length; i++ ) {
    const [x0, y0] = path[i - 1], [x1, y1] = path[i];
    const L = Math.hypot(x1 - x0, y1 - y0);
    if ( left <= L || i === path.length - 1 ) {
      const t = L ? Math.max(0, left / L) : 0;
      return { x: x0 + ((x1 - x0) * t), y: y0 + ((y1 - y0) * t), angle: Math.atan2(y1 - y0, x1 - x0) };
    }
    left -= L;
  }
  const p = path.at(-1);
  return { x: p[0], y: p[1], angle: 0 };
}

/**
 * Разложить буквы по пути: widths — ширина каждой буквы. Текст по центру пути,
 * если он длиннее пути — буквы встают вплотную и выходят за края поровну.
 * Возвращает [{ x, y, angle }] для центра каждой буквы.
 */
export function placeLetters(path, widths, spacing = 0) {
  const L = pathLength(path);
  const total = widths.reduce((a, b) => a + b, 0) + (spacing * Math.max(0, widths.length - 1));
  let s = (L - total) / 2;
  const out = [];
  for ( const w of widths ) {
    out.push(pointAt(path, s + (w / 2)));
    s += w + spacing;
  }
  return out;
}

/** Размер шрифта, при котором надпись займёт около fill длины пути. */
export function fitFontSize(text, length, { fill = 0.8, min = 12, max = 64, charWidth = 0.62, scale = 1 } = {}) {
  const chars = Math.max(1, String(text).length);
  const size = (length * fill) / (chars * charWidth);
  return Math.round(Math.max(min, Math.min(max, size)) * scale);
}
