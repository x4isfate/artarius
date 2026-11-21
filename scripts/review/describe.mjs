/**
 * Описание правок словами: одна строка на правку и разница «было → стало» по полям.
 * Чистый код без Foundry: перевод и имена типов приходят снаружи.
 *
 * ctx = { t(key, data), typeName(id), layerName(id), actorName(id), userName(id) }
 */
import { changedFields, formatStatus } from "./ops.mjs";
import { demiurgesOf } from "../data/access.mjs";
import { zoneCells } from "../data/world.mjs";
import { KIND_TOOL } from "../constants.mjs";

const MAX_TEXT = 90;

/** HTML → короткий текст без тегов. */
export function plain(html, max = MAX_TEXT) {
  const s = String(html ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Короткое описание правки: «Зона «Лес»: +12 гекс.». */
export function describeOp(op, base, ctx) {
  const { t } = ctx;
  const before = base.get(op.id);
  const st = op.state ?? before;
  const kind = st?.system?.kind ?? "object";
  const what = t(`ART.Kind.${KIND_TOOL[kind] ?? "mark"}`);
  const name = st?.name || op.name || t("ART.Card.unnamed");
  if ( op.action === "delete" ) return t("ART.Op.delete", { what, name });
  if ( op.action === "create" || !before ) {
    const n = kind === "area" ? zoneCells(st).length : 0;
    return n ? t("ART.Op.createZone", { name, n }) : t("ART.Op.create", { what, name });
  }
  if ( kind === "area" ) {
    const d = zoneCells(st).length - zoneCells(before).length;
    if ( d ) return t(d > 0 ? "ART.Op.cellsPlus" : "ART.Op.cellsMinus", { name, n: Math.abs(d) });
  }
  const fields = changedFields(before, st).map(k => t(`ART.Diff.${k}`)).join(", ");
  return t("ART.Op.update", { what, name, fields: fields || "—" });
}

/** Значение поля элемента словами. */
function fieldText(key, s, ctx) {
  if ( !s ) return "";
  const { t, typeName = id => id, layerName = id => id, actorName = id => id, userName = id => id } = ctx;
  const sys = s.system ?? {};
  switch ( key ) {
    case "name": return s.name ?? "";
    case "text": return plain(s.text);
    case "type": return sys.typeId ? typeName(sys.typeId) : "";
    case "demiurge": return demiurgesOf(s).map(actorName).join(", ");
    case "statuses": return (sys.statuses ?? []).map(formatStatus).join(", ");
    case "aspects": return (sys.aspects ?? []).map(a => {
      const inner = (a.statuses ?? []).map(formatStatus).join(", ");
      return inner ? `${formatStatus(a)}: ${inner}` : formatStatus(a);
    }).join("; ");
    case "geometry": {
      const g = sys.geometry ?? {};
      if ( sys.kind === "area" ) return t("ART.Diff.cells", { n: zoneCells(s).length });
      if ( sys.kind === "line" ) return t("ART.Diff.points", { n: (g.points ?? []).length });
      return g.cell ? g.cell.join(":") : `${Math.round(g.x ?? 0)}, ${Math.round(g.y ?? 0)}`;
    }
    case "style": return Object.entries(sys.style ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ");
    case "layer": return sys.layerId ? layerName(sys.layerId) : "";
    case "links": return (sys.links ?? []).length ? t("ART.Diff.linksN", { n: sys.links.length }) : "";
    case "visibility": {
      const mode = sys.visibility?.mode ?? "all";
      const who = mode === "some" ? (sys.visibility?.users ?? []).map(userName).join(", ") : "";
      return who ? `${t(`ART.Vis.${mode}`)}: ${who}` : t(`ART.Vis.${mode}`);
    }
    default: return "";
  }
}

/**
 * Разница по полям: [{ key, label, before, after }]. У новой правки before пустой,
 * у удаления after пустой. Пустые с обеих сторон поля не попадают.
 */
export function diffOf(op, base, ctx) {
  const before = base.get(op.id) ?? null;
  const after = op.action === "delete" ? null : (op.state ?? null);
  const keys = op.action === "delete" ? changedFields(null, before) : changedFields(before, after);
  const rows = [];
  for ( const key of keys ) {
    const b = fieldText(key, before, ctx), a = fieldText(key, after, ctx);
    if ( !b && !a ) continue;
    if ( before && after && b === a ) continue;
    rows.push({ key, label: ctx.t(`ART.Diff.${key}`), before: b, after: a });
  }
  return rows;
}
