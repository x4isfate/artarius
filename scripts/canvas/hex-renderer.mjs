/**
 * PIXI-рисование гекс-мира. Данные берёт из студии, сетку — из её backend.grid.
 * Три слоя перерисовки: основа (пустые гексы), данные (зоны, линии, метки)
 * и накладка (выделение, курсор, призраки, начатая линия).
 */
import { largestComponent, labelPath, placeLetters, fitFontSize } from "../geometry/label-path.mjs";
import { shapePoints, shapeOf } from "../data/mark-shape.mjs";
import { visibleZoneCells, boundaryEdges, labelCell, layerIdOf, lineLayerOf, zoneCells } from "../data/world.mjs";
import { COAST_DEFAULTS } from "../constants.mjs";
import { resolveStyleOf } from "./style.mjs";
import { isResourceType } from "../data/view.mjs";
import { isHidden } from "../data/access.mjs";
import { FIELD_IDS, RAMPS, ICE_TEMP, fieldAt, fieldsFit, rampColor } from "../data/fields.mjs";
import { layoutMarks, counterAt } from "../data/mark-layout.mjs";
import { catmullRom, meander, ribbon, dashPolyline, midpoint, roughPolygon, roughEdge } from "../geometry/geometry.mjs";
import { ATLAS_PAPER, ATLAS_INK, paperColor, paperTone, shadeColor, waterDistance, waterColor, glyphsFor, coastPairs, sharedEdge } from "./atlas.mjs";
import { lineCurve, lineDash } from "./style.mjs";

const color = c => {
  try { return foundry.utils.Color.from(c || "#ffffff").valueOf(); }
  catch { return 0xffffff; }
};

const flatV = vs => vs.flatMap(v => [v.x, v.y]);

function makeLabel(text, size, fill, font = null) {
  const PreciseText = foundry.canvas.containers.PreciseText;
  const opts = { fontSize: size, fill: color(fill), strokeThickness: Math.max(3, size / 5), stroke: 0x111111, fontWeight: "bold" };
  if ( font ) opts.fontFamily = font;
  const style = PreciseText.getTextStyle(opts);
  const t = new PreciseText(text ?? "", style);
  t.anchor.set(0.5, 0.5);
  return t;
}

/**
 * Отрезки параллельных линий направления dir с шагом step внутри выпуклого многоугольника ring.
 * Линии привязаны к началу координат, поэтому у соседних гексов они продолжают друг друга.
 */
export function hatchSegments(ring, dir, step) {
  const len = Math.hypot(dir[0], dir[1]) || 1;
  const d = [dir[0] / len, dir[1] / len];
  const n = [-d[1], d[0]];
  const proj = ring.map(([x, y]) => (x * n[0]) + (y * n[1]));
  const lo = Math.ceil(Math.min(...proj) / step), hi = Math.floor(Math.max(...proj) / step);
  const out = [];
  for ( let k = lo; k <= hi; k++ ) {
    const c = k * step;
    const hits = [];
    for ( let e = 0; e < ring.length; e++ ) {
      const a = ring[e], b = ring[(e + 1) % ring.length];
      const pa = proj[e] - c, pb = proj[(e + 1) % ring.length] - c;
      if ( (pa < 0) === (pb < 0) || pa === pb ) continue;
      const t = pa / (pa - pb);
      hits.push([a[0] + ((b[0] - a[0]) * t), a[1] + ((b[1] - a[1]) * t)]);
    }
    if ( hits.length >= 2 ) out.push([hits[0], hits[1]]);
  }
  return out;
}

const GHOST = { create: 0x5fcf6f, update: 0xe8c27a, delete: 0xff6a5a };

/** Направление ломаной в точке m (на ближайшем к ней отрезке), в радианах. */
function angleAt(line, m) {
  let best = 0, bd = Infinity;
  for ( let i = 1; i < line.length; i++ ) {
    const [a, b] = [line[i - 1], line[i]];
    const d = Math.hypot(((a[0] + b[0]) / 2) - m[0], ((a[1] + b[1]) / 2) - m[1]);
    if ( d < bd && (a[0] !== b[0] || a[1] !== b[1]) ) { bd = d; best = Math.atan2(b[1] - a[1], b[0] - a[0]); }
  }
  return best;
}

export default class HexRenderer {
  constructor(grid) {
    this.grid = grid;
    this.container = new PIXI.Container();
    this.base = this.container.addChild(new PIXI.Graphics());
    this.zones = this.container.addChild(new PIXI.Container());
    // Слои данных как в Azgaar (высота, климат, население, лёд) и сетка поверх зон.
    this.fieldLayer = this.container.addChild(new PIXI.Container());
    this.gridLines = this.container.addChild(new PIXI.Graphics());
    this.lines = this.container.addChild(new PIXI.Container());
    this.marks = this.container.addChild(new PIXI.Container());
    this.labels = this.container.addChild(new PIXI.Container());
    // Подписи по видам: порядок как раньше — зоны, линии, метки.
    this.zoneLabels = this.labels.addChild(new PIXI.Container());
    this.lineLabels = this.labels.addChild(new PIXI.Container());
    this.markLabels = this.labels.addChild(new PIXI.Container());
    // Координаты гексов, роза ветров, масштаб.
    this.decor = this.container.addChild(new PIXI.Container());
    this.ghosts = this.container.addChild(new PIXI.Graphics());
    this.overlay = this.container.addChild(new PIXI.Graphics());
    // Гекс под курсором: своя графика, чтобы движение мыши не перерисовывало выделение.
    this.cursor = this.container.addChild(new PIXI.Graphics());
    /**
     * Готовые фигуры по элементам: id → { key, objs }. Если ключ (вид и гексы элемента) не поменялся,
     * фигура и подписи берутся старые. Перерисовывается только то, что изменилось.
     */
    this._zoneCache = new Map();
    this._lineCache = new Map();
    this._markCache = new Map();
    this._terrain = null;
    /** Контейнеры слоёв (0.9.9): у каждого слоя своя прозрачность и размытие. id → Container. */
    this._zoneBoxes = new Map();
    this._lineBoxes = new Map();
    this._fields = null;
    this._decor = null;
    this._eph = [];
    // Метка, которую тащат мышью: рисуется целиком, со значком, поверх всего.
    this.dragMark = this.container.addChild(new PIXI.Container());
    this.eventMode = "none";
    this.container.eventMode = "none";
  }

  destroy() {
    this.container.destroy({ children: true });
    this._zoneCache.clear();
    this._lineCache.clear();
    this._markCache.clear();
  }

  /** Убрать фигуры из кэша и с карты насовсем. */
  _drop(objs) {
    for ( const o of objs ?? [] ) if ( o && !o.destroyed ) { o.parent?.removeChild(o); o.destroy({ children: true }); }
  }

  /**
   * Взять готовое из кэша по id или построить заново, если ключ другой.
   * build() → [[объект, контейнер], …]; объекты встают в свои контейнеры в порядке вызова.
   */
  _reuse(cache, id, key, build, used) {
    let e = cache.get(id);
    if ( !e || e.key !== key ) {
      if ( e ) this._drop(e.objs.map(([o]) => o));
      e = { key, objs: build().filter(([o]) => o) };
      cache.set(id, e);
    }
    used.add(id);
    for ( const [o, box] of e.objs ) box.addChild(o);
    return e;
  }

  _sweep(cache, used) {
    for ( const [id, e] of cache ) {
      if ( used.has(id) ) continue;
      this._drop(e.objs.map(([o]) => o));
      cache.delete(id);
    }
  }

  /**
   * Картинка карты для превью сцены: поле, зоны, линии, метки и подписи без выделения и наведения.
   * rect — прямоугольник сцены в координатах холста; maxSide — длинная сторона картинки в пикселях.
   * Возвращает data URL в webp.
   */
  async snapshot(pixiRenderer, rect, maxSide = 600) {
    const scale = maxSide / Math.max(rect.width, rect.height);
    const width = Math.max(1, Math.round(rect.width * scale)), height = Math.max(1, Math.round(rect.height * scale));
    const hide = [this.ghosts, this.overlay, this.cursor, this.dragMark];
    const was = hide.map(o => o.visible);
    for ( const o of hide ) o.visible = false;
    const rt = PIXI.RenderTexture.create({ width, height });
    try {
      const transform = new PIXI.Matrix(scale, 0, 0, scale, -rect.x * scale, -rect.y * scale);
      pixiRenderer.render(this.container, { renderTexture: rt, transform, clear: true });
      return await pixiRenderer.extract.base64(rt, "image/webp", 0.85);
    } finally {
      hide.forEach((o, n) => { o.visible = was[n]; });
      rt.destroy(true);
    }
  }

  /** Пустые гексы поля и сетка. */
  drawBase(world) {
    const g = this.base;
    g.clear();
    const cells = this.grid.allCells();
    const atlas = world.style !== "flat";
    g.beginFill(color(atlas ? ATLAS_PAPER.deep : world.baseColor), 1);
    for ( const c of cells ) g.drawPolygon(flatV(this.grid.vertices(c)));
    g.endFill();
    const lines = this.gridLines;
    lines.clear();
    if ( world.gridAlpha > 0 ) {
      // В атласе сетка тонкая, тушью поверх бумаги.
      if ( atlas ) lines.lineStyle({ width: 1, color: color(ATLAS_INK), alpha: Math.min(1, world.gridAlpha * 1.5) });
      else lines.lineStyle({ width: 1.5, color: color(world.gridColor), alpha: world.gridAlpha });
      for ( const c of cells ) lines.drawPolygon(flatV(this.grid.vertices(c)));
    }
  }

  _clear(container) {
    for ( const c of container.removeChildren() ) c.destroy({ children: true });
  }

  /** Зоны, линии, метки и подписи. Неизменившиеся элементы берутся из кэша. */
  drawData(states, types, layers, world = {}, view = {}, fields = null) {
    this.rough = !!world.rough;
    const show = { marks: true, resources: true, lines: true, rivers: true, labels: true, borders: true, grid: true, ...view };
    this.showBorders = show.borders;
    // Снять всё с карты без уничтожения: что не поменялось, вернётся на место из кэша.
    for ( const c of [this.zones, this.fieldLayer, this.lines, this.marks, this.zoneLabels, this.lineLabels, this.markLabels, this.decor] ) c.removeChildren();
    for ( const b of [...this._zoneBoxes.values(), ...this._lineBoxes.values()] ) b.removeChildren();
    this._drop(this._eph);
    this._eph = [];
    const hidden = new Set(layers.filter(l => l.visible === false).map(l => l.id));
    // Слои снизу вверх: у каждого свой контейнер с прозрачностью и размытием, их задаёт мастер.
    for ( const l of layers ) {
      if ( hidden.has(l.id) ) continue;
      this.zones.addChild(this._layerBox(this._zoneBoxes, l));
    }
    this.show = show;
    this.world = world;
    const order = new Map(layers.map((l, n) => [l.id, n]));
    const all = [...states.values()];
    const zones = all.filter(s => s.system.kind === "area" && !hidden.has(layerIdOf(s, types)))
      .sort((a, b) => ((order.get(layerIdOf(a, types)) ?? 99) - (order.get(layerIdOf(b, types)) ?? 99))
        || ((a.system.sort ?? 0) - (b.system.sort ?? 0)));
    const vis = visibleZoneCells(zones, types, layers);
    const inside = c => this.grid.inBounds(c);
    const sig = cells => cells.map(c => `${c[0]},${c[1]}`).join(";");
    this.atlas = world.style !== "flat";
    const usedZones = new Set();
    if ( this.atlas && !hidden.has("terrain") ) {
      const land = zones.filter(z => layerIdOf(z, types) === "terrain");
      const key = [this.rough, this.grid.radius, JSON.stringify(world.coast ?? null), ...land.map(z => `${z.system.typeId}|${resolveStyleOf(z, types).color}|${sig(vis.get(z.id) ?? [])}`)].join("#");
      if ( this._terrain?.key !== key ) {
        this._drop(this._terrain?.objs);
        const objs = this._drawAtlasTerrain(land, vis, types, { ...COAST_DEFAULTS, ...(world.coast ?? {}) });
        this._terrain = { key, objs, coast: objs[1] };
      }
      const tbox = this._zoneBoxes.get("terrain") ?? this.zones;
      for ( const o of this._terrain.objs ) tbox.addChild(o);
      if ( this._terrain.coast ) this._terrain.coast.visible = show.coast !== false;
      for ( const z of land ) {
        const style = resolveStyleOf(z, types);
        const cells = (vis.get(z.id) ?? []).filter(inside);
        if ( !cells.length || !(style.labelSize > 0) || !z.name ) continue;
        const k = `${z.name}|${JSON.stringify(style)}|${sig(cells)}`;
        this._reuse(this._zoneCache, `t:${z.id}`, k, () => [[this._zoneLabel(z, style, cells, "terrain"), this.zoneLabels]], usedZones);
      }
    } else if ( this._terrain ) {
      this._drop(this._terrain.objs);
      this._terrain = null;
    }
    for ( const z of zones ) {
      const layerId = layerIdOf(z, types);
      if ( this.atlas && layerId === "terrain" ) continue;
      const cells = (vis.get(z.id) ?? []).filter(inside);
      if ( !cells.length ) continue;
      const style = resolveStyleOf(z, types);
      const k = `${layerId}|${this.rough}|${this.showBorders}|${isHidden(z)}|${z.name}|${JSON.stringify(style)}|${sig(cells)}`;
      this._reuse(this._zoneCache, z.id, k, () => this._buildZone(z, cells, style, layerId), usedZones);
    }
    this._sweep(this._zoneCache, usedZones);
    this._drawFields(fields, show);
    const usedLines = new Set();
    const layerOf = new Map(layers.map(l => [l.id, l]));
    for ( const l of all.filter(s => s.system.kind === "line") ) {
      if ( !(isRiverLine(l, types) ? show.rivers : show.lines) ) continue;
      // Линия в слое прячется вместе со слоем и берёт его прозрачность (0.9.9).
      const lid = lineLayerOf(l, types);
      if ( lid && hidden.has(lid) ) continue;
      const box = lid && layerOf.has(lid) ? this._lineBox(layerOf.get(lid)) : this.lines;
      const style = resolveStyleOf(l, types);
      const k = JSON.stringify([l.name, l.system.geometry, style, isHidden(l), lid]);
      this._reuse(this._lineCache, l.id, k, () => this._buildLine(l, style, box), usedLines);
    }
    this._sweep(this._lineCache, usedLines);
    this._drawMarks(all.filter(s => s.system.kind === "object"
      && (isResourceType(s.system.typeId) ? show.resources : show.marks)), types);
    this.labels.visible = show.labels;
    this.gridLines.visible = show.grid;
    this._drawDecor(show, world);
  }

  /** Контейнер слоя: прозрачность и размытие из настроек слоя (0.9.9). */
  _layerBox(map, layer) {
    let box = map.get(layer.id);
    if ( !box || box.destroyed ) {
      box = new PIXI.Container();
      box.eventMode = "none";
      map.set(layer.id, box);
    }
    const alpha = Number.isFinite(Number(layer.opacity)) ? Math.max(0, Math.min(1, Number(layer.opacity))) : 1;
    box.alpha = alpha;
    const blur = Math.max(0, Number(layer.blur) || 0);
    if ( blur > 0 ) {
      const f = box.filters?.[0];
      if ( f?.blur !== blur ) box.filters = [Object.assign(new PIXI.BlurFilter(blur), { blur })];
    } else if ( box.filters ) box.filters = null;
    return box;
  }

  /** Контейнер линий слоя: та же прозрачность и размытие, что у зон слоя. */
  _lineBox(layer) {
    const box = this._layerBox(this._lineBoxes, layer);
    if ( box.parent !== this.lines ) this.lines.addChild(box);
    return box;
  }

  /** Координаты, роза ветров и линейка: перерисовываются, только когда их включили или выключили. */
  _drawDecor(show, world) {
    const key = [show.coords, show.windrose, show.scale, world.hexKm, world.distanceUnit, this.grid.radius, this.grid.allCells().length].join("|");
    if ( this._decor?.key !== key ) {
      this._drop(this._decor?.objs);
      const box = new PIXI.Container();
      const prev = this.decor;
      this.decor = box;
      try {
        if ( show.coords ) this._drawCoords();
        if ( show.windrose ) this._drawWindRose();
        if ( show.scale ) this._drawScale(world);
      } finally { this.decor = prev; }
      this._decor = { key, objs: [box] };
    }
    this.decor.addChild(this._decor.objs[0]);
  }

  /** Высота, температура, осадки, население и лёд: гексы красятся по шкале, как слои Azgaar. */
  _drawFields(fields, show) {
    const cells = this.grid.allCells();
    if ( !fields || !fieldsFit(fields, cells) ) return;
    const key = [show.heights, show.temp, show.prec, show.pop, show.ice, cells.length].join("|");
    if ( this._fields?.ref === fields && this._fields.key === key ) {
      for ( const o of this._fields.objs ) this.fieldLayer.addChild(o);
      return;
    }
    this._drop(this._fields?.objs);
    this._fields = { ref: fields, key, objs: [] };
    const add = this.fieldLayer.addChild.bind(this.fieldLayer);
    this.fieldLayer.addChild = o => { this._fields.objs.push(o); return add(o); };
    try { this._paintFields(fields, show, cells); }
    finally { delete this.fieldLayer.addChild; }
  }

  _paintFields(fields, show, cells) {
    const ALPHA = { height: 0.8, temp: 0.6, prec: 0.6, pop: 0.65 };
    const SHOW = { height: "heights", temp: "temp", prec: "prec", pop: "pop" };
    for ( const id of FIELD_IDS ) {
      if ( !show[SHOW[id]] ) continue;
      const g = new PIXI.Graphics();
      for ( const c of cells ) {
        const v = fieldAt(fields, id, c);
        if ( v === null ) continue;
        // Население моря и пустошей не красим, иначе всё поле фиолетовое.
        if ( id === "pop" && v <= 0 ) continue;
        g.beginFill(color(rampColor(RAMPS[id], v)), ALPHA[id]).drawPolygon(flatV(this.grid.vertices(c))).endFill();
      }
      this.fieldLayer.addChild(g);
    }
    if ( show.ice ) {
      const g = new PIXI.Graphics();
      const r = this.grid.radius;
      for ( const c of cells ) {
        const t = fieldAt(fields, "temp", c);
        if ( t === null || t > ICE_TEMP ) continue;
        g.beginFill(0xf4fbff, 0.78).drawPolygon(flatV(this.grid.vertices(c))).endFill();
        const { x, y } = this.grid.center(c);
        g.lineStyle({ width: Math.max(1, r / 30), color: 0x9cc7e0, alpha: 0.9 });
        g.moveTo(x - (r * 0.35), y - (r * 0.1)).lineTo(x + (r * 0.1), y - (r * 0.35));
        g.moveTo(x - (r * 0.1), y + (r * 0.35)).lineTo(x + (r * 0.35), y + (r * 0.1));
        g.lineStyle(0);
      }
      this.fieldLayer.addChild(g);
    }
  }

  /** Рамка поля в координатах холста. */
  _bounds() {
    const cells = this.grid.allCells();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for ( const c of cells ) {
      const { x, y } = this.grid.center(c);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    const r = this.grid.radius;
    return { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
  }

  /** Координаты гексов «ряд:столбец», как в «Перейти к гексу». На большом поле — у каждого пятого гекса. */
  _drawCoords() {
    const cells = this.grid.allCells();
    const step = cells.length > 3000 ? 5 : 1;
    const size = Math.max(8, Math.round(this.grid.radius * 0.3));
    for ( const [i, j] of cells ) {
      if ( step > 1 && (i % step || j % step) ) continue;
      const { x, y } = this.grid.center([i, j]);
      const t = makeLabel(`${i}:${j}`, size, "#f6efe2");
      t.alpha = 0.85;
      t.position.set(x, y - (this.grid.radius * 0.6));
      this.decor.addChild(t);
    }
  }

  /** Роза ветров в правом верхнем углу поля. */
  _drawWindRose() {
    const b = this._bounds();
    const R = Math.min(this.grid.radius * 2.4, (b.x1 - b.x0) * 0.06);
    const cx = b.x1 - (R * 1.5), cy = b.y0 + (R * 1.6);
    const g = new PIXI.Graphics();
    g.lineStyle({ width: Math.max(1, R / 40), color: 0x3a2d22, alpha: 0.9 });
    g.beginFill(0xf6efe2, 0.55).drawCircle(cx, cy, R * 0.72).endFill();
    for ( let n = 0; n < 8; n++ ) {
      const a = (n * Math.PI / 4) - (Math.PI / 2);
      const long = n % 2 === 0;
      const len = long ? R : R * 0.55, w = long ? R * 0.16 : R * 0.1;
      const tip = [cx + (Math.cos(a) * len), cy + (Math.sin(a) * len)];
      const l = [cx + (Math.cos(a - (Math.PI / 2)) * w), cy + (Math.sin(a - (Math.PI / 2)) * w)];
      const rr = [cx + (Math.cos(a + (Math.PI / 2)) * w), cy + (Math.sin(a + (Math.PI / 2)) * w)];
      g.beginFill(0x3a2d22, 0.95).drawPolygon([cx, cy, ...l, ...tip]).endFill();
      g.beginFill(0xf6efe2, 0.95).drawPolygon([cx, cy, ...rr, ...tip]).endFill();
    }
    this.decor.addChild(g);
    const t = makeLabel("N", Math.round(R * 0.32), "#f6efe2");
    t.position.set(cx, cy - R - (R * 0.22));
    this.decor.addChild(t);
  }

  /** Линейка масштаба в левом нижнем углу: пять гексов и сколько это километров (если известно). */
  _drawScale(world) {
    const b = this._bounds();
    const hexW = Math.sqrt(3) * this.grid.radius;
    const n = 5;
    const len = hexW * n;
    const x = b.x0 + (this.grid.radius * 1.5), y = b.y1 - (this.grid.radius * 1.4);
    const g = new PIXI.Graphics();
    const h = Math.max(4, this.grid.radius * 0.18);
    g.lineStyle({ width: Math.max(1, h / 4), color: 0x1a1410, alpha: 1 });
    for ( let k = 0; k < n; k++ ) {
      g.beginFill(k % 2 ? 0xf6efe2 : 0x1a1410, 0.95).drawRect(x + (k * hexW), y, hexW, h).endFill();
    }
    this.decor.addChild(g);
    const km = Number(world.hexKm);
    const text = km > 0 ? `${Math.round(km * n)} ${world.distanceUnit || "км"}` : `${n} гексов`;
    const t = makeLabel(text, Math.round(this.grid.radius * 0.42), "#f6efe2");
    t.position.set(x + (len / 2), y - (this.grid.radius * 0.35));
    this.decor.addChild(t);
  }

  /**
   * Местность в виде «Атлас»: бумажные цвета с неровным тоном, вода светлее у берега,
   * обводка берега тушью и значки рельефа. Всё в двух Graphics внизу слоя зон.
   */
  _drawAtlasTerrain(zones, vis, types, coastStyle = COAST_DEFAULTS) {
    const grid = this.grid, r = grid.radius;
    const key = c => `${c[0]},${c[1]}`;
    const typeOf = new Map(), ownColor = new Map();
    for ( const z of zones ) {
      const t = z.system.typeId;
      ownColor.set(t, resolveStyleOf(z, types).color);
      for ( const c of vis.get(z.id) ?? [] ) typeOf.set(key(c), t);
    }
    const terrainOf = k => typeOf.get(k);
    const inBounds = c => grid.inBounds(c);
    const cells = grid.allCells();
    const near = c => grid.neighbors(c);
    const dist = waterDistance(cells, near, terrainOf, { inBounds });
    const isWater = t => !t || t === "water";
    const amp = r * 0.3;
    const poly = c => (this.rough ? roughPolygon(grid.vertices(c), amp) : flatV(grid.vertices(c)));
    // Заливки по цвету: вода раньше суши, чтобы волнистый берег суши ложился поверх.
    const water = new Map(), land = new Map();
    for ( const c of cells ) {
      const k = key(c), t = typeOf.get(k), p = grid.center(c);
      const tone = paperTone(p.x, p.y, r);
      const wet = isWater(t);
      const col = wet ? shadeColor(waterColor(dist.get(k) ?? 9), 0.97 + ((tone - 0.96) * 0.5))
        : shadeColor(paperColor(t, ownColor.get(t)), tone);
      const bucket = wet ? water : land;
      if ( !bucket.has(col) ) bucket.set(col, []);
      bucket.get(col).push(c);
    }
    const g = new PIXI.Graphics();
    for ( const bucket of [water, land] ) {
      for ( const [col, list] of bucket ) {
        g.beginFill(color(col), 1);
        for ( const c of list ) g.drawPolygon(poly(c));
        g.endFill();
      }
    }
    const coast = this._drawCoast(cells, near, terrainOf, inBounds, coastStyle, amp);
    // Волнистые края крайних гексов не вылезают за поле.
    if ( this.rough ) {
      const mask = new PIXI.Graphics();
      mask.beginFill(0xffffff, 1);
      for ( const c of cells ) mask.drawPolygon(flatV(grid.vertices(c)));
      mask.endFill();
      g.addChild(mask);
      g.mask = mask;
    }
    const glyphs = new PIXI.Graphics();
    for ( const c of cells ) {
      const k = key(c), t = typeOf.get(k);
      const deep = isWater(t) && (dist.get(k) ?? 9) >= 3;
      for ( const gl of glyphsFor(t, grid.center(c), r, k, { deep }) ) this._drawGlyph(glyphs, gl, r);
    }
    if ( this.rough ) {
      const mask = new PIXI.Graphics();
      mask.beginFill(0xffffff, 1);
      for ( const c of cells ) mask.drawPolygon(flatV(grid.vertices(c)));
      mask.endFill();
      coast.addChild(mask);
      coast.mask = mask;
    }
    return [g, coast, glyphs];
  }

  /**
   * Береговая линия по рёбрам суши и воды (0.9.9): узор, цвет, толщина, прозрачность, размытие,
   * тень или подсветка и полоса мелководья. Пустой узор — как у поля: волна при неровных границах.
   */
  _drawCoast(cells, near, terrainOf, inBounds, st, amp) {
    const grid = this.grid, r = grid.radius;
    const g = new PIXI.Graphics();
    const pattern = st.pattern || (this.rough ? "rough" : "flat");
    // Волна без неровной заливки идёт ближе к ребру, иначе линия уходит от края суши.
    const wave = this.rough ? amp : r * 0.12;
    const edges = [];
    for ( const [a, b] of coastPairs(cells, near, terrainOf, inBounds) ) {
      const e = sharedEdge(grid.vertices(a), grid.vertices(b));
      if ( !e ) continue;
      const pts = pattern === "rough" ? [[e[0].x, e[0].y], ...roughEdge(e[0], e[1], wave), [e[1].x, e[1].y]] : [[e[0].x, e[0].y], [e[1].x, e[1].y]];
      // Нормаль к воде: от центра суши к центру воды.
      const ca = grid.center(a), cb = grid.center(b);
      const len = Math.hypot(cb.x - ca.x, cb.y - ca.y) || 1;
      edges.push({ pts, n: [(cb.x - ca.x) / len, (cb.y - ca.y) / len] });
    }
    const width = Math.max(1.5, r * 0.05) * (Number(st.width) > 0 ? Number(st.width) : 1);
    const alpha = Math.max(0, Math.min(1, Number(st.alpha ?? 0.85)));
    const col = color(st.color || ATLAS_INK);
    const stroke = (w, c, a, dx = 0, dy = 0, off = 0) => {
      g.lineStyle({ width: w, color: c, alpha: a, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
      for ( const { pts, n } of edges ) {
        const ox = dx + (n[0] * off), oy = dy + (n[1] * off);
        g.moveTo(pts[0][0] + ox, pts[0][1] + oy);
        for ( const [x, y] of pts.slice(1) ) g.lineTo(x + ox, y + oy);
      }
    };
    if ( st.shallow ) stroke(r * 0.22, color(ATLAS_PAPER.shallow), 0.75, 0, 0, r * 0.11);
    if ( st.filter === "shadow" ) stroke(width, 0x000000, alpha * 0.3, r * 0.03, r * 0.04);
    if ( st.filter === "glow" ) stroke(width * 3, 0xf6efe2, alpha * 0.5);
    stroke(width, col, alpha);
    if ( pattern === "double" ) stroke(width * 0.7, col, alpha * 0.45, 0, 0, r * 0.09);
    if ( pattern === "hatch" ) {
      // Штрихи к воде вдоль берега.
      g.lineStyle({ width: Math.max(1, width * 0.6), color: col, alpha: alpha * 0.6, cap: PIXI.LINE_CAP.ROUND });
      for ( const { pts, n } of edges ) {
        const [x0, y0] = pts[0], [x1, y1] = pts[pts.length - 1];
        for ( const t of [0.2, 0.5, 0.8] ) {
          const x = x0 + ((x1 - x0) * t), y = y0 + ((y1 - y0) * t);
          g.moveTo(x + (n[0] * r * 0.02), y + (n[1] * r * 0.02));
          g.lineTo(x + (n[0] * r * 0.12) - (n[1] * r * 0.04), y + (n[1] * r * 0.12) + (n[0] * r * 0.04));
        }
      }
    }
    g.lineStyle(0);
    const blur = Math.max(0, Number(st.blur) || 0);
    if ( blur > 0 ) g.filters = [new PIXI.BlurFilter(blur)];
    return g;
  }

  /** Один значок атласа. Формы — как в макете варианта «Атлас» и рисунках рельефа 0.9.9. */
  _drawGlyph(g, gl, r) {
    const { kind, x, y, s } = gl;
    const ink = color(ATLAS_INK), lw = Math.max(1, r * 0.035);
    const line = (alpha = 0.85, w = lw, c = ink) => g.lineStyle({ width: w, color: c, alpha, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
    const none = () => g.lineStyle(0);
    const poly = (pts, fill, alpha) => { none(); g.beginFill(fill, alpha); g.drawPolygon(pts.flat()); g.endFill(); };
    const path = pts => { g.moveTo(...pts[0]); for ( const p of pts.slice(1) ) g.lineTo(...p); };
    switch ( kind ) {
      case "mountain": {
        const hw = gl.hw ?? 1, top = gl.top ?? 0.75;
        const L = [x - (s * hw), y + (s * 0.55)], T = [x, y - (s * top)], R = [x + (s * hw), y + (s * 0.55)];
        poly([L, T, R], 0xffffff, 0.35);
        poly([T, R, [x + (s * 0.15), y + (s * 0.55)]], 0x8a7552, 0.55);
        line(0.9, lw * 1.2);
        path([L, T, R]);
        // Штрихи склона в тени.
        line(0.5, lw * 0.7);
        for ( const t of [0.35, 0.6] ) {
          const px = x + (s * t * 0.8 * hw), py = y - (s * top) + ((top + 0.55) * s * t);
          g.moveTo(px, py); g.lineTo(px - (s * 0.12), py + (s * 0.22));
        }
        if ( gl.cap ) {
          // Снежная шапка: верхняя треть склона светлая, с неровным краем.
          const p1 = [T[0] + (0.32 * (L[0] - T[0])), T[1] + (0.32 * (L[1] - T[1]))];
          const p2 = [T[0] + (0.32 * (R[0] - T[0])), T[1] + (0.32 * (R[1] - T[1]))];
          const capPts = [T, p2, [x + (0.1 * s), p2[1] - (0.02 * s)], [x - (0.02 * s), p1[1] + (0.1 * s)], [x - (0.16 * s), p1[1] - (0.03 * s)], p1];
          poly(capPts, 0xfbfaf4, 0.95);
          line(0.55, lw * 0.6);
          path(capPts.slice(1, -1));
        }
        break;
      }
      case "mountainRound": {
        const L = [x - s, y + (0.55 * s)], R = [x + s, y + (0.55 * s)], C = [x, y - (1.9 * s)];
        const q = t => [((1 - t) ** 2 * L[0]) + (2 * (1 - t) * t * C[0]) + (t * t * R[0]), ((1 - t) ** 2 * L[1]) + (2 * (1 - t) * t * C[1]) + (t * t * R[1])];
        const curve = Array.from({ length: 17 }, (_, i) => q(i / 16));
        const right = Array.from({ length: 9 }, (_, i) => q(0.5 + (i / 16)));
        poly(curve, 0xffffff, 0.35);
        poly([...right, [x + (0.2 * s), y + (0.55 * s)]], 0x8a7552, 0.5);
        line(0.9, lw * 1.2);
        path(curve);
        line(0.5, lw * 0.7);
        g.moveTo(x + (0.3 * s), y - (0.45 * s)); g.lineTo(x + (0.2 * s), y - (0.25 * s));
        break;
      }
      case "mountainTwin": {
        const L = [x - s, y + (0.55 * s)], T1 = [x - (0.35 * s), y - (0.6 * s)], S = [x + (0.02 * s), y - (0.2 * s)];
        const T2 = [x + (0.38 * s), y - (0.85 * s)], R = [x + (1.05 * s), y + (0.55 * s)];
        poly([L, T1, S, T2, R], 0xffffff, 0.35);
        poly([T2, R, [x + (0.5 * s), y + (0.55 * s)]], 0x8a7552, 0.55);
        poly([T1, S, [x - (0.15 * s), y + (0.55 * s)]], 0x8a7552, 0.4);
        line(0.9, lw * 1.2);
        path([L, T1, S, T2, R]);
        line(0.5, lw * 0.7);
        g.moveTo(x + (0.6 * s), y - (0.35 * s)); g.lineTo(x + (0.48 * s), y - (0.13 * s));
        break;
      }
      case "hill": {
        const R0 = s * (gl.R0 ?? 0.7), cy = y + (s * 0.4), a0 = Math.PI * (gl.a0 ?? 1.1), a1 = Math.PI * (gl.a1 ?? 1.9);
        if ( gl.shade ) {
          // Тень на правом склоне.
          const am = Math.PI * 1.5;
          const pts = [];
          for ( let k = 0; k <= 8; k++ ) { const a = am + ((a1 - am) * k / 8); pts.push([x + (Math.cos(a) * R0), cy + (Math.sin(a) * R0)]); }
          pts.push([x + (0.2 * s), cy + (Math.sin(a1) * R0) - (0.02 * s)], [x + (0.05 * s), cy - R0 + (0.25 * s)]);
          poly(pts, 0x8a7552, 0.3);
        }
        line(0.85, lw * 1.1);
        g.moveTo(x + (Math.cos(a0) * R0), cy + (Math.sin(a0) * R0));
        g.arc(x, cy, R0, a0, a1);
        break;
      }
      case "tree": case "palm": {
        if ( gl.shadow ) { none(); g.beginFill(ink, 0.14); g.drawEllipse(x + (0.25 * s), y + (0.9 * s), 0.6 * s, 0.16 * s); g.endFill(); }
        line(0.8);
        g.moveTo(x, y + (s * 0.3)); g.lineTo(x, y + (s * 0.9));
        g.beginFill(gl.color ?? (kind === "palm" ? 0x6c9061 : 0x7f9a5e), 1);
        g.drawCircle(x, y, s * 0.55);
        g.endFill();
        break;
      }
      case "birch": {
        line(0.85, lw * 1.6);
        g.moveTo(x, y + (0.2 * s)); g.lineTo(x, y + (0.95 * s));
        line(1, lw * 0.7, 0xf4f1e6);
        g.moveTo(x, y + (0.2 * s)); g.lineTo(x, y + (0.95 * s));
        line(0.85);
        g.beginFill(0xb9c98e, 1);
        g.drawEllipse(x, y - (0.05 * s), 0.3 * s, 0.52 * s);
        g.endFill();
        break;
      }
      case "conifer": {
        line(0.8);
        g.moveTo(x, y + (s * 0.5)); g.lineTo(x, y + (s * 0.9));
        const tiers = gl.tiers === 2 ? [[0.44, -0.15, 0.5], [0.32, -0.75, -0.05]] : [[0.4, -0.7, 0.5]];
        for ( const [w, top, bot] of tiers ) {
          g.beginFill(0x6f8a6a, 1);
          g.drawPolygon([x - (w * s), y + (bot * s), x, y + (top * s), x + (w * s), y + (bot * s)]);
          g.endFill();
        }
        if ( gl.snow ) {
          line(0.6, lw * 0.7);
          g.beginFill(0xfbfaf4, 1);
          g.drawPolygon([x - (0.15 * s), y - (0.25 * s), x, y - (0.7 * s), x + (0.15 * s), y - (0.25 * s)]);
          g.endFill();
        }
        break;
      }
      case "tuft": case "snow": {
        const k = s / 5;
        line(kind === "snow" ? 0.35 : 0.7);
        g.moveTo(x - (3 * k), y); g.lineTo(x - k, y - (4 * k));
        g.moveTo(x, y); g.lineTo(x, y - (5 * k));
        g.moveTo(x + (3 * k), y); g.lineTo(x + k, y - (4 * k));
        break;
      }
      case "dune": {
        if ( gl.shade ) {
          none();
          g.beginFill(0xb89b62, 0.35);
          g.moveTo(x - s, y); g.quadraticCurveTo(x, y - (s * 0.6), x + s, y); g.quadraticCurveTo(x + (0.3 * s), y + (0.05 * s), x - s, y);
          g.endFill();
        }
        line(0.7);
        g.moveTo(x - s, y); g.quadraticCurveTo(x, y - (s * 0.6), x + s, y);
        g.moveTo(x - (s * 0.5), y + (s * 0.35)); g.quadraticCurveTo(x, y + (s * 0.05), x + (s * 0.5), y + (s * 0.35));
        break;
      }
      case "cactus": {
        // Микрокактус: та же тушь, но почти прозрачная.
        line(gl.op ?? 0.3, lw * 0.9);
        g.moveTo(x, y); g.lineTo(x, y - s);
        g.moveTo(x, y - (0.5 * s)); g.lineTo(x - (0.3 * s), y - (0.5 * s)); g.lineTo(x - (0.3 * s), y - (0.78 * s));
        g.moveTo(x, y - (0.38 * s)); g.lineTo(x + (0.28 * s), y - (0.38 * s)); g.lineTo(x + (0.28 * s), y - (0.66 * s));
        break;
      }
      case "ripple": {
        // Рябь на песке: s — радиус гекса (или его доля).
        const k = s;
        line(0.45, lw * 0.9);
        g.moveTo(x, y);
        g.quadraticCurveTo(x + (0.07 * k), y - (0.05 * k), x + (0.14 * k), y);
        g.quadraticCurveTo(x + (0.21 * k), y + (0.05 * k), x + (0.28 * k), y);
        break;
      }
      case "stone": {
        const k = s;
        line(0.75, lw * 0.8);
        g.beginFill(0xb8a98a, 1);
        g.drawEllipse(x, y, 0.07 * k, 0.045 * k);
        g.endFill();
        break;
      }
      case "reed": {
        line(0.7);
        for ( const dx of [-0.3, 0, 0.3] ) { g.moveTo(x + (dx * s), y); g.lineTo(x + (dx * s * 1.4), y - (s * (dx ? 0.7 : 0.9))); }
        g.moveTo(x - (s * 0.6), y + (s * 0.15)); g.lineTo(x + (s * 0.6), y + (s * 0.15));
        break;
      }
      case "wave": {
        g.lineStyle({ width: lw, color: 0x3c5a6e, alpha: 0.55, cap: PIXI.LINE_CAP.ROUND });
        g.moveTo(x - s, y);
        g.quadraticCurveTo(x - (s / 2), y - (s / 2), x, y);
        g.quadraticCurveTo(x + (s / 2), y + (s / 2), x + s, y);
        break;
      }
    }
  }

  /** Заливка зоны и её подпись: [[фигура, контейнер], [подпись, контейнер]]. */
  _buildZone(state, cells, style, layerId) {
    const g = new PIXI.Graphics();
    if ( isHidden(state) ) g.alpha = 0.5;
    // Неровные границы только у местности: державы и области остаются ровно по гексам.
    const rough = this.rough && layerId === "terrain";
    const amp = this.grid.radius * 0.3;
    g.beginFill(color(style.color), style.alpha ?? 0.3);
    for ( const c of cells ) g.drawPolygon(rough ? roughPolygon(this.grid.vertices(c), amp) : flatV(this.grid.vertices(c)));
    g.endFill();
    if ( style.pattern && style.pattern !== "none" ) this._drawPattern(g, cells, style);
    if ( style.borderWidth > 0 && this.showBorders !== false ) {
      g.lineStyle({
        width: style.borderWidth, color: color(style.borderColor || style.color), alpha: style.borderAlpha ?? 0.95,
        cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND
      });
      for ( const [a, b] of boundaryEdges(cells, this.grid.vertices) ) {
        g.moveTo(a[0], a[1]);
        g.lineTo(b[0], b[1]);
      }
    }
    const label = style.labelSize > 0 && state.name ? this._zoneLabel(state, style, cells, layerId) : null;
    return [[g, this._zoneBoxes.get(layerId) ?? this.zones], [label, this.zoneLabels]];
  }

  /**
   * Подпись зоны. Державы по умолчанию подписаны изогнутой надписью вдоль зоны, как в Azgaar;
   * labelMode у типа или зоны: "curved", "straight" или "none". labelScale меняет размер.
   */
  _zoneLabel(state, style, cells, layerId) {
    const mode = style.labelMode ?? (layerId === "politics" ? "curved" : "straight");
    if ( mode === "none" ) return null;
    const scale = Number(style.labelScale) > 0 ? Number(style.labelScale) : 1;
    if ( mode === "curved" && this.grid.neighbors ) {
      const part = largestComponent(cells, c => this.grid.neighbors(c));
      const lp = part.length >= 3 ? labelPath(part.map(c => { const p = this.grid.center(c); return [p.x, p.y]; }), { bend: (style.labelBend ?? 1) * Math.min(1, part.length / 14) }) : null;
      if ( lp && lp.length > this.grid.radius * 2 ) {
        const size = fitFontSize(state.name, lp.length, { min: Math.max(10, style.labelSize * 0.7), max: style.labelSize * 3, scale });
        const box = new PIXI.Container();
        const letters = [...state.name].map(ch => makeLabel(ch, size, style.labelColor, style.labelFont));
        const spacing = size * 0.06;
        const widths = letters.map(t => Math.max(size * 0.25, t.width - (Math.max(3, size / 5) * 0.9)));
        const at = placeLetters(lp.path, widths, spacing);
        letters.forEach((t, i) => {
          t.position.set(at[i].x, at[i].y);
          t.rotation = at[i].angle;
          box.addChild(t);
        });
        return box;
      }
    }
    const p = this.grid.center(labelCell(cells, this.grid.center));
    const t = makeLabel(state.name, Math.round(style.labelSize * scale), style.labelColor, style.labelFont);
    t.position.set(p.x, p.y);
    return t;
  }

  /**
   * Штриховка зоны. Значки (крестики, точки) ставятся в каждый гекс,
   * линии считаются для каждого гекса отдельно и обрезаются его краями.
   */
  _drawPattern(g, cells, style) {
    const r = this.grid.radius;
    const col = color(style.patternColor || "#1a1a1a");
    const alpha = style.patternAlpha ?? 0.55;
    const width = Math.max(1.5, r / 22);
    g.lineStyle({ width, color: col, alpha, cap: PIXI.LINE_CAP.ROUND });
    const p = style.pattern;
    for ( const c of cells ) {
      const { x, y } = this.grid.center(c);
      if ( p === "cross" ) {
        const k = r * 0.16;
        for ( const [dx, dy] of [[-0.38, -0.2], [0.38, -0.2], [0, 0.42]] ) {
          const cx = x + (dx * r), cy = y + (dy * r);
          g.moveTo(cx - k, cy - k).lineTo(cx + k, cy + k).moveTo(cx - k, cy + k).lineTo(cx + k, cy - k);
        }
      } else if ( p === "dots" ) {
        g.lineStyle(0).beginFill(col, alpha);
        for ( const [dx, dy] of [[-0.42, -0.25], [0.42, -0.25], [0, 0], [-0.42, 0.25], [0.42, 0.25], [0, -0.5], [0, 0.5]] ) {
          g.drawCircle(x + (dx * r), y + (dy * r), width * 1.3);
        }
        g.endFill().lineStyle({ width, color: col, alpha, cap: PIXI.LINE_CAP.ROUND });
      } else {
        const ring = this.grid.vertices(c).map(v => [v.x, v.y]);
        const dirs = { hatch: [[1, -1]], crosshatch: [[1, -1], [1, 1]], vertical: [[0, 1]] }[p] ?? [];
        for ( const d of dirs ) {
          for ( const [a, b] of hatchSegments(ring, d, r * 0.42) ) g.moveTo(a[0], a[1]).lineTo(b[0], b[1]);
        }
      }
    }
    g.lineStyle(0);
  }

  /** Линия и её подписи: [[фигура, контейнер], [подпись, контейнер], …]. */
  _buildLine(state, style, box = this.lines) {
    const pts = state.system.geometry?.points ?? [];
    if ( pts.length < 2 ) return [];
    const curve = lineCurve(pts, style, state.id);
    const g = new PIXI.Graphics();
    if ( isHidden(state) ) g.alpha = 0.5;
    const out = [[g, box]];
    const w0 = style.widthStart ?? 3, w1 = style.widthEnd ?? 3;
    const wMax = Math.max(w0, w1);
    const alpha = style.alpha ?? 1;
    const [dash, gap] = lineDash(style, wMax);
    const stroke = (pts2, width, c) => {
      g.lineStyle({ width, color: c, alpha, join: PIXI.LINE_JOIN.ROUND, cap: PIXI.LINE_CAP.ROUND });
      g.moveTo(pts2[0][0], pts2[0][1]);
      for ( const p of pts2.slice(1) ) g.lineTo(p[0], p[1]);
    };
    if ( style.outlineWidth > 0 ) stroke(curve, wMax + (2 * style.outlineWidth), color(style.outlineColor));
    if ( dash > 0 && gap > 0 ) {
      // Точки — короткие штрихи с круглыми концами.
      for ( const part of dashPolyline(curve, dash, gap) ) if ( part.length >= 2 ) stroke(part, wMax, color(style.color));
    } else if ( w0 !== w1 ) {
      g.lineStyle(0);
      g.beginFill(color(style.color), alpha);
      g.drawPolygon(ribbon(curve, w0, w1).flat());
      g.endFill();
    } else stroke(curve, wMax, color(style.color));
    // Подпись (0.9.9): labelMode "none" — без подписи, "along" — вдоль линии, иначе прямо над серединой.
    const lmode = style.labelMode ?? "";
    const lsize = style.labelSize * (Number(style.labelScale) > 0 ? Number(style.labelScale) : 1);
    const place = (t, line, lift) => {
      const m = midpoint(line);
      if ( !m ) return false;
      t.position.set(m[0], m[1] - wMax - (lsize * lift));
      if ( lmode === "along" ) {
        const a = angleAt(line, m);
        // Текст не встаёт вверх ногами.
        t.rotation = a > Math.PI / 2 || a < -Math.PI / 2 ? a + Math.PI : a;
        t.position.set(m[0] + (Math.sin(t.rotation) * (wMax + (lsize * lift))), m[1] - (Math.cos(t.rotation) * (wMax + (lsize * lift))));
      }
      return true;
    };
    if ( lmode !== "none" && lsize > 0 && state.name ) {
      const t = makeLabel(state.name, lsize, style.labelColor, style.labelFont);
      if ( place(t, curve, 0.6) ) out.push([t, this.lineLabels]);
      else t.destroy();
    }
    // Подписи участков со своими названиями.
    if ( lmode !== "none" && lsize > 0 ) for ( const seg of state.system.geometry?.segments ?? [] ) {
      if ( !seg.name ) continue;
      const t = makeLabel(seg.name, lsize * 0.85, style.labelColor, style.labelFont);
      if ( place(t, pts.slice(seg.from, seg.to + 1), 0.5) ) out.push([t, this.lineLabels]);
      else t.destroy();
    }
    return out;
  }

  /**
   * Метки по гексам. Несколько меток в гексе ложатся группой (как в Civ 5),
   * сверху на гексе — счётчик. Подпись у группы одна: первой метки с именем.
   */
  _drawMarks(marks, types) {
    const styles = new Map(marks.map(m => [m.id, resolveStyleOf(m, types)]));
    const byId = new Map(marks.map(m => [m.id, m]));
    const { slots, cells } = layoutMarks(marks, this.grid, m => styles.get(m.id).size, m => styles.get(m.id).cells ?? 1);
    const labelled = new Set();
    const used = new Set();
    for ( const slot of slots ) {
      if ( slot.more ) { this._drawMore(slot); continue; }
      const m = byId.get(slot.id);
      const style = styles.get(slot.id);
      const label = !labelled.has(slot.key) && !!m.name && style.labelSize > 0 && style.labelMode !== "none";
      if ( label ) labelled.add(slot.key);
      // Подпись группы — под гексом, чтобы не лезть на соседние значки.
      const g = cells.get(slot.key);
      const below = slot.count > 1 ? { x: g.x, y: g.y + (this.grid.radius * 0.98) } : null;
      const at = label ? below : false;
      const k = JSON.stringify([slot.x, slot.y, slot.d, m.name, style, isHidden(m), at]);
      this._reuse(this._markCache, m.id, k, () => this._buildMark(m, style, slot, at), used);
    }
    this._sweep(this._markCache, used);
    for ( const group of cells.values() ) if ( group.count > 1 ) this._drawCounter(group);
  }

  /** Счётчик меток на гексе. */
  _drawCounter(group) {
    const { x, y, r } = counterAt(group, this.grid.radius);
    const g = new PIXI.Graphics();
    g.beginFill(0x1b1712, 0.95).lineStyle(Math.max(1.5, r / 5), 0xffcf8a, 1).drawCircle(x, y, r).endFill();
    this.marks.addChild(g);
    const t = makeLabel(String(group.count), Math.round(r * 1.35), "#ffe9c4");
    t.position.set(x, y);
    this.marks.addChild(t);
    this._eph.push(g, t);
  }

  /** Плашка «+N» на месте лишних меток. */
  _drawMore(slot) {
    const g = new PIXI.Graphics();
    g.beginFill(0x111111, 0.7).lineStyle(Math.max(2, slot.d / 22), 0xd9c7b0, 0.9).drawCircle(slot.x, slot.y, slot.d / 2).endFill();
    this.marks.addChild(g);
    const t = makeLabel(`+${slot.more}`, Math.round(slot.d * 0.38), "#f3e6d6");
    t.position.set(slot.x, slot.y);
    this.marks.addChild(t);
    this._eph.push(g, t);
  }

  /** Метка и её подпись: [[значок, контейнер], [подпись, контейнер]]. */
  _buildMark(state, style, slot, label = null) {
    const out = [];
    const prevM = this.marks, prevL = this.markLabels;
    const fake = arr => ({ addChild: o => { arr.push(o); return o; } });
    const icons = [], labels = [];
    this.marks = fake(icons);
    this.markLabels = fake(labels);
    try { this._drawMark(state, style, slot, label); }
    finally { this.marks = prevM; this.markLabels = prevL; }
    for ( const o of icons ) out.push([o, this.marks]);
    for ( const o of labels ) out.push([o, this.markLabels]);
    return out;
  }

  /** label: false — без подписи; null — под значком; { x, y } — место подписи группы. */
  _drawMark(state, style, slot, label = null) {
    const { x, y } = slot;
    const size = slot.d;
    const c = new PIXI.Container();
    c.position.set(x, y);
    // Скрытую метку мастер видит полупрозрачной, как скрытый токен.
    if ( isHidden(state) ) c.alpha = 0.5;
    const bg = new PIXI.Graphics();
    const shape = shapeOf(style);
    if ( shape !== "none" ) {
      bg.beginFill(0x111111, 0.62).lineStyle(Math.max(2, size / 22), color(style.color), 0.95);
      const pts = shapePoints(shape, size * 0.5);
      if ( pts ) bg.drawPolygon(pts.flat());
      else bg.drawCircle(0, 0, size * 0.5);
      bg.endFill();
    }
    c.addChild(bg);
    if ( style.emoji ) {
      // Эмодзи рисуется как текст своими цветами, без окраски цветом типа.
      const e = new PIXI.Text(style.emoji, { fontSize: Math.max(8, Math.round(size * 0.56)), fontFamily: "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif" });
      e.anchor.set(0.5);
      c.addChild(e);
    } else if ( style.icon ) {
      const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      sprite.anchor.set(0.5);
      // Значки библиотеки белые и красятся цветом типа; свою цветную картинку можно не красить.
      sprite.tint = style.tint === false ? 0xffffff : color(style.iconColor || style.color);
      c.addChild(sprite);
      const fit = tex => {
        if ( !tex || sprite.destroyed ) return;
        sprite.texture = tex;
        const k = (size * 0.66) / Math.max(tex.width, tex.height, 1);
        sprite.scale.set(k);
      };
      const cached = foundry.canvas.getTexture?.(style.icon);
      if ( cached ) fit(cached);
      else foundry.canvas.loadTexture(style.icon).then(fit).catch(() => {});
    }
    this.marks.addChild(c);
    if ( label !== false && state.name && style.labelSize > 0 && style.labelMode !== "none" ) {
      const lsize = Math.round(style.labelSize * (Number(style.labelScale) > 0 ? Number(style.labelScale) : 1));
      const t = makeLabel(state.name, lsize, style.labelColor, style.labelFont);
      if ( label ) t.position.set(label.x, label.y);
      else t.position.set(x, y + (size * 0.5) + (lsize * 0.75));
      this.markLabels.addChild(t);
    }
  }

  /** Метка под курсором при перетаскивании: та же подложка и тот же значок, что на карте. */
  _drawDragMark(studio, drag) {
    const box = this.dragMark;
    if ( !drag ) {
      if ( box.children.length ) box.removeChildren().forEach(c => c.destroy({ children: true }));
      this._dragId = null;
      return;
    }
    const grid = this.grid;
    if ( this._dragId !== drag.id ) {
      box.removeChildren().forEach(c => c.destroy({ children: true }));
      this._dragId = drag.id;
      const state = studio.stateOf(drag.id);
      if ( !state ) return;
      const style = resolveStyleOf(state, studio.types);
      const size = grid.radius * 2 * Math.min(style.size ?? 0.6, 0.8);
      const prev = this.marks;
      // _drawMark кладёт метку в this.marks; на время подменяем на контейнер перетаскивания.
      this.marks = box;
      try { this._drawMark(state, style, { x: 0, y: 0, d: size }, false); }
      finally { this.marks = prev; }
      box.alpha = 0.9;
    }
    box.position.set(drag.at.x, drag.at.y);
  }

  /** Гекс под курсором. Рисуется отдельно: движение мыши трогает только его. */
  drawCursor(studio) {
    const c = this.cursor;
    c.clear();
    if ( studio.hover && studio.tool && studio.tool !== "line" ) {
      c.beginFill(0xffffff, 0.12).lineStyle({ width: 2, color: 0xffffff, alpha: 0.6 })
        .drawPolygon(flatV(this.grid.vertices(studio.hover))).endFill().lineStyle(0);
    }
  }

  /** Выделение, курсор, осматриваемый гекс, начатая линия, призраки правок. */
  drawOverlay(studio) {
    const g = this.overlay;
    const grid = this.grid;
    g.clear();
    const gh = this.ghosts;
    gh.clear();
    for ( const { state, mode } of studio.ghosts() ) {
      const tint = GHOST[mode] ?? 0xffffff;
      const kind = state.system?.kind;
      if ( kind === "area" ) {
        const cells = zoneCells(state);
        gh.beginFill(tint, 0.12);
        for ( const c of cells ) gh.drawPolygon(flatV(grid.vertices(c)));
        gh.endFill();
        gh.lineStyle({ width: 4, color: tint, alpha: 0.95 });
        for ( const [a, b] of boundaryEdges(cells, grid.vertices) ) { gh.moveTo(a[0], a[1]); gh.lineTo(b[0], b[1]); }
        gh.lineStyle(0);
      } else if ( kind === "line" ) {
        const pts = state.system.geometry?.points ?? [];
        if ( pts.length >= 2 ) {
          gh.lineStyle({ width: 10, color: tint, alpha: 0.5, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
          gh.moveTo(pts[0][0], pts[0][1]);
          for ( const p of pts.slice(1) ) gh.lineTo(p[0], p[1]);
          gh.lineStyle(0);
        }
      } else if ( kind === "object" ) {
        const { x = 0, y = 0 } = state.system.geometry ?? {};
        gh.lineStyle({ width: 4, color: tint, alpha: 0.95 }).drawCircle(x, y, grid.radius * 0.5);
        gh.lineStyle(0);
      }
    }
    // Зона, в которую пойдут гексы. Граница считается один раз, пока зона не поменялась.
    if ( studio.tool === "zone" && studio.zone.target !== "new" ) {
      const z = studio.states.get(studio.zone.target);
      if ( z ) {
        const sig = JSON.stringify(z.system.geometry?.cells ?? []);
        if ( this._targetEdges?.id !== z.id || this._targetEdges.sig !== sig ) {
          this._targetEdges = { id: z.id, sig, edges: boundaryEdges(zoneCells(z), grid.vertices) };
        }
        g.lineStyle({ width: 3, color: 0xffffff, alpha: 0.85 });
        for ( const [a, b] of this._targetEdges.edges ) { g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
        g.lineStyle(0);
      }
    }
    if ( studio.selection.size ) {
      // Выделение: лёгкая заливка, чтобы цвет местности остался виден, и общая обводка по краю.
      const sel = [...studio.selection.values()];
      g.beginFill(0xfff0c8, 0.14);
      for ( const c of sel ) g.drawPolygon(flatV(grid.vertices(c)));
      g.endFill();
      g.lineStyle({ width: 2, color: 0xffe7a8, alpha: 0.45 });
      for ( const c of sel ) g.drawPolygon(flatV(grid.vertices(c)));
      g.lineStyle({ width: 4, color: 0xfff4d6, alpha: 0.95, join: PIXI.LINE_JOIN.ROUND });
      for ( const [a, b] of boundaryEdges(sel, grid.vertices) ) { g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
      g.lineStyle(0);
    }
    if ( studio.inspected && !studio.multi ) {
      // При осмотре нескольких гексов общая граница уже есть: толстая рамка одного гекса только мешает.
      g.lineStyle({ width: 5, color: 0xffffff, alpha: 1 }).drawPolygon(flatV(grid.vertices(studio.inspected))).lineStyle(0);
    }
    // Выбранные метки: светлое кольцо вокруг значка.
    if ( studio.markSel?.size ) {
      for ( const sl of studio.markSlots().slots ) {
        if ( !sl.id || !studio.markSel.has(sl.id) ) continue;
        g.lineStyle({ width: 3, color: 0xfff4d6, alpha: 0.95 }).drawCircle(sl.x, sl.y, sl.d / 2 + 4);
        g.lineStyle({ width: 1.5, color: 0x111111, alpha: 0.6 }).drawCircle(sl.x, sl.y, sl.d / 2 + 6.5);
      }
      g.lineStyle(0);
    }
    // Рамка выбора меток (Ctrl-протяжка).
    if ( studio.box ) {
      const b = studio.box;
      const x = Math.min(b.start.x, b.at.x), y = Math.min(b.start.y, b.at.y);
      g.beginFill(0xfff4d6, 0.08).lineStyle({ width: 2, color: 0xfff4d6, alpha: 0.9 })
        .drawRect(x, y, Math.abs(b.at.x - b.start.x), Math.abs(b.at.y - b.start.y)).endFill().lineStyle(0);
    }
    this.drawCursor(studio);
    // Метку тащат: куда ляжет и сама метка под курсором.
    const drag = studio.markDrag;
    if ( drag?.moved ) {
      const to = grid.cellAt(drag.at);
      const ok = grid.inBounds(to);
      if ( ok ) g.beginFill(0xffcf8a, 0.18).lineStyle({ width: 4, color: 0xffcf8a, alpha: 0.95 })
        .drawPolygon(flatV(grid.vertices(to))).endFill().lineStyle(0);
    }
    this._drawDragMark(studio, drag?.moved ? drag : null);
    const pts = studio.tool === "line" ? studio.line.points : [];
    if ( pts.length ) {
      g.lineStyle({ width: 4, color: 0xffe7a8, alpha: 0.95, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
      g.moveTo(pts[0][0], pts[0][1]);
      for ( const p of pts.slice(1) ) g.lineTo(p[0], p[1]);
      g.lineStyle({ width: 2, color: 0x111111 });
      for ( const [x, y] of pts ) g.beginFill(0xffffff).drawCircle(x, y, 7).endFill();
      g.lineStyle(0);
    }
  }
}

/** Река или ручей: тип «river» или тип с пометкой water. Остальные линии — пути. */
export function isRiverLine(state, types) {
  const id = state.system?.typeId;
  if ( id === "river" ) return true;
  return !!types?.find?.(t => t.id === id)?.water;
}
