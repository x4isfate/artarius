/**
 * Импорт из Azgaar's Fantasy Map Generator («Export → JSON → Full») на гекс-поле.
 * Чистый код без Foundry, проверяется в Node.
 *
 * Каждый гекс сцены смотрит, в какую клетку Azgaar попал его центр (ближайшая точка
 * клетки — это и есть её ячейка Вороного). Дальше гексы собираются в зоны:
 * местность по биому и высоте, державы по state, области по province.
 * Города становятся метками на своих гексах, реки и дороги — свободными линиями.
 *
 * У каждого импортированного элемента есть system.ext.azgaar = { mapId, kind, i },
 * по нему повторный импорт находит и заменяет то, что создал прошлый.
 */
import { simplify, roundPoints } from "../geometry/geometry.mjs";

export const AZGAAR_URL = "https://azgaar.github.io/Fantasy-Map-Generator/";

/** Что можно взять из файла и что включено по умолчанию. */
export const AZGAAR_PARTS = {
  terrain: true,
  states: true,
  provinces: false,
  burgs: true,
  rivers: true,
  routes: true
};

/** Типы, на которые опирается импорт. Недостающие добавляются в атлас. */
export const AZGAAR_TYPES = [
  { id: "water", kind: "area", name: "Вода", layerId: "terrain", style: { color: "#3c6f9e", alpha: 1, borderWidth: 0, labelSize: 0 } },
  { id: "plains", kind: "area", name: "Равнина", layerId: "terrain", style: { color: "#9bb164", alpha: 1, borderWidth: 0, labelSize: 0 } },
  { id: "forest", kind: "area", name: "Лес", layerId: "terrain", style: { color: "#3f6b3a", alpha: 1, borderWidth: 0, labelSize: 0 } },
  { id: "hills", kind: "area", name: "Холмы", layerId: "terrain", style: { color: "#a8975c", alpha: 1, borderWidth: 0, labelSize: 0 } },
  { id: "mountains", kind: "area", name: "Горы", layerId: "terrain", style: { color: "#8a8079", alpha: 1, borderWidth: 0, labelSize: 0 } },
  { id: "swamp", kind: "area", name: "Болото", layerId: "terrain", style: { color: "#5e6b4b", alpha: 1, borderWidth: 0, labelSize: 0 } },
  { id: "desert", kind: "area", name: "Пустыня", layerId: "terrain", style: { color: "#dcc48e", alpha: 1, borderWidth: 0, labelSize: 0 } },
  { id: "snow", kind: "area", name: "Снега", layerId: "terrain", style: { color: "#e4ecee", alpha: 1, borderWidth: 0, labelSize: 0 } },
  { id: "realm", kind: "area", name: "Держава", layerId: "politics", style: { color: "#c96f4a", alpha: 0.28, borderWidth: 4 } },
  { id: "region", kind: "area", name: "Область", layerId: "regions", style: { color: "#d9c39a", alpha: 0.12, borderWidth: 2, labelSize: 20 } },
  { id: "city", kind: "object", name: "Город", style: { icon: "modules/artarius/assets/icons/castle.svg", color: "#f2e3c9" } },
  { id: "capital", kind: "object", name: "Столица", style: { icon: "modules/artarius/assets/icons/capitol.svg", color: "#f0c96a", size: 0.72 } },
  { id: "river", kind: "line", name: "Река", style: { color: "#5b8fd6", widthStart: 2, widthEnd: 9, meander: 0.2 } },
  { id: "road", kind: "line", name: "Дорога", style: { color: "#d8c3a0", widthStart: 3, widthEnd: 3, outlineColor: "#3a2d22", outlineWidth: 1, dash: 12, gap: 7, meander: 0.05 } },
  { id: "trail", kind: "line", name: "Тропа", style: { color: "#b8a080", widthStart: 2, widthEnd: 2, dash: 6, gap: 8, meander: 0 } },
  { id: "searoute", kind: "line", name: "Морской путь", style: { color: "#9fc3e8", widthStart: 2, widthEnd: 2, dash: 4, gap: 10, meander: 0, alpha: 0.7 } }
];

/** Слои, куда импорт кладёт зоны. */
export const AZGAAR_LAYERS = [
  { id: "terrain", name: "Местность", visible: true, exclusive: true },
  { id: "regions", name: "Области", visible: true, exclusive: true },
  { id: "politics", name: "Владения", visible: true, exclusive: true }
];

/**
 * Биом Azgaar → тип местности (набор биомов по умолчанию):
 * 0 Marine, 1 Hot desert, 2 Cold desert, 3 Savanna, 4 Grassland, 5 Tropical seasonal forest,
 * 6 Temperate deciduous forest, 7 Tropical rainforest, 8 Temperate rainforest, 9 Taiga,
 * 10 Tundra, 11 Glacier, 12 Wetland.
 */
export const BIOME_TERRAIN = ["water", "desert", "desert", "plains", "plains", "forest", "forest", "forest", "forest", "forest", "snow", "snow", "swamp"];

/** Местность клетки: вода, потом горы и холмы по высоте, потом биом. */
export function terrainOf(cell) {
  const h = Number(cell?.h ?? 50);
  if ( h < 20 || cell?.biome === 0 ) return "water";
  if ( h >= 67 ) return "mountains";
  if ( h >= 50 ) return "hills";
  return BIOME_TERRAIN[cell?.biome] ?? "plains";
}

/** Проверка формата. Возвращает ключ ошибки или null. */
export function validateAzgaar(data) {
  if ( !data || typeof data !== "object" ) return "notJson";
  if ( !data.info?.width || !data.info?.height ) return "noInfo";
  if ( !Array.isArray(data.pack?.cells) || !Array.isArray(data.pack?.vertices) ) return "notFull";
  return null;
}

/** Координаты карты ↔ сцены. rect = { x, y, width, height } прямоугольника сцены. */
export function makeTransform(info, rect) {
  const sx = rect.width / info.width;
  const sy = rect.height / info.height;
  return {
    point: ([x, y]) => [Math.round(rect.x + (x * sx)), Math.round(rect.y + (y * sy))],
    back: ({ x, y }) => [(x - rect.x) / sx, (y - rect.y) / sy],
    scale: Math.min(sx, sy)
  };
}

/** Поиск ближайшей клетки Azgaar по точке карты: корзины по сетке. */
export function nearestCellIndex(cells, info) {
  const n = Math.max(1, cells.length);
  const step = Math.max(1, Math.sqrt((info.width * info.height) / n) * 2);
  const cols = Math.ceil(info.width / step) + 1;
  const buckets = new Map();
  cells.forEach((c, idx) => {
    if ( !Array.isArray(c?.p) ) return;
    const k = (Math.floor(c.p[1] / step) * cols) + Math.floor(c.p[0] / step);
    if ( !buckets.has(k) ) buckets.set(k, []);
    buckets.get(k).push(idx);
  });
  return ([x, y]) => {
    const bx = Math.floor(x / step), by = Math.floor(y / step);
    let best = -1, bd = Infinity;
    for ( let r = 0; r < 6 && (best < 0 || r < 2); r++ ) {
      for ( let dy = -r; dy <= r; dy++ ) {
        for ( let dx = -r; dx <= r; dx++ ) {
          if ( Math.max(Math.abs(dx), Math.abs(dy)) !== r ) continue;
          for ( const idx of buckets.get(((by + dy) * cols) + bx + dx) ?? [] ) {
            const p = cells[idx].p;
            const d = ((p[0] - x) ** 2) + ((p[1] - y) ** 2);
            if ( d < bd ) { bd = d; best = idx; }
          }
        }
      }
    }
    return best;
  };
}

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const key = ([i, j]) => `${i},${j}`;

function baseSystem(kind, typeId, ext, extra = {}) {
  return {
    kind, typeId, demiurge: "", statuses: [], aspects: [], style: {}, geometry: {},
    layerId: "", blend: "replace", sort: 0, links: [], rev: 0, ext: { azgaar: ext }, ...extra
  };
}

/**
 * Собрать элементы из экспорта Azgaar.
 * options: { rect, hexes: [[i, j], …], center([i, j]) → {x, y}, cellAt({x, y}) → [i, j], parts, newId, tolerance }.
 * Возвращает { features, stats, mapId, name }.
 */
export function buildAzgaarFeatures(data, { rect, hexes, center, cellAt, parts = AZGAAR_PARTS, newId, tolerance = 1.5 } = {}) {
  const { info, pack } = data;
  const mapId = String(info.mapId ?? info.seed ?? "");
  const t = makeTransform(info, rect);
  const lineToScene = pts => roundPoints(simplify(pts.map(t.point), tolerance));
  const cells = pack.cells;
  const features = [];
  const stats = { terrain: 0, states: 0, provinces: 0, burgs: 0, rivers: 0, routes: 0 };
  const nearest = nearestCellIndex(cells, info);
  const hexToCell = new Map();
  for ( const h of hexes ) {
    const idx = nearest(t.back(center(h)));
    if ( idx >= 0 ) hexToCell.set(key(h), { hex: h, cell: cells[idx] });
  }
  const stateIds = new Map();
  let sort = 1;

  /** Сгруппировать гексы по значению поля клетки. */
  const group = pick => {
    const out = new Map();
    for ( const { hex, cell } of hexToCell.values() ) {
      const k = pick(cell);
      if ( !k ) continue;
      if ( !out.has(k) ) out.set(k, []);
      out.get(k).push(hex);
    }
    return out;
  };

  const pushZone = (kindKey, item, hexList, typeId, layerId, extra = {}) => {
    const id = newId();
    const style = item?.color && /^#[0-9a-f]{3,8}$/i.test(item.color) ? { color: item.color } : {};
    features.push({
      id, name: item?.fullName || item?.name || extra.name || "",
      text: item?.form ? `<p>${esc(item.formName || item.form)}</p>` : "",
      system: baseSystem("area", typeId, { mapId, kind: kindKey, i: item?.i ?? typeId }, {
        layerId, sort: sort++, style, geometry: { cells: hexList.map(h => [...h]) }
      })
    });
    return id;
  };

  if ( parts.terrain ) {
    const names = Object.fromEntries(AZGAAR_TYPES.map(x => [x.id, x.name]));
    for ( const [typeId, list] of group(c => terrainOf(c)) ) {
      pushZone("terrain", null, list, typeId, "terrain", { name: names[typeId] });
      stats.terrain++;
    }
  }

  if ( parts.states && Array.isArray(pack.states) ) {
    const byState = group(c => c.state);
    for ( const s of pack.states ) {
      if ( !s?.i || s.removed || !byState.has(s.i) ) continue;
      stateIds.set(s.i, pushZone("state", s, byState.get(s.i), "realm", "politics"));
      stats.states++;
    }
  }

  if ( parts.provinces && Array.isArray(pack.provinces) ) {
    const byProv = group(c => c.province);
    for ( const p of pack.provinces ) {
      if ( !p?.i || p.removed || !byProv.has(p.i) ) continue;
      pushZone("province", p, byProv.get(p.i), "region", "regions");
      stats.provinces++;
    }
  }

  if ( parts.burgs && Array.isArray(pack.burgs) ) {
    // На гекс встаёт одна метка: столица, иначе самый населённый город.
    const best = new Map();
    for ( const b of pack.burgs ) {
      if ( !b?.i || b.removed || !Number.isFinite(b.x) || !Number.isFinite(b.y) ) continue;
      const [x, y] = t.point([b.x, b.y]);
      const hex = cellAt({ x, y });
      const k = key(hex);
      if ( !hexToCell.has(k) ) continue;
      const score = (b.capital ? 1e9 : 0) + (b.population ?? 0);
      const cur = best.get(k);
      if ( !cur || score > cur.score ) best.set(k, { b, hex, score });
    }
    for ( const { b, hex } of best.values() ) {
      const c = center(hex);
      const lines = [];
      if ( b.population ) lines.push(`Население: ${Math.round(b.population * 1000).toLocaleString("ru-RU")}`);
      if ( b.port ) lines.push("Порт");
      const links = stateIds.has(b.state) ? [{ target: stateIds.get(b.state), role: b.capital ? "столица" : "в составе" }] : [];
      features.push({
        id: newId(), name: b.name ?? "",
        text: lines.map(l => `<p>${esc(l)}</p>`).join(""),
        system: baseSystem("object", b.capital ? "capital" : "city", { mapId, kind: "burg", i: b.i }, {
          geometry: { x: Math.round(c.x), y: Math.round(c.y), cell: [...hex] }, links
        })
      });
      stats.burgs++;
    }
  }

  if ( parts.rivers && Array.isArray(pack.rivers) ) {
    for ( const r of pack.rivers ) {
      if ( !r?.i ) continue;
      let pts = Array.isArray(r.points) && r.points.length >= 2 ? r.points.map(p => [p[0], p[1]])
        : (r.cells ?? []).filter(c => c >= 0 && cells[c]?.p).map(c => cells[c].p);
      if ( pts.length < 2 ) continue;
      pts = lineToScene(pts);
      if ( pts.length < 2 ) continue;
      const widthEnd = Math.max(4, Math.min(14, Math.round(4 + ((r.width ?? 0) * 2))));
      features.push({
        id: newId(), name: r.name ? `${r.name}${r.type ? ` (${r.type})` : ""}` : "",
        text: "",
        system: baseSystem("line", "river", { mapId, kind: "river", i: r.i }, { geometry: { points: pts }, style: { widthEnd } })
      });
      stats.rivers++;
    }
  }

  if ( parts.routes && Array.isArray(pack.routes) ) {
    const typeOf = g => ({ roads: "road", trails: "trail", searoutes: "searoute" })[g] ?? "road";
    for ( const r of pack.routes ) {
      if ( !r || !Array.isArray(r.points) || r.points.length < 2 ) continue;
      const pts = lineToScene(r.points.map(p => [p[0], p[1]]));
      if ( pts.length < 2 ) continue;
      features.push({
        id: newId(), name: r.name ?? "",
        text: "",
        system: baseSystem("line", typeOf(r.group), { mapId, kind: "route", i: r.i }, { geometry: { points: pts } })
      });
      stats.routes++;
    }
  }

  return { features, stats, mapId, name: info.mapName ?? "" };
}

/** Добавить в списки атласа недостающие типы и слои импорта. Возвращает новые списки. */
export function mergeTypesAndLayers(types, layers) {
  const outTypes = types.slice();
  for ( const t of AZGAAR_TYPES ) if ( !outTypes.some(x => x.id === t.id) ) outTypes.push(structuredClone(t));
  const outLayers = layers.slice();
  for ( const l of AZGAAR_LAYERS ) if ( !outLayers.some(x => x.id === l.id) ) outLayers.push({ ...l, sort: outLayers.length });
  return { types: outTypes, layers: outLayers };
}
