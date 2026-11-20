import { MODULE_ID } from "../constants.mjs";
import { describeOp } from "./describe.mjs";
import { isHidden } from "../data/access.mjs";
import { getAtlas, atlasStates, getTypes, getLayers } from "../data/store.mjs";

/**
 * Сообщения о карте в чате: новая заявка (мастеру, со звуком), принятая заявка
 * и пачка правок мастера (всем, если включена настройка «Изменения карты в чате»).
 */

const L = k => game.i18n.localize(k);
const F = (k, d) => game.i18n.format(k, d);
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
const MAX_LINES = 12;
const BATCH_MS = 4000;

const gmIds = () => game.users.filter(u => u.isGM).map(u => u.id);
const enabled = () => game.settings.get(MODULE_ID, "chatChanges");

function ctxFor(scene) {
  const atlas = getAtlas(scene);
  const types = getTypes(atlas), layers = getLayers(atlas);
  return {
    t: (k, d) => (d ? F(k, d) : L(k)),
    typeName: id => types.find(x => x.id === id)?.name ?? id,
    layerName: id => layers.find(x => x.id === id)?.name ?? id
  };
}

/** Строки правок; скрытые метки не попадают в общее сообщение. */
function lines(ops, base, scene, { hideHidden = true } = {}) {
  const ctx = ctxFor(scene);
  const visible = ops.filter(op => !hideHidden || (!isHidden(op.state) && !isHidden(base.get(op.id))));
  const out = visible.slice(0, MAX_LINES).map(op => `<li>${esc(describeOp(op, base, ctx))}</li>`);
  if ( visible.length > MAX_LINES ) out.push(`<li>${esc(F("ART.Chat.more", { n: visible.length - MAX_LINES }))}</li>`);
  return { html: out.join(""), count: visible.length };
}

const card = (title, sub, list) => `<div class="artarius-chat"><h3>${esc(title)}</h3>${sub ? `<p>${esc(sub)}</p>` : ""}${list ? `<ul>${list}</ul>` : ""}</div>`;

/** Игрок отправил заявку: сообщение только мастерам, со звуком. */
export async function postClaimSubmitted(claim, scene) {
  const base = atlasStates(getAtlas(scene));
  const { html } = lines(claim.ops ?? [], base, scene, { hideHidden: false });
  const sub = F("ART.Chat.claimFrom", { name: game.user.name, title: claim.title, n: claim.ops.length });
  return ChatMessage.implementation.create({
    content: card(L("ART.Chat.claimNew"), sub, html),
    whisper: gmIds(),
    sound: CONFIG.sounds?.notification,
    speaker: { alias: "Artarius" },
    flags: { [MODULE_ID]: { claimNotice: { claimId: claim.id, userId: game.user.id } } }
  });
}

/** Мастер принял заявки: по сообщению на заявку. base — атлас до применения. */
export async function postClaimsApplied(entries, bases = new Map()) {
  if ( !enabled() ) return;
  for ( const { user, claim } of entries ) {
    const scene = game.scenes.get(claim.sceneId);
    const base = bases.get(claim.sceneId) ?? atlasStates(getAtlas(scene));
    const { html, count } = lines(claim.ops ?? [], base, scene);
    if ( !count ) continue;
    await ChatMessage.implementation.create({
      content: card(L("ART.Chat.applied"), F("ART.Chat.appliedFrom", { title: claim.title, name: user.name }), html),
      speaker: { alias: "Artarius" }
    });
  }
}

/* Правки мастера копятся несколько секунд и уходят одним сообщением. */
let pending = null;

/** Хук artarius.commit: собрать прямые правки мастера. */
export function onDirectCommit(op, { scene, direct, before } = {}) {
  if ( !direct || !game.user.isGM || !enabled() || !scene ) return;
  if ( pending && pending.sceneId !== scene.id ) flushDirect();
  pending ??= { sceneId: scene.id, ops: new Map(), base: new Map(), timer: null };
  if ( !pending.ops.has(op.id) && before ) pending.base.set(op.id, before);
  // Создали и удалили в одной пачке — ничего не было.
  const prev = pending.ops.get(op.id);
  if ( prev?.action === "create" && op.action === "delete" ) pending.ops.delete(op.id);
  else pending.ops.set(op.id, prev?.action === "create" ? { ...op, action: "create" } : op);
  clearTimeout(pending.timer);
  pending.timer = setTimeout(flushDirect, BATCH_MS);
}

export async function flushDirect() {
  const p = pending;
  pending = null;
  if ( !p ) return;
  clearTimeout(p.timer);
  const scene = game.scenes.get(p.sceneId);
  const { html, count } = lines([...p.ops.values()], p.base, scene);
  if ( !count ) return;
  return ChatMessage.implementation.create({
    content: card(L("ART.Chat.changes"), scene?.name ?? "", html),
    speaker: { alias: "Artarius" }
  });
}
