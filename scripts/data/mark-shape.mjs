/**
 * Формы подложки метки. Чистый код: точки многоугольника для холста и путь SVG для кнопок выбора.
 * circle — круг (как было до 0.8), none — без подложки, только значок.
 */
export const MARK_SHAPES = ["circle", "square", "diamond", "hexagon", "shield", "none"];

/** Точки многоугольника формы радиуса r вокруг (0, 0) или null для круга и «без подложки». */
export function shapePoints(shape, r) {
  switch ( shape ) {
    case "square": {
      const a = r * 0.86;
      return [[-a, -a], [a, -a], [a, a], [-a, a]];
    }
    case "diamond": return [[0, -r * 1.08], [r * 1.08, 0], [0, r * 1.08], [-r * 1.08, 0]];
    case "hexagon": return Array.from({ length: 6 }, (_, n) => {
      const t = (Math.PI / 3) * n;
      return [Math.cos(t) * r, Math.sin(t) * r];
    });
    case "shield": {
      // Щит: прямой верх, бока вниз и острый низ.
      const w = r * 0.9;
      return [[-w, -r * 0.9], [w, -r * 0.9], [w, r * 0.1], [w * 0.55, r * 0.62], [0, r * 1.02], [-w * 0.55, r * 0.62], [-w, r * 0.1]];
    }
    default: return null;
  }
}

/** Форма из стиля: незнакомое значение считается кругом. */
export function shapeOf(style) {
  return MARK_SHAPES.includes(style?.shape) ? style.shape : "circle";
}

/** Маленький образец формы для кнопки выбора (SVG 24×24). */
export function shapeSwatch(shape) {
  const pts = shapePoints(shape, 9);
  const body = shape === "none"
    ? '<circle cx="12" cy="12" r="9" fill="none" stroke-dasharray="3 3"/>'
    : pts ? `<polygon points="${pts.map(([x, y]) => `${(x + 12).toFixed(1)},${(y + 12).toFixed(1)}`).join(" ")}"/>`
      : '<circle cx="12" cy="12" r="9"/>';
  return `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" class="art-shape-sw">${body}</svg>`;
}
