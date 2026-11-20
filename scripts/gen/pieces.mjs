/**
 * «Кусочки» генератора мира: формы суши, из которых собирается рельеф, рецепты миров
 * и нейтральные объекты. Чистый код без Foundry.
 *
 * Каждый кусочек — функция высоты в нормированных координатах поля (u, v ∈ 0…1, ax — ширина
 * к высоте). Генератор берёт случайный рецепт, кладёт его кусочки со случайными местом,
 * размером и поворотом, складывает высоты и добавляет мелкий шум. Так одинаковых миров не бывает,
 * а форма остаётся узнаваемой: материк, полуостров, архипелаг, хребет, внутреннее море.
 */

const TAU = Math.PI * 2;
const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - (2 * t)));
const between = (rnd, a, b) => a + (rnd() * (b - a));

/** Извилистый край: радиус пятна меняется по углу суммой синусов со случайными фазами. */
function wobble(rnd, amount) {
  const waves = [2, 3, 5, 7].map(f => ({ f, a: amount * between(rnd, 0.3, 1) / Math.sqrt(f), ph: rnd() * TAU }));
  return angle => 1 + waves.reduce((s, w) => s + (w.a * Math.sin((w.f * angle) + w.ph)), 0);
}

/** Пятно: эллипс с извилистым краем. amp > 0 поднимает сушу, < 0 копает море. */
export function blob({ cx, cy, rx, ry, rot = 0, amp = 1, edge = 0.35, wob = 0.25 }, rnd) {
  const w = wobble(rnd, wob);
  const c = Math.cos(rot), s = Math.sin(rot);
  return (u, v, ax) => {
    const dx = (u - cx) * ax, dy = v - cy;
    const x = ((dx * c) + (dy * s)) / rx, y = ((-dx * s) + (dy * c)) / ry;
    const r = Math.hypot(x, y) / w(Math.atan2(y, x));
    return amp * smooth((1 - r) / edge);
  };
}

/** Хребет: гребень вдоль отрезка, высота плавно гуляет по длине. */
export function ridge({ x0, y0, x1, y1, width, amp = 1 }, rnd) {
  const ph = rnd() * TAU, f = between(rnd, 2, 5);
  return (u, v, ax) => {
    const px = u * ax, py = v, ax0 = x0 * ax, ax1 = x1 * ax;
    const dx = ax1 - ax0, dy = y1 - y0;
    const len2 = (dx * dx) + (dy * dy) || 1;
    const t = Math.max(0, Math.min(1, (((px - ax0) * dx) + ((py - y0) * dy)) / len2));
    const d = Math.hypot(px - (ax0 + (t * dx)), py - (y0 + (t * dy)));
    const along = 0.65 + (0.35 * Math.sin((t * f * Math.PI) + ph));
    const ends = smooth(Math.min(t, 1 - t) / 0.15);
    return amp * along * ends * Math.exp(-((d / width) ** 2));
  };
}

/** База кусочков. Каждый ставится в точку (cx, cy) с размером k и поворотом rot. */
export const PIECES = {
  continent: { role: "land", name: "Материк", make: (p, rnd) => blob({ cx: p.cx, cy: p.cy, rx: 0.82 * p.k, ry: 0.46 * p.k, rot: p.rot, amp: 1, edge: 0.45, wob: 0.3 }, rnd) },
  subcontinent: { role: "land", name: "Большой остров", make: (p, rnd) => blob({ cx: p.cx, cy: p.cy, rx: 0.46 * p.k, ry: 0.3 * p.k, rot: p.rot, amp: 0.95, edge: 0.4, wob: 0.32 }, rnd) },
  peninsula: { role: "land", name: "Полуостров", make: (p, rnd) => blob({ cx: p.cx, cy: p.cy, rx: 0.42 * p.k, ry: 0.11 * p.k, rot: p.rot, amp: 0.85, edge: 0.5, wob: 0.2 }, rnd) },
  island: { role: "land", name: "Остров", make: (p, rnd) => blob({ cx: p.cx, cy: p.cy, rx: 0.13 * p.k, ry: 0.09 * p.k, rot: p.rot, amp: 0.9, edge: 0.6, wob: 0.35 }, rnd) },
  volcano: { role: "relief", name: "Вулканический остров", make: (p, rnd) => blob({ cx: p.cx, cy: p.cy, rx: 0.06 * p.k, ry: 0.06 * p.k, amp: 1.5, edge: 1, wob: 0.15 }, rnd) },
  ridge: {
    role: "relief",
    name: "Горный хребет",
    make: (p, rnd) => {
      const L = 0.2 * p.k;
      return ridge({ x0: p.cx - (Math.cos(p.rot) * L), y0: p.cy - (Math.sin(p.rot) * L), x1: p.cx + (Math.cos(p.rot) * L), y1: p.cy + (Math.sin(p.rot) * L), width: 0.035, amp: 0.75 }, rnd);
    }
  },
  plateau: { role: "relief", name: "Плоскогорье", make: (p, rnd) => blob({ cx: p.cx, cy: p.cy, rx: 0.2 * p.k, ry: 0.14 * p.k, rot: p.rot, amp: 0.35, edge: 0.2, wob: 0.2 }, rnd) },
  inlandSea: { role: "cut", name: "Внутреннее море", make: (p, rnd) => blob({ cx: p.cx, cy: p.cy, rx: 0.22 * p.k, ry: 0.14 * p.k, rot: p.rot, amp: -1.1, edge: 0.5, wob: 0.3 }, rnd) },
  bay: { role: "cut", name: "Залив", make: (p, rnd) => blob({ cx: p.cx, cy: p.cy, rx: 0.16 * p.k, ry: 0.05 * p.k, rot: p.rot, amp: -0.9, edge: 0.6, wob: 0.15 }, rnd) },
  lowland: { role: "cut", name: "Низина", make: (p, rnd) => blob({ cx: p.cx, cy: p.cy, rx: 0.18 * p.k, ry: 0.12 * p.k, rot: p.rot, amp: -0.18, edge: 0.6, wob: 0.25 }, rnd) }
};

/**
 * Рецепты миров: сколько каких кусочков и где. [кусочек, сколько от, до, где]:
 * где — "center" (ближе к середине), "edge" (у края материка), "any".
 */
export const RECIPES = [
  { id: "pangaea", name: "Один материк", parts: [["continent", 1, 1, "center"], ["peninsula", 1, 3, "edge"], ["ridge", 2, 3, "center"], ["bay", 1, 3, "edge"], ["island", 2, 5, "any"], ["lowland", 1, 2, "center"], ["plateau", 0, 1, "center"]] },
  { id: "twins", name: "Два материка", parts: [["subcontinent", 2, 2, "spread"], ["peninsula", 1, 2, "edge"], ["ridge", 2, 3, "center"], ["island", 3, 6, "any"], ["bay", 0, 2, "edge"], ["lowland", 1, 2, "center"]] },
  { id: "archipelago", name: "Архипелаг", parts: [["subcontinent", 1, 2, "spread"], ["island", 8, 14, "any"], ["volcano", 1, 3, "any"], ["ridge", 1, 2, "center"]] },
  { id: "ring", name: "Кольцо у внутреннего моря", parts: [["continent", 1, 1, "center"], ["inlandSea", 1, 1, "middle"], ["ridge", 2, 3, "center"], ["island", 2, 4, "any"], ["peninsula", 1, 2, "edge"]] },
  { id: "highlands", name: "Нагорья", parts: [["continent", 1, 1, "center"], ["plateau", 2, 3, "center"], ["ridge", 3, 4, "center"], ["bay", 1, 2, "edge"], ["island", 1, 3, "any"]] },
  { id: "broken", name: "Разорванный материк", parts: [["subcontinent", 3, 4, "spread"], ["peninsula", 1, 3, "edge"], ["ridge", 1, 3, "center"], ["island", 3, 6, "any"], ["volcano", 0, 2, "any"]] }
];

/** Разложить рецепт на кусочки с местом, размером и поворотом. */
export function layoutRecipe(recipe, rnd) {
  const out = [];
  const spreadPts = [];
  for ( const [id, from, to, where] of recipe.parts ) {
    const n = from + Math.floor(rnd() * ((to - from) + 1));
    for ( let i = 0; i < n; i++ ) {
      let cx, cy;
      if ( where === "middle" ) { cx = between(rnd, 0.45, 0.55); cy = between(rnd, 0.45, 0.55); }
      else if ( where === "center" ) { cx = between(rnd, 0.3, 0.7); cy = between(rnd, 0.3, 0.7); }
      else if ( where === "edge" ) {
        const a = rnd() * TAU, r = between(rnd, 0.22, 0.32);
        cx = 0.5 + (Math.cos(a) * r); cy = 0.5 + (Math.sin(a) * r * 0.8);
      } else if ( where === "spread" ) {
        // Крупные куски держатся подальше друг от друга.
        let best = null, bd = -1;
        for ( let t = 0; t < 12; t++ ) {
          const p = [between(rnd, 0.25, 0.75), between(rnd, 0.25, 0.75)];
          const d = spreadPts.length ? Math.min(...spreadPts.map(q => Math.hypot(q[0] - p[0], q[1] - p[1]))) : 1;
          if ( d > bd ) { bd = d; best = p; }
        }
        [cx, cy] = best;
        spreadPts.push(best);
      } else { cx = between(rnd, 0.12, 0.88); cy = between(rnd, 0.12, 0.88); }
      out.push({ id, cx, cy, k: between(rnd, 0.8, 1.25), rot: rnd() * TAU });
    }
  }
  return out;
}

/**
 * Высота поля из кусочков: функция (u, v) → число. Суша берётся по самому высокому куску
 * (материки не складываются в гору там, где перекрываются), рельеф добавляется сверху, моря вычитаются.
 */
export function piecesHeight(layout, ax, rnd) {
  const parts = layout.map(p => ({ role: PIECES[p.id].role, f: PIECES[p.id].make(p, rnd) }));
  const land = parts.filter(p => p.role === "land"), rest = parts.filter(p => p.role !== "land");
  return (u, v) => {
    let base = 0;
    for ( const p of land ) base = Math.max(base, p.f(u, v, ax));
    let add = 0;
    for ( const p of rest ) add += p.f(u, v, ax);
    return (base * 0.7) + add;
  };
}

/* ---------------------------------------------------------------- */
/*  Нейтральные объекты                                              */
/* ---------------------------------------------------------------- */

const ICON = name => `modules/artarius/assets/icons/${name}.svg`;
export const NEUTRAL_FOLDER = "Нейтральные объекты";

/**
 * Нейтральные объекты: где бывают и как называются. terrain — подходящая местность,
 * coast — только у моря. Типы меток заводятся в атласе при генерации.
 */
export const NEUTRAL_OBJECTS = [
  { id: "poi-ruins", name: "Руины", icon: "ancient-ruins", color: "#c9bfae", terrain: ["plains", "hills", "desert", "savanna", "forest"], names: ["Забытый город", "Руины старой крепости", "Обвалившаяся башня", "Мёртвый посёлок"] },
  { id: "poi-lair", name: "Логово", icon: "dragon-head", color: "#e06a4f", terrain: ["mountains", "hills", "snow"], names: ["Логово дракона", "Гнездо виверн", "Пещера тролля"] },
  { id: "poi-cave", name: "Пещера", icon: "cave-entrance", color: "#b5a58f", terrain: ["hills", "mountains", "taiga"], names: ["Глубокая пещера", "Кристальный грот", "Гномьи штольни"] },
  { id: "poi-grove", name: "Священная роща", icon: "tree-face", color: "#8fd07a", terrain: ["forest", "jungle", "taiga"], names: ["Древняя роща", "Дуб-великан", "Лес шёпотов"] },
  { id: "poi-stones", name: "Каменный круг", icon: "menhir", color: "#d8d0c0", terrain: ["plains", "tundra", "hills"], names: ["Каменный круг", "Стоячие камни", "Курган вождей"] },
  { id: "poi-oasis", name: "Оазис", icon: "oasis", color: "#7fd6c2", terrain: ["desert", "savanna"], names: ["Оазис", "Колодец караванщиков", "Пальмовая долина"] },
  { id: "poi-wreck", name: "Кораблекрушение", icon: "ship-wreck", color: "#9fc3e8", terrain: ["plains", "jungle", "mangrove", "desert", "savanna", "tundra", "forest"], coast: true, names: ["Разбитый корабль", "Мель утопленников", "Остов галеона"] },
  { id: "poi-swamp", name: "Топь", icon: "swamp", color: "#9db36b", terrain: ["swamp", "mangrove"], names: ["Гнилая топь", "Ведьмина трясина", "Туманная заводь"] },
  { id: "poi-temple", name: "Заброшенный храм", icon: "greek-temple", color: "#f0d78a", terrain: ["jungle", "savanna", "forest", "hills"], names: ["Храм в лианах", "Забытое святилище", "Алтарь без бога"] },
  { id: "poi-camp", name: "Стоянка кочевников", icon: "camping-tent", color: "#e0b780", terrain: ["savanna", "plains", "tundra", "desert"], names: ["Стойбище", "Кочевой лагерь", "Ярмарка у реки"] },
  { id: "poi-portal", name: "Портал", icon: "magic-portal", color: "#b98bd9", terrain: ["mountains", "forest", "desert", "snow", "tundra"], names: ["Врата бури", "Мерцающий портал", "Разлом"] }
];

/** Типы меток для нейтральных объектов, в своей папке. */
export const NEUTRAL_TYPES = NEUTRAL_OBJECTS.map(o => ({
  id: o.id, kind: "object", name: o.name, folder: NEUTRAL_FOLDER,
  style: { icon: ICON(o.icon), color: o.color, size: 0.5, labelSize: 14, shape: "diamond" }
}));
