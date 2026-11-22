/**
 * Что видно на карте: слои зон и отдельные виды элементов (метки, ресурсы, линии, подписи).
 * Скрытое хранится одним списком id у каждого пользователя. Наборы слоёв переключают
 * его целиком, как «Набор слоёв» в Azgaar. Чистый код без Foundry.
 */

/**
 * Виды на карте помимо слоёв зон, как кнопки слоёв в Azgaar.
 * on — включён ли вид, пока его не трогали. Для включённых по умолчанию id в списке значит «спрятан»,
 * для выключенных по умолчанию (климат, сетка координат, роза ветров) — «показан».
 * group — раздел в панели слоёв.
 */
export const VIEW_PART_DEFS = [
  { id: "@marks", on: true, group: "objects" },
  { id: "@resources", on: true, group: "objects" },
  { id: "@labels", on: true, group: "objects" },
  { id: "@rivers", on: true, group: "lines" },
  { id: "@lines", on: true, group: "lines" },
  { id: "@borders", on: true, group: "map" },
  { id: "@coast", on: true, group: "map" },
  { id: "@grid", on: true, group: "map" },
  { id: "@coords", on: false, group: "map" },
  { id: "@heights", on: false, group: "data" },
  { id: "@temp", on: false, group: "data" },
  { id: "@prec", on: false, group: "data" },
  { id: "@pop", on: false, group: "data" },
  { id: "@ice", on: false, group: "data" },
  { id: "@windrose", on: false, group: "map" },
  { id: "@scale", on: false, group: "map" }
];
export const VIEW_PARTS = VIEW_PART_DEFS.map(d => d.id);
const DEFAULT_ON = new Map(VIEW_PART_DEFS.map(d => [d.id, d.on]));

/** Виден ли слой или вид при этом списке переключённого. */
export function isShown(id, toggled) {
  const h = toggled instanceof Set ? toggled : new Set(toggled ?? []);
  return (DEFAULT_ON.get(id) ?? true) ? !h.has(id) : h.has(id);
}

/** Ресурс — метка генератора или типа res-*. */
export const isResourceType = typeId => String(typeId ?? "").startsWith("res-");

/**
 * Готовые наборы. hidden — что спрятать; всё остальное видно.
 * Слои, которых нет в атласе, просто не учитываются.
 */
export const BUILTIN_PRESETS = [
  { id: "all", hidden: [] },
  { id: "political", hidden: ["regions", "cultures", "religions", "@resources"] },
  { id: "physical", hidden: ["politics", "regions", "cultures", "religions", "@resources", "@labels", "@heights"] },
  { id: "resources", hidden: ["politics", "regions", "cultures", "religions", "@marks", "@labels"] },
  { id: "borders", hidden: ["terrain", "cultures", "religions", "@resources", "@marks"] },
  { id: "peoples", hidden: ["politics", "regions", "religions", "@resources"] },
  { id: "religions", hidden: ["politics", "regions", "cultures", "@resources"] },
  { id: "climate", hidden: ["politics", "regions", "cultures", "religions", "@resources", "@marks", "@temp", "@prec"] },
  { id: "admin", hidden: ["politics", "cultures", "religions", "@resources"] },
  { id: "terrain", hidden: ["politics", "regions", "cultures", "religions", "overlay", "@marks", "@resources", "@lines", "@rivers", "@labels"] }
];

/** Какие виды показывать при этом списке переключённого: { marks, resources, lines, rivers, labels, borders, grid, coords, heights… }. */
export function viewOf(hidden) {
  const h = hidden instanceof Set ? hidden : new Set(hidden ?? []);
  return Object.fromEntries(VIEW_PARTS.map(id => [id.slice(1), isShown(id, h)]));
}

/**
 * Какой набор сейчас включён: id набора или null, если вид собран вручную.
 * known — id, которые есть на этой карте (слои и виды): слои, которых нет, в сравнении не участвуют.
 */
export function activePreset(hidden, presets, known = null) {
  const norm = list => [...new Set(list ?? [])].filter(id => !known || known.has(id)).sort().join();
  const h = norm(hidden);
  return presets.find(p => norm(p.hidden) === h)?.id ?? null;
}
