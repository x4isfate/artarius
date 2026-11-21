import { MODULE_ID, FEATURE_TYPE, STARTER_TYPES, STARTER_LAYERS, CLAIM_STATUS } from "../constants.mjs";

const OPEN_STATUSES = [CLAIM_STATUS.pending, CLAIM_STATUS.check, CLAIM_STATUS.rolled];
import { addToDraft, draftOps, applyOps, buildApplyPlan } from "../review/ops.mjs";
import { mergeTypes } from "./world.mjs";
import { resolveStyleOf } from "../canvas/style.mjs";

/** Версия формата атласа. 3 — гекс-мир: слои с exclusive, типы зон знают свой слой. */
export const ATLAS_VERSION = 4;

/**
 * Где лежат данные карты.
 * - Атлас: журнал на сцену. Страницы журнала — элементы карты, флаги — типы и слои.
 * - Черновик игрока: флаг его документа User, по сцене: drafts.<sceneId> = [Op].
 * - Заявки игрока: флаг его документа User: claims = [Claim].
 * Игрок пишет только в свой User, атлас меняет только мастер.
 */

/* ---------------------------------------------------------------- */
/*  Атлас                                                            */
/* ---------------------------------------------------------------- */

/** Атлас сцены или null. */
export function getAtlas(scene = canvas?.scene) {
  if ( !scene ) return null;
  const id = scene.getFlag(MODULE_ID, "atlas");
  const byId = id ? game.journal.get(id) : null;
  if ( byId ) return byId;
  return game.journal.find(j => j.getFlag(MODULE_ID, "sceneId") === scene.id) ?? null;
}

/** Атлас сцены; если его нет, мастер его создаёт. */
export async function ensureAtlas(scene = canvas?.scene) {
  if ( !scene ) return null;
  const existing = getAtlas(scene);
  if ( existing ) return existing;
  if ( !game.user.isGM ) return null;
  const atlas = await JournalEntry.implementation.create({
    name: game.i18n.format("VMAP.Atlas.name", { scene: scene.name }),
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
    flags: { [MODULE_ID]: { sceneId: scene.id, types: STARTER_TYPES, layers: STARTER_LAYERS, version: ATLAS_VERSION } }
  });
  await scene.setFlag(MODULE_ID, "atlas", atlas.id);
  return atlas;
}

/**
 * Атлас старой версии: добавить недостающие слои и типы гекс-мира, свои не трогать.
 * Вызывает мастер. Возвращает true, если атлас поменялся.
 */
export async function upgradeAtlas(atlas) {
  if ( !atlas || !game.user.isGM ) return false;
  if ( (atlas.getFlag(MODULE_ID, "version") ?? 0) >= ATLAS_VERSION ) return false;
  const { types, layers } = upgradedTypesAndLayers(atlas.getFlag(MODULE_ID, "types") ?? [], atlas.getFlag(MODULE_ID, "layers") ?? []);
  await atlas.update({
    [`flags.${MODULE_ID}.types`]: types,
    [`flags.${MODULE_ID}.layers`]: layers,
    [`flags.${MODULE_ID}.version`]: ATLAS_VERSION
  });
  return true;
}

/** Чистая часть обновления: старые записи плюс недостающие из стартового набора. */
export function upgradedTypesAndLayers(oldTypes, oldLayers) {
  const layers = oldLayers.map(l => ({ exclusive: l.id !== "overlay" && l.exclusive !== false, ...l }));
  for ( const l of STARTER_LAYERS ) {
    if ( layers.some(x => x.id === l.id) ) continue;
    // Новый свободный слой встаёт под «Прочее», чтобы свои пометки мастера оставались сверху.
    const over = layers.findIndex(x => x.id === "overlay");
    if ( over >= 0 && l.id !== "overlay" ) layers.splice(over, 0, { ...l });
    else layers.push({ ...l });
  }
  const types = [...oldTypes];
  for ( const t of STARTER_TYPES ) if ( !types.some(x => x.id === t.id) ) types.push(foundry.utils.deepClone(t));
  return { types, layers: layers.map((l, i) => ({ ...l, sort: i })) };
}

/** Страница журнала → состояние элемента для черновиков и рендера. */
export function pageToState(page) {
  return {
    id: page.id,
    name: page.name,
    text: page.text?.content ?? "",
    system: foundry.utils.deepClone(page._source.system)
  };
}

/** Все элементы атласа: Map id → состояние. */
export function atlasStates(atlas) {
  const out = new Map();
  if ( !atlas ) return out;
  for ( const page of atlas.pages ) {
    if ( page.type === FEATURE_TYPE ) out.set(page.id, pageToState(page));
  }
  return out;
}

/** Типы атласа без личных типов игроков. */
export const getAtlasTypes = atlas => foundry.utils.deepClone(atlas?.getFlag(MODULE_ID, "types") ?? STARTER_TYPES);

/** Личные типы пользователей: их игроки создают сами, пока мастер не перенёс их в атлас. */
export function personalTypes() {
  return (game.users?.contents ?? []).map(u => ({ userId: u.id, types: u.getFlag(MODULE_ID, "types") ?? [] }))
    .filter(p => p.types.length);
}

/** Все типы: атлас и личные типы игроков. */
export const getTypes = atlas => mergeTypes(getAtlasTypes(atlas), foundry.utils.deepClone(personalTypes()));
export const getLayers = atlas => foundry.utils.deepClone(atlas?.getFlag(MODULE_ID, "layers") ?? STARTER_LAYERS)
  .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

export async function setTypes(atlas, types) {
  return atlas.update({ [`flags.${MODULE_ID}.types`]: types });
}
export async function setLayers(atlas, layers) {
  return atlas.update({ [`flags.${MODULE_ID}.layers`]: layers.map((l, i) => ({ ...l, sort: i })) });
}

/**
 * Добавить или поменять тип. Мастер пишет в атлас, игрок — в свои личные типы.
 * Игрок может менять только свои личные типы.
 */
export async function saveType(type, scene = canvas?.scene) {
  const { personal, ...clean } = type;
  if ( game.user.isGM ) {
    const atlas = getAtlas(scene) ?? await ensureAtlas(scene);
    const types = getAtlasTypes(atlas);
    const n = types.findIndex(t => t.id === clean.id);
    if ( n >= 0 ) types[n] = clean; else types.push(clean);
    return setTypes(atlas, types);
  }
  const mine = foundry.utils.deepClone(game.user.getFlag(MODULE_ID, "types") ?? []);
  const n = mine.findIndex(t => t.id === clean.id);
  if ( n >= 0 ) mine[n] = clean; else mine.push(clean);
  return game.user.update({ [`flags.${MODULE_ID}.types`]: mine });
}

/** Удалить тип (мастер — из атласа, игрок — свой личный). */
export async function deleteType(id, scene = canvas?.scene) {
  if ( game.user.isGM ) {
    const atlas = getAtlas(scene);
    if ( atlas ) await setTypes(atlas, getAtlasTypes(atlas).filter(t => t.id !== id));
    return;
  }
  const mine = (game.user.getFlag(MODULE_ID, "types") ?? []).filter(t => t.id !== id);
  return game.user.update({ [`flags.${MODULE_ID}.types`]: mine });
}

/** Итоговый вид элемента (см. canvas/style.mjs). */
export const resolveStyle = resolveStyleOf;

/* ---------------------------------------------------------------- */
/*  Черновик и заявки                                                */
/* ---------------------------------------------------------------- */

/** Черновик пользователя по сцене как объект id → Op. */
export function getDraft(user = game.user, sceneId = canvas?.scene?.id) {
  const list = user.getFlag(MODULE_ID, `drafts.${sceneId}`) ?? [];
  return Object.fromEntries(list.map(op => [op.id, op]));
}

export async function setDraft(draft, user = game.user, sceneId = canvas?.scene?.id) {
  return user.update({ [`flags.${MODULE_ID}.drafts.${sceneId}`]: draftOps(draft) });
}

/** Заявки пользователя. */
export const getClaims = (user = game.user) => foundry.utils.deepClone(user.getFlag(MODULE_ID, "claims") ?? []);

export async function setClaims(claims, user = game.user) {
  return user.update({ [`flags.${MODULE_ID}.claims`]: claims });
}

/** Правки открытых заявок пользователя по сцене, в порядке подачи. */
export function pendingClaimOps(user = game.user, sceneId = canvas?.scene?.id) {
  return getClaims(user)
    .filter(c => c.sceneId === sceneId && OPEN_STATUSES.includes(c.status))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .flatMap(c => c.ops ?? []);
}

/**
 * Состояние карты так, как его видит этот пользователь: атлас, поверх его открытые
 * заявки и черновик. Мастер видит только атлас, заявки он смотрит в очереди.
 */
export function effectiveStates(scene = canvas?.scene) {
  const base = atlasStates(getAtlas(scene));
  if ( game.user.isGM ) return base;
  const withClaims = applyOps(base, pendingClaimOps(game.user, scene?.id));
  return applyOps(withClaims, draftOps(getDraft(game.user, scene?.id)));
}

/** Текущая версия элемента в атласе (или undefined, если его там нет). */
export function revOf(atlas, id) {
  const page = atlas?.pages.get(id);
  return page ? (page._source.system?.rev ?? 0) : undefined;
}

/**
 * Записать правку. Мастер пишет прямо в атлас, игрок — в свой черновик.
 * op: { action, id, state?, name? }; baseRev ставится здесь.
 * Хук artarius.preCommit может отменить правку (вернуть false), artarius.commit сообщает о ней.
 */
export async function commit(op, scene = canvas?.scene) {
  const atlas = getAtlas(scene) ?? await ensureAtlas(scene);
  if ( !atlas ) {
    ui.notifications.warn(game.i18n.localize("VMAP.Notify.noAtlas"));
    return;
  }
  if ( Hooks.call("artarius.preCommit", op, { scene, direct: game.user.isGM }) === false ) return;
  let result;
  const before = game.user.isGM ? atlasStates(atlas).get(op.id) : undefined;
  if ( game.user.isGM ) {
    const plan = buildApplyPlan([{ ...op, baseRev: revOf(atlas, op.id) }], id => revOf(atlas, id), { force: true });
    result = await applyPlan(atlas, plan);
  } else {
    const draft = getDraft(game.user, scene.id);
    const prev = draft[op.id];
    const baseRev = prev?.baseRev ?? revOf(atlas, op.id) ?? null;
    result = await setDraft(addToDraft(draft, { ...op, baseRev }), game.user, scene.id);
  }
  Hooks.callAll("artarius.commit", op, { scene, direct: game.user.isGM, before });
  return result;
}

/**
 * Записать несколько правок разом (например, зона забрала гексы у соседей).
 * Мастер применяет их одним планом, игрок кладёт в черновик одним обновлением.
 */
export async function commitOps(ops, scene = canvas?.scene) {
  ops = ops.filter(Boolean);
  if ( !ops.length ) return;
  const atlas = getAtlas(scene) ?? await ensureAtlas(scene);
  if ( !atlas ) {
    ui.notifications.warn(game.i18n.localize("VMAP.Notify.noAtlas"));
    return;
  }
  const allowed = ops.filter(op => Hooks.call("artarius.preCommit", op, { scene, direct: game.user.isGM }) !== false);
  if ( !allowed.length ) return;
  let result;
  // Прежнее состояние нужно хуку только для затронутых элементов: весь атлас не копируем.
  const base = new Map();
  if ( game.user.isGM ) for ( const op of allowed ) {
    const page = atlas.pages.get(op.id);
    if ( page?.type === FEATURE_TYPE ) base.set(op.id, pageToState(page));
  }
  if ( game.user.isGM ) {
    const plan = buildApplyPlan(allowed.map(op => ({ ...op, baseRev: revOf(atlas, op.id) })), id => revOf(atlas, id), { force: true });
    result = await applyPlan(atlas, plan);
  } else {
    let draft = getDraft(game.user, scene.id);
    for ( const op of allowed ) {
      const baseRev = draft[op.id]?.baseRev ?? revOf(atlas, op.id) ?? null;
      draft = addToDraft(draft, { ...op, baseRev });
    }
    result = await setDraft(draft, game.user, scene.id);
  }
  for ( const op of allowed ) Hooks.callAll("artarius.commit", op, { scene, direct: game.user.isGM, before: base.get(op.id) });
  return result;
}

/** Применить план к атласу: создания, правки и удаления пакетными вызовами. */
export async function applyPlan(atlas, plan) {
  const toPage = s => ({
    _id: s.id,
    name: s.name || game.i18n.localize("VMAP.Feature.unnamed"),
    type: FEATURE_TYPE,
    text: { content: s.text ?? "", format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML },
    system: s.system
  });
  if ( plan.create.length ) await atlas.createEmbeddedDocuments("JournalEntryPage", plan.create.map(toPage), { keepId: true });
  if ( plan.update.length ) {
    // На сервер уходит только то, что поменялось. Где из объекта что-то убрали, страница пишется целиком.
    const partial = [], whole = [];
    for ( const s of plan.update ) {
      const page = atlas.pages.get(s.id);
      const { type, ...full } = toPage(s);
      const diff = page ? pageDiff(page._source, full) : null;
      if ( diff === null ) whole.push(full);
      else if ( Object.keys(diff).length > 1 ) partial.push(diff);
    }
    if ( partial.length ) await atlas.updateEmbeddedDocuments("JournalEntryPage", partial);
    if ( whole.length ) await atlas.updateEmbeddedDocuments("JournalEntryPage", whole, { recursive: false });
  }
  if ( plan.delete.length ) await atlas.deleteEmbeddedDocuments("JournalEntryPage", plan.delete);
  return plan;
}

const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const sameJSON = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Есть ли в старом объекте ключи, которых нет в новом (на любой глубине). Массивы заменяются целиком. */
function lostKeys(before, after) {
  if ( !isObj(before) ) return false;
  if ( !isObj(after) ) return true;
  return Object.keys(before).some(k => !(k in after) || lostKeys(before[k], after[k]));
}

/**
 * Правка страницы только по изменённым полям: { _id, name?, "text.content"?, "system.<ключ>"? }.
 * null — если из системы что-то убрали: тогда страница пишется целиком без слияния.
 */
export function pageDiff(source, full) {
  const out = { _id: full._id };
  if ( source.name !== full.name ) out.name = full.name;
  if ( (source.text?.content ?? "") !== (full.text?.content ?? "") ) out["text.content"] = full.text.content;
  const a = source.system ?? {}, b = full.system ?? {};
  for ( const k of Object.keys(a) ) {
    if ( !(k in b) ) return null;
    if ( lostKeys(a[k], b[k]) ) return null;
  }
  for ( const k of Object.keys(b) ) if ( !sameJSON(a[k], b[k]) ) out[`system.${k}`] = b[k];
  return out;
}

/** Персонажи, которыми владеет пользователь: закреплённый за ним и те, где у него права владельца. */
export function ownedActorIds(user) {
  if ( !user || user.isGM ) return [];
  const out = new Set();
  if ( user.character?.id ) out.add(user.character.id);
  for ( const a of game.actors ?? [] ) {
    try { if ( a.testUserPermission(user, "OWNER") ) out.add(a.id); } catch { /* актёр без прав */ }
  }
  return [...out];
}
