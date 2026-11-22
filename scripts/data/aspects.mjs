/**
 * Аспекты и статусы как предметы Foundry (0.9.9). Чистый код без Foundry.
 *
 * Предмет в студии: { id, name, folder, system: { kind, icon, color, description, steps, parentId, key } }.
 * kind "status" ложится в system.statuses элемента карты, kind "aspect" — в system.aspects.
 * Статус, который входит в аспект (parentId), ложится внутрь этого аспекта, если аспект уже висит на элементе.
 */
import { BASE_STATUSES, BASE_ASPECTS } from "./statuses.mjs";

/** Значки на выбор для аспекта (Font Awesome). */
export const ASPECT_ICONS = [
  "sun", "droplet", "skull", "fire", "snowflake", "wind", "bolt", "seedling", "wheat-awn", "coins",
  "shield", "shield-halved", "hand-fist", "ban", "crown", "scroll", "eye", "ghost", "biohazard", "house-crack",
  "trowel-bricks", "person-digging", "book-open", "smog", "star", "route", "anchor", "dove"
];

/** Ступени на выбор: 0 — без уровня. */
export const ASPECT_STEPS = [0, 2, 3, 5];

const clone = x => JSON.parse(JSON.stringify(x));

/** Висит ли предмет на элементе (сам или внутри аспекта). */
export function hasItem(state, itemId) {
  const sys = state?.system ?? {};
  if ( (sys.statuses ?? []).some(x => x.itemId === itemId) ) return true;
  return (sys.aspects ?? []).some(a => a.itemId === itemId || (a.statuses ?? []).some(x => x.itemId === itemId));
}

/** Запись статуса или аспекта из предмета. */
export function entryOf(item, newId) {
  const s = item.system ?? {};
  const steps = Number(s.steps) || 0;
  const base = {
    id: newId(), itemId: item.id, key: s.key ?? "", icon: s.icon ?? "", name: item.name,
    value: steps ? 1 : null, max: steps || null
  };
  if ( s.kind === "aspect" ) return { ...base, description: s.description ?? "", statuses: [] };
  return base;
}

/**
 * Новое состояние элемента с предметом или null, если он уже висит.
 * Статус с parentId встаёт в свой аспект, если тот есть на элементе; иначе — к статусам элемента.
 */
export function attachItem(state, item, newId) {
  if ( !state || !item || hasItem(state, item.id) ) return null;
  const next = clone(state);
  const sys = next.system;
  sys.statuses ??= [];
  sys.aspects ??= [];
  const entry = entryOf(item, newId);
  if ( item.system?.kind === "aspect" ) sys.aspects.push(entry);
  else {
    const parent = item.system?.parentId ? sys.aspects.find(a => a.itemId === item.system.parentId) : null;
    if ( parent ) (parent.statuses ??= []).push(entry);
    else sys.statuses.push(entry);
  }
  return next;
}

/** Снять предмет с элемента. null — его там не было. */
export function detachItem(state, itemId) {
  if ( !hasItem(state, itemId) ) return null;
  const next = clone(state);
  const sys = next.system;
  sys.statuses = (sys.statuses ?? []).filter(x => x.itemId !== itemId);
  sys.aspects = (sys.aspects ?? []).filter(a => a.itemId !== itemId)
    .map(a => ({ ...a, statuses: (a.statuses ?? []).filter(x => x.itemId !== itemId) }));
  return next;
}

/** Где висит предмет: [{ state, entry }] по элементам карты. */
export function hostsOf(states, itemId) {
  const out = [];
  for ( const st of states.values() ) {
    const sys = st.system ?? {};
    const all = [...(sys.statuses ?? []), ...(sys.aspects ?? []), ...(sys.aspects ?? []).flatMap(a => a.statuses ?? [])];
    const entry = all.find(x => x.itemId === itemId);
    if ( entry ) out.push({ state: st, entry });
  }
  return out;
}

/** Поиск предметов по названию и описанию. */
export function searchItems(items, q) {
  const f = String(q ?? "").trim().toLowerCase();
  if ( !f ) return items;
  return items.filter(i => i.name.toLowerCase().includes(f) || String(i.system?.description ?? "").toLowerCase().includes(f));
}

/**
 * Предметы для базовых статусов и аспектов модуля: мастер заводит их одной кнопкой.
 * parentKey — ключ аспекта, в который входит статус (id появится после создания).
 */
export function baseItems() {
  const status = (b, parentKey = "") => ({
    name: b.name, parentKey,
    system: { kind: "status", icon: b.icon ?? "", color: "#c9a45c", description: "", steps: b.level ? 3 : (b.max ?? 0), parentId: "", key: b.key }
  });
  return [
    ...BASE_STATUSES.map(b => status(b)),
    ...BASE_ASPECTS.flatMap(a => [
      { name: a.name, parentKey: "", system: { kind: "aspect", icon: a.icon ?? "", color: "#8f7bb5", description: "", steps: 0, parentId: "", key: a.key } },
      ...a.statuses.map(s => status(s, a.key))
    ])
  ];
}

/** Подпись ступеней: «статус · 3 ступени». */
export function stepsLabel(item, t) {
  const n = Number(item.system?.steps) || 0;
  const kind = t(item.system?.kind === "aspect" ? "ART.Aspect.kindAspect" : "ART.Aspect.kindStatus").toLowerCase();
  return n ? `${kind} · ${t("ART.Aspect.stepsN", { n })}` : kind;
}
