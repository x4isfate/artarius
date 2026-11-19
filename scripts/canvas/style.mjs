import { DEFAULT_STYLES } from "../constants.mjs";
import { catmullRom, meander, roundCorners } from "../geometry/geometry.mjs";

/** Итоговый вид элемента: умолчания вида, потом тип, потом свои правки. Без Foundry. */
export function resolveStyleOf(state, types) {
  const kind = state.system?.kind ?? "object";
  const type = types.find(t => t.id === state.system?.typeId);
  const style = { ...DEFAULT_STYLES[kind], ...(type?.style ?? {}), ...(state.system?.style ?? {}) };
  // До 0.3 размер метки был в пикселях; теперь это доля гекса.
  if ( kind === "object" && style.size > 2 ) style.size = DEFAULT_STYLES.object.size;
  return style;
}

/** Формы линии: прямые отрезки, ломаная со скруглёнными углами, плавная кривая. */
export const LINE_SHAPES = ["straight", "rounded", "curved"];
/** Узор линии: сплошная, штрих, точки. */
export const LINE_PATTERNS = ["solid", "dash", "dot"];

/** Точки, по которым рисуется линия, с учётом формы и излома (bend 0…1). */
export function lineCurve(points, style, seed = "") {
  const shape = LINE_SHAPES.includes(style.shape) ? style.shape : "curved";
  if ( shape === "straight" ) return points.slice();
  if ( shape === "rounded" ) return roundCorners(points, style.bend ?? 0.5);
  return catmullRom(meander(points, style.meander ?? 0, seed), 6);
}

/**
 * Штрих и промежуток в пикселях. Старые поля dash/gap важнее узора;
 * узор считает их от толщины: штрих — 3 толщины, точки — круглые точки через 2 толщины.
 */
export function lineDash(style, width) {
  if ( style.dash > 0 && style.gap > 0 ) return [style.dash, style.gap];
  if ( style.pattern === "dash" ) return [width * 3, width * 2];
  if ( style.pattern === "dot" ) return [0.01, width * 2];
  return [0, 0];
}
