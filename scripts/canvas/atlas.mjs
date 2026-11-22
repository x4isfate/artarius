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
 * Значки гекса: список { kind, x, y, s, … } в координатах холста.
 * kind: mountain, mountainRound, mountainTwin, hill, tree, birch, conifer, palm, tuft, dune, cactus,
 * ripple, stone, reed, wave, snow. Дополнительные поля задают вариант формы (шапка снега, тень, ярусы).
 * У гор, холмов, лесов, тайги и пустыни по шесть раскладок (0.9.9); раскладка берётся из номера гекса,
 * поэтому при перерисовке значки стоят на месте и у всех игроков одинаковые.
 */
export const GLYPH_VARIANTS = 6;

export function glyphsFor(typeId, center, r, seedKey, { deep = false } = {}) {
  const rnd = seededRandom(`glyph|${seedKey}`);
  const at = (spread = 0.45) => {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r * spread;
    return [center.x + (Math.cos(a) * d), center.y + (Math.sin(a) * d * 0.85)];
  };
  const out = [];
  const add = (kind, x, y, s, extra = null) => out.push(extra ? { kind, x, y, s, ...extra } : { kind, x, y, s });
  /** Значок в точке (dx, dy) в долях радиуса от центра, размер k долей радиуса. */
  const put = (kind, dx, dy, k, extra = null) => add(kind, center.x + (dx * r), center.y + (dy * r), k * r, extra);
  const scatter = (kind, n, s, spread) => {
    // Сверху вниз: нижние значки рисуются поверх верхних, как на гравюре.
    const pts = Array.from({ length: n }, () => at(spread)).sort((p, q) => p[1] - q[1]);
    for ( const [x, y] of pts ) add(kind, x, y, s * (0.85 + (0.3 * rnd())));
  };
  const variant = () => Math.floor(rnd() * GLYPH_VARIANTS);
  const TREES4 = [[-0.25, -0.2], [0.18, -0.25], [-0.05, 0.12], [0.28, 0.1]];
  switch ( typeId ) {
    case "mountains": {
      const v = variant();
      if ( v === 1 ) {
        // Снежные шапки.
        put("mountain", 0.3, -0.1, 0.58 * 0.7, { cap: true });
        put("mountain", -0.06, 0.1, 0.58 * 1.05, { cap: true });
      } else if ( v === 2 ) {
        // Гряда из пяти вершин.
        for ( const [dx, dy, k] of [[0.42, -0.28, 0.3], [0.14, -0.18, 0.36], [-0.16, -0.04, 0.34], [-0.42, 0.1, 0.3], [0.1, 0.22, 0.4]] ) put("mountain", dx, dy, k);
      } else if ( v === 3 ) {
        // Острые пики.
        put("mountain", 0.28, -0.02, 0.36, { hw: 0.55, top: 1.15 });
        put("mountain", -0.26, 0.02, 0.34, { hw: 0.55, top: 1.05 });
        put("mountain", 0.02, 0.14, 0.46, { hw: 0.55, top: 1.2 });
      } else if ( v === 4 ) {
        // Старые, округлые.
        put("mountainRound", 0.28, -0.08, 0.34);
        put("mountainRound", -0.08, 0.12, 0.5);
      } else if ( v === 5 ) {
        // Двуглавая.
        put("mountain", 0.42, 0.1, 0.26);
        put("mountainTwin", -0.08, 0.08, 0.52);
      } else {
        // Два-три пика: большой в середине, меньшие по бокам и чуть выше.
        const big = r * 0.58;
        const side = rnd() < 0.5 ? -1 : 1;
        add("mountain", center.x + (side * r * 0.32), center.y - (r * 0.12), big * 0.7);
        if ( rnd() < 0.6 ) add("mountain", center.x - (side * r * 0.34), center.y - (r * 0.05), big * 0.6);
        add("mountain", center.x + (side * r * -0.04), center.y + (r * 0.12), big);
      }
      break;
    }
    case "hills": {
      const v = variant();
      if ( v === 1 ) {
        put("hill", -0.25, -0.1, 0.4, { shade: true });
        put("hill", 0.22, 0.14, 0.46, { shade: true });
      } else if ( v === 2 ) {
        for ( const [dx, dy] of [[-0.38, -0.2], [-0.06, -0.3], [0.28, -0.2], [-0.22, 0.14], [0.12, 0.14], [0.42, 0.2]] ) put("hill", dx, dy, 0.24);
      } else if ( v === 3 ) {
        put("hill", -0.22, 0.05, 0.46);
        put("hill", 0.3, 0.2, 0.3);
        put("tree", -0.22, -0.22, 0.16);
      } else if ( v === 4 ) {
        put("hill", -0.02, 0.05, 0.5, { R0: 1.05, a0: 1.25, a1: 1.75 });
        put("hill", 0.2, -0.32, 0.26);
      } else if ( v === 5 ) {
        put("hill", -0.22, -0.14, 0.4);
        put("hill", 0.24, 0.02, 0.36);
        put("stone", -0.12, 0.34, 1);
        put("stone", 0.02, 0.4, 0.8);
        put("stone", 0.4, 0.32, 0.7);
      } else {
        add("hill", center.x - (r * 0.25), center.y - (r * 0.1), r * 0.38);
        add("hill", center.x + (r * 0.22), center.y + (r * 0.12), r * 0.42);
        if ( rnd() < 0.4 ) add("hill", center.x + (r * 0.05), center.y - (r * 0.38), r * 0.3);
      }
      break;
    }
    case "forest": {
      const v = variant();
      if ( v === 1 ) {
        // Густой лес: десять деревьев помельче.
        [[-0.32, -0.28], [0, -0.34], [0.3, -0.26], [-0.42, 0.02], [-0.14, -0.04], [0.16, -0.02], [0.42, 0.04], [-0.24, 0.26], [0.06, 0.26], [0.32, 0.3]]
          .forEach(([dx, dy], i) => put("tree", dx, dy, 0.15, i % 3 ? null : { color: 0x738f55 }));
      } else if ( v === 2 ) {
        put("conifer", -0.28, -0.2, 0.22);
        put("tree", 0.14, -0.26, 0.19);
        put("tree", -0.1, 0.12, 0.2);
        put("conifer", 0.3, 0.06, 0.24);
      } else if ( v === 3 ) {
        // Дуб с тенью.
        put("tree", 0.28, -0.28, 0.13);
        put("tree", -0.05, -0.05, 0.36, { shadow: true });
        put("tree", -0.38, 0.2, 0.13);
      } else if ( v === 4 ) {
        // Опушка.
        put("tree", -0.32, -0.2, 0.19);
        put("tree", -0.1, -0.02, 0.2);
        put("tree", -0.36, 0.2, 0.18);
        put("tuft", 0.26, -0.1, 0.2);
        put("tuft", 0.36, 0.26, 0.18);
      } else if ( v === 5 ) {
        for ( const [dx, dy] of [[-0.3, -0.2], [0.02, -0.28], [0.32, -0.16], [-0.14, 0.14], [0.2, 0.16]] ) put("birch", dx, dy, 0.26);
      } else scatter("tree", 4, r * 0.2, 0.5);
      break;
    }
    case "jungle": scatter(rnd() < 0.5 ? "palm" : "tree", 5, r * 0.2, 0.52); break;
    case "taiga": {
      const v = variant();
      if ( v === 1 ) {
        for ( const [dx, dy, k] of [[-0.34, -0.14, 0.2], [-0.08, -0.3, 0.3], [0.24, -0.2, 0.24], [-0.18, 0.16, 0.26], [0.2, 0.18, 0.18]] ) put("conifer", dx, dy, k);
      } else if ( v === 2 ) {
        put("conifer", -0.26, 0.02, 0.26);
        put("conifer", 0.12, -0.12, 0.34, { tiers: 2 });
        put("conifer", 0.38, 0.2, 0.2);
      } else if ( v === 3 ) {
        put("conifer", -0.2, -0.2, 0.26);
        put("conifer", 0.26, 0.02, 0.22);
        put("tuft", -0.3, 0.32, 0.17);
        put("tuft", 0.02, 0.2, 0.15);
      } else if ( v === 4 ) {
        for ( const [dx, dy] of [[-0.36, -0.24], [-0.08, -0.32], [0.22, -0.28], [-0.24, 0.02], [0.06, -0.02], [0.36, 0], [-0.08, 0.28], [0.22, 0.26]] ) put("conifer", dx, dy, 0.17);
      } else if ( v === 5 ) {
        for ( const [dx, dy] of TREES4 ) put("conifer", dx, dy, 0.24, { snow: true });
      } else scatter("conifer", 4, r * 0.24, 0.5);
      break;
    }
    case "mangrove": scatter("tree", 2, r * 0.17, 0.4); scatter("reed", 2, r * 0.18, 0.45); break;
    case "swamp": scatter("reed", 3, r * 0.2, 0.5); break;
    case "plains": if ( rnd() < 0.7 ) scatter("tuft", 1 + Math.floor(rnd() * 2), r * 0.16, 0.45); break;
    case "savanna":
      scatter("tuft", 2, r * 0.16, 0.45);
      if ( rnd() < 0.35 ) scatter("tree", 1, r * 0.16, 0.35);
      break;
    case "tundra": if ( rnd() < 0.6 ) scatter("tuft", 1, r * 0.13, 0.4); break;
    case "desert": {
      const v = variant();
      const dunes = () => { put("dune", -0.15, -0.12, 0.28); put("dune", 0.18, 0.2, 0.28); };
      if ( v === 1 ) {
        // Микрокактусы: еле видны издалека.
        dunes();
        put("cactus", 0.3, -0.14, 0.15, { op: 0.3 });
        put("cactus", -0.36, 0.2, 0.15 * 0.85, { op: 0.3 });
        put("cactus", 0.02, 0.42, 0.15 * 0.7, { op: 0.3 });
      } else if ( v === 2 ) {
        for ( const [dx, dy] of [[-0.42, -0.3], [-0.08, -0.22], [0.12, -0.4], [-0.3, 0.02], [0.06, 0.08], [-0.16, 0.32], [0.2, 0.3]] ) put("ripple", dx, dy, 1);
      } else if ( v === 3 ) {
        put("dune", -0.1, -0.12, 0.32);
        put("stone", 0.2, 0.26, 1);
        put("stone", 0.32, 0.2, 0.7);
        put("stone", 0.1, 0.34, 0.6);
      } else if ( v === 4 ) {
        for ( const [dx, dy, m] of [[-0.3, -0.1, 1], [0.12, -0.26, 0.8], [0.32, 0.16, 1], [-0.08, 0.3, 0.75]] ) put("cactus", dx, dy, 0.15 * m, { op: 0.34 });
      } else if ( v === 5 ) {
        put("dune", -0.1, -0.05, 0.4, { shade: true });
        put("dune", 0.28, 0.3, 0.2, { shade: true });
      } else scatter("dune", 1 + Math.floor(rnd() * 2), r * 0.28, 0.4);
      break;
    }
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
