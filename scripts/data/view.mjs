/**
 * Что видно на карте: слои зон и отдельные виды элементов (метки, ресурсы, линии, подписи).
 * Скрытое хранится одним списком id у каждого пользователя. Наборы слоёв переключают
 * его целиком, как «Набор слоёв» в Azgaar. Чистый код без Foundry.
 */

/** Виды элементов, которые прячутся так же, как слои зон. */
export const VIEW_PARTS = ["@marks", "@resources", "@lines", "@labels"];

/** Ресурс — метка генератора или типа res-*. */
export const isResourceType = typeId => String(typeId ?? "").startsWith("res-");

/**
 * Готовые наборы. hidden — что спрятать; всё остальное видно.
 * Слои, которых нет в атласе, просто не учитываются.
 */
export const BUILTIN_PRESETS = [
  { id: "all", hidden: [] },
  { id: "political", hidden: ["regions", "@resources"] },
  { id: "physical", hidden: ["politics", "regions", "@resources", "@labels"] },
  { id: "resources", hidden: ["politics", "regions", "@marks", "@labels"] },
  { id: "admin", hidden: ["politics", "@resources"] },
  { id: "terrain", hidden: ["politics", "regions", "overlay", "@marks", "@resources", "@lines", "@labels"] }
];

/** Что из видов элементов показывать при этом списке скрытого. */
export function viewOf(hidden) {
  const h = hidden instanceof Set ? hidden : new Set(hidden ?? []);
  return { marks: !h.has("@marks"), resources: !h.has("@resources"), lines: !h.has("@lines"), labels: !h.has("@labels") };
}

/** Какой набор сейчас включён: id набора или null, если вид собран вручную. */
export function activePreset(hidden, presets) {
  const h = [...new Set(hidden ?? [])].sort().join();
  return presets.find(p => [...new Set(p.hidden)].sort().join() === h)?.id ?? null;
}
