/**
 * Замер скорости в поддельном Foundry: npm run perf.
 * Мир 60×40 из генератора, мазок кистью на 30 гексов, гекс в большую зону, повторная отрисовка.
 * Пределы заданы с запасом: тест ловит возврат старых тормозов (перерисовка всей карты на каждый гекс),
 * а не разницу между машинами.
 */
import * as F from "../foundry/stub.mjs";

const out = window.__perf = {};
const fails = window.__fails = [];
const budget = (name, value, max) => {
  out[name] = +value.toFixed(2);
  if ( !(value <= max) ) fails.push(`${name}: ${value.toFixed(1)} > ${max}`);
};

const lang = await (await fetch("../../lang/ru.json")).json();
await F.makeGame(lang);
const grid = F.makeGrid({ size: 100, rows: 40, cols: 60 });
const scene = new F.Scene({ _id: "sc1", name: "Мир", flags: { artarius: { world: { enabled: true } } } });
game.scenes.set(scene.id, scene);
F.makeCanvas(scene, grid);
await import("../../scripts/main.mjs");
const api = () => game.modules.get("artarius").api;
Hooks.callAll("init"); await F.settle();
Hooks.callAll("ready"); await F.settle();
const layer = new CONFIG.Canvas.layers.artarius.layerClass();
canvas.artarius = layer;
Hooks.callAll("canvasReady", canvas); await F.settle();
await layer.draw(); await F.settle();
await api().generateTestWorld({ seed: "perf", realmCount: 4, clear: true, water: 0.3, resources: 0.2, rough: true });
await F.settle();
await new Promise(r => setTimeout(r, 300));
const { runtime } = await import("../../scripts/canvas/hex-layer.mjs");
const atlas = api().getAtlas(scene);
out.pages = atlas.pages.size;

const C = {}, T = {};
const wrap = (obj, name) => {
  const f = obj[name];
  obj[name] = function(...a) {
    const t0 = performance.now();
    try { return f.apply(this, a); }
    finally { C[name] = (C[name] ?? 0) + 1; T[name] = (T[name] ?? 0) + performance.now() - t0; }
  };
};
const R = layer.renderer;
wrap(R, "drawData");
wrap(R, "drawOverlay");
wrap(runtime.ui, "render");
const reset = () => { for ( const k in C ) delete C[k]; for ( const k in T ) delete T[k]; };
let updBytes = 0;
const origUpd = atlas.updateEmbeddedDocuments.bind(atlas);
atlas.updateEmbeddedDocuments = (t, u, o) => { updBytes += JSON.stringify(u).length; return origUpd(t, u, o); };

const el = canvas.app.view;
const rect = el.getBoundingClientRect();
const scr = pt => { const g = canvas.stage.worldTransform.apply(new PIXI.Point(pt.x, pt.y)); return { clientX: rect.left + g.x, clientY: rect.top + g.y }; };
const base = { bubbles: true, cancelable: true, button: 0, pointerId: 1 };
const frame = () => new Promise(r => requestAnimationFrame(() => r()));
const s = api().studio;

// 1. Мазок кистью: 30 гексов, по движению на кадр, как у настоящей мыши.
s.setTool("zone", { toggle: false });
s.zone.paint = true;
s.zone.target = "new";
s.zone.typeId = s.types.find(t => t.kind === "area" && t.layerId !== "terrain")?.id ?? s.zone.typeId;
await F.settle(); await frame(); await frame();
reset();
const N = 30;
let busy = 0;
el.dispatchEvent(new PointerEvent("pointerdown", { ...base, ...scr(grid.hm.center([10, 5])) }));
for ( let k = 1; k <= N; k++ ) {
  el.dispatchEvent(new PointerEvent("pointermove", { ...base, buttons: 1, ...scr(grid.hm.center([10, 5 + k])) }));
  const t0 = performance.now();
  await frame();
  busy += performance.now() - t0;
}
out.strokeDrawData = C.drawData ?? 0;
out.strokePanels = C.render ?? 0;
if ( out.strokeDrawData ) fails.push(`карта перерисована во время мазка ${out.strokeDrawData} раз`);
if ( out.strokePanels ) fails.push(`окна перерисованы во время мазка ${out.strokePanels} раз`);
budget("strokeOverlayMsPerMove", (T.drawOverlay ?? 0) / Math.max(1, C.drawOverlay ?? 1), 8);

// 2. Кнопку отпустили: одна запись и одна перерисовка.
reset();
let t0 = performance.now();
el.dispatchEvent(new PointerEvent("pointerup", { ...base, ...scr(grid.hm.center([10, 5 + N])) }));
await F.settle(); await frame(); await frame();
budget("strokeCommitMs", performance.now() - t0, 250);
out.commitDrawData = C.drawData ?? 0;

// 3. Один гекс в самую большую зону: уходит только изменение.
const big = atlas.pages.contents.filter(p => p.system.kind === "area").sort((a, b) => b.system.geometry.cells.length - a.system.geometry.cells.length)[0];
out.bigZoneCells = big.system.geometry.cells.length;
s.zone.target = big.id;
reset(); updBytes = 0;
t0 = performance.now();
el.dispatchEvent(new PointerEvent("pointerdown", { ...base, ...scr(grid.hm.center([20, 20])) }));
el.dispatchEvent(new PointerEvent("pointerup", { ...base, ...scr(grid.hm.center([20, 20])) }));
await F.settle(); await frame(); await frame();
budget("oneHexMs", performance.now() - t0, 400);
// Страница целиком с именем, описанием и статусами весила бы больше: уходят только гексы и номер правки.
budget("oneHexBytes", updBytes, (out.bigZoneCells * 12) + 400);

// 4. Снимок данных и повторная отрисовка без изменений берутся из кэша.
const b = api().backend;
t0 = performance.now();
for ( let k = 0; k < 100; k++ ) b.states();
budget("statesMs", (performance.now() - t0) / 100, 0.5);
t0 = performance.now();
R.drawData(s.states, s.types, s.layers, b.world(), s.view(), b.fields?.());
budget("redrawSameMs", performance.now() - t0, 40);

// 5. Наведение: гекс под курсором без перерисовки выделения и окон.
s.setTool("select", { toggle: false });
await F.settle(); await frame(); await frame();
reset();
for ( let k = 0; k < 20; k++ ) {
  el.dispatchEvent(new PointerEvent("pointermove", { ...base, buttons: 0, ...scr(grid.hm.center([5, 3 + k])) }));
  await frame();
}
out.hoverOverlay = C.drawOverlay ?? 0;
out.hoverPanels = C.render ?? 0;
if ( out.hoverPanels ) fails.push(`окна перерисованы при наведении ${out.hoverPanels} раз`);
if ( out.hoverOverlay ) fails.push(`выделение перерисовано при наведении ${out.hoverOverlay} раз`);

// 6. Изменения карты в чате по умолчанию выключены.
if ( game.settings.get("artarius", "chatChanges") !== false ) fails.push("изменения карты в чате включены по умолчанию");
window.__done = true;
