/**
 * Генератор тестового мира на гексах. Чистый код без Foundry, проверяется в Node.
 *
 * Высота и влажность — сглаженный шум по центрам гексов, по краям поля вода.
 * Местность берётся из высоты (вода, холмы, горы) и влажности (пустыня, равнина,
 * лес, болото), снега — на холодных краях карты. Ресурсы ставятся метками на гексы
 * подходящей местности. Стартовые державы растут от столиц, разнесённых по суше.
 *
 * Каждый элемент помечен system.ext.artariusGen = { seed, kind }: по нему повторная
 * генерация находит прошлую.
 */
import { seededRandom } from "../geometry/geometry.mjs";
import { REALM_COLORS } from "../constants.mjs";


/** Типы ресурсов: метки. Недостающие добавляются в атлас при генерации. */
export const RESOURCE_TYPES = [
  { id: "res-grain", kind: "object", name: "Зерно", style: { icon: "modules/artarius/assets/icons/wheat.svg", color: "#f0d17a", size: 0.38, labelSize: 0 } },
  { id: "res-wood", kind: "object", name: "Древесина", style: { icon: "modules/artarius/assets/icons/wood-pile.svg", color: "#b98a57", size: 0.38, labelSize: 0 } },
  { id: "res-stone", kind: "object", name: "Камень", style: { icon: "modules/artarius/assets/icons/stone-pile.svg", color: "#c9c3b8", size: 0.38, labelSize: 0 } },
  { id: "res-iron", kind: "object", name: "Железо", style: { icon: "modules/artarius/assets/icons/anvil.svg", color: "#9fb3c8", size: 0.38, labelSize: 0 } },
  { id: "res-gold", kind: "object", name: "Золото", style: { icon: "modules/artarius/assets/icons/gold-bar.svg", color: "#ffd24a", size: 0.38, labelSize: 0 } },
  { id: "res-fish", kind: "object", name: "Рыба", style: { icon: "modules/artarius/assets/icons/fishing.svg", color: "#8fd0f0", size: 0.38, labelSize: 0 } }
];

/** Какие ресурсы бывают на какой местности (с весами). */
const RESOURCE_BY_TERRAIN = {
  plains: [["res-grain", 1]],
  forest: [["res-wood", 1]],
  hills: [["res-stone", 3], ["res-iron", 1]],
  mountains: [["res-iron", 3], ["res-gold", 1], ["res-stone", 1]],
  swamp: [["res-wood", 1]],
  desert: [["res-gold", 1], ["res-stone", 2]],
  coast: [["res-fish", 1]]
};

export const GEN_DEFAULTS = { seed: "", water: 0.35, mountains: 0.1, resources: 0.1, realms: [] };

const key = ([i, j]) => `${i},${j}`;

/** Соседи гекса в сетке «острым верхом», нечётные ряды сдвинуты вправо (HEXODDR). */
export function oddRNeighbors([i, j]) {
  const d = (i & 1)
    ? [[0, 1], [0, -1], [-1, 0], [-1, 1], [1, 0], [1, 1]]
    : [[0, 1], [0, -1], [-1, -1], [-1, 0], [1, -1], [1, 0]];
  return d.map(([di, dj]) => [i + di, j + dj]);
}

/** Сглаженный шум: случайная решётка, билинейная интерполяция с плавным шагом, несколько октав. */
function makeNoise(rnd, size = 64) {
  const grid = Array.from({ length: size * size }, () => rnd());
  const at = (x, y) => grid[(((y % size) + size) % size * size) + (((x % size) + size) % size)];
  const smooth = t => t * t * (3 - (2 * t));
  const base = (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const tx = smooth(x - x0), ty = smooth(y - y0);
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return (a + ((b - a) * tx)) + (((c + ((d - c) * tx)) - (a + ((b - a) * tx))) * ty);
  };
  return (x, y, octaves = 4) => {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for ( let o = 0; o < octaves; o++ ) {
      sum += base(x * f, y * f) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  };
}

/** Значение порога, ниже которого лежит доля q значений. */
function quantile(values, q) {
  if ( !values.length ) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
}

function pickWeighted(list, rnd) {
  const total = list.reduce((a, [, w]) => a + w, 0);
  let r = rnd() * total;
  for ( const [id, w] of list ) {
    r -= w;
    if ( r <= 0 ) return id;
  }
  return list.at(-1)[0];
}

/**
 * Местность каждого гекса.
 * options: { cells, center, seed, water, mountains }. Возвращает Map "i,j" → тип местности.
 */
export function generateTerrain({ cells, center, seed = "", water = GEN_DEFAULTS.water, mountains = GEN_DEFAULTS.mountains }) {
  const rnd = seededRandom(`terrain:${seed}`);
  const hNoise = makeNoise(rnd);
  const mNoise = makeNoise(rnd);
  const pts = cells.map(c => center(c));
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  // Масштаб шума: около 5 «пятен» суши по длинной стороне.
  const scale = 5 / Math.max(w, h);
  const height = new Map(), moist = new Map(), lat = new Map();
  cells.forEach((c, n) => {
    const p = pts[n];
    const u = (p.x - minX) / w, v = (p.y - minY) / h;
    // Края поля опускаются: материк в середине, море по краям.
    const edge = Math.min(u, 1 - u, v, 1 - v);
    const falloff = Math.min(1, edge / 0.18);
    const k = key(c);
    height.set(k, (hNoise(p.x * scale, p.y * scale) * 0.75) + (falloff * 0.35));
    moist.set(k, mNoise((p.x * scale * 1.3) + 17, (p.y * scale * 1.3) + 31, 3));
    lat.set(k, Math.abs(v - 0.5) * 2);
  });
  const hs = [...height.values()];
  const seaLevel = quantile(hs, water);
  const land = hs.filter(x => x >= seaLevel);
  const mountLevel = quantile(land, 1 - mountains);
  const hillLevel = quantile(land, Math.max(0, 1 - mountains - 0.15));
  const ms = [...moist.values()];
  const dry = quantile(ms, 0.18), wet = quantile(ms, 0.62), soaked = quantile(ms, 0.9);
  const out = new Map();
  for ( const c of cells ) {
    const k = key(c);
    const ht = height.get(k), m = moist.get(k), la = lat.get(k);
    let t;
    if ( ht < seaLevel ) t = "water";
    else if ( ht >= mountLevel ) t = la > 0.75 ? "snow" : "mountains";
    else if ( la > 0.86 ) t = "snow";
    else if ( ht >= hillLevel ) t = "hills";
    else if ( m >= soaked && ht < quantile(land, 0.35) ) t = "swamp";
    else if ( m >= wet ) t = "forest";
    else if ( m <= dry && la < 0.6 ) t = "desert";
    else t = "plains";
    out.set(k, t);
  }
  return out;
}

/**
 * Столицы: первая — случайный гекс суши, каждая следующая — самый далёкий от уже выбранных.
 * Горы и вода не годятся.
 */
export function pickCapitals({ cells, terrain, center, count, rnd }) {
  const ok = cells.filter(c => !["water", "mountains", "snow"].includes(terrain.get(key(c))));
  if ( !ok.length || count <= 0 ) return [];
  const out = [ok[Math.floor(rnd() * ok.length)]];
  const d2 = (a, b) => { const p = center(a), q = center(b); return ((p.x - q.x) ** 2) + ((p.y - q.y) ** 2); };
  while ( out.length < Math.min(count, ok.length) ) {
    let best = null, bd = -1;
    for ( const c of ok ) {
      const d = Math.min(...out.map(o => d2(o, c)));
      if ( d > bd ) { bd = d; best = c; }
    }
    out.push(best);
  }
  return out;
}

/** Державы растут от столиц по суше одновременно, пока не наберут size гексов или не упрутся в соседей. */
export function growRealms({ capitals, terrain, neighbors, inBounds, size }) {
  const owner = new Map();
  const fronts = capitals.map(c => [c]);
  const counts = capitals.map(() => 1);
  capitals.forEach((c, n) => owner.set(key(c), n));
  let grew = true;
  while ( grew ) {
    grew = false;
    fronts.forEach((front, n) => {
      if ( counts[n] >= size ) return;
      const next = [];
      for ( const c of front ) {
        for ( const nb of neighbors(c) ) {
          const k = key(nb);
          if ( counts[n] >= size ) break;
          if ( !inBounds(nb) || owner.has(k) || terrain.get(k) === "water" || terrain.get(k) === undefined ) continue;
          owner.set(k, n);
          counts[n]++;
          next.push(nb);
        }
      }
      fronts[n] = next;
      if ( next.length ) grew = true;
    });
  }
  return capitals.map((_, n) => [...owner.entries()].filter(([, o]) => o === n).map(([k]) => k.split(",").map(Number)));
}

function baseSystem(kind, typeId, ext, extra = {}) {
  return {
    kind, typeId, demiurge: "", statuses: [], aspects: [], style: {}, geometry: {},
    layerId: "", blend: "replace", sort: 0, links: [], rev: 1, ext: { artariusGen: ext }, ...extra
  };
}

/**
 * Собрать тестовый мир.
 * options: { cells, center, neighbors?, inBounds?, seed, water, mountains, resources,
 *   realms: [{ name, color?, demiurge?, userId? }], newId }.
 * Возвращает { features, stats, seed }.
 */
export function generateWorld(options) {
  const o = { ...GEN_DEFAULTS, ...options };
  const seed = String(o.seed || Math.floor(Math.random() * 1e9).toString(36));
  const { cells, center, newId } = o;
  const neighbors = o.neighbors ?? oddRNeighbors;
  const all = new Set(cells.map(key));
  const inBounds = o.inBounds ?? (c => all.has(key(c)));
  const rnd = seededRandom(`world:${seed}`);
  const terrain = generateTerrain({ cells, center, seed, water: o.water, mountains: o.mountains });
  const features = [];
  const stats = { terrain: 0, hexes: cells.length, resources: 0, realms: 0 };
  const ext = kind => ({ seed, kind });

  // Местность: одна зона на тип.
  const byType = new Map();
  for ( const c of cells ) {
    const t = terrain.get(key(c));
    if ( !byType.has(t) ) byType.set(t, []);
    byType.get(t).push(c);
  }
  const TERRAIN_NAMES = { plains: "Равнины", forest: "Леса", hills: "Холмы", mountains: "Горы", swamp: "Болота", desert: "Пустыни", snow: "Снега", water: "Море" };
  let sort = 1;
  for ( const [t, list] of byType ) {
    features.push({
      id: newId(), name: TERRAIN_NAMES[t] ?? t, text: "",
      system: baseSystem("area", t, ext("terrain"), { layerId: "terrain", sort: sort++, geometry: { cells: list.map(c => [...c]) } })
    });
    stats.terrain++;
  }

  // Стартовые державы со столицами.
  const realms = o.realms ?? [];
  const busy = new Set();
  if ( realms.length ) {
    const landN = cells.filter(c => terrain.get(key(c)) !== "water").length;
    const size = Math.max(3, Math.min(19, Math.floor(landN / (realms.length * 4))));
    const capitals = pickCapitals({ cells, terrain, center, count: realms.length, rnd });
    const owned = growRealms({ capitals, terrain, neighbors, inBounds, size });
    capitals.forEach((cap, n) => {
      const r = realms[n];
      const color = r.color || REALM_COLORS[n % REALM_COLORS.length];
      const realmId = newId();
      features.push({
        id: realmId, name: r.name || `Держава ${n + 1}`, text: "",
        system: baseSystem("area", "realm", { ...ext("realm"), userId: r.userId ?? null }, {
          layerId: "politics", sort: sort++, demiurge: r.demiurge ?? "", style: { color }, geometry: { cells: owned[n] }
        })
      });
      const p = center(cap);
      features.push({
        id: newId(), name: r.capital || `Столица ${n + 1}`, text: "",
        system: baseSystem("object", "city", ext("capital"), {
          demiurge: r.demiurge ?? "", geometry: { x: Math.round(p.x), y: Math.round(p.y), cell: [...cap] },
          links: [{ target: realmId, role: "столица" }]
        })
      });
      busy.add(key(cap));
      stats.realms++;
    });
  }

  // Ресурсы: по одной метке на гекс, на подходящей местности. Рыба — у берега.
  const names = Object.fromEntries(RESOURCE_TYPES.map(t => [t.id, t.name]));
  const resRnd = seededRandom(`res:${seed}`);
  for ( const c of cells ) {
    const k = key(c);
    if ( busy.has(k) ) continue;
    let t = terrain.get(k);
    if ( t === "water" ) {
      const coast = neighbors(c).some(nb => inBounds(nb) && terrain.get(key(nb)) && terrain.get(key(nb)) !== "water");
      if ( !coast ) continue;
      t = "coast";
    }
    const list = RESOURCE_BY_TERRAIN[t];
    if ( !list || resRnd() >= o.resources ) continue;
    const typeId = pickWeighted(list, resRnd);
    const p = center(c);
    features.push({
      id: newId(), name: names[typeId], text: "",
      system: baseSystem("object", typeId, ext("resource"), { geometry: { x: Math.round(p.x), y: Math.round(p.y), cell: [...c] } })
    });
    stats.resources++;
  }

  return { features, stats, seed, terrain };
}

/** Добавить недостающие типы ресурсов. */
export function withResourceTypes(types) {
  const out = types.map(t => {
    // Значки ресурсов 0.3 (assets/res) заменены значками библиотеки.
    const base = RESOURCE_TYPES.find(r => r.id === t.id);
    if ( base && String(t.style?.icon ?? "").includes("/assets/res/") ) return { ...t, style: { ...t.style, icon: base.style.icon } };
    return t;
  });
  for ( const t of RESOURCE_TYPES ) if ( !out.some(x => x.id === t.id) ) out.push(structuredClone(t));
  return out;
}
