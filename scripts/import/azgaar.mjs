/**
 * Import from Azgaar's Fantasy Map Generator ("Export → JSON → Full").
 * Pure data code: no Foundry, tested in Node.
 *
 * Output is a list of feature states ({ id, name, text, system }) ready for applyPlan.
 * Every imported feature carries system.ext.azgaar = { mapId, kind, i } so a repeated
 * import can find and replace what the previous one created.
 */
import { cellsOutline, signedArea, simplify, roundPoints } from "../geometry/geometry.mjs";

export const AZGAAR_URL = "https://azgaar.github.io/Fantasy-Map-Generator/";

/** What the importer can bring in, and the default choice. */
export const AZGAAR_PARTS = {
  states: true,
  provinces: false,
  burgs: true,
  rivers: true,
  routes: true
};

/** Types the importer relies on. Missing ones are added to the atlas. */
export const AZGAAR_TYPES = [
  { id: "city", kind: "object", name: "Город", style: { icon: "icons/svg/village.svg" } },
  { id: "capital", kind: "object", name: "Столица", style: { icon: "icons/svg/castle.svg", color: "#f0c96a", size: 56 } },
  { id: "river", kind: "line", name: "Река", style: { color: "#5b8fd6", widthStart: 2, widthEnd: 12, meander: 0.2 } },
  { id: "road", kind: "line", name: "Дорога", style: { color: "#d8c3a0", widthStart: 3, widthEnd: 3, outlineColor: "#3a2d22", outlineWidth: 2, dash: 14, gap: 8, meander: 0 } },
  { id: "trail", kind: "line", name: "Тропа", style: { color: "#b8a080", widthStart: 2, widthEnd: 2, dash: 6, gap: 8, meander: 0, labelSize: 0 } },
  { id: "searoute", kind: "line", name: "Морской путь", style: { color: "#9fc3e8", widthStart: 2, widthEnd: 2, dash: 4, gap: 10, meander: 0, alpha: 0.7, labelSize: 0 } },
  { id: "realm", kind: "area", name: "Страна", style: { color: "#c96f4a", alpha: 0.3, borderColor: "#c96f4a" } },
  { id: "province", kind: "area", name: "Провинция", style: { alpha: 0.12, borderWidth: 1, labelSize: 16 } }
];

/** Layers the importer puts areas on. */
export const AZGAAR_LAYERS = [
  { id: "politics", name: "Политика", visible: true },
  { id: "provinces", name: "Провинции", visible: true }
];

/** Check the shape of the file. Returns an error key or null. */
export function validateAzgaar(data) {
  if ( !data || typeof data !== "object" ) return "notJson";
  if ( !data.info?.width || !data.info?.height ) return "noInfo";
  if ( !Array.isArray(data.pack?.cells) || !Array.isArray(data.pack?.vertices) ) return "notFull";
  return null;
}

/** Map coordinates → scene coordinates. rect = { x, y, width, height } of the scene. */
export function makeTransform(info, rect) {
  const sx = rect.width / info.width;
  const sy = rect.height / info.height;
  return {
    point: ([x, y]) => [Math.round(rect.x + (x * sx)), Math.round(rect.y + (y * sy))],
    scale: Math.min(sx, sy)
  };
}

/** Polygon of a pack cell in map coordinates, always clockwise on screen. */
function cellPolygon(cell, vertices) {
  const poly = (cell?.v ?? []).map(v => vertices[v]?.p).filter(Array.isArray);
  if ( poly.length < 3 ) return null;
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
}

/** Outline of all cells for which pick(cell) is true. Rings in map coordinates. */
export function regionRings(cells, vertices, pick) {
  const polys = [];
  for ( const cell of cells ) {
    if ( !pick(cell) ) continue;
    const p = cellPolygon(cell, vertices);
    if ( p ) polys.push(p);
  }
  return polys.length ? cellsOutline(polys) : [];
}

/** Group cell ids by a field (state, province). Zero means "none" in Azgaar. */
function cellsBy(cells, field) {
  const out = new Map();
  for ( const cell of cells ) {
    const k = cell[field];
    if ( !k ) continue;
    if ( !out.has(k) ) out.set(k, []);
    out.get(k).push(cell);
  }
  return out;
}

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function baseSystem(kind, typeId, ext, extra = {}) {
  return {
    kind, typeId, demiurge: "", statuses: [], aspects: [], style: {}, geometry: {},
    layerId: "", blend: "replace", sort: 0, links: [], rev: 0, ext: { azgaar: ext }, ...extra
  };
}

/**
 * Build feature states from an Azgaar export.
 * options: { rect, parts, newId, tolerance }.
 * Returns { features, stats } where stats counts what was built.
 */
export function buildAzgaarFeatures(data, { rect, parts = AZGAAR_PARTS, newId, tolerance = 1.5 } = {}) {
  const { info, pack } = data;
  const mapId = String(info.mapId ?? info.seed ?? "");
  const t = makeTransform(info, rect);
  const ringToScene = ring => roundPoints(simplify(ring.map(t.point), tolerance));
  const lineToScene = pts => roundPoints(simplify(pts.map(t.point), tolerance));
  const cells = pack.cells;
  const vertices = pack.vertices;
  const features = [];
  const stats = { states: 0, provinces: 0, burgs: 0, rivers: 0, routes: 0 };
  const stateIds = new Map();
  let sort = 1;

  const pushArea = (kind, item, cellList, typeId, layerId) => {
    const rings = cellsOutline(cellList.map(c => cellPolygon(c, vertices)).filter(Boolean))
      .map(ringToScene).filter(r => r.length >= 3);
    if ( !rings.length ) return null;
    const id = newId();
    const style = item.color && /^#[0-9a-f]{3,8}$/i.test(item.color) ? { color: item.color, borderColor: item.color } : {};
    features.push({
      id, name: item.fullName || item.name || "",
      text: item.form ? `<p>${esc(item.formName || item.form)}</p>` : "",
      system: baseSystem("area", typeId, { mapId, kind, i: item.i }, {
        layerId, sort: sort++, style, geometry: { cells: [], shapes: rings }
      })
    });
    stats[kind === "state" ? "states" : "provinces"]++;
    return id;
  };

  if ( parts.states && Array.isArray(pack.states) ) {
    const byState = cellsBy(cells, "state");
    for ( const s of pack.states ) {
      if ( !s?.i || s.removed || !byState.has(s.i) ) continue;
      const id = pushArea("state", s, byState.get(s.i), "realm", "politics");
      if ( id ) stateIds.set(s.i, id);
    }
  }

  if ( parts.provinces && Array.isArray(pack.provinces) ) {
    const byProv = cellsBy(cells, "province");
    for ( const p of pack.provinces ) {
      if ( !p?.i || p.removed || !byProv.has(p.i) ) continue;
      pushArea("province", p, byProv.get(p.i), "province", "provinces");
    }
  }

  if ( parts.burgs && Array.isArray(pack.burgs) ) {
    for ( const b of pack.burgs ) {
      if ( !b?.i || b.removed || !Number.isFinite(b.x) || !Number.isFinite(b.y) ) continue;
      const [x, y] = t.point([b.x, b.y]);
      const lines = [];
      if ( b.population ) lines.push(`Население: ${Math.round(b.population * 1000).toLocaleString("ru-RU")}`);
      if ( b.port ) lines.push("Порт");
      const links = stateIds.has(b.state) ? [{ target: stateIds.get(b.state), role: b.capital ? "столица" : "в составе" }] : [];
      features.push({
        id: newId(), name: b.name ?? "",
        text: lines.map(l => `<p>${esc(l)}</p>`).join(""),
        system: baseSystem("object", b.capital ? "capital" : "city", { mapId, kind: "burg", i: b.i }, { geometry: { x, y }, links })
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
      // Width at the mouth follows the river's own width (km) loosely, clamped to sane pixels.
      const widthEnd = Math.max(4, Math.min(18, Math.round(4 + ((r.width ?? 0) * 2))));
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

/** Add missing importer types and layers to the atlas lists. Returns new lists. */
export function mergeTypesAndLayers(types, layers) {
  const outTypes = types.slice();
  for ( const t of AZGAAR_TYPES ) if ( !outTypes.some(x => x.id === t.id) ) outTypes.push(structuredClone(t));
  const outLayers = layers.slice();
  for ( const l of AZGAAR_LAYERS ) if ( !outLayers.some(x => x.id === l.id) ) outLayers.push({ ...l, sort: outLayers.length });
  return { types: outTypes, layers: outLayers };
}
