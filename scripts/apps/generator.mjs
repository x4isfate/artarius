/**
 * Генератор тестового мира в Foundry: окно с настройками и запись в атлас сцены.
 * Сам мир собирает чистый scripts/gen/mapgen.mjs.
 */
import { MODULE_ID, FEATURE_TYPE } from "../constants.mjs";
import { getAtlas, ensureAtlas, getAtlasTypes, getLayers, setTypes, setLayers, applyPlan } from "../data/store.mjs";
import { generateWorld, withResourceTypes, GEN_DEFAULTS } from "../gen/mapgen.mjs";
import { upgradedTypesAndLayers } from "../data/store.mjs";
import { esc } from "../ui/dom.mjs";
import { resizeWorld, sceneDims } from "./world-size.mjs";
import { worldOf } from "../foundry-backend.mjs";

const L = k => game.i18n.localize(k);
const players = () => game.users.filter(u => !u.isGM);

/** Окно настроек. Мастер выбирает, игроку кнопка не видна. */
export async function openGenerator() {
  if ( !game.user.isGM ) return ui.notifications.warn(L("ART.Gen.gmOnly"));
  const api = game.modules.get(MODULE_ID).api;
  if ( !api.isWorldScene() ) return ui.notifications.warn(L("VMAP.Azgaar.noScene"));
  const seed = Math.floor(Math.random() * 1e9).toString(36);
  // Без игроков тестовому миру всё равно нужны державы.
  const n = players().length || 3;
  const d = sceneDims(canvas.scene);
  const rough = worldOf(canvas.scene).rough || !canvas.scene.getFlag(MODULE_ID, "world")?.roughSet;
  const pct = v => Math.round(v * 100);
  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: L("ART.Gen.title"), icon: "fa-solid fa-mountain-sun" },
    position: { width: 420 },
    content: `<p class="hint">${esc(L("ART.Gen.hint"))}</p>
      <fieldset><legend>${esc(L("ART.World.size"))}</legend>
        <div class="form-group"><label>${esc(L("ART.Scene.cols"))}</label><div class="form-fields"><input type="number" name="cols" value="${d.cols}" min="5" max="300"></div></div>
        <div class="form-group"><label>${esc(L("ART.Scene.rows"))}</label><div class="form-fields"><input type="number" name="rows" value="${d.rows}" min="5" max="300"></div></div>
        <div class="form-group"><label>${esc(L("ART.Scene.size"))}</label><div class="form-fields"><input type="number" name="size" value="${d.size}" min="30" max="400" step="5"></div>
          <p class="hint">${esc(L("ART.Gen.sizeHint"))}</p></div>
      </fieldset>
      <div class="form-group"><label>${esc(L("ART.Gen.seed"))}</label><div class="form-fields"><input type="text" name="seed" value="${esc(seed)}"></div></div>
      <div class="form-group"><label>${esc(L("ART.Gen.water"))}</label><div class="form-fields"><input type="number" name="water" value="${pct(GEN_DEFAULTS.water)}" min="0" max="80" step="5"></div></div>
      <div class="form-group"><label>${esc(L("ART.Gen.mountains"))}</label><div class="form-fields"><input type="number" name="mountains" value="${pct(GEN_DEFAULTS.mountains)}" min="0" max="40" step="1"></div></div>
      <div class="form-group"><label>${esc(L("ART.Gen.resources"))}</label><div class="form-fields"><input type="number" name="resources" value="${pct(GEN_DEFAULTS.resources)}" min="0" max="60" step="1"></div></div>
      <div class="form-group"><label>${esc(L("ART.Gen.realms"))}</label><div class="form-fields"><input type="number" name="realms" value="${n}" min="0" max="12" step="1"></div>
        <p class="hint">${esc(L("ART.Gen.realmsHint"))}</p></div>
      <div class="form-group"><label>${esc(L("ART.World.rough"))}</label><div class="form-fields"><input type="checkbox" name="rough" ${rough ? "checked" : ""}></div>
        <p class="hint">${esc(L("ART.World.roughHint"))}</p></div>
      <div class="form-group"><label>${esc(L("ART.Gen.clear"))}</label><div class="form-fields"><input type="checkbox" name="clear" checked></div>
        <p class="hint">${esc(L("ART.Gen.clearHint"))}</p></div>`,
    ok: {
      label: L("ART.Gen.go"),
      icon: "fa-solid fa-wand-magic-sparkles",
      callback: (ev, button) => {
        const f = button.form.elements;
        const num = (el, max) => Math.max(0, Math.min(max, Number(el.value) || 0));
        return {
          seed: f.seed.value.trim() || seed,
          water: num(f.water, 80) / 100,
          mountains: num(f.mountains, 40) / 100,
          resources: num(f.resources, 60) / 100,
          realmCount: Math.round(num(f.realms, 12)),
          clear: f.clear.checked,
          rough: f.rough.checked,
          cols: Number(f.cols.value), rows: Number(f.rows.value), size: Number(f.size.value)
        };
      }
    },
    rejectClose: false
  });
  if ( !result ) return;
  const out = await generateTestWorld(result);
  if ( out ) ui.notifications.info(game.i18n.format("ART.Gen.done", { ...out.stats, seed: out.seed }));
  return out;
}

/**
 * Создать тестовый мир на текущей сцене. Есть в API для макросов.
 * options: { seed, water, mountains, resources, realmCount, realms?, clear, cols?, rows?, size?, rough? }.
 * cols, rows, size — размер поля: сцена перестраивается до генерации. rough — неровные берега.
 * realms — свои державы [{ name, color?, demiurge? }]; без них по державе на игрока.
 */
export async function generateTestWorld(options = {}) {
  if ( !game.user.isGM ) throw new Error(L("ART.Gen.gmOnly"));
  let scene = canvas.scene;
  // Сначала поле нужного размера: генератор заполняет всё, что есть на сцене.
  if ( options.cols || options.rows || options.size ) {
    const d = sceneDims(scene);
    await resizeWorld(scene, { cols: options.cols ?? d.cols, rows: options.rows ?? d.rows, size: options.size ?? d.size });
    scene = canvas.scene;
  }
  if ( options.rough !== undefined ) {
    await scene.update({ [`flags.${MODULE_ID}.world`]: { ...worldOf(scene), rough: !!options.rough, roughSet: true } });
  }
  const api = game.modules.get(MODULE_ID).api;
  const grid = api.backend.grid;
  const atlas = getAtlas(scene) ?? await ensureAtlas(scene);

  let realms = options.realms;
  if ( !realms ) {
    const count = options.realmCount ?? players().length;
    const ps = players();
    realms = Array.from({ length: count }, (_, n) => {
      const u = ps[n];
      return {
        name: u ? game.i18n.format("ART.Gen.realmOf", { name: u.name }) : game.i18n.format("ART.Gen.realmN", { n: n + 1 }),
        capital: game.i18n.format("ART.Gen.capitalN", { n: n + 1 }),
        color: u?.color?.css,
        demiurge: u?.character?.id ?? "",
        userId: u?.id ?? null
      };
    });
  }

  const built = generateWorld({
    cells: grid.allCells(), center: grid.center, neighbors: grid.neighbors, inBounds: grid.inBounds,
    seed: options.seed, water: options.water, mountains: options.mountains, resources: options.resources,
    realms, newId: () => foundry.utils.randomID()
  });

  // Типы: стартовый набор (местность, держава, город) и ресурсы.
  const upgraded = upgradedTypesAndLayers(getAtlasTypes(atlas), getLayers(atlas));
  await setTypes(atlas, withResourceTypes(upgraded.types));
  await setLayers(atlas, upgraded.layers);

  const old = atlas.pages.filter(p => p.type === FEATURE_TYPE && (options.clear || p._source.system?.ext?.artariusGen)).map(p => p.id);
  for ( let i = 0; i < old.length; i += 200 ) {
    await applyPlan(atlas, { create: [], update: [], delete: old.slice(i, i + 200), skipped: [] });
  }
  for ( let i = 0; i < built.features.length; i += 200 ) {
    await applyPlan(atlas, { create: built.features.slice(i, i + 200), update: [], delete: [], skipped: [] });
  }
  Hooks.callAll("artarius.generate", { scene, atlas, built, removed: old.length });
  return { ...built, removed: old.length };
}
