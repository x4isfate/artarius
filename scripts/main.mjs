import { MODULE_ID, FEATURE_TYPE, CLAIM_STATUS } from "./constants.mjs";
import FeatureModel from "./data/feature-model.mjs";
import * as store from "./data/store.mjs";
import { getAtlas, ensureAtlas, getClaims } from "./data/store.mjs";
import MapLayer, { LAYER_NAME } from "./canvas/map-layer.mjs";
import FeatureSheet from "./apps/feature-sheet.mjs";
import AtlasConfig from "./apps/atlas-config.mjs";
import ClaimsApp from "./apps/claims-app.mjs";
import FeaturePageSheet from "./sheets/feature-page-sheet.mjs";
import GuideApp from "./apps/guide-app.mjs";
import QuickMenu, { registerQuickAction, unregisterQuickAction, registerBuiltInActions, QUICK_ACTIONS } from "./apps/quick-menu.mjs";
import QuickMenuConfig from "./apps/quick-menu-config.mjs";
import AzgaarApp, { AzgaarGenerator, importAzgaar } from "./apps/azgaar-app.mjs";
import findFeature from "./apps/find-feature.mjs";
import { checkForUpdate } from "./update-check.mjs";
import {
  SOCKET, onSocket, onCheckMessage, onCheckUpdated, autoApplyTrusted, rollForClaim
} from "./review/claims.mjs";

/* ------------------------------------------------------------------ */
/*  Подключение                                                        */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  CONFIG.JournalEntryPage.dataModels[FEATURE_TYPE] = FeatureModel;
  CONFIG.Canvas.layers[LAYER_NAME] = { layerClass: MapLayer, group: "interface" };

  foundry.applications.apps.DocumentSheetConfig.registerSheet(JournalEntryPage, MODULE_ID, FeaturePageSheet, {
    types: [FEATURE_TYPE], makeDefault: true, label: "VMAP.Sheet.page"
  });

  game.settings.register(MODULE_ID, "autoApplyOnSuccess", {
    name: "VMAP.Settings.autoApplyOnSuccess.name",
    hint: "VMAP.Settings.autoApplyOnSuccess.hint",
    scope: "world", config: true, type: Boolean, default: true,
    onChange: () => ClaimsApp.refresh()
  });
  game.settings.register(MODULE_ID, "trustedUsers", {
    scope: "world", config: false, type: Array, default: [],
    onChange: () => ClaimsApp.refresh()
  });
  game.settings.register(MODULE_ID, "guideSeen", {
    scope: "client", config: false, type: Boolean, default: false
  });
  game.settings.register(MODULE_ID, "renderBelowTokens", {
    name: "VMAP.Settings.renderBelowTokens.name",
    hint: "VMAP.Settings.renderBelowTokens.hint",
    scope: "world", config: true, type: Boolean, default: false,
    requiresReload: true
  });

  game.settings.register(MODULE_ID, "quickMenu", {
    scope: "client", config: false, type: Object, default: { items: null, collapsed: false },
    onChange: () => QuickMenu.render()
  });
  game.settings.register(MODULE_ID, "quickMenuDefault", {
    scope: "world", config: false, type: Array, default: [],
    onChange: () => QuickMenu.render()
  });
  game.settings.register(MODULE_ID, "checkUpdates", {
    name: "VMAP.Settings.checkUpdates.name",
    hint: "VMAP.Settings.checkUpdates.hint",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "notifiedVersion", {
    scope: "world", config: false, type: String, default: ""
  });

  foundry.applications.handlebars.loadTemplates({
    vmapStatus: `modules/${MODULE_ID}/templates/status-row.hbs`,
    vmapClaim: `modules/${MODULE_ID}/templates/claim-card.hbs`,
    vmapOp: `modules/${MODULE_ID}/templates/op-row.hbs`
  });

  game.modules.get(MODULE_ID).api = {
    /** Версия API. Растёт, когда что-то в нём меняется несовместимо. */
    version: 1,
    openFeature: id => FeatureSheet.open(id),
    openClaims: () => ClaimsApp.open(),
    openGuide: () => GuideApp.open(),
    openAtlasConfig: () => game.user.isGM ? new AtlasConfig().render({ force: true }) : null,
    openAzgaar: () => AzgaarApp.open(),
    openAzgaarGenerator: () => AzgaarGenerator.open(),
    openQuickMenuConfig: () => QuickMenuConfig.open(),
    importAzgaar,
    findFeature,
    activateLayer,
    getAtlas, ensureAtlas,
    layer: () => canvas[LAYER_NAME],
    /** Данные: атлас, типы, слои, черновики, заявки и запись правок. */
    store,
    /** Меню быстрых действий: добавить свою кнопку, убрать, перерисовать. */
    quickActions: QUICK_ACTIONS,
    registerQuickAction,
    unregisterQuickAction,
    refreshQuickMenu: () => QuickMenu.render(),
    refreshMap: () => canvas[LAYER_NAME]?.refresh()
  };
  registerBuiltInActions();
  Hooks.callAll("artarius.init", game.modules.get(MODULE_ID).api);
});

/** Включить группу «Карта мира» в панели слева. */
function activateLayer(tool = "select") {
  if ( !canvas?.ready ) return;
  if ( ui.controls?.activate ) ui.controls.activate({ control: LAYER_NAME, tool });
  else canvas[LAYER_NAME]?.activate();
}

/** Запасной путь: если Foundry не собрал группу со слоя, добавить её вручную. */
Hooks.on("getSceneControlButtons", controls => {
  if ( controls && !controls[LAYER_NAME] ) {
    const control = MapLayer.prepareSceneControls();
    if ( control ) controls[LAYER_NAME] = control;
  }
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, onSocket);
  rememberClaimStatuses();
  if ( !game.settings.get(MODULE_ID, "guideSeen") ) {
    GuideApp.open();
    game.settings.set(MODULE_ID, "guideSeen", true);
  }
  QuickMenu.render();
  checkForUpdate();
  Hooks.callAll("artarius.ready", game.modules.get(MODULE_ID).api);
});

// Меню быстрых действий следит за инструментами, сценой и заявками.
for ( const hook of ["renderSceneControls", "canvasReady", "renderPlayers", "renderPlayerList"] ) {
  Hooks.on(hook, () => QuickMenu.render());
}

/* ------------------------------------------------------------------ */
/*  Ошибки модуля не должны пропадать молча                            */
/* ------------------------------------------------------------------ */

/** Ошибка из кода модуля: показать сообщение с текстом, полную трассу оставить в консоли. */
function reportError(err) {
  const stack = String(err?.stack ?? "");
  if ( !stack.includes(`modules/${MODULE_ID}/`) ) return;
  console.error(`${MODULE_ID} |`, err);
  ui.notifications?.error(game.i18n.format("VMAP.Notify.error", { message: err?.message ?? String(err) }), { permanent: true });
}
window.addEventListener("error", ev => reportError(ev.error));
window.addEventListener("unhandledrejection", ev => reportError(ev.reason));

/* ------------------------------------------------------------------ */
/*  Перерисовка                                                        */
/* ------------------------------------------------------------------ */

const refreshMap = () => canvas?.ready && canvas[LAYER_NAME]?.refresh();
const isCurrentAtlas = journal => !!journal && journal === getAtlas(canvas?.scene);

for ( const hook of ["createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage"] ) {
  Hooks.on(hook, page => {
    if ( page.type !== FEATURE_TYPE ) return;
    if ( isCurrentAtlas(page.parent) ) refreshMap();
    ClaimsApp.refresh();
  });
}
Hooks.on("updateJournalEntry", journal => {
  if ( isCurrentAtlas(journal) ) refreshMap();
});
Hooks.on("updateScene", (scene, changes) => {
  if ( scene === canvas?.scene && foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`) ) refreshMap();
});
Hooks.on("canvasReady", () => refreshMap());

Hooks.on("updateUser", (user, changes) => {
  if ( !foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`) ) return;
  if ( user.isSelf || game.user.isGM ) refreshMap();
  ClaimsApp.refresh();
  QuickMenu.render();
  canvas?.[LAYER_NAME]?.palette?.render();
  if ( user.isSelf ) announceDecisions(user);
  if ( game.user.isGM ) autoApplyTrusted(user);
});

/* ------------------------------------------------------------------ */
/*  Решения по заявкам: сообщить игроку                                */
/* ------------------------------------------------------------------ */

let knownStatuses = new Map();

function rememberClaimStatuses() {
  knownStatuses = new Map(getClaims(game.user).map(c => [c.id, c.status]));
}

function announceDecisions(user) {
  if ( user.isGM ) return rememberClaimStatuses();
  for ( const claim of getClaims(user) ) {
    const before = knownStatuses.get(claim.id);
    if ( !before || before === claim.status ) continue;
    const key = {
      [CLAIM_STATUS.applied]: "VMAP.Claims.youApplied",
      [CLAIM_STATUS.rejected]: "VMAP.Claims.youRejected",
      [CLAIM_STATUS.check]: "VMAP.Claims.youCheck"
    }[claim.status];
    if ( key ) ui.notifications.info(game.i18n.format(key, { title: claim.title }));
  }
  rememberClaimStatuses();
}

/* ------------------------------------------------------------------ */
/*  Чат: карточка проверки по заявке                                   */
/* ------------------------------------------------------------------ */

Hooks.on("renderChatMessageHTML", (message, html) => {
  const flag = message.getFlag(MODULE_ID, "claimCheck");
  if ( !flag ) return;
  const btn = html.querySelector("[data-vmap-claim-roll]");
  if ( !btn ) return;
  const claim = getClaims(game.users.get(flag.userId)).find(c => c.id === flag.claimId);
  const canRoll = (flag.userId === game.user.id || game.user.isGM) && claim?.status === CLAIM_STATUS.check
    && claim?.messageId === message.id;
  if ( !canRoll ) {
    btn.disabled = true;
    if ( claim && claim.status !== CLAIM_STATUS.check ) btn.textContent = game.i18n.localize(`VMAP.ClaimStatus.${claim.status}`);
    return;
  }
  btn.addEventListener("click", ev => {
    ev.preventDefault();
    rollForClaim(message);
  });
});

Hooks.on("createChatMessage", message => onCheckMessage(message));
Hooks.on("updateChatMessage", (message, changes) => onCheckUpdated(message, changes));
