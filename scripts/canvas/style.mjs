import { DEFAULT_STYLES } from "../constants.mjs";

/** Итоговый вид элемента: умолчания вида, потом тип, потом свои правки. Без Foundry. */
export function resolveStyleOf(state, types) {
  const kind = state.system?.kind ?? "object";
  const type = types.find(t => t.id === state.system?.typeId);
  const style = { ...DEFAULT_STYLES[kind], ...(type?.style ?? {}), ...(state.system?.style ?? {}) };
  // До 0.3 размер метки был в пикселях; теперь это доля гекса.
  if ( kind === "object" && style.size > 2 ) style.size = DEFAULT_STYLES.object.size;
  return style;
}
