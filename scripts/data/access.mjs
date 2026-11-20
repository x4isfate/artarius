/**
 * Кто что видит и кто что может. Чистый код без Foundry.
 *
 * Видимость метки (как у скрытого токена): system.visibility = { mode, users }.
 *  mode "all" (или нет поля) — видят все; "gm" — мастер и автор; "some" — мастер, автор и users.
 * Мастер и помощник мастера видят всё. Автор метки — system.author (id пользователя).
 *
 * Права игроков: place — ставить метки, draw — рисовать зоны и линии,
 * editOthers — менять и удалять чужое, statuses — менять статусы и аспекты.
 * Настройка: { roles: { [роль]: { право: bool } }, users: { [id]: { право: bool } } }; у игрока сильнее, чем у роли.
 */

export const PERMS = ["place", "draw", "editOthers", "statuses"];
export const DEFAULT_PERMS = { place: true, draw: true, editOthers: true, statuses: true };
/** Роли Foundry, которым настраиваются права: игрок и доверенный игрок. Помощник и мастер могут всё. */
export const PERM_ROLES = [1, 2];

/** Права пользователя { id, role, isGM }: у мастера всё, дальше настройка игрока, роли, по умолчанию. */
export function permsFor(config, user) {
  const out = {};
  for ( const p of PERMS ) {
    if ( user?.isGM ) { out[p] = true; continue; }
    const own = config?.users?.[user?.id]?.[p];
    const role = config?.roles?.[user?.role]?.[p];
    out[p] = own ?? role ?? DEFAULT_PERMS[p];
  }
  return out;
}

/** Видит ли пользователь элемент. Прячутся только метки. */
export function canSee(state, userId, isGM = false) {
  if ( isGM || state?.system?.kind !== "object" ) return true;
  const v = state.system.visibility;
  if ( !v || !v.mode || v.mode === "all" ) return true;
  if ( state.system.author && state.system.author === userId ) return true;
  return v.mode === "some" && (v.users ?? []).includes(userId);
}

/** Элементы, которые видит пользователь. */
export function visibleStates(states, userId, isGM = false) {
  if ( isGM ) return states;
  const out = new Map();
  for ( const [id, s] of states ) if ( canSee(s, userId, isGM) ) out.set(id, s);
  return out;
}

/** Спрятана ли метка от кого-то (для полупрозрачного вида у мастера). */
export const isHidden = state => !!state?.system?.visibility?.mode && state.system.visibility.mode !== "all";

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const KIND_PERM = { object: "place", area: "draw", line: "draw" };

/**
 * Какое право нужно на правку. before — элемент до правки (нет у нового).
 * Чужое: автор не этот пользователь (у старых элементов без автора — чужое).
 * Гексы зоны и точки линии — это рисование, даже у чужой зоны: новая зона забирает гексы у соседей.
 */
export function permFor(op, before, userId) {
  const kind = (op.state ?? before)?.system?.kind ?? "object";
  if ( op.action === "create" && !before ) return KIND_PERM[kind] ?? "place";
  const mine = before?.system?.author === userId;
  if ( op.action === "delete" ) return mine ? null : "editOthers";
  const a = before?.system ?? {}, b = op.state?.system ?? {};
  const statusOnly = same(before?.name, op.state?.name) && same(before?.text, op.state?.text)
    && Object.keys({ ...a, ...b }).every(k => ["statuses", "aspects", "rev"].includes(k) || same(a[k], b[k]));
  if ( statusOnly ) return (same(a.statuses, b.statuses) && same(a.aspects, b.aspects)) ? null : "statuses";
  if ( mine ) return null;
  const geometryOnly = kind !== "object" && same(before?.name, op.state?.name)
    && Object.keys({ ...a, ...b }).every(k => ["geometry", "rev"].includes(k) || same(a[k], b[k]));
  return geometryOnly ? "draw" : "editOthers";
}

/** Разделить правки на разрешённые и запрещённые: { allowed, denied: [{ op, perm }] }. */
export function checkOps(ops, beforeOf, perms, userId) {
  const allowed = [], denied = [];
  for ( const op of ops ) {
    const need = permFor(op, beforeOf(op.id), userId);
    if ( !need || perms[need] !== false ) allowed.push(op);
    else denied.push({ op, perm: need });
  }
  return { allowed, denied };
}
