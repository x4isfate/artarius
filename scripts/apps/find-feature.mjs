import { MODULE_ID } from "../constants.mjs";

const L = k => game.i18n.localize(k);
const esc = s => foundry.utils.escapeHTML(String(s ?? ""));

/** Pick a feature by name: the camera moves to it and its sheet opens. */
export default async function findFeature() {
  const api = game.modules.get(MODULE_ID).api;
  const layer = api.layer();
  if ( !layer ) return ui.notifications.warn(L("VMAP.Notify.noAtlas"));
  const all = [...layer.currentStates().values()]
    .sort((a, b) => a.name.localeCompare(b.name));
  if ( !all.length ) return ui.notifications.info(L("VMAP.Quick.findEmpty"));
  const options = all.map(s => `<option value="${esc(s.id)}">${esc(s.name)} · ${esc(L(`VMAP.Kind.${s.system.kind}`))}</option>`).join("");
  const id = await foundry.applications.api.DialogV2.prompt({
    window: { title: "VMAP.Quick.find" },
    content: `<label class="vmap-dialog-field">${L("VMAP.Quick.findLabel")}
      <input type="search" name="q" placeholder="${esc(L("VMAP.Quick.findPlaceholder"))}" autofocus></label>
      <select name="id" size="10" style="width:100%">${options}</select>`,
    render: (event, dialog) => {
      const root = dialog.element ?? dialog;
      const q = root.querySelector("[name=q]");
      const sel = root.querySelector("[name=id]");
      if ( sel?.options.length ) sel.selectedIndex = 0;
      q?.addEventListener("input", () => {
        const needle = q.value.trim().toLowerCase();
        let first = null;
        for ( const o of sel.options ) {
          const hit = !needle || o.textContent.toLowerCase().includes(needle);
          o.hidden = !hit;
          if ( hit && !first ) first = o;
        }
        if ( first ) first.selected = true;
      });
    },
    ok: { label: "VMAP.Feature.pan", callback: (ev, button) => button.form.elements.id.value },
    rejectClose: false
  });
  if ( !id ) return;
  api.activateLayer("select");
  layer.panTo(id);
  api.openFeature(id);
}
