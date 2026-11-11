import { MODULE_ID } from "./constants.mjs";

const RELEASES = "https://api.github.com/repos/x4isfate/artarius/releases/latest";

/**
 * Tell the GM once per version that a newer Artarius is out. Foundry itself updates
 * modules from the setup screen; this only points there. Network errors stay silent.
 */
export async function checkForUpdate() {
  if ( !game.user.isGM || !game.settings.get(MODULE_ID, "checkUpdates") ) return;
  const current = game.modules.get(MODULE_ID)?.version;
  let latest;
  try {
    const res = await fetch(RELEASES, { headers: { Accept: "application/vnd.github+json" } });
    if ( !res.ok ) return;
    latest = String((await res.json())?.tag_name ?? "").replace(/^v/, "");
  } catch {
    return;
  }
  if ( !latest || !current || !foundry.utils.isNewerVersion(latest, current) ) return;
  if ( game.settings.get(MODULE_ID, "notifiedVersion") === latest ) return;
  await game.settings.set(MODULE_ID, "notifiedVersion", latest);
  ui.notifications.info(game.i18n.format("VMAP.Notify.updateAvailable", { current, latest }), { permanent: true });
}
