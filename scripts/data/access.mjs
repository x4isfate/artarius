/**
 * Кто что видит и кто что может. Чистый код без Foundry.
 *
 * Видимость элемента (метки, зоны, линии), как у скрытого токена: system.visibility = { mode, users }.
 *  mode "all" (или нет поля) — видят все; "gm" — мастер, автор и демиурги; "some" — ещё users.
 * Мастер и помощник мастера видят всё. Автор — system.author (id пользователя).
 * Демиурги — system.demiurges (id персонажей); у старых элементов одно поле system.demiurge.
 * Игрок, который владеет персонажем-демиургом, видит элемент всегда: спрятать от него нельзя.
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

/** Демиурги элемента: список id персонажей. Старое поле demiurge (один id) читается как список из одного. */
export function demiurgesOf(state) {
  const sys = state?.system ?? state ?? {};
  if ( Array.isArray(sys.demiurges) && (sys.demiurges.length || !sys.demiurge) ) return sys.demiurges.filter(Boolean);
  return sys.demiurge ? [sys.demiurge] : [];
}

/** Записать демиургов: список и, для старого кода и импорта, первый из них в demiurge. */
export function setDemiurges(system, ids) {
  const list = [...new Set((ids ?? []).filter(Boolean))];
  system.demiurges = list;
  system.demiurge = list[0] ?? "";
  return system;
}

const asSet = ids => (ids instanceof Set ? ids : new Set(ids ?? []));

/** Демиург ли этот элемент для пользователя с такими персонажами. */
export function isDemiurge(state, actorIds) {
  const mine = asSet(actorIds);
  return !!mine.size && demiurgesOf(state).some(id => mine.has(id));
}

/** Видит ли пользователь элемент. actorIds — персонажи, которыми он владеет. */
export function canSee(state, userId, isGM = false, actorIds = null) {
  if ( isGM ) return true;
  const v = state?.system?.visibility;
  if ( !v || !v.mode || v.mode === "all" ) return true;
  if ( state.system.author && state.system.author === userId ) return true;
  if ( isDemiurge(state, actorIds) ) return true;
  return v.mode === "some" && (v.users ?? []).includes(userId);
}

/** Элементы, которые видит пользователь. */
export function visibleStates(states, userId, isGM = false, actorIds = null) {
  if ( isGM ) return states;
  const mine = asSet(actorIds);
  const out = new Map();
  for ( const [id, s] of states ) if ( canSee(s, userId, isGM, mine) ) out.set(id, s);
  return out;
}

/** Менять «Кто видит» может мастер или игрок, чей персонаж — демиург элемента. */
export function canEditVisibility(state, { isGM = false, actorIds = null } = {}) {
  return isGM || isDemiurge(state, actorIds);
}

/**
 * Игроки, у которых видимость не отнять: они владеют персонажем-демиургом.
 * players — [{ id, actorIds }].
 */
export function lockedViewers(state, players) {
  const dem = new Set(demiurgesOf(state));
  return (players ?? []).filter(p => (p.actorIds ?? []).some(id => dem.has(id))).map(p => p.id);
}

/**
 * Нужно ли подтверждение мастера, даже у доверенного игрока: правка меняет демиургов.
 * Новый элемент со своими персонажами (или без демиургов) подтверждения не ждёт.
 */
export function needsGMApproval(op, before, actorIds = null) {
  if ( op?.action === "delete" || !op?.state ) return false;
  if ( !before ) {
    const mine = asSet(actorIds);
    return demiurgesOf(op.state).some(id => !mine.has(id));
  }
  return demiurgesChanged(before, op.state);
}

/** Поменялись ли демиурги правкой. */
export function demiurgesChanged(before, after) {
  const a = demiurgesOf(before).slice().sort(), b = demiurgesOf(after).slice().sort();
  return a.length !== b.length || a.some((x, i) => x !== b[i]);
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
export function permFor(op, before, userId, actorIds = null) {
  const kind = (op.state ?? before)?.system?.kind ?? "object";
  // «Кто видит» меняет только демиург элемента (мастер сюда не попадает: у него проверки нет).
  if ( op.action !== "delete" && op.state ) {
    const was = before?.system?.visibility?.mode ? before.system.visibility : { mode: "all", users: [] };
    const now = op.state.system?.visibility?.mode ? op.state.system.visibility : { mode: "all", users: [] };
    if ( !same(was, now) && !isDemiurge(before ?? op.state, actorIds) && !isDemiurge(op.state, actorIds) ) return "visibility";
  }
  if ( op.action === "create" && !before ) return KIND_PERM[kind] ?? "place";
  const mine = before?.system?.author === userId;
  if ( op.action === "delete" ) return mine ? null : "editOthers";
  const a = before?.system ?? {}, b = op.state?.system ?? {};
  const statusOnly = same(before?.name, op.state?.name) && same(before?.text, op.state?.text)
    && Object.keys({ ...a, ...b }).every(k => ["statuses", "aspects", "rev"].includes(k) || same(a[k], b[k]));
  const visOnly = same(before?.name, op.state?.name) && same(before?.text, op.state?.text)
    && Object.keys({ ...a, ...b }).every(k => ["visibility", "rev"].includes(k) || same(a[k], b[k]));
  if ( visOnly ) return null;
  if ( statusOnly ) return (same(a.statuses, b.statuses) && same(a.aspects, b.aspects)) ? null : "statuses";
  if ( mine ) return null;
  const geometryOnly = kind !== "object" && same(before?.name, op.state?.name)
    && Object.keys({ ...a, ...b }).every(k => ["geometry", "rev"].includes(k) || same(a[k], b[k]));
  return geometryOnly ? "draw" : "editOthers";
}

/** Разделить правки на разрешённые и запрещённые: { allowed, denied: [{ op, perm }] }. */
export function checkOps(ops, beforeOf, perms, userId, actorIds = null) {
  const allowed = [], denied = [];
  for ( const op of ops ) {
    const need = permFor(op, beforeOf(op.id), userId, actorIds);
    // Право «visibility» настройкой не выдаётся: его даёт только демиург.
    if ( !need || (need !== "visibility" && perms[need] !== false) ) allowed.push(op);
    else denied.push({ op, perm: need });
  }
  return { allowed, denied };
}
