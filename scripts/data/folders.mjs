/**
 * Папки типов и слоёв (0.9.9): у зон, меток, линий и слоёв одинаковые. Чистый код без Foundry.
 *
 * Папка атласа: { id, kind, name, color }. kind — area, object, line или layer.
 * У типа (и у слоя зон) поле folder — id папки. Старые типы меток хранили там название папки:
 * такая папка показывается как есть и становится настоящей, когда её переименуют или перекрасят.
 * Без папки элемент попадает в запасную группу: зоны — по своему слою, слои зон — в «Мир», метки и линии — в корень.
 */
import { FOLDER_COLORS } from "../constants.mjs";

/**
 * Разложить элементы по папкам. fallback(item) → { id, name, color, sort } или null (корень без заголовка).
 * Возвращает [{ id, name, color, virtual, legacy, items }]: корень первым, потом запасные группы, потом папки атласа.
 */
export function groupByFolders(kind, items, folders = [], fallback = () => null) {
  const real = folders.filter(f => f.kind === kind);
  const byId = new Map(real.map((f, n) => [f.id, { ...f, virtual: false, legacy: false, items: [], sort: 1000 + n }]));
  const extra = new Map();
  const root = { id: "", name: "", color: "", virtual: true, legacy: false, items: [], sort: -1 };
  for ( const it of items ) {
    const fid = String(it.folder ?? "");
    let f = fid ? byId.get(fid) : null;
    if ( !f && fid ) {
      // Папка из старых данных: в folder лежит её название.
      f = extra.get(`legacy:${fid}`);
      if ( !f ) extra.set(`legacy:${fid}`, f = { id: fid, name: fid, color: "", virtual: true, legacy: true, items: [], sort: 500 + extra.size });
    }
    if ( !f ) {
      const fb = fallback(it);
      if ( fb ) {
        f = extra.get(`fb:${fb.id}`);
        if ( !f ) extra.set(`fb:${fb.id}`, f = { id: fb.id, name: fb.name, color: fb.color ?? "", virtual: true, legacy: false, items: [], sort: fb.sort ?? 0 });
      } else f = root;
    }
    f.items.push(it);
  }
  return [root, ...extra.values(), ...byId.values()]
    .filter(f => f.items.length || !f.virtual)
    .sort((a, b) => a.sort - b.sort)
    .map(({ sort, ...f }) => f);
}

/** Цвет новой папки: первый из набора, которого ещё нет у папок этого вида. */
export function nextFolderColor(kind, folders = []) {
  const used = new Set(folders.filter(f => f.kind === kind).map(f => String(f.color ?? "").toLowerCase()));
  return FOLDER_COLORS.find(c => !used.has(c)) ?? FOLDER_COLORS[used.size % FOLDER_COLORS.length];
}

/**
 * Сделать запасную или старую папку настоящей: название и цвет теперь хранятся в атласе.
 * Возвращает { folder, moved }: moved — элементы, которым надо записать новый folder.
 */
export function materialize(kind, group, newId, patch = {}) {
  const id = group.legacy ? group.id : newId();
  const folder = { id, kind, name: group.name, color: group.color || FOLDER_COLORS[0], ...patch };
  const moved = group.items.filter(it => (it.folder ?? "") !== id);
  return { folder, moved };
}
