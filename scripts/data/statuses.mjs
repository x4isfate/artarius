/**
 * Базовые статусы меток и базовые аспекты. Свои статусы (с уровнем и без) остаются как были.
 * key связывает статус с базовым: по нему берётся значок. Чистый код без Foundry.
 */

/** Десять базовых статусов. level — у статуса есть уровень (стадия стройки, раскопок). */
export const BASE_STATUSES = [
  { key: "siege", name: "Осаждён", icon: "shield-halved" },
  { key: "ruined", name: "Разрушен", icon: "house-crack" },
  { key: "fire", name: "Горит", icon: "fire" },
  { key: "plague", name: "Чума", icon: "biohazard" },
  { key: "revolt", name: "Восстание", icon: "hand-fist" },
  { key: "blockade", name: "Блокада", icon: "ban" },
  { key: "abandoned", name: "Заброшен", icon: "ghost" },
  { key: "protected", name: "Под защитой", icon: "shield" },
  { key: "building", name: "Строится", icon: "trowel-bricks", level: true },
  { key: "digging", name: "Раскопки", icon: "person-digging", level: true }
];

/** Базовые аспекты со своими статусами. */
export const BASE_ASPECTS = [
  {
    key: "hvon", name: "Ассимилированный Хвонами", icon: "eye",
    statuses: [
      { key: "hvon-learned", name: "Изучившие Хвонов", icon: "book-open", value: 0, max: 3 },
      { key: "haze-learned", name: "Изучившие марево", icon: "smog" }
    ]
  }
];

const ALL = [...BASE_STATUSES, ...BASE_ASPECTS, ...BASE_ASPECTS.flatMap(a => a.statuses)];

/** Значок статуса: у базового — свой, у своего — по словам в названии, иначе кружок. */
export function statusIcon(status) {
  const s = typeof status === "string" ? { name: status } : (status ?? {});
  const base = s.key ? ALL.find(x => x.key === s.key) : ALL.find(x => x.name.toLowerCase() === String(s.name ?? "").trim().toLowerCase());
  if ( base?.icon ) return base.icon;
  const n = String(s.name ?? "").toLowerCase();
  const words = [["осад", "shield-halved"], ["разруш", "house-crack"], ["гор", "fire"], ["пожар", "fire"], ["чум", "biohazard"],
    ["восстан", "hand-fist"], ["бунт", "hand-fist"], ["блокад", "ban"], ["заброш", "ghost"], ["защит", "shield"],
    ["стро", "trowel-bricks"], ["раскоп", "person-digging"], ["изуч", "book-open"], ["марев", "smog"], ["голод", "wheat-awn-circle-exclamation"]];
  return words.find(([k]) => n.includes(k))?.[1] ?? "circle-dot";
}

/** Новый статус по базовому: уровень 1 у статусов с уровнем. */
export function baseStatus(key, newId) {
  const b = [...BASE_STATUSES, ...BASE_ASPECTS.flatMap(a => a.statuses)].find(x => x.key === key);
  if ( !b ) return null;
  return { id: newId(), key: b.key, name: b.name, value: b.level ? 1 : (b.value ?? null), max: b.max ?? null };
}

/** Новый аспект по базовому вместе с его статусами. */
export function baseAspect(key, newId) {
  const b = BASE_ASPECTS.find(x => x.key === key);
  if ( !b ) return null;
  return {
    id: newId(), key: b.key, name: b.name, description: "", value: null, max: null,
    statuses: b.statuses.map(s => ({ id: newId(), key: s.key, name: s.name, value: s.value ?? null, max: s.max ?? null }))
  };
}
