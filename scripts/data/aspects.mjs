/**
 * Аспекты и статусы как предметы Foundry (0.9.9, в 1.0 — значки, ступени X/X, статусы аспекта). Чистый код без Foundry.
 *
 * Предмет в студии: { id, name, folder, system: { kind, icon, emoji, tint, color, description, steps, start, statusIds, parentId, key } }.
 * kind "status" ложится в system.statuses элемента карты, kind "aspect" — в system.aspects.
 * icon — имя значка Font Awesome ("sun") или путь к картинке (".../castle.svg"); emoji важнее значка.
 * Статусы аспекта: statusIds аспекта плюс статусы, у которых parentId указывает на него (так было до 1.0).
 * Аспект ложится на элемент вместе со своими статусами. Статус, который входит в аспект, уже висящий
 * на элементе, ложится внутрь этого аспекта.
 */
import { BASE_STATUSES, BASE_ASPECTS } from "./statuses.mjs";

/** Простые значки на выбор (Font Awesome). Картинки из библиотеки и свои файлы — через общий выбор значка. */
export const ASPECT_ICONS = [
  "sun", "droplet", "skull", "fire", "snowflake", "wind", "bolt", "seedling", "wheat-awn", "coins",
  "shield", "shield-halved", "hand-fist", "ban", "crown", "scroll", "eye", "ghost", "biohazard", "house-crack",
  "trowel-bricks", "person-digging", "book-open", "smog", "star", "route", "anchor", "dove"
];

/** Больше ступеней не бывает: защита от опечатки «1000000». */
export const MAX_STEPS = 999;

const clone = x => JSON.parse(JSON.stringify(x));
const num = v => (v === "" || v === null || v === undefined ? NaN : Number(v));

/** Значок — картинка (путь), а не имя Font Awesome. */
export const isImageIcon = icon => /[/.]/.test(String(icon ?? ""));

/**
 * Ступени предмета: max — сколько всего (0 — без ступеней), start — с какой ступени статус ложится на элемент.
 * Старые предметы без start начинают с 1.
 */
export function stepsOf(item) {
  const s = item?.system ?? {};
  const max = Math.max(0, Math.min(MAX_STEPS, Math.trunc(num(s.steps)) || 0));
  if ( !max ) return { max: 0, start: null };
  const st = Math.trunc(num(s.start));
  return { max, start: Number.isFinite(st) ? Math.max(0, Math.min(max, st)) : Math.min(1, max) };
}

/** Привести ступени формы к числам: «X / X», пустой максимум — без ступеней. */
export function cleanSteps(start, max) {
  const m = Math.max(0, Math.min(MAX_STEPS, Math.trunc(num(max)) || 0));
  if ( !m ) return { steps: 0, start: null };
  const s = Math.trunc(num(start));
  return { steps: m, start: Number.isFinite(s) ? Math.max(0, Math.min(m, s)) : 1 };
}

/** id статусов аспекта: свой список и статусы с parentId на него, без повторов и без пропавших. */
export function statusIdsOf(aspect, items = []) {
  if ( !aspect || aspect.system?.kind !== "aspect" ) return [];
  const known = new Set(items.map(i => i.id));
  const own = (aspect.system?.statusIds ?? []).filter(id => !items.length || known.has(id));
  const byParent = items.filter(i => i.system?.kind === "status" && i.system?.parentId === aspect.id).map(i => i.id);
  return [...new Set([...own, ...byParent])].filter(id => id !== aspect.id);
}

/** Предметы-статусы аспекта по порядку. */
export function statusesOf(aspect, items) {
  const byId = new Map(items.map(i => [i.id, i]));
  return statusIdsOf(aspect, items).map(id => byId.get(id)).filter(i => i && i.system?.kind === "status");
}

/** В какие аспекты входит статус. */
export function aspectsWith(statusId, items) {
  return items.filter(a => a.system?.kind === "aspect" && statusIdsOf(a, items).includes(statusId));
}

/** Висит ли предмет на элементе (сам или внутри аспекта). */
export function hasItem(state, itemId) {
  const sys = state?.system ?? {};
  if ( (sys.statuses ?? []).some(x => x.itemId === itemId) ) return true;
  return (sys.aspects ?? []).some(a => a.itemId === itemId || (a.statuses ?? []).some(x => x.itemId === itemId));
}

/** Запись статуса или аспекта из предмета. У аспекта — его статусы внутри (если передан список предметов). */
export function entryOf(item, newId, items = []) {
  const s = item.system ?? {};
  const { max, start } = stepsOf(item);
  const base = {
    id: newId(), itemId: item.id, key: s.key ?? "", icon: s.icon ?? "", emoji: s.emoji ?? "", name: item.name,
    value: max ? start : null, max: max || null
  };
  if ( s.kind === "aspect" ) return { ...base, description: s.description ?? "", statuses: statusesOf(item, items).map(x => entryOf(x, newId)) };
  return base;
}

/**
 * Новое состояние элемента с предметом или null, если он уже висит.
 * Аспект приносит свои статусы; такие же статусы, висевшие на элементе отдельно, уходят внутрь аспекта.
 * Статус встаёт в свой аспект, если тот есть на элементе; иначе — к статусам элемента.
 */
export function attachItem(state, item, newId, items = []) {
  if ( !state || !item || hasItem(state, item.id) ) return null;
  const next = clone(state);
  const sys = next.system;
  sys.statuses ??= [];
  sys.aspects ??= [];
  const all = items.some(i => i.id === item.id) ? items : [...items, item];
  if ( item.system?.kind === "aspect" ) {
    const entry = entryOf(item, newId, all);
    const inside = new Map(entry.statuses.map(x => [x.itemId, x]));
    // Статус уже висел отдельно: переносим его внутрь аспекта вместе с набранной ступенью.
    sys.statuses = sys.statuses.filter(x => {
      const mine = x.itemId && inside.get(x.itemId);
      if ( !mine ) return true;
      Object.assign(mine, { id: x.id, value: x.value ?? mine.value, max: x.max ?? mine.max });
      return false;
    });
    sys.aspects.push(entry);
  } else {
    const entry = entryOf(item, newId, all);
    const parents = new Set([item.system?.parentId, ...aspectsWith(item.id, all).map(a => a.id)].filter(Boolean));
    const parent = sys.aspects.find(a => parents.has(a.itemId));
    if ( parent ) (parent.statuses ??= []).push(entry);
    else sys.statuses.push(entry);
  }
  return next;
}

/** Статус прямо внутрь аспекта элемента (по номеру аспекта). null — уже есть или аспекта нет. */
export function attachInto(state, aspectN, item, newId) {
  const a = state?.system?.aspects?.[aspectN];
  if ( !a || !item || item.system?.kind !== "status" || hasItem(state, item.id) ) return null;
  const next = clone(state);
  (next.system.aspects[aspectN].statuses ??= []).push(entryOf(item, newId));
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

/** Все записи элемента списком: статусы, аспекты и статусы внутри аспектов. */
export function entriesOf(state) {
  const sys = state?.system ?? {};
  return [...(sys.statuses ?? []), ...(sys.aspects ?? []), ...(sys.aspects ?? []).flatMap(a => a.statuses ?? [])];
}

/** Есть ли на элементе статус или аспект, в названии которого встречается q (без учёта регистра). */
export function hasEntryLike(state, q) {
  const f = String(q ?? "").trim().toLowerCase();
  if ( !f ) return false;
  return entriesOf(state).some(x => String(x.name ?? "").toLowerCase().includes(f));
}

/** Где висит предмет: [{ state, entry }] по элементам карты. */
export function hostsOf(states, itemId) {
  const out = [];
  for ( const st of states.values() ) {
    const entry = entriesOf(st).find(x => x.itemId === itemId);
    if ( entry ) out.push({ state: st, entry });
  }
  return out;
}

/**
 * Поиск предметов по названию и описанию. Аспект находится и по названию своего статуса:
 * «Голод» найдёт и статус «Голод», и аспект «Неурожай», в который он входит.
 */
export function searchItems(items, q) {
  const f = String(q ?? "").trim().toLowerCase();
  if ( !f ) return items;
  const hit = i => i.name.toLowerCase().includes(f) || String(i.system?.description ?? "").toLowerCase().includes(f);
  const direct = new Set(items.filter(hit).map(i => i.id));
  return items.filter(i => direct.has(i.id) || (i.system?.kind === "aspect" && statusIdsOf(i, items).some(id => direct.has(id))));
}

/** Сначала точные совпадения, потом начинающиеся с запроса, потом остальные. */
export function rankItems(items, q) {
  const f = String(q ?? "").trim().toLowerCase();
  if ( !f ) return items;
  const rank = i => {
    const n = i.name.toLowerCase();
    return n === f ? 0 : n.startsWith(f) ? 1 : n.includes(f) ? 2 : 3;
  };
  return [...items].sort((a, b) => rank(a) - rank(b));
}

/** Предмет с точно таким названием (без учёта регистра и пробелов по краям). */
export function itemByName(items, name, kind = null) {
  const f = String(name ?? "").trim().toLowerCase();
  if ( !f ) return null;
  return items.find(i => i.name.trim().toLowerCase() === f && (!kind || i.system?.kind === kind)) ?? null;
}

/**
 * Свои статусы и аспекты на карте, которых нет в общем списке: что завести предметами.
 * Ответ: [{ name, kind, max, icon }] без повторов по названию и виду.
 */
export function looseEntries(states, items) {
  const seen = new Map();
  const add = (x, kind) => {
    if ( x.itemId && items.some(i => i.id === x.itemId) ) return;
    const name = String(x.name ?? "").trim();
    if ( !name ) return;
    const key = `${kind}:${name.toLowerCase()}`;
    if ( seen.has(key) || itemByName(items, name, kind) ) return;
    seen.set(key, { name, kind, max: Number(x.max) || 0, icon: x.icon ?? "", key: x.key ?? "" });
  };
  for ( const st of states.values() ) {
    for ( const x of st.system?.statuses ?? [] ) add(x, "status");
    for ( const a of st.system?.aspects ?? [] ) {
      add(a, "aspect");
      for ( const x of a.statuses ?? [] ) add(x, "status");
    }
  }
  return [...seen.values()];
}

/**
 * Связать записи на элементе с предметами по названию: у каждой записи без itemId появляется itemId,
 * если в списке есть предмет того же вида и названия. null — менять нечего.
 */
export function linkEntries(state, items) {
  let changed = false;
  const next = clone(state);
  const link = (x, kind) => {
    if ( x.itemId && items.some(i => i.id === x.itemId) ) return;
    const item = itemByName(items, x.name, kind);
    if ( !item ) return;
    x.itemId = item.id;
    if ( !x.icon && item.system?.icon ) x.icon = item.system.icon;
    changed = true;
  };
  for ( const x of next.system?.statuses ?? [] ) link(x, "status");
  for ( const a of next.system?.aspects ?? [] ) {
    link(a, "aspect");
    for ( const x of a.statuses ?? [] ) link(x, "status");
  }
  return changed ? next : null;
}

/**
 * Предметы для базовых статусов и аспектов модуля: мастер заводит их одной кнопкой.
 * parentKey — ключ аспекта, в который входит статус (id появится после создания).
 */
export function baseItems() {
  const status = (b, parentKey = "") => ({
    name: b.name, parentKey,
    system: {
      kind: "status", icon: b.icon ?? "", emoji: "", tint: true, color: "#c9a45c", description: "",
      steps: b.level ? 3 : (b.max ?? 0), start: b.level ? 1 : (b.max ? (b.value ?? 0) : null), statusIds: [], parentId: "", key: b.key
    }
  });
  return [
    ...BASE_STATUSES.map(b => status(b)),
    ...BASE_ASPECTS.flatMap(a => [
      { name: a.name, parentKey: "", system: { kind: "aspect", icon: a.icon ?? "", emoji: "", tint: true, color: "#8f7bb5", description: "", steps: 0, start: null, statusIds: [], parentId: "", key: a.key } },
      ...a.statuses.map(s => status(s, a.key))
    ])
  ];
}

/** Подпись ступеней: «статус · 1/5» или просто «статус». */
export function stepsLabel(item, t) {
  const { max, start } = stepsOf(item);
  const kind = t(item.system?.kind === "aspect" ? "ART.Aspect.kindAspect" : "ART.Aspect.kindStatus").toLowerCase();
  return max ? `${kind} · ${start}/${max}` : kind;
}
