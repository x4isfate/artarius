/**
 * Вид «Атлас»: местность как на старой бумажной карте. Бумажные цвета биомов,
 * обводка берега, значки гор, холмов и лесов, штрихи волн на глубокой воде.
 * Здесь только расчёт: какой цвет у гекса и какие значки в нём стоят.
 * Рисует hex-renderer.
 */
import { seededRandom } from "../geometry/geometry.mjs";

/** Бумажные цвета биомов. Свой тип местности без цвета в списке берёт свой цвет, смешанный с бумагой. */
export const ATLAS_PAPER = {
  deep: "#8fb0c4", water: "#a9c6d3", shallow: "#bcd3dc",
  plains: "#cfd39a", forest: "#a8b884", hills: "#d9c99a", mountains: "#c9b99a",
  swamp: "#b3bb95", desert: "#e8d6a6", snow: "#f1eee6", savanna: "#ddd39c",
  jungle: "#93ae86", taiga: "#a2b096", tundra: "#d5d5bf", mangrove: "#a3b38f"
};
export const ATLAS_INK = "#463728";
const PAPER_BASE = "#e9dfc5";

const hex2rgb = h => {
  const n = parseInt(String(h).replace("#", "").slice(0, 6).padEnd(6, "0"), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgb2hex = ([r, g, b]) => `#${[r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
export const mixColor = (a, b, t) => {
  const A = hex2rgb(a), B = hex2rgb(b);
  return rgb2hex(A.map((v, i) => v + ((B[i] - v) * t)));
};
export const shadeColor = (c, k) => rgb2hex(hex2rgb(c).map(v => v * k));

/** Бумажный цвет типа местности. */
export function paperColor(typeId, ownColor) {
  return ATLAS_PAPER[typeId] ?? mixColor(ownColor || PAPER_BASE, PAPER_BASE, 0.55);
}

/** Сглаженный шум 0..1 по точке: на нём держится неровный тон бумаги. */
export function paperNoise(x, y, scale) {
  const lattice = (i, j) => seededRandom(`paper|${i}|${j}`)();
  const fx = x / scale, fy = y / scale;
  const i = Math.floor(fx), j = Math.floor(fy);
  const tx = fx - i, ty = fy - j;
  const sx = tx * tx * (3 - (2 * tx)), sy = ty * ty * (3 - (2 * ty));
  const a = lattice(i, j), b = lattice(i + 1, j), c = lattice(i, j + 1), d = lattice(i + 1, j + 1);
  return (a + ((b - a) * sx)) + (((c + ((d - c) * sx)) - (a + ((b - a) * sx))) * sy);
}

/** Тон бумаги: множитель около 0.9…1.02, ступенями, чтобы гексы с одним тоном рисовались одной заливкой. */
export function paperTone(x, y, radius) {
  const v = (0.75 * paperNoise(x, y, radius * 3)) + (0.25 * paperNoise(x, y, radius * 11));
  return Math.round((0.9 + (0.12 * v)) * 50) / 50;
}

/**
 * Расстояние в гексах от каждого гекса воды до суши (у суши 0). Пустой гекс — тоже вода.
 * terrainOf(key) — id типа местности или undefined.
 */
export function waterDistance(cells, neighbors, terrainOf, { max = 4, inBounds = () => true } = {}) {
  const key = c => `${c[0]},${c[1]}`;
  const isWater = c => { const t = terrainOf(key(c)); return !t || t === "water"; };
  const dist = new Map();
  let front = [];
  for ( const c of cells ) if ( !isWater(c) ) { dist.set(key(c), 0); front.push(c); }
  for ( let d = 1; d <= max && front.length; d++ ) {
    const next = [];
    for ( const c of front ) for ( const nb of neighbors(c) ) {
      const k = key(nb);
      if ( dist.has(k) || !inBounds(nb) ) continue;
      dist.set(k, d);
      next.push(nb);
    }
    front = next;
  }
  return dist;
}

/** Цвет воды по расстоянию до суши: у берега светлее, вдали глубже. */
export function waterColor(dist) {
  if ( dist === 1 ) return ATLAS_PAPER.shallow;
  if ( dist === 2 ) return ATLAS_PAPER.water;
  if ( dist === 3 ) return mixColor(ATLAS_PAPER.water, ATLAS_PAPER.deep, 0.5);
  return ATLAS_PAPER.deep;
}

/**
 * Значки гекса: список { kind, x, y, s } в координатах холста.
 * kind: mountain, hill, tree, conifer, palm, tuft, dune, reed, wave, snow.
 * Раскладка зависит от гекса, поэтому при перерисовке значки стоят на месте.
 */
export function glyphsFor(typeId, center, r, seedKey, { deep = false } = {}) {
  const rnd = seededRandom(`glyph|${seedKey}`);
  const at = (spread = 0.45) => {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r * spread;
    return [center.x + (Math.cos(a) * d), center.y + (Math.sin(a) * d * 0.85)];
  };
  const out = [];
  const add = (kind, x, y, s) => out.push({ kind, x, y, s });
  const scatter = (kind, n, s, spread) => {
    // Сверху вниз: нижние значки рисуются поверх верхних, как на гравюре.
    const pts = Array.from({ length: n }, () => at(spread)).sort((p, q) => p[1] - q[1]);
    for ( const [x, y] of pts ) add(kind, x, y, s * (0.85 + (0.3 * rnd())));
  };
  switch ( typeId ) {
    case "mountains": {
      // Два-три пика: большой в середине, меньшие по бокам и чуть выше.
      const big = r * 0.58;
      const side = rnd() < 0.5 ? -1 : 1;
      add("mountain", center.x + (side * r * 0.32), center.y - (r * 0.12), big * 0.7);
      if ( rnd() < 0.6 ) add("mountain", center.x - (side * r * 0.34), center.y - (r * 0.05), big * 0.6);
      add("mountain", center.x + (side * r * -0.04), center.y + (r * 0.12), big);
      break;
    }
    case "hills":
      add("hill", center.x - (r * 0.25), center.y - (r * 0.1), r * 0.38);
      add("hill", center.x + (r * 0.22), center.y + (r * 0.12), r * 0.42);
      if ( rnd() < 0.4 ) add("hill", center.x + (r * 0.05), center.y - (r * 0.38), r * 0.3);
      break;
    case "forest": scatter("tree", 4, r * 0.2, 0.5); break;
    case "jungle": scatter(rnd() < 0.5 ? "palm" : "tree", 5, r * 0.2, 0.52); break;
    case "taiga": scatter("conifer", 4, r * 0.24, 0.5); break;
    case "mangrove": scatter("tree", 2, r * 0.17, 0.4); scatter("reed", 2, r * 0.18, 0.45); break;
    case "swamp": scatter("reed", 3, r * 0.2, 0.5); break;
    case "plains": if ( rnd() < 0.7 ) scatter("tuft", 1 + Math.floor(rnd() * 2), r * 0.16, 0.45); break;
    case "savanna":
      scatter("tuft", 2, r * 0.16, 0.45);
      if ( rnd() < 0.35 ) scatter("tree", 1, r * 0.16, 0.35);
      break;
    case "tundra": if ( rnd() < 0.6 ) scatter("tuft", 1, r * 0.13, 0.4); break;
    case "desert": scatter("dune", 1 + Math.floor(rnd() * 2), r * 0.28, 0.4); break;
    case "snow": if ( rnd() < 0.4 ) scatter("snow", 1, r * 0.22, 0.35); break;
    case "water": case undefined: case null: case "":
      if ( deep && rnd() < 0.55 ) scatter("wave", 1, r * 0.26, 0.35);
      break;
  }
  return out;
}

/** Пары (суша, вода) соседних гексов: по их общему ребру идёт обводка берега. */
export function coastPairs(cells, neighbors, terrainOf, inBounds = () => true) {
  const key = c => `${c[0]},${c[1]}`;
  const isWater = c => { const t = terrainOf(key(c)); return !t || t === "water"; };
  const out = [];
  for ( const c of cells ) {
    if ( isWater(c) ) continue;
    for ( const nb of neighbors(c) ) if ( inBounds(nb) && isWater(nb) ) out.push([c, nb]);
  }
  return out;
}

/** Общее ребро двух соседних гексов: две вершины или null. */
export function sharedEdge(va, vb) {
  const k = v => `${Math.round(v.x * 10)},${Math.round(v.y * 10)}`;
  const set = new Map(vb.map(v => [k(v), v]));
  const n = va.length;
  for ( let i = 0; i < n; i++ ) {
    const a = va[i], b = va[(i + 1) % n];
    if ( set.has(k(a)) && set.has(k(b)) ) return [a, b];
  }
  return null;
}
