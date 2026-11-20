/**
 * PIXI-рисование гекс-мира. Данные берёт из студии, сетку — из её backend.grid.
 * Три слоя перерисовки: основа (пустые гексы), данные (зоны, линии, метки)
 * и накладка (выделение, курсор, призраки, начатая линия).
 */
import { shapePoints, shapeOf } from "../data/mark-shape.mjs";
import { visibleZoneCells, boundaryEdges, labelCell, layerIdOf, zoneCells } from "../data/world.mjs";
import { resolveStyleOf } from "./style.mjs";
import { isResourceType } from "../data/view.mjs";
import { layoutMarks, counterAt } from "../data/mark-layout.mjs";
import { catmullRom, meander, ribbon, dashPolyline, midpoint, roughPolygon } from "../geometry/geometry.mjs";
import { lineCurve, lineDash } from "./style.mjs";

const color = c => {
  try { return foundry.utils.Color.from(c || "#ffffff").valueOf(); }
  catch { return 0xffffff; }
};

const flatV = vs => vs.flatMap(v => [v.x, v.y]);

function makeLabel(text, size, fill) {
  const PreciseText = foundry.canvas.containers.PreciseText;
  const style = PreciseText.getTextStyle({
    fontSize: size, fill: color(fill), strokeThickness: Math.max(3, size / 5), stroke: 0x111111, fontWeight: "bold"
  });
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

export default class HexRenderer {
  constructor(grid) {
    this.grid = grid;
    this.container = new PIXI.Container();
    this.base = this.container.addChild(new PIXI.Graphics());
    this.zones = this.container.addChild(new PIXI.Container());
    this.lines = this.container.addChild(new PIXI.Container());
    this.marks = this.container.addChild(new PIXI.Container());
    this.labels = this.container.addChild(new PIXI.Container());
    this.ghosts = this.container.addChild(new PIXI.Graphics());
    this.overlay = this.container.addChild(new PIXI.Graphics());
    // Метка, которую тащат мышью: рисуется целиком, со значком, поверх всего.
    this.dragMark = this.container.addChild(new PIXI.Container());
    this.eventMode = "none";
    this.container.eventMode = "none";
  }

  destroy() {
    this.container.destroy({ children: true });
  }

  /**
   * Картинка карты для превью сцены: поле, зоны, линии, метки и подписи без выделения и наведения.
   * rect — прямоугольник сцены в координатах холста; maxSide — длинная сторона картинки в пикселях.
   * Возвращает data URL в webp.
   */
  async snapshot(pixiRenderer, rect, maxSide = 600) {
    const scale = maxSide / Math.max(rect.width, rect.height);
    const width = Math.max(1, Math.round(rect.width * scale)), height = Math.max(1, Math.round(rect.height * scale));
    const hide = [this.ghosts, this.overlay, this.dragMark];
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
    g.beginFill(color(world.baseColor), 1);
    for ( const c of cells ) g.drawPolygon(flatV(this.grid.vertices(c)));
    g.endFill();
    if ( world.gridAlpha > 0 ) {
      g.lineStyle({ width: 1.5, color: color(world.gridColor), alpha: world.gridAlpha });
      for ( const c of cells ) g.drawPolygon(flatV(this.grid.vertices(c)));
    }
  }

  _clear(container) {
    for ( const c of container.removeChildren() ) c.destroy({ children: true });
  }

  /** Зоны, линии, метки и подписи. */
  drawData(states, types, layers, world = {}, view = {}) {
    this.rough = !!world.rough;
    const show = { marks: true, resources: true, lines: true, labels: true, ...view };
    for ( const c of [this.zones, this.lines, this.marks, this.labels] ) this._clear(c);
    const hidden = new Set(layers.filter(l => l.visible === false).map(l => l.id));
    const order = new Map(layers.map((l, n) => [l.id, n]));
    const all = [...states.values()];
    const zones = all.filter(s => s.system.kind === "area" && !hidden.has(layerIdOf(s, types)))
      .sort((a, b) => ((order.get(layerIdOf(a, types)) ?? 99) - (order.get(layerIdOf(b, types)) ?? 99))
        || ((a.system.sort ?? 0) - (b.system.sort ?? 0)));
    const vis = visibleZoneCells(zones, types, layers);
    const inside = c => this.grid.inBounds(c);
    for ( const z of zones ) {
      const cells = (vis.get(z.id) ?? []).filter(inside);
      this._drawZone(z, cells, resolveStyleOf(z, types), layerIdOf(z, types));
    }
    if ( show.lines ) for ( const l of all.filter(s => s.system.kind === "line") ) this._drawLine(l, resolveStyleOf(l, types));
    this._drawMarks(all.filter(s => s.system.kind === "object"
      && (isResourceType(s.system.typeId) ? show.resources : show.marks)), types);
    this.labels.visible = show.labels;
  }

  _drawZone(state, cells, style, layerId) {
    if ( !cells.length ) return;
    const g = new PIXI.Graphics();
    const solid = (style.alpha ?? 0.3) >= 1;
    // Неровные границы только у местности: державы и области остаются ровно по гексам.
    const rough = this.rough && layerId === "terrain";
    const amp = this.grid.radius * 0.3;
    g.beginFill(color(style.color), style.alpha ?? 0.3);
    for ( const c of cells ) g.drawPolygon(rough ? roughPolygon(this.grid.vertices(c), amp) : flatV(this.grid.vertices(c)));
    g.endFill();
    if ( solid ) {
      g.lineStyle({ width: 1, color: 0x000000, alpha: 0.18 });
      for ( const c of cells ) g.drawPolygon(flatV(this.grid.vertices(c)));
      g.lineStyle(0);
    }
    if ( style.pattern && style.pattern !== "none" ) this._drawPattern(g, cells, style);
    if ( style.borderWidth > 0 ) {
      g.lineStyle({
        width: style.borderWidth, color: color(style.borderColor || style.color), alpha: style.borderAlpha ?? 0.95,
        cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND
      });
      for ( const [a, b] of boundaryEdges(cells, this.grid.vertices) ) {
        g.moveTo(a[0], a[1]);
        g.lineTo(b[0], b[1]);
      }
    }
    this.zones.addChild(g);
    if ( style.labelSize > 0 && state.name ) {
      const p = this.grid.center(labelCell(cells, this.grid.center));
      const t = makeLabel(state.name, style.labelSize, style.labelColor);
      t.position.set(p.x, p.y);
      this.labels.addChild(t);
    }
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

  _drawLine(state, style) {
    const pts = state.system.geometry?.points ?? [];
    if ( pts.length < 2 ) return;
    const curve = lineCurve(pts, style, state.id);
    const g = new PIXI.Graphics();
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
    this.lines.addChild(g);
    if ( style.labelSize > 0 && state.name ) {
      const m = midpoint(curve);
      if ( m ) {
        const t = makeLabel(state.name, style.labelSize, style.labelColor);
        t.position.set(m[0], m[1] - wMax - style.labelSize * 0.6);
        this.labels.addChild(t);
      }
    }
    // Подписи участков со своими названиями.
    if ( style.labelSize > 0 ) for ( const seg of state.system.geometry?.segments ?? [] ) {
      const m = midpoint(pts.slice(seg.from, seg.to + 1));
      if ( !m || !seg.name ) continue;
      const t = makeLabel(seg.name, style.labelSize * 0.85, style.labelColor);
      t.position.set(m[0], m[1] - wMax - style.labelSize * 0.5);
      this.labels.addChild(t);
    }
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
    for ( const slot of slots ) {
      if ( slot.more ) { this._drawMore(slot); continue; }
      const m = byId.get(slot.id);
      const style = styles.get(slot.id);
      const label = !labelled.has(slot.key) && !!m.name && style.labelSize > 0;
      if ( label ) labelled.add(slot.key);
      // Подпись группы — под гексом, чтобы не лезть на соседние значки.
      const g = cells.get(slot.key);
      const below = slot.count > 1 ? { x: g.x, y: g.y + (this.grid.radius * 0.98) } : null;
      this._drawMark(m, style, slot, label ? below : false);
    }
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
  }

  /** Плашка «+N» на месте лишних меток. */
  _drawMore(slot) {
    const g = new PIXI.Graphics();
    g.beginFill(0x111111, 0.7).lineStyle(Math.max(2, slot.d / 22), 0xd9c7b0, 0.9).drawCircle(slot.x, slot.y, slot.d / 2).endFill();
    this.marks.addChild(g);
    const t = makeLabel(`+${slot.more}`, Math.round(slot.d * 0.38), "#f3e6d6");
    t.position.set(slot.x, slot.y);
    this.marks.addChild(t);
  }

  /** label: false — без подписи; null — под значком; { x, y } — место подписи группы. */
  _drawMark(state, style, slot, label = null) {
    const { x, y } = slot;
    const size = slot.d;
    const c = new PIXI.Container();
    c.position.set(x, y);
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
    if ( style.icon ) {
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
    if ( label !== false && state.name && style.labelSize > 0 ) {
      const t = makeLabel(state.name, style.labelSize, style.labelColor);
      if ( label ) t.position.set(label.x, label.y);
      else t.position.set(x, y + (size * 0.5) + (style.labelSize * 0.75));
      this.labels.addChild(t);
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
    // Зона, в которую пойдут гексы.
    if ( studio.tool === "zone" && studio.zone.target !== "new" ) {
      const z = studio.states.get(studio.zone.target);
      if ( z ) {
        g.lineStyle({ width: 3, color: 0xffffff, alpha: 0.85 });
        for ( const [a, b] of boundaryEdges(zoneCells(z), grid.vertices) ) { g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
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
    if ( studio.hover && studio.tool && studio.tool !== "line" ) {
      g.beginFill(0xffffff, 0.12).lineStyle({ width: 2, color: 0xffffff, alpha: 0.6 })
        .drawPolygon(flatV(grid.vertices(studio.hover))).endFill().lineStyle(0);
    }
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
