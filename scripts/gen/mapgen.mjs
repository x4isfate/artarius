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
import { RECIPES, layoutRecipe, piecesHeight, NEUTRAL_OBJECTS, NEUTRAL_TYPES, PIECES } from "./pieces.mjs";


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
  savanna: [["res-grain", 2], ["res-stone", 1]],
  jungle: [["res-wood", 2], ["res-gold", 1]],
  taiga: [["res-wood", 3], ["res-iron", 1]],
  tundra: [["res-stone", 1], ["res-iron", 1]],
  mangrove: [["res-wood", 1]],
  coast: [["res-fish", 1]]
};

export const GEN_DEFAULTS = { seed: "", water: 0.35, mountains: 0.1, resources: 0.1, neutral: 0.5, recipe: "", realms: [] };

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
export function generateTerrain(options) {
  return generateTerrainData(options).terrain;
}

/**
 * Местность и то, из чего она получилась: высота, влажность, температура, широта, уровень моря.
 *
 * Рельеф собирается из «кусочков» (pieces.mjs) по случайному рецепту плюс мелкий шум.
 * Температура падает от экватора к полюсам и с высотой, влажность растёт у воды и падает
 * за горами (ветер с запада). Биомы идут по порядку тепла и влаги, поэтому пустыня не встаёт
 * рядом с тундрой, а границы между ними размыты шумом.
 */
export function generateTerrainData({ cells, center, seed = "", water = GEN_DEFAULTS.water, mountains = GEN_DEFAULTS.mountains, recipe = null }) {
  const rnd = seededRandom(`terrain:${seed}`);
  const dNoise = makeNoise(rnd);
  const mNoise = makeNoise(rnd);
  const tNoise = makeNoise(rnd);
  const pts = cells.map(c => center(c));
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  const ax = w / h;
  const scale = 6 / Math.max(w, h);
  const pickRecipe = RECIPES.find(r => r.id === recipe) ?? RECIPES[Math.floor(rnd() * RECIPES.length)];
  const layout = layoutRecipe(pickRecipe, rnd);
  const shapeH = piecesHeight(layout, ax, rnd);
  // Экватор гуляет: мир может быть целиком северным или южным.
  const equator = 0.5 + ((rnd() - 0.5) * 0.5);
  const height = new Map(), moist = new Map(), lat = new Map(), uv = new Map();
  cells.forEach((c, n) => {
    const p = pts[n];
    const u = (p.x - minX) / w, v = (p.y - minY) / h;
    const edge = Math.min(u, 1 - u, v, 1 - v);
    const falloff = Math.min(1, edge / 0.1);
    const k = key(c);
    const detail = (dNoise(p.x * scale, p.y * scale) - 0.5) * 0.4;
    height.set(k, shapeH(u, v) + detail - ((1 - falloff) * 0.6));
    lat.set(k, Math.min(1, Math.abs(v - equator) / Math.max(equator, 1 - equator)));
    uv.set(k, [u, v]);
  });
  const hs = [...height.values()];
  const seaLevel = quantile(hs, water);
  const land = hs.filter(x => x >= seaLevel);
  const mountLevel = quantile(land, 1 - mountains);
  const hillLevel = quantile(land, Math.max(0, 1 - mountains - 0.15));
  const top = land.length ? Math.max(...land) : seaLevel + 1;

  // Расстояние до воды в гексах (волной от моря).
  const byKey = new Map(cells.map(c => [key(c), c]));
  const dist = new Map();
  let front = cells.filter(c => height.get(key(c)) < seaLevel);
  for ( const c of front ) dist.set(key(c), 0);
  for ( let d = 1; front.length && d < 40; d++ ) {
    const next = [];
    for ( const c of front ) {
      for ( const nb of oddRNeighbors(c) ) {
        const nk = key(nb);
        if ( !byKey.has(nk) || dist.has(nk) ) continue;
        dist.set(nk, d);
        next.push(nb);
      }
    }
    front = next;
  }

  const temp = new Map();
  for ( const c of cells ) {
    const k = key(c);
    const [u, v] = uv.get(k);
    const ht = height.get(k);
    const elev = ht < seaLevel ? 0 : (ht - seaLevel) / ((top - seaLevel) || 1);
    // Тень гор: если в нескольких гексах к западу хребет, ветер приходит сухим.
    let shadow = 0;
    for ( let d = 1; d <= 4; d++ ) {
      const wk = key([c[0], c[1] - d]);
      if ( height.has(wk) && height.get(wk) >= mountLevel ) { shadow = 0.22 * (1 - ((d - 1) / 4)); break; }
    }
    const near = Math.exp(-(dist.get(k) ?? 40) / 5);
    const m = (0.5 * mNoise((u * 4.2) + 17, (v * 4.2) + 31, 3)) + (0.45 * near) + 0.08 - shadow;
    moist.set(k, Math.max(0, Math.min(1, m)));
    const t = 1 - (lat.get(k) * 0.95) - (elev * 0.45) + ((tNoise(u * 3, v * 3, 3) - 0.5) * 0.3);
    temp.set(k, Math.max(0, Math.min(1, t)));
  }

  const out = new Map();
  for ( const c of cells ) {
    const k = key(c);
    const ht = height.get(k), m = moist.get(k), t = temp.get(k);
    const coast = (dist.get(k) ?? 40) === 1;
    let b;
    if ( ht < seaLevel ) b = "water";
    else if ( ht >= mountLevel ) b = t < 0.3 ? "snow" : "mountains";
    else if ( t < 0.08 ) b = "snow";
    else if ( ht >= hillLevel ) b = t < 0.22 ? "tundra" : "hills";
    else b = biomeOf(t, m, { coast, low: ht < quantile(land, 0.3) });
    out.set(k, b);
  }
  smoothBiomes(cells, out);
  return { terrain: out, height, moist, lat, temp, seaLevel, recipe: pickRecipe.id, pieces: layout.map(p => p.id) };
}

/** Биом по теплу и влаге (0…1). Порядок как у Уиттекера: холод → тундра, тайга; тепло → саванна, джунгли. */
export function biomeOf(t, m, { coast = false, low = false } = {}) {
  if ( t < 0.25 ) return "tundra";
  if ( t < 0.42 ) return m > 0.38 ? "taiga" : "plains";
  if ( t < 0.72 ) {
    if ( m < 0.2 ) return "desert";
    if ( m < 0.48 ) return "plains";
    if ( m > 0.82 && low ) return "swamp";
    return "forest";
  }
  if ( m < 0.26 ) return "desert";
  if ( m < 0.52 ) return "savanna";
  if ( m > 0.7 && coast && low ) return "mangrove";
  if ( m > 0.86 && low ) return "swamp";
  return "jungle";
}

/** Одиночный гекс среди чужого биома принимает биом соседей: без пятнистости. Вода, горы и холмы не трогаются. */
function smoothBiomes(cells, terrain) {
  const fixed = new Set(["water", "mountains", "hills", "snow"]);
  const changes = [];
  for ( const c of cells ) {
    const k = key(c);
    const own = terrain.get(k);
    if ( fixed.has(own) ) continue;
    const counts = new Map();
    let n = 0;
    for ( const nb of oddRNeighbors(c) ) {
      const t = terrain.get(key(nb));
      if ( !t ) continue;
      n++;
      if ( !fixed.has(t) ) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    if ( counts.get(own) ) continue;
    const [best, cnt] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    if ( best && cnt >= Math.max(3, n / 2) ) changes.push([k, best]);
  }
  for ( const [k, t] of changes ) terrain.set(k, t);
}

/**
 * Столицы: первая — случайный гекс суши, каждая следующая — самый далёкий от уже выбранных.
 * Горы и вода не годятся.
 */
export function pickCapitals({ cells, terrain, center, count, rnd }) {
  const bad = ["water", "mountains", "snow", "tundra"];
  const fine = cells.filter(c => !bad.includes(terrain.get(key(c))));
  // Столица — не на краю света: все соседи суша, иначе хоть какая-то суша.
  const inner = fine.filter(c => oddRNeighbors(c).every(nb => { const t = terrain.get(key(nb)); return t && t !== "water"; }));
  const ok = inner.length >= count ? inner : (fine.length ? fine : cells.filter(c => !["water", "mountains", "snow"].includes(terrain.get(key(c)))));
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
  const data = generateTerrainData({ cells, center, seed, water: o.water, mountains: o.mountains, recipe: o.recipe || null });
  const terrain = data.terrain;
  const features = [];
  const stats = { terrain: 0, hexes: cells.length, resources: 0, realms: 0, neutral: 0, recipe: data.recipe };
  const ext = kind => ({ seed, kind });

  // Местность: одна зона на тип.
  const byType = new Map();
  for ( const c of cells ) {
    const t = terrain.get(key(c));
    if ( !byType.has(t) ) byType.set(t, []);
    byType.get(t).push(c);
  }
  const TERRAIN_NAMES = {
    plains: "Равнины", forest: "Леса", hills: "Холмы", mountains: "Горы", swamp: "Болота", desert: "Пустыни", snow: "Снега", water: "Море",
    savanna: "Саванны", jungle: "Тропические леса", taiga: "Тайга", tundra: "Тундра", mangrove: "Мангры"
  };
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

  // Нейтральные объекты: руины, логова, рощи, оазисы. Не ближе трёх гексов друг к другу и к столицам.
  const poiRnd = seededRandom(`poi:${seed}`);
  const landCells = cells.filter(c => terrain.get(key(c)) !== "water");
  const want = Math.round((landCells.length / 60) * (o.neutral ?? 0) * 2);
  const placed = [];
  const far = c => [...placed, ...[...busy].map(k => k.split(",").map(Number))].every(q => hexDist(q, c) >= 3);
  const isCoast = c => neighbors(c).some(nb => inBounds(nb) && terrain.get(key(nb)) === "water");
  for ( let tries = 0; placed.length < want && tries < want * 30; tries++ ) {
    const c = landCells[Math.floor(poiRnd() * landCells.length)];
    if ( !c || busy.has(key(c)) || !far(c) ) continue;
    const t = terrain.get(key(c));
    const fits = NEUTRAL_OBJECTS.filter(x => x.terrain.includes(t) && (!x.coast || isCoast(c)));
    if ( !fits.length ) continue;
    const obj = fits[Math.floor(poiRnd() * fits.length)];
    const p = center(c);
    features.push({
      id: newId(), name: obj.names[Math.floor(poiRnd() * obj.names.length)], text: "",
      system: baseSystem("object", obj.id, ext("neutral"), { geometry: { x: Math.round(p.x), y: Math.round(p.y), cell: [...c] } })
    });
    placed.push(c);
    stats.neutral++;
  }
  for ( const c of placed ) busy.add(key(c));

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

  return { features, stats, seed, terrain, climate: data };
}

/** Расстояние между гексами odd-r в шагах. */
export function hexDist([i1, j1], [i2, j2]) {
  const toCube = (i, j) => { const x = j - ((i - (i & 1)) / 2); return [x, i, -x - i]; };
  const a = toCube(i1, j1), b = toCube(i2, j2);
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/** Добавить недостающие типы нейтральных объектов. */
export function withNeutralTypes(types) {
  const out = types.slice();
  for ( const t of NEUTRAL_TYPES ) if ( !out.some(x => x.id === t.id) ) out.push(structuredClone(t));
  return out;
}

export { RECIPES, PIECES };

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
