/**
 * Карта стенда на SVG. Повторяет то, что в игре рисует PIXI-слой:
 * базовые гексы, зоны по слоям, границы, линии, метки, выделение и призраки.
 */
import { shapePoints, shapeOf } from "../../scripts/data/mark-shape.mjs";
import { visibleZoneCells, boundaryEdges, labelCell, layerIdOf, zoneCells, cellKey } from "../../scripts/data/world.mjs";
import { resolveStyleOf } from "../../scripts/canvas/style.mjs";
import { catmullRom, meander } from "../../scripts/geometry/geometry.mjs";

const NS = "http://www.w3.org/2000/svg";
const poly = vs => vs.map(v => `${v.x.toFixed(1)},${v.y.toFixed(1)}`).join(" ");

export default class SvgView {
  constructor(studio, backend, svg) {
    this.studio = studio;
    this.backend = backend;
    this.svg = svg;
    const h = backend.hex;
    svg.setAttribute("viewBox", `-330 -50 ${h.width + 700} ${h.height + 100}`);
    svg.innerHTML = `<g class="base"></g><g class="zones"></g><g class="lines"></g><g class="marks"></g><g class="ghosts"></g><g class="over"></g>`;
    this.g = Object.fromEntries([...svg.children].map(el => [el.getAttribute("class"), el]));
    this.drawBase();
    studio.subscribe(what => what === "overlay" ? this.drawOverlay() : this.drawAll());
    this.drawAll();
    this.bind();
  }

  /** Точка сцены → пиксели окна (для панели на гексе). */
  project(pt) {
    const p = this.svg.createSVGPoint();
    p.x = pt.x; p.y = pt.y;
    const r = p.matrixTransform(this.svg.getScreenCTM());
    return { x: r.x, y: r.y };
  }

  pt(ev) {
    const p = this.svg.createSVGPoint();
    p.x = ev.clientX; p.y = ev.clientY;
    const m = this.svg.getScreenCTM().inverse();
    const r = p.matrixTransform(m);
    return { x: r.x, y: r.y };
  }

  bind() {
    this.svg.addEventListener("mousedown", ev => {
      if ( ev.button === 2 ) return;
      if ( !this.studio.tool && !ev.altKey ) return;
      this.studio.pointerDown(this.pt(ev), { shift: ev.shiftKey, alt: ev.altKey, ctrl: ev.ctrlKey });
    });
    this.svg.addEventListener("mousemove", ev => this.studio.pointerMove(this.pt(ev)));
    window.addEventListener("mouseup", () => this.studio.pointerUp());
    this.svg.addEventListener("contextmenu", ev => { ev.preventDefault(); this.studio.rightClick(); });
    this.svg.addEventListener("dblclick", () => { if ( this.studio.tool === "line" ) this.studio.finishLine(); });
    window.addEventListener("keydown", ev => {
      if ( ev.target.matches("input, textarea, select") ) return;
      if ( ev.key === "Escape" ) this.studio.dismiss();
      if ( ev.key === "Enter" && this.studio.tool === "line" ) this.studio.finishLine();
    });
  }

  el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for ( const [k, v] of Object.entries(attrs) ) e.setAttribute(k, v);
    parent?.appendChild(e);
    return e;
  }

  drawBase() {
    const grid = this.backend.grid;
    for ( const c of grid.allCells() ) {
      this.el("polygon", { points: poly(grid.vertices(c)), fill: "#24496b", stroke: "rgba(0,0,0,0.18)", "stroke-width": 1 }, this.g.base);
    }
  }

  drawAll() {
    const { grid } = this.backend;
    const states = this.studio.states;
    const types = this.studio.types;
    const layers = this.studio.layers;
    for ( const k of ["zones", "lines", "marks"] ) this.g[k].innerHTML = "";
    const hidden = new Set(layers.filter(l => l.visible === false).map(l => l.id));
    const order = new Map(layers.map((l, n) => [l.id, n]));
    const zones = [...states.values()].filter(s => s.system.kind === "area" && !hidden.has(layerIdOf(s, types)))
      .sort((a, b) => (order.get(layerIdOf(a, types)) ?? 99) - (order.get(layerIdOf(b, types)) ?? 99));
    const vis = visibleZoneCells(zones, types, layers);
    for ( const z of zones ) {
      const st = resolveStyleOf(z, types);
      const cells = vis.get(z.id) ?? [];
      const g = this.el("g", { "data-zone": z.id }, this.g.zones);
      for ( const c of cells ) this.el("polygon", { points: poly(grid.vertices(c)), fill: st.color, "fill-opacity": st.alpha, stroke: st.alpha >= 1 ? "rgba(0,0,0,0.18)" : "none" }, g);
      if ( st.borderWidth > 0 ) {
        for ( const [a, b] of boundaryEdges(cells, grid.vertices) ) {
          this.el("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: st.borderColor || st.color, "stroke-width": st.borderWidth, "stroke-linecap": "round", "stroke-opacity": st.borderAlpha }, g);
        }
      }
      if ( st.labelSize > 0 && z.name && cells.length ) {
        const p = grid.center(labelCell(cells, grid.center));
        this.el("text", { x: p.x, y: p.y, "font-size": st.labelSize * 0.6, class: "lbl" }, g).textContent = z.name;
      }
    }
    for ( const l of [...states.values()].filter(s => s.system.kind === "line") ) {
      const st = resolveStyleOf(l, types);
      const pts = l.system.geometry.points ?? [];
      if ( pts.length < 2 ) continue;
      const curve = catmullRom(meander(pts, st.meander ?? 0, l.id), 6);
      this.el("polyline", {
        points: curve.map(p => p.join(",")).join(" "), fill: "none", stroke: st.color,
        "stroke-width": Math.max(st.widthStart, st.widthEnd), "stroke-linecap": "round", "stroke-linejoin": "round",
        "stroke-dasharray": st.dash > 0 ? `${st.dash} ${st.gap}` : "", "data-line": l.id
      }, this.g.lines);
    }
    const r = grid.radius;
    // Метки раскладываются так же, как в игре: группа в гексе и счётчик.
    const { slots, cells } = this.studio.markSlots();
    for ( const slot of slots ) {
      if ( slot.more ) {
        const g = this.el("g", { "data-more": slot.key }, this.g.marks);
        this.el("circle", { cx: slot.x, cy: slot.y, r: slot.d / 2, fill: "rgba(17,17,17,0.7)", stroke: "#d9c7b0", "stroke-width": 2 }, g);
        this.el("text", { x: slot.x, y: slot.y + 4, "font-size": slot.d * 0.38, class: "lbl" }, g).textContent = `+${slot.more}`;
        continue;
      }
      const m = states.get(slot.id);
      const st = resolveStyleOf(m, types);
      const { x, y, d } = slot;
      const g = this.el("g", { "data-mark": m.id, "data-cell": slot.key }, this.g.marks);
      const pts = shapePoints(shapeOf(st), d / 2);
      if ( pts ) this.el("polygon", { points: pts.map(([px, py]) => `${x + px},${y + py}`).join(" "), fill: "rgba(17,17,17,0.6)", stroke: st.color, "stroke-width": 2, "data-shape": shapeOf(st) }, g);
      else if ( shapeOf(st) !== "none" ) this.el("circle", { cx: x, cy: y, r: d / 2, fill: "rgba(17,17,17,0.6)", stroke: st.color, "stroke-width": 2, "data-shape": "circle" }, g);
      this.el("text", { x, y: y + 4, "font-size": d * 0.45, class: "ico", fill: st.color }, g).textContent = (m.name || "?")[0];
      if ( m.name && slot.count === 1 ) this.el("text", { x, y: y + (d / 2) + 12, "font-size": 11, class: "lbl" }, g).textContent = m.name;
    }
    for ( const [key, c] of cells ) {
      if ( c.count < 2 ) continue;
      const g = this.el("g", { "data-count": key }, this.g.marks);
      this.el("circle", { cx: c.x, cy: c.y - (r * 0.68), r: Math.max(7, r * 0.17), fill: "#1b1712", stroke: "#ffcf8a", "stroke-width": 2 }, g);
      this.el("text", { x: c.x, y: c.y - (r * 0.68) + 4, "font-size": 11, class: "lbl" }, g).textContent = String(c.count);
    }
    this.drawOverlay();
  }

  drawOverlay() {
    const { grid } = this.backend;
    const s = this.studio;
    const o = this.g.over;
    o.innerHTML = "";
    this.g.ghosts.innerHTML = "";
    for ( const gh of s.ghosts() ) {
      const color = { create: "#5fcf6f", update: "#e8c27a", delete: "#ff6a5a" }[gh.mode];
      const st = gh.state;
      if ( st.system.kind === "area" ) {
        for ( const [a, b] of boundaryEdges(zoneCells(st), grid.vertices) ) {
          this.el("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: color, "stroke-width": 3, "stroke-dasharray": "6 4" }, this.g.ghosts);
        }
      } else if ( st.system.kind === "line" ) {
        this.el("polyline", { points: st.system.geometry.points.map(p => p.join(",")).join(" "), fill: "none", stroke: color, "stroke-width": 8, "stroke-opacity": 0.5 }, this.g.ghosts);
      } else {
        this.el("circle", { cx: st.system.geometry.x, cy: st.system.geometry.y, r: grid.radius * 0.55, fill: "none", stroke: color, "stroke-width": 3 }, this.g.ghosts);
      }
    }
    // Цель зоны подсвечивается, чтобы было видно, куда пойдут гексы.
    if ( s.tool === "zone" && s.zone.target !== "new" && s.states.has(s.zone.target) ) {
      for ( const [a, b] of boundaryEdges(zoneCells(s.states.get(s.zone.target)), grid.vertices) ) {
        this.el("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: "#fff", "stroke-width": 2, "stroke-dasharray": "3 3" }, o);
      }
    }
    for ( const c of s.selection.values() ) {
      this.el("polygon", { points: poly(grid.vertices(c)), fill: "rgba(255,240,200,0.28)", stroke: "#ffe7a8", "stroke-width": 2, class: "sel" }, o);
    }
    if ( s.inspected ) this.el("polygon", { points: poly(grid.vertices(s.inspected)), fill: "none", stroke: "#fff", "stroke-width": 3 }, o);
    if ( s.hover && s.tool ) this.el("polygon", { points: poly(grid.vertices(s.hover)), fill: "rgba(255,255,255,0.12)", stroke: "rgba(255,255,255,0.6)", "stroke-width": 1 }, o);
    if ( s.markDrag?.moved ) {
      const to = grid.cellAt(s.markDrag.at);
      if ( grid.inBounds(to) ) this.el("polygon", { points: poly(grid.vertices(to)), fill: "rgba(255,207,138,0.18)", stroke: "#ffcf8a", "stroke-width": 3, class: "drop" }, o);
      this.el("circle", { cx: s.markDrag.at.x, cy: s.markDrag.at.y, r: grid.radius * 0.36, fill: "rgba(17,17,17,0.55)", stroke: "#ffcf8a", "stroke-width": 3 }, o);
    }
    if ( s.tool === "line" && s.line.points.length ) {
      const pts = s.line.points;
      this.el("polyline", { points: pts.map(p => p.join(",")).join(" "), fill: "none", stroke: "#ffe7a8", "stroke-width": 3, "stroke-dasharray": "8 5" }, o);
      for ( const [x, y] of pts ) this.el("circle", { cx: x, cy: y, r: 5, fill: "#fff", stroke: "#111" }, o);
    }
  }
}

export { cellKey };
