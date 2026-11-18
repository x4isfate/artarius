/**
 * Размер гекс-поля в Foundry: перестроить сцену под cols × rows гексов размера size
 * и перенести на новое поле зоны, метки и линии атласа.
 */
import { MODULE_ID } from "../constants.mjs";
import { getAtlas, atlasStates, applyPlan } from "../data/store.mjs";
import { sceneSizeFor, dimsOf, normalizeDims, remapFeatures } from "../hex/dims.mjs";

/** Текущий размер поля сцены в гексах. */
export function sceneDims(scene = canvas.scene) {
  return dimsOf({ width: scene.width, height: scene.height, size: scene.grid?.size ?? 100 });
}

/** Дождаться перерисовки холста после правки сетки. */
function canvasRedrawn(timeout = 15000) {
  return new Promise(resolve => {
    const id = Hooks.once("canvasReady", () => { clearTimeout(t); resolve(true); });
    const t = setTimeout(() => { Hooks.off("canvasReady", id); resolve(false); }, timeout);
  });
}

/**
 * Перестроить сцену. Возвращает true, если размер поменялся.
 * Зоны и метки сдвигаются вместе с полем, линии растягиваются под новый размер гекса.
 */
export async function resizeWorld(scene, dims) {
  if ( !game.user.isGM || !scene ) return false;
  const next = normalizeDims(dims);
  const cur = sceneDims(scene);
  if ( next.cols === cur.cols && next.rows === cur.rows && next.size === cur.size ) return false;
  const grid = game.modules.get(MODULE_ID).api.backend.grid;
  const onCanvas = scene === canvas.scene;
  const before = onCanvas
    ? { rect: { ...canvas.dimensions.sceneRect }, size: canvas.grid.size, cells: grid.allCells() }
    : null;

  const { width, height } = sceneSizeFor(next);
  const redrawn = onCanvas ? canvasRedrawn() : null;
  await scene.update({ width, height, "grid.size": next.size });
  if ( !onCanvas ) return true;
  await redrawn;
  grid.reset();

  const atlas = getAtlas(scene);
  if ( !atlas || !before?.cells.length ) return true;
  const after = { rect: { ...canvas.dimensions.sceneRect }, size: canvas.grid.size, cells: grid.allCells() };
  const plan = remapFeatures(atlasStates(atlas), { before, after, center: grid.center, inBounds: grid.inBounds });
  for ( let i = 0; i < plan.update.length; i += 200 ) {
    await applyPlan(atlas, { create: [], update: plan.update.slice(i, i + 200), delete: [], skipped: [] });
  }
  if ( plan.delete.length ) await applyPlan(atlas, { create: [], update: [], delete: plan.delete, skipped: [] });
  return true;
}
