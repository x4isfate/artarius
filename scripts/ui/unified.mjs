/**
 * Единый интерфейс 0.9.9: окна «Зоны», «Метки», «Линии», «Слои» и «Аспекты» устроены одинаково.
 * Сверху поиск и счётчик, слева «Новый тип», «Папка» и папки с плитками, справа выбранный тип:
 * что его на карте, форма нового элемента с аспектами и подписью, кнопка действия внизу.
 * Здесь же быстрый осмотр гекса (вариант 7А «Плашка»), сжатая карточка и полоса режимов.
 *
 * Методы примешиваются к ArtariusUI (см. конец panels.mjs). Кнопки — через data-action,
 * обработчики в unifiedActions(); tools/check-buttons.mjs сверяет их с разметкой.
 */
import { esc, icon, htmlToText } from "./dom.mjs";
import { colorField, iconImg } from "./panels.mjs";
import { zoneCells, layerIdOf, lineLayerOf, markCell } from "../data/world.mjs";
import { VIEW_PART_DEFS, isShown } from "../data/view.mjs";
import { hasField } from "../data/fields.mjs";
import { FOLDER_COLORS, COAST_DEFAULTS } from "../constants.mjs";
import { ASPECT_ICONS, searchItems, stepsLabel, statusIdsOf, aspectsWith, isImageIcon, hasEntryLike } from "../data/aspects.mjs";
import { statusIcon } from "../data/statuses.mjs";

/** Полоса режимов внизу: порядок и клавиши 1–6 (0.9.9). */
export const MODE_DEFS = [
  { id: "select", icon: "arrow-pointer", key: "1" },
  { id: "zones", icon: "draw-polygon", key: "2" },
  { id: "marks", icon: "location-dot", key: "3" },
  { id: "lines", icon: "route", key: "4" },
  { id: "players", icon: "scroll", key: "5" },
  { id: "layers", icon: "layer-group", key: "6" }
];

const SLOT = { area: "zone", object: "mark", line: "line" };
const TOOL_ICON = { area: "draw-polygon", object: "location-dot", line: "route" };
/** Разделы окна слоёв для видов карты (не слоёв зон). */
const VIEW_GROUPS = ["objects", "lines", "map", "data"];
const VIEW_FIELD = { "@heights": "height", "@temp": "temp", "@prec": "prec", "@pop": "pop", "@ice": "temp" };
const COAST_PATTERNS = ["flat", "rough", "double", "hatch"];
/** Сколько строк «На карте» видно без прокрутки. */
const ON_MAP_MAX = 400;

/** Подсветить найденное в названии. */
function mark(text, q) {
  const s = String(text ?? "");
  const f = String(q ?? "").trim().toLowerCase();
  const n = f ? s.toLowerCase().indexOf(f) : -1;
  if ( n < 0 ) return esc(s);
  return `${esc(s.slice(0, n))}<mark>${esc(s.slice(n, n + f.length))}</mark>${esc(s.slice(n + f.length))}`;
}

/** Образец берега для плитки стиля (SVG). */
export function coastSwatch(kind, color = "#1f3846", w = 72, h = 40) {
  const base = "M0,26 C10,18 16,30 26,22 S44,12 52,20 S66,30 72,22";
  const flat = "M0,24 C14,22 28,24 40,22 S62,22 72,22";
  const d = kind === "flat" ? flat : base;
  const line = `<path d="${d}" fill="none" stroke="${esc(color)}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`;
  const extra = kind === "double"
    ? `<path d="${d}" transform="translate(0,-5)" fill="none" stroke="${esc(color)}" stroke-opacity=".45" stroke-width="1.1" vector-effect="non-scaling-stroke"/>`
    : kind === "hatch"
      ? [[6, 22], [14, 21], [22, 22], [32, 19], [40, 16], [48, 17], [58, 22], [66, 24]].map(([x, y]) => `<path d="M${x},${y} l-2,-4" stroke="${esc(color)}" stroke-opacity=".55" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join("")
      : "";
  return `<svg width="${w}" height="${h}" viewBox="0 0 72 40" preserveAspectRatio="none" aria-hidden="true"><rect width="72" height="40" fill="#a9c6d3"/>`
    + `<path d="${d} L72,40 L0,40 Z" fill="#cfd39a"/>${line}${extra}</svg>`;
}

export const UnifiedUI = {

  /* ---------------------------------------------------------------- */
  /*  Общие куски окна                                                 */
  /* ---------------------------------------------------------------- */

  /** Поиск сверху и счётчик справа от него. */
  uStrip(model, value, placeholder, pill) {
    return `<div class="art-ustrip"><input type="search" class="art-search" data-model="${model}" data-key="${model}" value="${esc(value ?? "")}" placeholder="${esc(placeholder)}">
      ${pill ? `<span class="art-spill">${pill}</span>` : ""}</div>`;
  },

  /** «Новый тип» и «Папка» над папками. */
  uNewbar(kind, { action = "newType", label = "ART.Type.new", canNew = true } = {}) {
    const canFolder = this.studio.canFolders(kind);
    return `<div class="art-newbar">
      <button type="button" class="art-btn" data-action="${action}" data-kind="${kind}" ${canNew ? "" : "disabled"}>${icon("plus")} ${esc(this.t(label))}</button>
      <button type="button" class="art-btn" data-action="newFolder" data-kind="${kind}" ${canFolder ? "" : "disabled"}
        title="${esc(this.t(canFolder ? "ART.Folder.new" : "ART.Folder.gmOnly"))}">${icon("folder-plus")} ${esc(this.t("ART.Folder.one"))}</button></div>`;
  },

  /** Шапка папки: стрелка, цвет, название, число, «⋮». Меню папки раскрывается под шапкой. */
  uFolderHead(kind, g, open) {
    const s = this.studio;
    const menuOn = s.folderMenu?.kind === kind && s.folderMenu?.id === g.id;
    const canMenu = s.canFolders(kind);
    const head = `<div class="art-fh${menuOn ? " hov" : ""}" style="--c:${esc(g.color || "#777")}">
      <button type="button" class="art-fh-fold" data-action="folderFold" data-kind="${kind}" data-id="${esc(g.id)}" aria-expanded="${open}">
        ${icon(open ? "chevron-down" : "chevron-right")}<i class="art-fd"></i><span class="art-fh-name">${esc(g.name)}</span> <span class="art-cnt">${g.items.length}</span></button>
      ${canMenu ? `<button type="button" class="art-icon-btn art-fh-menu${menuOn ? " active" : ""}" data-action="folderMenu" data-kind="${kind}" data-id="${esc(g.id)}"
        title="${esc(this.t("ART.Folder.menu"))}" aria-label="${esc(this.t("ART.Folder.menu"))}">${icon("ellipsis-vertical")}</button>` : ""}</div>`;
    if ( !menuOn ) return head;
    const color = g.color || "#777777";
    const swatches = FOLDER_COLORS.map(c => `<button type="button" class="art-fcolor${c === color ? " on" : ""}" style="--c:${c}" data-action="folderColor"
      data-kind="${kind}" data-id="${esc(g.id)}" data-color="${c}" aria-label="${esc(c)}"></button>`).join("");
    const newLabel = kind === "aspect" ? "ART.Folder.newAspectIn" : kind === "layer" ? "ART.Folder.newLayerIn" : "ART.Folder.newIn";
    return `${head}<div class="art-fmenu" role="menu">
      <button type="button" class="art-menu-row" data-action="folderRename" data-kind="${kind}" data-id="${esc(g.id)}">${icon("pen")}<span>${esc(this.t("ART.Folder.rename"))}</span></button>
      <div class="art-fcolors">${swatches}<label class="art-fcolor art-fcolor-own" title="${esc(this.t("ART.Folder.ownColor"))}">${icon("plus")}
        <input type="color" value="${esc(color)}" data-change="folderColorPick" data-kind="${kind}" data-id="${esc(g.id)}"></label></div>
      <button type="button" class="art-menu-row" data-action="folderNewIn" data-kind="${kind}" data-id="${esc(g.id)}">${icon("plus")}<span>${esc(this.t(newLabel))}</span></button>
      ${!g.virtual || g.legacy ? `<button type="button" class="art-menu-row art-danger" data-action="folderRemove" data-kind="${kind}" data-id="${esc(g.id)}">${icon("trash")}<span>${esc(this.t("ART.Folder.remove"))}</span></button>` : ""}
    </div>`;
  },

  _uOpen(kind, id) { return !(this.uShut ??= new Set()).has(`${kind}:${id}`); },

  /**
   * Папки вида с плитками. tile(item) → HTML плитки. keep(item) — фильтр поиска.
   * Корень (без папки) идёт первым и без шапки. Пустые папки видны: в них можно завести тип.
   */
  uFolders(kind, tile, keep = () => true, { rows = false } = {}) {
    const q = !!this._uQuery;
    return this.studio.folderGroups(kind).map(g => {
      const items = g.items.filter(keep);
      if ( q && !items.length ) return "";
      const body = items.map(tile).join("");
      const wrap = rows ? `<div class="art-lrows">${body}</div>` : `<div class="art-ft" style="--c:${esc(g.color || "transparent")}">${body}</div>`;
      if ( !g.id ) return body ? wrap : "";
      const open = q || this._uOpen(kind, g.id);
      return `<section class="art-fgroup">${this.uFolderHead(kind, g, open)}${open && body ? wrap : ""}</section>`;
    }).join("");
  },

  /** Плитка типа: значок над названием; у выбранной карандаш правки. */
  uTypeTile(kind, t, selectedId) {
    const s = this.studio;
    const on = t.id === selectedId;
    const pen = on && s.canEditType(t)
      ? `<button type="button" class="art-ut-pen" data-action="editType" data-kind="${kind}" data-id="${esc(t.id)}" title="${esc(this.t("ART.Type.edit"))}" aria-label="${esc(this.t("ART.Type.edit"))}">${icon("pen")}</button>` : "";
    return `<div class="art-ut-wrap"><button type="button" class="art-ut${on ? " on" : ""}" data-action="pickType" data-kind="${kind}" data-id="${esc(t.id)}"
      title="${esc(t.name)}${t.personal ? ` · ${esc(this.t("ART.Type.personal"))}` : ""}">${this.uTypeIcon(t)}<span>${mark(t.name, this._uQuery)}</span></button>${pen}</div>`;
  },

  /** Крупный значок типа для плитки и шапки. */
  uTypeIcon(t, size = "") {
    const st = t?.style ?? {};
    const c = st.color ?? "#ccc";
    if ( t?.kind === "object" ) {
      if ( st.emoji ) return `<span class="art-plate${size}"><span class="art-emoji">${esc(st.emoji)}</span></span>`;
      if ( st.icon ) return `<span class="art-plate${size}" style="--c:${esc(c)}">${iconImg(st.icon, c, { tint: st.tint !== false, cls: "art-plate-ico" })}</span>`;
      return `<span class="art-plate${size}" style="--c:${esc(c)}"></span>`;
    }
    if ( t?.kind === "line" ) {
      const dash = st.pattern === "dash" ? ' stroke-dasharray="6 3"' : st.pattern === "dot" ? ' stroke-dasharray="1 4"' : "";
      return `<svg class="art-lnsw" width="34" height="14" viewBox="0 0 34 14" aria-hidden="true"><path d="M2 10 C10 2, 20 14, 32 4" stroke="${esc(c)}" stroke-width="3" fill="none" stroke-linecap="round"${dash}/></svg>`;
    }
    return `<span class="art-circ${size}" style="--c:${esc(c)}"></span>`;
  },

  /** Шапка правой колонки: значок, название, плашка. */
  uHead(sw, name, chip = "") {
    return `<div class="art-thead">${sw}<b>${esc(name)}</b>${chip}</div>`;
  },

  uChip(text, color = "", ic = "") {
    const lead = color ? `<i style="background:${esc(color)}"></i>` : ic ? icon(ic) : "";
    return `<span class="art-lchip">${lead}${esc(text)}</span>`;
  },

  uLab(text, count = "") {
    return `<div class="art-lab">${esc(text)}${count !== "" ? ` <span class="art-cnt">${esc(String(count))}</span>` : ""}</div>`;
  },

  /** Кнопки внизу правой колонки. */
  uActions(html) { return `<div class="art-uactions">${html}</div>`; },

  /** Две колонки окна: слева папки, справа выбранное. */
  uCols(left, right, key) {
    return `<div class="art-ucols"><nav class="art-ucol-left" data-scroll="${key}-l">${left}</nav>
      <div class="art-ucol-right" data-scroll="${key}-r">${right}</div></div>`;
  },

  /**
   * Значок аспекта или статуса без подложки: эмодзи, картинка (белые значки библиотеки красятся цветом)
   * или значок Font Awesome. sys — system предмета или запись на элементе.
   */
  uGlyph(sys, color = "", fallback = "star") {
    if ( sys?.emoji ) return `<span class="art-emoji">${esc(sys.emoji)}</span>`;
    const ic = sys?.icon || fallback;
    if ( isImageIcon(ic) ) return iconImg(ic, color || "#ddd", { tint: sys?.tint !== false, cls: "art-glyph-img" });
    return icon(ic);
  },

  /** Значок аспекта: кружок с цветом и значком. */
  uAspectPlate(item, size = "") {
    const c = item?.system?.color || "#c9a45c";
    return `<span class="art-plate art-aplate${size}" style="--c:${esc(c)}">${this.uGlyph(item?.system, c)}</span>`;
  },

  /**
   * Значок записи на элементе карты. Берётся из предмета (если его поменяли — меняется везде),
   * иначе из самой записи; у старых статусов — по названию.
   */
  uEntryGlyph(x, aspect = false) {
    const item = x?.itemId ? this.studio.aspectById(x.itemId) : null;
    if ( item ) return { html: this.uGlyph(item.system, item.system?.color), color: item.system?.color || "" };
    const fallback = aspect ? (x?.key ? statusIcon(x) : "star") : statusIcon(x);
    return { html: this.uGlyph({ icon: x?.icon, emoji: x?.emoji }, "", fallback), color: "" };
  },

  /** Точки ступеней: n из m. */
  uPips(n, m) {
    if ( !m ) return "";
    return `<span class="art-pips">${Array.from({ length: m }, (_, k) => `<i class="${k < n ? "on" : ""}"></i>`).join("")}</span>`;
  },

  /**
   * Блок «Аспекты и статусы» формы нового элемента: выбранные предметы, «Добавить»,
   * подсказка про перетаскивание. Сюда же можно бросить плитку из окна «Аспекты».
   */
  uAspectsBlock(slot) {
    const s = this.studio;
    const ids = s[slot]?.aspects ?? [];
    const pills = ids.map(id => s.aspectById(id)).filter(Boolean).map(a => `<span class="art-pill">${this.uAspectPlate(a, " art-plate-xs")}${esc(a.name)}
      <button type="button" class="art-pill-x" data-action="pendingRemove" data-slot="${slot}" data-id="${esc(a.id)}" aria-label="${esc(this.t("ART.Aspect.detach"))}">${icon("xmark")}</button></span>`).join("");
    const open = s.aspectPick?.slot === slot;
    return `<div class="art-sect art-sect-aspects" data-drop-slot="${slot}">
      <div class="art-lab">${icon("wand-magic-sparkles")} ${esc(this.t("ART.Aspect.block"))}</div>
      <div class="art-chiprow">${pills}<button type="button" class="art-btn art-sm art-dashed${open ? " active" : ""}" data-action="aspectPickOpen" data-slot="${slot}">${icon("plus")} ${esc(this.t("ART.Aspect.add"))}</button></div>
      ${open ? this.uAspectPicker() : `<div class="art-muted art-small">${esc(this.t("ART.Aspect.dragHint"))}</div>`}
    </div>`;
  },

  /**
   * Выбор аспекта или статуса: поиск по названию и список, сначала точные совпадения.
   * Если такого названия нет, внизу «Новый статус «…»» и «Новый аспект «…»»: он заводится в общем списке
   * и сразу ложится туда, откуда открыт выбор. Для формы, элемента карточки и статусов аспекта один и тот же.
   */
  uAspectPicker() {
    const s = this.studio;
    const p = s.aspectPick;
    const all = s.pickList();
    const list = all.slice(0, 40);
    const none = !s.aspects().length;
    const t = (k, d) => this.t(k, d);
    const rows = list.map(a => {
      const parents = a.system?.kind === "status" ? aspectsWith(a.id, s.aspects()).map(x => x.name).join(", ") : "";
      return `<button type="button" class="art-menu-row" data-action="aspectPickRow" data-id="${esc(a.id)}" title="${esc(a.system?.description || a.name)}">
        ${this.uAspectPlate(a, " art-plate-md")}<span class="art-apick-name">${mark(a.name, p?.q)}${parents ? `<small>${esc(parents)}</small>` : ""}</span>
        <small class="art-apick-kind">${esc(stepsLabel(a, t))}</small></button>`;
    }).join("");
    const q = String(p?.q ?? "").trim();
    const creates = s.pickCreateKinds().map(k => `<button type="button" class="art-menu-row art-menu-new" data-action="aspectPickCreate" data-kind="${k}">
      <span class="art-plate art-plate-md art-plate-new">${icon("plus")}</span><span class="art-apick-name">${esc(this.t(k === "aspect" ? "ART.Aspect.createAspect" : "ART.Aspect.createStatus", { name: q }))}</span></button>`).join("");
    const empty = rows || creates ? "" : `<p class="art-empty">${esc(this.t(none && !q ? "ART.Aspect.emptyShort" : "ART.Aspect.noneFound"))}</p>`;
    const ph = s._pickOnlyStatus(p) ? "ART.Aspect.findStatus" : "ART.Aspect.find";
    return `<div class="art-apick">
      <input type="search" class="art-search" data-model="aspectPick.q" data-key="apick-q" data-enter="aspectPickEnter" value="${esc(p?.q ?? "")}" placeholder="${esc(this.t(ph))}" autocomplete="off">
      <div class="art-apick-list">${rows}${creates}${empty}</div>
      ${all.length > list.length ? `<p class="art-muted art-small">${esc(this.t("ART.Unified.more", { n: all.length - list.length }))}</p>` : ""}
      ${p?.form ? "" : `<button type="button" class="art-link" data-action="openAspects">${icon("up-right-from-square")} ${esc(this.t("ART.Aspect.openWindow"))}</button>`}
    </div>`;
  },

  /** Варианты вида подписи. forType — форма типа (пусто — как по умолчанию), иначе форма элемента (пусто — как у типа). */
  _labelModes(kind, forType) {
    const own = { area: ["curved", "straight", "none"], object: ["below", "none"], line: ["straight", "along", "none"] }[kind] ?? ["straight", "none"];
    const first = forType ? { area: "ART.Label.auto", object: "ART.Label.below", line: "ART.Label.straight" }[kind] : "ART.Label.asType";
    const rest = forType ? own.filter(m => !(kind === "object" && m === "below") && !(kind === "line" && m === "straight")) : own;
    return [["", this.t(first)], ...rest.map(m => [m, this.t(`ART.Label.${m}`)])];
  },

  /**
   * Блок «Подпись» одинаковый везде: вид, размер, шрифт.
   * bind: { slot } — форма нового элемента, { type: true } — форма типа.
   */
  uLabelBlock(kind, values, bind) {
    const attr = key => (bind.type ? `data-model="typeForm.${key}"` : `data-change="formLabel" data-slot="${bind.slot}" data-lkey="${key}"`);
    const keyOf = key => (bind.type ? `tf-${key}` : `${bind.slot}-${key}`);
    const mode = values.labelMode ?? "";
    const opts = this._labelModes(kind, !!bind.type).map(([v, n]) => `<option value="${v}"${mode === v ? " selected" : ""}>${esc(n)}</option>`).join("");
    const scale = Number(values.labelScale) > 0 ? Number(values.labelScale) : 1;
    const fonts = this.backend.fonts?.() ?? [];
    const font = values.labelFont ?? "";
    const fopt = v => `<option value="${esc(v)}"${font === v ? " selected" : ""}${v ? ` style="font-family:'${esc(v)}'"` : ""}>${esc(v || this.t(bind.type ? "ART.Type.fontDefault" : "ART.Label.asType"))}</option>`;
    return `<div class="art-sect art-sect-labels"><div class="art-lab">${icon("font")} ${esc(this.t("ART.Label.title"))}</div>
      <div class="art-g3">
        <label class="art-field"><span>${esc(this.t("ART.Label.view"))}</span><select ${attr("labelMode")}>${opts}</select></label>
        <label class="art-field"><span>${esc(this.t("ART.Label.sizePct", { n: Math.round(scale * 100) }))}</span>
          <input type="range" min="0.4" max="3" step="0.1" value="${esc(String(scale))}" ${attr("labelScale")} data-key="${keyOf("lscale")}"></label>
      </div>
      <label class="art-field"><span>${esc(this.t("ART.Label.font"))}</span><select ${attr("labelFont")}>${fopt("")}${fonts.map(fopt).join("")}</select></label>
    </div>`;
  },

  /** Значок элемента карты для строки списка. */
  uFeatureIcon(st, size = "") {
    const s = this.studio;
    const type = s.typeById(st.system.typeId);
    const color = st.system.style?.color ?? type?.style?.color ?? "#ccc";
    if ( st.system.kind === "object" ) {
      const path = st.system.style?.icon ?? type?.style?.icon;
      const emoji = st.system.style?.emoji ?? type?.style?.emoji;
      if ( emoji ) return `<span class="art-plate art-plate-sm${size}"><span class="art-emoji">${esc(emoji)}</span></span>`;
      return `<span class="art-plate art-plate-sm${size}" style="--c:${esc(color)}">${path ? iconImg(path, color, { tint: (st.system.style?.tint ?? type?.style?.tint) !== false, cls: "art-plate-ico" }) : ""}</span>`;
    }
    if ( st.system.kind === "line" ) return `<i class="art-line-sw" style="--c:${esc(color)}"></i>`;
    return `<i class="art-swatch" style="--c:${esc(color)}"></i>`;
  },

  /** Строки «На карте»: элементы выбранного типа. */
  uOnMap(kind, typeId, q) {
    const s = this.studio;
    const f = String(q ?? "").trim().toLowerCase();
    const all = s.featuresOfType(typeId);
    const list = all.filter(st => !f || (st.name ?? "").toLowerCase().includes(f) || (s.typeById(typeId)?.name ?? "").toLowerCase().includes(f) || hasEntryLike(st, f));
    const z = s.zone;
    const rows = list.slice(0, ON_MAP_MAX).map(st => {
      const name = st.name || this.t("ART.Card.unnamed");
      if ( kind === "area" ) {
        const n = zoneCells(st).length;
        return `<div class="art-irow${st.id === z.target ? " on" : ""}${n ? "" : " art-archived"}">
          <button type="button" class="art-irow-main" data-action="zoneTarget" data-id="${esc(st.id)}" title="${esc(this.t("ART.Zone.paintWith"))}">
            ${this.uFeatureIcon(st)}<span class="art-nm">${mark(name, q)}</span><span class="art-note">${n}</span></button>
          <button type="button" class="art-icon-btn" data-action="focusFeature" data-id="${esc(st.id)}" title="${esc(this.t("ART.Catalog.show"))}">${icon("crosshairs")}</button></div>`;
      }
      let note = "";
      if ( kind === "object" ) {
        const c = markCell(st, s.grid.cellAt);
        note = c ? `${c[0]}:${c[1]}` : "";
      } else {
        const lid = lineLayerOf(st, s.types);
        note = lid ? (s.layers.find(l => l.id === lid)?.name ?? "") : "";
      }
      return `<div class="art-irow${st.id === s.openId ? " on" : ""}"><button type="button" class="art-irow-main" data-action="focusFeature" data-id="${esc(st.id)}" title="${esc(this.t("ART.Catalog.show"))}">
        ${this.uFeatureIcon(st)}<span class="art-nm">${mark(name, q)}</span><span class="art-note">${esc(note)}</span>${icon("crosshairs", "art-go")}</button></div>`;
    }).join("");
    const more = list.length > ON_MAP_MAX ? `<p class="art-muted art-small">${esc(this.t("ART.Unified.more", { n: list.length - ON_MAP_MAX }))}</p>` : "";
    return `${this.uLab(this.t("ART.Unified.onMap"), all.length)}
      ${rows ? `<div class="art-irows art-resize" data-size="onmap-${kind}" data-scroll="onmap-${kind}" title="${esc(this.t("ART.Unified.resizeHint"))}">${rows}</div>${more}` : `<p class="art-empty art-small">${esc(this.t("ART.Unified.noneOnMap"))}</p>`}`;
  },

  /** Плашка у шапки: слой зоны или линии, папка метки. */
  uTypeChip(kind, t) {
    const s = this.studio;
    if ( !t ) return "";
    if ( kind === "object" ) {
      const g = s.folderGroups("object").find(x => x.id && x.items.some(i => i.id === t.id));
      return g ? this.uChip(g.name, g.color || "#777") : this.uChip(this.t("ART.Unified.noFolder"));
    }
    const lid = kind === "area" ? (t.layerId ?? "overlay") : (t.layerId ?? "");
    const l = s.layers.find(x => x.id === lid);
    return l ? this.uChip(this.t("ART.Unified.layerOf", { name: l.name }), l.color || "#c9573f") : this.uChip(this.t("ART.Unified.noLayer"));
  },

  /* ---------------------------------------------------------------- */
  /*  Окна «Зоны», «Метки», «Линии»                                    */
  /* ---------------------------------------------------------------- */

  /** Окно инструмента: kind — area, object или line. */
  renderToolWindow(kind) {
    const s = this.studio;
    const slot = SLOT[kind];
    const f = s[slot];
    const q = f.filter ?? "";
    this._uQuery = q.trim().toLowerCase();
    const target = kind === "area" && f.target !== "new" && s.states.has(f.target) ? s.stateOf(f.target) : null;
    const selected = target?.system.typeId ?? f.typeId;
    const types = s.typesOf(kind);
    // Поиск находит и тип по названию, и тип, у которого есть элемент с таким названием.
    // 1.0: и тип, на элементе которого висит статус или аспект с таким названием («Голод»).
    const hasNamed = new Set(this._uQuery ? [...s.states.values()]
      .filter(st => st.system.kind === kind && ((st.name ?? "").toLowerCase().includes(this._uQuery) || hasEntryLike(st, this._uQuery)))
      .map(st => st.system.typeId) : []);
    const keep = t => !this._uQuery || t.name.toLowerCase().includes(this._uQuery) || hasNamed.has(t.id);
    const tiles = this.uFolders(kind, t => this.uTypeTile(kind, t, selected), keep);
    const left = `${this.uNewbar(kind)}${tiles || `<p class="art-empty">${esc(this.t(types.length ? "ART.Unified.nothingFound" : "ART.Unified.noTypes"))}</p>`}`;
    this._uQuery = "";
    const right = s.typeForm?.kind === kind ? this.renderTypeEditor(kind) : this.renderToolRight(kind, target);
    const pill = kind === "line"
      ? `${esc(this.t("ART.Unified.points"))}: <b>${s.line.points.length}</b>`
      : `${esc(this.t("ART.Unified.selected"))}: <b>${s.selection.size}</b>${s.selection.size ? `<button type="button" class="art-spill-x" data-action="clearSelection" title="${esc(this.t("ART.Sel.clear"))}" aria-label="${esc(this.t("ART.Sel.clear"))}">${icon("xmark")}</button>` : ""}`;
    const ph = { area: "ART.Unified.findZone", object: "ART.Unified.findMark", line: "ART.Unified.findLine" }[kind];
    return `<div class="art-uw">${this.introHint({ area: "ART.Zone.hint", object: "ART.Mark.hint", line: "ART.Line.hint" }[kind])}
      ${this.uStrip(`${slot}.filter`, q, this.t(ph), pill)}
      ${this.uCols(left, right, slot)}</div>`;
  },

  /** Правая колонка окна инструмента: тип, «На карте», форма нового элемента, кнопка. */
  renderToolRight(kind, target = null) {
    const s = this.studio;
    const slot = SLOT[kind];
    const f = s[slot];
    const type = s.typeById(target?.system.typeId ?? f.typeId);
    if ( !type ) return `<p class="art-empty">${esc(this.t("ART.Unified.pickType"))}</p>`;
    const head = this.uHead(this.uTypeIcon(type, " art-plate-lg"), type.name, this.uTypeChip(kind, type));
    const onMap = this.uOnMap(kind, type.id, f.filter);
    const n = s.selection.size;
    const nameField = (ph, enter) => `<label class="art-field"><span>${esc(this.t("ART.Field.name"))}</span>
      <input type="text" data-model="${slot}.name" data-key="${slot}-name"${enter ? ` data-enter="${enter}"` : ""} value="${esc(f.name)}" placeholder="${esc(ph)}"></label>`;
    const textField = `<label class="art-field"><span>${esc(this.t("ART.Field.text"))}</span>
      <textarea rows="2" data-model="${slot}.text" data-key="${slot}-text" placeholder="${esc(this.t("ART.Field.textPh"))}">${esc(f.text ?? "")}</textarea></label>`;
    if ( kind === "area" ) {
      if ( target ) {
        const cells = zoneCells(target).length;
        return `${head}${onMap}
          ${this.uLab(this.t("ART.Unified.zoneOf", { name: target.name || this.t("ART.Card.unnamed") }))}
          <p class="art-muted">${esc(this.t("ART.Zone.cells", { n: cells }))}. ${esc(this.t("ART.Unified.zoneOfHint"))}</p>
          ${this.uActions(`<button type="button" class="art-btn art-accent" data-action="attach" ${n ? "" : "disabled"}>${icon("check")} ${esc(this.t("ART.Unified.addCells", { n }))}</button>
            <button type="button" class="art-btn" data-action="zoneTarget" data-id="new">${icon("plus")} ${esc(this.t("ART.Zone.newZone"))}</button>`)}
          ${this.uDetach()}`;
      }
      const terrain = type.layerId === "terrain";
      const paint = !!s.zone.paint && !s.zone.erase;
      return `${head}${onMap}
        ${this.uLab(this.t("ART.Zone.newZone"))}
        ${nameField(type.name, "")}${textField}
        ${terrain ? "" : `<label class="art-field art-inline"><span>${esc(this.t("ART.Field.color"))}</span>${colorField('data-model="zone.color"', f.color || type.style?.color || "#c96f4a", "zone-color")}</label>`}
        ${this.uAspectsBlock("zone")}
        ${this.uLabelBlock("area", f.label ?? {}, { slot: "zone" })}
        ${this.uActions(`<button type="button" class="art-btn art-accent" data-action="attach">${icon("check")} ${esc(this.t(n ? "ART.Zone.create" : "ART.Zone.createEmpty", { n }))}</button>
          <button type="button" class="art-btn${paint ? " active" : ""}" data-action="brushMode" data-mode="${paint ? "pick" : "paint"}" aria-pressed="${paint}"
            title="${esc(this.t("ART.Brush.hint.paint"))}">${icon("paintbrush")} ${esc(this.t("ART.Unified.brush"))}</button>`)}
        ${this.uDetach()}`;
    }
    if ( kind === "object" ) {
      return `${head}${onMap}
        ${this.uLab(this.t("ART.Unified.newMark"))}
        ${nameField(type.name, "placeMarks")}${textField}
        ${this.uAspectsBlock("mark")}
        ${this.uLabelBlock("object", f.label ?? {}, { slot: "mark" })}
        <label class="art-check"><input type="checkbox" data-model="mark.paint" ${f.paint ? "checked" : ""}> ${esc(this.t("ART.Mark.paint"))}</label>
        ${this.uActions(`<button type="button" class="art-btn art-accent" data-action="placeMarks" ${n ? "" : "disabled"}>${icon("location-dot")} ${esc(this.t("ART.Mark.place", { n }))}</button>`)}`;
    }
    const l = s.line;
    const pts = l.points.length;
    return `${head}${onMap}
      ${this.uLab(this.t("ART.Unified.newLine"))}
      ${nameField(type.name, "finishLine")}${textField}
      <div class="art-field"><span>${esc(this.t("ART.Line.mode"))}</span>
        <div class="art-seg">${["free", "hex", "edge", "draw"].map(m => `<button type="button" class="art-btn${l.mode === m ? " active" : ""}" data-action="lineMode" data-mode="${m}" title="${esc(this.t(`ART.Line.hints.${m}`))}">${icon({ free: "bezier-curve", hex: "border-all", edge: "vector-square", draw: "pencil" }[m])} ${esc(this.t(`ART.Line.modes.${m}`))}</button>`).join("")}</div>
        <p class="art-hint">${esc(this.t(`ART.Line.hints.${l.mode}`))}</p></div>
      ${l.mode === "free" ? `<label class="art-check"><input type="checkbox" data-model="line.snap" ${l.snap ? "checked" : ""}> ${esc(this.t("ART.Line.snap"))}</label>` : ""}
      <label class="art-check"><input type="checkbox" data-model="line.join" ${l.join !== false ? "checked" : ""}> ${esc(this.t("ART.Line.join"))}</label>
      ${this.uAspectsBlock("line")}
      ${this.uLabelBlock("line", f.label ?? {}, { slot: "line" })}
      ${this.uActions(`<button type="button" class="art-btn art-accent" data-action="finishLine" ${pts >= 2 ? "" : "disabled"}>${icon("check")} ${esc(this.t("ART.Line.finish"))} <kbd>Enter</kbd></button>
        <button type="button" class="art-btn" data-action="undoPoint" ${pts ? "" : "disabled"} title="${esc(this.t("ART.Unified.undoPoint"))}">${icon("rotate-left")}</button>
        <button type="button" class="art-btn" data-action="clearLine" ${pts ? "" : "disabled"} title="${esc(this.t("ART.Unified.clearLine"))}">${icon("xmark")}</button>`)}`;
  },

  /** «Убрать гексы из зон»: свёрнуто под кнопками окна зон. */
  uDetach() {
    const s = this.studio;
    const z = s.zone;
    const n = s.selection.size;
    const opts = [`<option value="">${esc(this.t("ART.Zone.allLayers"))}</option>`,
      ...s.layers.map(l => `<option value="${esc(l.id)}"${l.id === z.detachLayer ? " selected" : ""}>${esc(l.name)}</option>`)].join("");
    const open = (this.wfOpen ??= new Set(["settings"])).has("detach");
    return `<details class="art-fold-inner" data-fold="detach"${open ? " open" : ""}><summary>${icon("eraser")} ${esc(this.t("ART.Zone.detachTitle"))}</summary>
      <div class="art-row-btns"><select data-model="zone.detachLayer">${opts}</select>
      <button type="button" class="art-btn" data-action="detach" ${n ? "" : "disabled"}>${icon("eraser")} ${esc(this.t("ART.Zone.detach"))}</button></div>
      <p class="art-hint">${esc(this.t("ART.Unified.eraseHint"))}</p></details>`;
  },

  /**
   * Правка типа в правой колонке окна инструмента (макет «Линии»): название, папка, слой, цвет,
   * вид своего рода, подпись. «Сохранить тип», «Отмена», корзина.
   */
  renderTypeEditor(kind) {
    const s = this.studio;
    const f = s.typeForm;
    const folders = s.folderGroups(kind).filter(g => g.id && (!g.virtual || g.legacy));
    const fopts = [`<option value="">${esc(this.t("ART.Unified.noFolder"))}</option>`,
      ...folders.map(g => `<option value="${esc(g.id)}"${g.id === (f.folder ?? "") ? " selected" : ""}>${esc(g.name)}</option>`)].join("");
    const layerSel = kind === "object" ? "" : `<label class="art-field"><span>${esc(this.t("ART.Layer.one"))}</span><select data-model="typeForm.layerId">
      ${kind === "line" ? `<option value=""${f.layerId ? "" : " selected"}>${esc(this.t("ART.Unified.noLayer"))}</option>` : ""}
      ${s.layers.map(l => `<option value="${esc(l.id)}"${l.id === f.layerId ? " selected" : ""}>${esc(l.name)}</option>`).join("")}</select></label>`;
    const type = f.id ? s.typeById(f.id) : null;
    const sw = type ? this.uTypeIcon(type, " art-plate-lg") : `<span class="art-plate art-plate-lg">${icon(TOOL_ICON[kind])}</span>`;
    const area = kind === "area" ? `<div class="art-field"><span>${esc(this.t("ART.Pattern.title"))}</span>
        <div class="art-patterns">${this.patternButtons(f.pattern)}</div></div>
      ${f.pattern && f.pattern !== "none" ? `<label class="art-field art-inline"><span>${esc(this.t("ART.Pattern.color"))}</span>${colorField('data-model="typeForm.patternColor"', f.patternColor || "#1a1a1a", "tf-pcolor")}</label>` : ""}` : "";
    const object = kind === "object" ? `${this.renderShapePicker(f.shape)}
      <label class="art-field"><span>${esc(this.t("ART.Type.emoji"))}</span>
        <input type="text" class="art-emoji-input" maxlength="8" data-model="typeForm.emoji" data-key="tf-emoji" value="${esc(f.emoji ?? "")}" placeholder="🐉"></label>
      ${f.emoji ? "" : this.renderIconPicker(f)}` : "";
    return `${this.uHead(sw, f.id ? (type?.name ?? f.name) : this.t("ART.Type.newTitle"), f.id ? this.uChip(this.t("ART.Unified.editType"), "", "pen") : "")}
      ${this.uLab(this.t(f.id ? "ART.Unified.editType" : "ART.Type.newTitle"))}
      <label class="art-field"><span>${esc(this.t("ART.Field.name"))}</span>
        <input type="text" data-model="typeForm.name" data-key="tf-name" data-enter="saveType" value="${esc(f.name)}" placeholder="${esc(this.t("ART.Type.namePh"))}"></label>
      <div class="art-grid2"><label class="art-field"><span>${esc(this.t("ART.Folder.one"))}</span><select data-model="typeForm.folder">${fopts}</select></label>${layerSel}</div>
      <label class="art-field art-inline"><span>${esc(this.t("ART.Field.color"))}</span>${colorField('data-model="typeForm.color"', f.color, "tf-color")}</label>
      ${area}${object}${kind === "line" ? this.renderLineStyle(f) : ""}
      ${this.uLabelBlock(kind, f, { type: true })}
      ${this.uActions(`<button type="button" class="art-btn art-accent" data-action="saveType">${icon("check")} ${esc(this.t("ART.Unified.saveType"))}</button>
        <button type="button" class="art-btn" data-action="cancelType">${esc(this.t("ART.Cancel"))}</button><span class="art-sp"></span>
        ${f.id ? `<button type="button" class="art-btn art-danger art-icon-only" data-action="deleteType" data-id="${esc(f.id)}" title="${esc(this.t("ART.Unified.deleteType"))}">${icon("trash")}</button>` : ""}`)}`;
  },

  /* ---------------------------------------------------------------- */
  /*  Окно «Слои»                                                       */
  /* ---------------------------------------------------------------- */

  renderLayersWindow() {
    const s = this.studio;
    const gm = !!this.backend.isGM;
    const hidden = s.hidden();
    const presets = s.presets();
    const active = s.activePreset();
    const custom = presets.find(p => p.id === active && p.custom);
    const options = [`<option value=""${active ? "" : " selected"}>${esc(this.t("ART.Preset.manual"))}</option>`,
      ...presets.map(p => `<option value="${esc(p.id)}"${p.id === active ? " selected" : ""}>${esc(p.name)}</option>`)].join("");
    const strip = `<div class="art-ustrip"><label class="art-preset-pick"><span>${esc(this.t("ART.Preset.title"))}:</span>
        <select data-change="applyPreset">${options}</select></label>
      <button type="button" class="art-icon-btn" data-action="savePreset" title="${esc(this.t("ART.Preset.save"))}">${icon("floppy-disk")}</button>
      ${custom ? `<button type="button" class="art-icon-btn" data-action="deletePreset" data-id="${esc(custom.id)}" title="${esc(this.t("ART.Preset.delete"))}">${icon("trash")}</button>` : ""}</div>`;
    const counts = new Map(s.zoneCatalog().map(g => [g.layer.id, g.types.reduce((n, x) => n + x.zones.length, 0)]));
    const row = (id, name, { note = "", ic = "", disabled = false, hint = "", color = "" } = {}) => {
      const on = isShown(id, hidden);
      return `<div class="art-lrow${s.layerSel === id ? " on" : ""}${on ? "" : " off"}">
        <button type="button" class="art-icon-btn" data-action="toggleLayer" data-id="${esc(id)}" aria-pressed="${on}" ${disabled ? "disabled" : ""}
          title="${esc(hint || this.t(on ? "ART.Layer.hide" : "ART.Layer.show"))}">${icon(on ? "eye" : "eye-slash")}</button>
        <button type="button" class="art-lrow-main" data-action="pickLayer" data-id="${esc(id)}">${color ? `<i class="art-fd" style="--c:${esc(color)}"></i>` : ic ? icon(ic) : ""}
          <span>${esc(name)}</span>${note !== "" ? `<small>${esc(note)}</small>` : ""}</button></div>`;
    };
    const fields = this.backend.fields?.();
    const zoneRows = this.uFolders("layer", l => row(l.id, l.name, { note: String(counts.get(l.id) ?? 0), color: l.color || "" }), () => true, { rows: true });
    const viewGroups = VIEW_GROUPS.map(gid => {
      const defs = VIEW_PART_DEFS.filter(d => d.group === gid);
      const open = this._uOpen("view", gid);
      const body = defs.map(d => {
        const fld = VIEW_FIELD[d.id];
        const empty = fld && !hasField(fields, fld);
        return row(d.id, this.t(`ART.View.${d.id.slice(1)}`), empty ? { disabled: true, hint: this.t("ART.View.noData"), ic: "database" } : { ic: d.id === "@coast" ? "water" : "" });
      }).join("");
      return `<section class="art-fgroup"><div class="art-fh" style="--c:#4a7bb5"><button type="button" class="art-fh-fold" data-action="folderFold" data-kind="view" data-id="${gid}" aria-expanded="${open}">
        ${icon(open ? "chevron-down" : "chevron-right")}<i class="art-fd"></i><span class="art-fh-name">${esc(this.t(`ART.LayerLook.group.${gid}`))}</span> <span class="art-cnt">${defs.length}</span></button></div>
        ${open ? `<div class="art-lrows">${body}</div>` : ""}</section>`;
    }).join("");
    const left = `${gm ? this.uNewbar("layer", { action: "newLayer", label: "ART.Layer.new" }) : ""}${zoneRows}${viewGroups}`;
    const head = this.host ? "" : `<header class="art-head">${icon("layer-group")}<h3>${esc(this.t("ART.Layer.title"))}</h3>
      <button type="button" class="art-icon-btn" data-action="toggleLayerPanel" title="${esc(this.t("ART.Close"))}">${icon("xmark")}</button></header>`;
    return `${head}<div class="art-body art-uw" data-scroll="layers">${this.introHint("ART.Layer.barHint")}${strip}${this.uCols(left, this.renderLayerRight(), "layers")}</div>`;
  },

  /** Правая колонка окна слоёв: слой зон, берег, вид карты или новый слой. */
  renderLayerRight() {
    const s = this.studio;
    const gm = !!this.backend.isGM;
    const id = s.layerSel;
    if ( id === "@coast" ) return this.renderCoast();
    if ( id && id.startsWith("@") ) {
      const on = isShown(id, s.hidden());
      return `${this.uHead(`<span class="art-plate art-plate-lg">${icon("eye")}</span>`, this.t(`ART.View.${id.slice(1)}`), this.uChip(this.t(on ? "ART.LayerLook.visible" : "ART.LayerLook.hidden"), "", on ? "eye" : "eye-slash"))}
        <p class="art-hint">${esc(this.t("ART.LayerLook.viewHint"))}</p>
        ${this.uActions(`<button type="button" class="art-btn" data-action="toggleLayer" data-id="${esc(id)}">${icon(on ? "eye-slash" : "eye")} ${esc(this.t(on ? "ART.Layer.hide" : "ART.Layer.show"))}</button>`)}`;
    }
    const layer = s.layers.find(l => l.id === id);
    const f = s.layerForm;
    if ( !layer && !(id === "new" && f) ) return `<p class="art-empty">${esc(this.t("ART.LayerLook.pick"))}</p>`;
    let top = "";
    if ( layer ) {
      const on = isShown(layer.id, s.hidden());
      const c = s.layerContents(layer.id);
      const names = list => list.map(t => t.name).join(", ");
      const op = layer.opacity ?? 1;
      const blur = layer.blur ?? 0;
      const slider = (look, label, value, min, max, step, shown, isDefault) => `<div class="art-mini"><span>${esc(this.t(label))}</span>
        <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-change="layerLook" data-id="${esc(layer.id)}" data-look="${look}" ${gm ? "" : "disabled"}>
        <b>${esc(shown)}</b>
        <button type="button" class="art-icon-btn" data-action="layerLookReset" data-id="${esc(layer.id)}" data-look="${look}" ${gm && !isDefault ? "" : "disabled"} title="${esc(this.t("ART.LayerLook.reset"))}">${icon("rotate-left")}</button></div>`;
      top = `${this.uHead(`<span class="art-sq" style="--c:${esc(layer.color || "#c9573f")}"></span>`, layer.name, this.uChip(this.t(on ? "ART.LayerLook.visible" : "ART.LayerLook.hidden"), "", on ? "eye" : "eye-slash"))}
        ${this.uLab(this.t("ART.LayerLook.inLayer"))}
        <div class="art-irows">
          <div class="art-irow"><span class="art-irow-main">${icon("draw-polygon")}<span class="art-nm">${esc(this.t("ART.LayerLook.zones"))}${c.zones.length ? `: ${esc(names(c.zones))}` : ""}</span><span class="art-note">${c.nZones}</span></span></div>
          <div class="art-irow"><span class="art-irow-main">${icon("route")}<span class="art-nm">${esc(this.t("ART.LayerLook.lines"))}${c.lines.length ? `: ${esc(names(c.lines))}` : ""}</span><span class="art-note">${c.nLines}</span></span></div>
        </div>
        <div class="art-sect art-sect-new"><div class="art-lab">${icon("eye")} ${esc(this.t("ART.LayerLook.view"))}</div>
          ${slider("opacity", "ART.LayerLook.opacity", op, 0, 1, 0.05, `${Math.round(op * 100)}%`, op === 1)}
          ${slider("blur", "ART.LayerLook.blur", blur, 0, 10, 0.5, `${blur} px`, blur === 0)}
          <div class="art-muted art-small">${esc(this.t(gm ? "ART.LayerLook.hint" : "ART.LayerLook.gmOnly"))}</div></div>`;
    }
    if ( !gm || !f ) return top;
    const n = f.id ? s.layers.findIndex(l => l.id === f.id) : -1;
    const folders = s.folderGroups("layer").filter(g => g.id && !g.virtual);
    const fopts = [`<option value="">${esc(this.t("ART.Folder.world"))}</option>`,
      ...folders.map(g => `<option value="${esc(g.id)}"${g.id === (f.folder ?? "") ? " selected" : ""}>${esc(g.name)}</option>`)].join("");
    return `${top}${f.id ? "" : this.uHead(`<span class="art-plate art-plate-lg">${icon("layer-group")}</span>`, this.t("ART.Layer.new"))}
      <label class="art-field"><span>${esc(this.t("ART.Field.name"))}</span>
        <input type="text" data-model="layerForm.name" data-key="lf-name" data-enter="saveLayer" value="${esc(f.name)}" placeholder="${esc(this.t("ART.Layer.namePh"))}"></label>
      <div class="art-grid2"><label class="art-field art-inline"><span>${esc(this.t("ART.LayerLook.color"))}</span>${colorField('data-model="layerForm.color"', f.color || "#c9573f", "lf-color")}</label>
        <label class="art-field"><span>${esc(this.t("ART.Folder.one"))}</span><select data-model="layerForm.folder">${fopts}</select></label></div>
      <label class="art-check"><input type="checkbox" data-model="layerForm.exclusive" ${f.exclusive ? "checked" : ""}> ${esc(this.t("ART.Layer.exclusiveCheck"))}</label>
      ${f.id === "terrain" ? `<p class="art-hint">${esc(this.t("ART.Layer.terrainHint"))}</p>` : ""}
      ${this.uActions(`<button type="button" class="art-btn art-accent" data-action="saveLayer">${icon("check")} ${esc(this.t("ART.LayerLook.save"))}</button>
        ${f.id ? `<button type="button" class="art-btn art-icon-only" data-action="layerUp" data-id="${esc(f.id)}" title="${esc(this.t("ART.Layer.up"))}" ${n > 0 ? "" : "disabled"}>${icon("arrow-up")}</button>
        <button type="button" class="art-btn art-icon-only" data-action="layerDown" data-id="${esc(f.id)}" title="${esc(this.t("ART.Layer.down"))}" ${n >= 0 && n < s.layers.length - 1 ? "" : "disabled"}>${icon("arrow-down")}</button>` : ""}
        <span class="art-sp"></span>
        ${f.id && f.id !== "terrain" ? `<button type="button" class="art-btn art-danger art-icon-only" data-action="deleteLayer" data-id="${esc(f.id)}" title="${esc(this.t("ART.Layer.delete"))}">${icon("trash")}</button>` : ""}`)}`;
  },

  /** Стиль береговой линии: узор, цвет, фильтр, ширина, прозрачность, размытие, мелководье. Меняется сразу. */
  renderCoast() {
    const s = this.studio;
    const gm = !!this.backend.isGM;
    const c = s.coastForm ?? { ...COAST_DEFAULTS, ...(this.backend.world?.()?.coast ?? {}) };
    const rough = !!this.backend.world?.()?.rough;
    const cur = c.pattern || (rough ? "rough" : "flat");
    const on = isShown("@coast", s.hidden());
    const dis = gm ? "" : "disabled";
    const tiles = COAST_PATTERNS.map(k => `<button type="button" class="art-coast-tile${k === cur ? " on" : ""}" data-action="coastSet" data-ckey="pattern" data-v="${k}" ${dis}>
      ${coastSwatch(k, c.color)}<span>${esc(this.t(`ART.Coast.${k}`))}</span></button>`).join("");
    const slider = (key, label, min, max, step, shown) => `<div class="art-mini"><span>${esc(this.t(label))}</span>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${esc(String(c[key]))}" data-change="coastSet" data-ckey="${key}" ${dis}><b>${esc(shown)}</b></div>`;
    const filters = ["none", "shadow", "glow"].map(v => `<option value="${v}"${(c.filter || "none") === v ? " selected" : ""}>${esc(this.t(`ART.Coast.filter_${v}`))}</option>`).join("");
    return `${this.uHead(`<span class="art-plate art-plate-lg" style="--c:#7fa9c4">${icon("water")}</span>`, this.t("ART.View.coast"), this.uChip(this.t(on ? "ART.LayerLook.visible" : "ART.LayerLook.hidden"), "", on ? "eye" : "eye-slash"))}
      <div class="art-sect art-sect-new"><div class="art-lab">${icon("water")} ${esc(this.t("ART.Coast.style"))}</div>
        <div class="art-coast-tiles">${tiles}</div>
        <div class="art-grid2"><label class="art-field art-inline"><span>${esc(this.t("ART.Field.color"))}</span>${colorField(`data-change="coastSet" data-ckey="color" ${dis}`, c.color, "coast-color")}</label>
          <label class="art-field"><span>${esc(this.t("ART.Coast.filter"))}</span><select data-change="coastSet" data-ckey="filter" ${dis}>${filters}</select></label></div>
        ${slider("width", "ART.Coast.width", 0.5, 4, 0.1, `×${Number(c.width).toFixed(1)}`)}
        ${slider("alpha", "ART.Coast.opacity", 0, 1, 0.05, `${Math.round(Number(c.alpha) * 100)}%`)}
        ${slider("blur", "ART.Coast.blur", 0, 6, 0.5, `${Number(c.blur)} px`)}
        <label class="art-check"><input type="checkbox" data-change="coastSet" data-ckey="shallow" ${c.shallow ? "checked" : ""} ${dis}> ${esc(this.t("ART.Coast.shallow"))}</label>
      </div>
      <div class="art-muted art-small">${esc(this.t(gm ? "ART.Coast.hint" : "ART.LayerLook.gmOnly"))}</div>
      ${gm ? this.uActions(`<button type="button" class="art-btn" data-action="coastReset">${icon("rotate-left")} ${esc(this.t("ART.Coast.reset"))}</button>`) : ""}`;
  },

  /* ---------------------------------------------------------------- */
  /*  Окно «Аспекты и статусы»                                         */
  /* ---------------------------------------------------------------- */

  renderAspectsWindow() {
    const s = this.studio;
    const all = s.aspects();
    const can = s.canEditAspects();
    const q = s.aspectQ ?? "";
    this._uQuery = q.trim().toLowerCase();
    const found = new Set(searchItems(all, q).map(a => a.id));
    const tiles = this.uFolders("aspect", a => `<div class="art-ut-wrap"><button type="button" class="art-ut${a.id === s.aspectSel ? " on" : ""}" data-action="pickAspect" data-id="${esc(a.id)}"
        draggable="true" data-drag-aspect="${esc(a.id)}" title="${esc(`${a.name} · ${stepsLabel(a, (k, d) => this.t(k, d))}\n${this.t("ART.Aspect.dragTile")}`)}">${this.uAspectPlate(a)}<span>${mark(a.name, q)}</span>
        ${a.system?.kind === "aspect" ? `<i class="art-ut-kind" title="${esc(this.t("ART.Aspect.kindAspect"))}"></i>` : ""}</button></div>`,
      a => found.has(a.id));
    this._uQuery = "";
    const empty = !all.length ? `<div class="art-empty">${esc(this.t("ART.Aspect.empty"))}
        ${can ? `<button type="button" class="art-btn" data-action="seedAspects">${icon("wand-magic-sparkles")} ${esc(this.t("ART.Aspect.seed"))}</button>` : ""}</div>`
      : (q.trim() && !found.size ? `<p class="art-empty">${esc(this.t("ART.Unified.nothingFound"))}</p>` : "");
    const canFolder = s.canFolders("aspect");
    const newbar = `<div class="art-newbar art-newbar3">
      <button type="button" class="art-btn" data-action="newAspect" data-kind="aspect" ${can ? "" : "disabled"} title="${esc(this.t("ART.Aspect.newAspect"))}">${icon("plus")} <span>${esc(this.t("ART.Aspect.kindAspect"))}</span></button>
      <button type="button" class="art-btn" data-action="newAspect" data-kind="status" ${can ? "" : "disabled"} title="${esc(this.t("ART.Aspect.newStatus"))}">${icon("plus")} <span>${esc(this.t("ART.Aspect.kindStatus"))}</span></button>
      <button type="button" class="art-btn art-icon-only" data-action="newFolder" data-kind="aspect" ${canFolder ? "" : "disabled"}
        title="${esc(this.t(canFolder ? "ART.Folder.new" : "ART.Folder.gmOnly"))}" aria-label="${esc(this.t("ART.Folder.new"))}">${icon("folder-plus")}</button></div>`;
    // Свои статусы, заведённые прямо на карте (до 1.0 так делали в карточке гекса): мастер переносит их в список.
    const loose = this.backend.isGM ? s.looseAspects() : [];
    const collect = loose.length ? `<div class="art-sect art-sect-info art-collect">${icon("circle-info")}
        <span>${esc(this.t("ART.Aspect.looseFound", { n: loose.length }))}</span>
        <button type="button" class="art-btn art-sm" data-action="collectLoose" title="${esc(loose.slice(0, 12).map(x => x.name).join(", "))}">${icon("file-import")} ${esc(this.t("ART.Aspect.collect"))}</button></div>` : "";
    const left = `${newbar}${tiles}${empty}`;
    const head = this.host ? "" : `<header class="art-head">${icon("art-star4")}<h3>${esc(this.t("ART.Aspect.title"))}</h3>
      <button type="button" class="art-icon-btn" data-action="toggleAspects" title="${esc(this.t("ART.Close"))}">${icon("xmark")}</button></header>`;
    const nA = all.filter(a => a.system?.kind === "aspect").length;
    const pill = `${esc(this.t("ART.Aspect.kindAspectsN"))}: <b>${nA}</b> · ${esc(this.t("ART.Aspect.kindStatusesN"))}: <b>${all.length - nA}</b>`;
    return `${head}<div class="art-body art-uw" data-scroll="aspects">${this.introHint("ART.Aspect.hint")}
      ${this.uStrip("aspectQ", q, this.t("ART.Aspect.find"), pill)}${collect}${this.uCols(left, this.renderAspectRight(), "aspects")}</div>`;
  },

  /** Пилюля предмета: значок и название; × убирает, щелчок открывает его в окне. */
  uItemPill(a, { remove = "", open = true } = {}) {
    const name = open ? `<button type="button" class="art-pill-name" data-action="pickAspect" data-id="${esc(a.id)}" title="${esc(this.t("ART.Aspect.openItem"))}">${esc(a.name)}</button>` : esc(a.name);
    return `<span class="art-pill">${this.uAspectPlate(a, " art-plate-xs")}${name}${remove
      ? `<button type="button" class="art-pill-x" data-action="${remove}" data-id="${esc(a.id)}" aria-label="${esc(this.t("ART.Aspect.detach"))}" title="${esc(this.t("ART.Aspect.detach"))}">${icon("xmark")}</button>` : ""}</span>`;
  },

  renderAspectRight() {
    const s = this.studio;
    const f = s.aspectForm;
    if ( !f ) return `<p class="art-empty">${esc(this.t("ART.Aspect.pick"))}</p>`;
    const can = s.canEditAspects();
    const dis = can ? "" : "disabled";
    const items = s.aspects();
    const item = f.id ? s.aspectById(f.id) : null;
    const preview = { system: { icon: f.icon, emoji: f.emoji, tint: f.tint, color: f.color, kind: f.kind, steps: f.steps, start: f.start } };
    const t = (k, d) => this.t(k, d);
    const isAspect = f.kind === "aspect";
    let hosts = "";
    if ( item ) {
      const list = s.aspectHosts(item.id);
      const kindName = st => this.t({ area: "ART.Aspect.onZone", object: "ART.Aspect.onMark", line: "ART.Aspect.onLine" }[st.system.kind] ?? "ART.Aspect.onZone");
      const rows = list.map(({ state: st, entry }) => {
        const lvl = entry.max ? `<span class="art-lvl">${esc(String(entry.value ?? 0))}/${esc(String(entry.max))}</span>` : "";
        return `<div class="art-irow"><button type="button" class="art-irow-main" data-action="focusFeature" data-id="${esc(st.id)}" title="${esc(this.t("ART.Catalog.show"))}">
          ${this.uFeatureIcon(st)}<span class="art-nm">${esc(st.name || this.t("ART.Card.unnamed"))}</span><span class="art-note">${esc(kindName(st))} ${lvl}</span></button>
          ${can ? `<button type="button" class="art-icon-btn" data-action="detachAspect" data-feature="${esc(st.id)}" data-id="${esc(item.id)}" title="${esc(this.t("ART.Aspect.detach"))}">${icon("xmark")}</button>` : ""}</div>`;
      }).join("");
      hosts = `${this.uLab(this.t("ART.Aspect.hostsOn"), list.length)}
        ${rows ? `<div class="art-irows art-resize" data-size="aspect-hosts" data-scroll="aspect-hosts">${rows}</div>` : `<p class="art-empty art-small">${esc(this.t("ART.Aspect.notHost"))}</p>`}`;
    }
    const seg = (action, values, cur, label) => `<div class="art-seg">${values.map(v => `<button type="button" class="art-btn${String(v) === String(cur) ? " active" : ""}" data-action="${action}" data-v="${v}" ${dis}>${esc(label(v))}</button>`).join("")}</div>`;
    const folders = s.folderGroups("aspect").filter(g => g.id);
    const fopts = [`<option value="">${esc(this.t("ART.Unified.noFolder"))}</option>`,
      ...folders.map(g => `<option value="${esc(g.id)}"${g.id === (f.folder ?? "") ? " selected" : ""}>${esc(g.name)}</option>`)].join("");
    // Похожие названия: новый не заводится вторым, а выбирается готовый.
    const similar = !f.id ? s.similarAspects(f.name) : [];
    const sim = similar.length ? `<div class="art-similar"><span class="art-muted art-small">${esc(this.t("ART.Aspect.similar"))}</span>
      ${similar.map(a => this.uItemPill(a)).join("")}</div>` : "";
    // Статусы аспекта или аспекты, в которые входит статус.
    let members = "";
    if ( isAspect ) {
      const byId = new Map(items.map(i => [i.id, i]));
      const pills = (f.statusIds ?? []).map(id => byId.get(id)).filter(Boolean).map(a => this.uItemPill(a, { remove: can ? "formStatusRemove" : "" })).join("");
      const open = !!s.aspectPick?.form;
      members = `<div class="art-sect art-sect-aspects">
        <div class="art-lab">${icon("list-check")} ${esc(this.t("ART.Aspect.statusesOf"))} <span class="art-cnt">${(f.statusIds ?? []).length}</span></div>
        <div class="art-chiprow">${pills}${can ? `<button type="button" class="art-btn art-sm art-dashed${open ? " active" : ""}" data-action="aspectPickOpen" data-form="1">${icon("plus")} ${esc(this.t("ART.Aspect.addStatus"))}</button>` : ""}</div>
        ${open ? this.uAspectPicker() : `<div class="art-muted art-small">${esc(this.t("ART.Aspect.statusesHint"))}</div>`}
      </div>`;
    } else if ( item ) {
      const parents = aspectsWith(item.id, items);
      members = `<div class="art-field"><span>${esc(this.t("ART.Aspect.inAspects"))}</span>
        ${parents.length ? `<div class="art-chiprow">${parents.map(a => this.uItemPill(a)).join("")}</div>` : `<p class="art-muted art-small">${esc(this.t("ART.Aspect.inNoAspect"))}</p>`}</div>`;
    }
    // Значок: эмодзи, простой значок или картинка из библиотеки и свой файл (как у меток).
    const simple = ASPECT_ICONS.map(ic => `<button type="button" class="art-aicon${!f.emoji && ic === f.icon ? " on" : ""}" data-action="aspectIcon" data-v="${ic}" ${dis} title="${esc(ic)}">${icon(ic)}</button>`).join("");
    const moreOpen = (this.wfOpen ??= new Set(["settings"])).has("aicon-more") || (isImageIcon(f.icon) && !f.emoji);
    const iconField = `<div class="art-field"><span>${esc(this.t("ART.Aspect.icon"))}</span>
      <div class="art-emoji-row"><label class="art-field art-inline"><span>${esc(this.t("ART.Type.emoji"))}</span>
        <input type="text" class="art-emoji-input" maxlength="8" data-model="aspectForm.emoji" data-key="af-emoji" value="${esc(f.emoji ?? "")}" placeholder="🔥" ${dis}></label>
        <span class="art-muted art-small">${esc(this.t("ART.Aspect.emojiHint"))}</span></div>
      <div class="art-aicons">${simple}</div>
      <details class="art-fold-inner" data-fold="aicon-more"${moreOpen ? " open" : ""}><summary>${icon("image")} ${esc(this.t("ART.Aspect.iconMore"))}</summary>
        ${can ? this.renderIconPicker(f, { model: "aspectForm", key: "af", pick: "aspectIconPick", cat: "aspectIconCat", browse: "aspectBrowse", defCat: "danger", title: false }) : ""}</details></div>`;
    const steps = `<div class="art-field"><span>${esc(this.t("ART.Aspect.steps"))}</span>
      <div class="art-steps"><input type="number" min="0" max="999" step="1" data-model="aspectForm.start" data-key="af-start" value="${esc(f.steps === "" ? "" : String(f.start ?? ""))}" placeholder="1" ${dis} aria-label="${esc(this.t("ART.Aspect.stepsNow"))}" title="${esc(this.t("ART.Aspect.stepsNow"))}">
        <span>/</span><input type="number" min="0" max="999" step="1" data-model="aspectForm.steps" data-key="af-steps" value="${esc(String(f.steps ?? ""))}" placeholder="—" ${dis} aria-label="${esc(this.t("ART.Aspect.stepsMax"))}" title="${esc(this.t("ART.Aspect.stepsMax"))}"></div></div>`;
    return `${this.uHead(this.uAspectPlate(preview, " art-plate-lg"), f.name || this.t(isAspect ? "ART.Aspect.newAspect" : "ART.Aspect.newStatus"), this.uChip(stepsLabel(preview, t), f.color || "#c9a45c"))}
      ${hosts}
      ${this.uLab(this.t("ART.Aspect.props"))}
      <label class="art-field"><span>${esc(this.t("ART.Field.name"))}</span>
        <input type="text" data-model="aspectForm.name" data-key="af-name" data-enter="saveAspect" value="${esc(f.name)}" ${dis} autocomplete="off"></label>
      ${sim}
      <label class="art-field"><span>${esc(this.t("ART.Field.text"))}</span>
        <textarea rows="2" data-model="aspectForm.description" data-key="af-desc" ${dis}>${esc(f.description ?? "")}</textarea></label>
      <div class="art-grid2 art-grid2-kind">
        <div class="art-field"><span>${esc(this.t("ART.Aspect.what"))}</span>${seg("aspectKind", ["aspect", "status"], f.kind, v => this.t(v === "aspect" ? "ART.Aspect.kindAspect" : "ART.Aspect.kindStatus"))}</div>
        ${steps}
      </div>
      <p class="art-hint">${esc(this.t("ART.Aspect.stepsHint"))}</p>
      ${members}
      ${iconField}
      <div class="art-grid2 art-grid2-even"><label class="art-field"><span>${esc(this.t("ART.Field.color"))}</span>${colorField(`data-model="aspectForm.color" ${dis}`, f.color || "#c9a45c", "af-color")}</label>
        <label class="art-field"><span>${esc(this.t("ART.Folder.one"))}</span><select data-model="aspectForm.folder" ${dis}>${fopts}</select></label></div>
      <div class="art-sect art-sect-info">${icon("circle-info")} <span>${esc(this.t("ART.Aspect.itemNote"))}</span></div>
      ${can ? this.uActions(`<button type="button" class="art-btn art-accent" data-action="saveAspect">${icon("check")} ${esc(this.t("ART.Save"))}</button><span class="art-sp"></span>
        ${f.id ? `<button type="button" class="art-btn art-danger art-icon-only" data-action="deleteAspect" data-id="${esc(f.id)}" title="${esc(this.t("ART.Aspect.delete"))}" aria-label="${esc(this.t("ART.Aspect.delete"))}">${icon("trash")}</button>` : ""}`)
        : `<p class="art-hint">${esc(this.t("ART.Aspect.readonly"))}</p>`}`;
  },

  /* ---------------------------------------------------------------- */
  /*  Полоса режимов                                                    */
  /* ---------------------------------------------------------------- */

  renderModes() {
    const s = this.studio;
    const presets = s.presets();
    const current = presets.find(p => p.id === s.activePreset())?.name ?? this.t("ART.Preset.manual");
    const mode = s.mode;
    return MODE_DEFS.map(m => {
      const on = m.id === "layers" ? !!s.layersOpen : mode === m.id;
      const label = this.t(`ART.Mode.${m.id}`);
      const badge = m.id === "players" ? this._queueBadge() : "";
      const preset = m.id === "layers" ? ` <b class="art-preset">${esc(current)}</b>` : "";
      return `<button type="button" class="art-mode${on ? " active" : ""}" data-action="setMode" data-mode="${m.id}" aria-pressed="${on}"
        title="${esc(`${label} · ${this.t(`ART.Mode.hint.${m.id}`)} (${m.key})`)}">${icon(m.icon)}<span>${esc(label)}</span>${preset}<kbd>${m.key}</kbd>${badge ? `<span class="art-badge">${badge}</span>` : ""}</button>`;
    }).join("");
  },

  /* ---------------------------------------------------------------- */
  /*  Быстрый осмотр 7А: плашка над гексом                              */
  /* ---------------------------------------------------------------- */

  renderQuickInspect() {
    const s = this.studio;
    const sum = s.summary();
    if ( !sum ) return "";
    const [i, j] = sum.cell;
    const owner = sum.owner ? this.backend.actors().find(a => a.id === sum.owner) : null;
    const facts = [sum.terrain?.name, sum.realm?.name ?? sum.region?.name, owner?.name].filter(Boolean);
    const what = sum.cells > 1
      ? `<b>${esc(this.t("ART.Card.hexes", { n: sum.cells }))}</b>`
      : `<b>${i}:${j}</b>${facts.length ? ` <span class="art-muted">${facts.map(esc).join(" · ")}</span>` : ""}`;
    const m = s.hudMenu;
    const btn = (action, ic, title, on = false) => `<button type="button" class="art-qbtn${on ? " on" : ""}" data-action="${action}" title="${esc(title)}" aria-label="${esc(title)}">${icon(ic)}</button>`;
    const n = sum.zones.length + sum.marks.length + sum.lines.length;
    // 1.0: под кнопками — аспекты и статусы меток гекса (если есть). Несколько меток — каждая со своим значком.
    const marks = sum.marks.map(m => s.stateOf(m.id) ?? m).filter(m => (m.system.statuses ?? []).some(x => x.name) || (m.system.aspects ?? []).some(x => x.name));
    const asp = marks.length ? `<div class="art-qi-asp">${marks.map(m => `<div class="art-qi-asp-row">${sum.marks.length > 1
      ? `<span class="art-qi-asp-who" title="${esc(m.name || this.t("ART.Card.unnamed"))}">${this.uFeatureIcon(m)}</span>` : ""}${this.statusChips(m, { limit: 10, nested: true })}</div>`).join("")}</div>` : "";
    const bar = `<div class="art-qi-bar${asp ? " art-qi-has-asp" : ""}"><div class="art-qi-row"><span class="art-qi-what">${what}</span><span class="art-qi-sep"></span>
      ${btn("hudMark", "location-dot", this.t("ART.Hud.markPick"), m?.kind === "type")}
      ${btn("hudZone", "draw-polygon", this.t("ART.Hud.zoneAdd"), m?.kind === "zone")}
      ${btn("hudLine", "route", this.t("ART.Hud.line"))}
      <span class="art-qi-sep"></span>
      <button type="button" class="art-qbtn art-qbtn-flat" data-action="hudDetails" title="${esc(this.t("ART.Hud.detailsN", { n }))}" aria-label="${esc(this.t("ART.Hud.details"))}">${icon("circle-info")}${n ? `<small>${n}</small>` : ""}</button></div>${asp}</div>`;
    let menu = "";
    if ( m?.kind === "type" ) {
      const q = m.q ?? "";
      const folders = new Map(s.folderGroups("object").filter(g => g.id).flatMap(g => g.items.map(t => [t.id, g.name])));
      const list = s.markTypesFor(q).slice(0, 8);
      const cur = s.mark.typeId;
      const rows = list.map(t => `<button type="button" class="art-menu-row${t.id === cur ? " active" : ""}" data-action="quickMark" data-id="${esc(t.id)}">
        ${this.uTypeIcon(t, " art-plate-sm")}<span>${mark(t.name, q)}</span><small class="art-muted">${esc(folders.get(t.id) ?? "")}</small></button>`).join("");
      menu = `<div class="art-hud-menu art-qi-menu" role="menu">${this._qiHead("ART.Hud.markPickShort", "object")}
        <input type="search" class="art-search" data-model="hudMenu.q" data-key="hud-mark-q" value="${esc(q)}" placeholder="${esc(this.t("ART.Hud.findMark"))}">
        ${rows || `<p class="art-empty">${esc(this.t("ART.Unified.nothingFound"))}</p>`}</div>`;
    } else if ( m?.kind === "zone" ) menu = this._hudZoneMenu(m);
    else if ( m?.kind === "delete" ) menu = this._hudMenu(sum, null);
    return `${bar}${menu}`;
  },

  /** Шапка меню быстрого осмотра с маленьким «+»: открыть полное окно с этим гексом. */
  _qiHead(title, kind) {
    return `<div class="art-menu-head"><span>${esc(this.t(title))}</span>
      <button type="button" class="art-plusb" data-action="toolHere" data-kind="${kind === "object" ? "mark" : "zone"}" title="${esc(this.t("ART.Hud.newHere"))}" aria-label="${esc(this.t("ART.Hud.newHere"))}">${icon("plus")}</button></div>`;
  },

  /* ---------------------------------------------------------------- */
  /*  Сжатая карточка гекса                                             */
  /* ---------------------------------------------------------------- */

  /** Строка элемента в карточке: значок, название, подпись, карандаш. Раскрыта — описание и значки. */
  renderCardItem(st, note = "") {
    const s = this.studio;
    const type = s.typeById(st.system.typeId);
    const owner = this.demiurgeNames(st);
    const draft = this.backend.isGM ? null : this.backend.draftOps().find(op => op.id === st.id);
    const open = s.openId === st.id;
    const edit = s.editId === st.id;
    const sub = [type?.name ?? "", note, owner].filter(Boolean).map(esc).join(" · ") + (draft ? ` · <em>${esc(this.t("ART.Card.inDraft"))}</em>` : "");
    const head = `<div class="art-citem-head">
      <button type="button" class="art-citem-main" data-action="openItem" data-id="${esc(st.id)}" aria-expanded="${open}">
        ${this.uFeatureIcon(st)}<b>${esc(st.name || this.t("ART.Card.unnamed"))}</b><span class="art-muted">${sub}</span></button>
      <button type="button" class="art-icon-btn${edit ? " active" : ""}" data-action="editItem" data-id="${esc(st.id)}" aria-pressed="${edit}"
        title="${esc(this.t(edit ? "ART.Card.editDone" : "ART.Card.edit"))}" aria-label="${esc(this.t("ART.Card.edit"))}">${icon(edit ? "check" : "pen")}</button></div>`;
    let body = "";
    if ( edit ) body = this.renderEditor(st, type);
    else if ( open ) {
      const text = htmlToText(st.text).trim();
      const chips = this.statusChips(st, { limit: 99, nested: true });
      const picking = s.aspectPick?.featureId === st.id;
      body = `<div class="art-citem-body">${text ? `<p class="art-citem-text">${esc(text)}</p>` : ""}
        <div class="art-chiprow">${chips}<button type="button" class="art-chip art-chip-add${picking ? " active" : ""}" data-action="aspectPickOpen" data-id="${esc(st.id)}"
          title="${esc(this.t("ART.Aspect.addTo"))}">${icon("plus")}<span>${esc(this.t("ART.Aspect.add"))}</span></button></div>
        ${picking ? this.uAspectPicker() : ""}</div>`;
    }
    return `<article class="art-citem${open || edit ? " open" : ""}" data-drop-feature="${esc(st.id)}">${head}${body}</article>`;
  },

  /**
   * Статусы и аспекты элемента в правке (1.0): строки со значком, названием и ступенями X/X.
   * Добавляются из общего списка «Статусы и аспекты» с поиском по названию; новое название заводится там же.
   * Внутрь аспекта статус кладётся его кнопкой «+ статус».
   */
  renderEntries(st) {
    const s = this.studio;
    const id = st.id;
    const p = s.aspectPick;
    const fld = (path, key) => `data-id="${esc(id)}" data-field="${esc(`${path}.${key}`)}" data-key="${esc(`${id}:${path}.${key}`)}"`;
    const row = (x, path, n, aspect) => {
      const g = this.uEntryGlyph(x, aspect);
      const base = `${path}.${n}`;
      const lvlPath = aspect ? "aspects" : path;
      const loose = !x.itemId || !s.aspectById(x.itemId);
      const remove = aspect
        ? `data-action="removeAspect" data-id="${esc(id)}" data-n="${n}"`
        : `data-action="removeStatus" data-id="${esc(id)}" data-path="${esc(path)}" data-n="${n}"`;
      return `<div class="art-erow${aspect ? " art-erow-aspect" : ""}">
        <span class="art-plate art-plate-sm" style="--c:${esc(g.color || (aspect ? "#8f7bb5" : "#c9a45c"))}">${g.html}</span>
        <span class="art-erow-name${loose ? " art-loose" : ""}" title="${esc(loose ? this.t("ART.Aspect.looseOne") : (x.description || x.name))}">${esc(x.name || this.t("ART.Card.unnamed"))}</span>
        <span class="art-steps art-steps-sm">
          <button type="button" class="art-icon-btn" data-action="stepLevel" data-id="${esc(id)}" data-path="${esc(lvlPath)}" data-n="${n}" data-delta="-1" title="−1" aria-label="−1">${icon("minus")}</button>
          <input type="number" class="art-num" value="${x.value ?? ""}" placeholder="—" ${fld(base, "value")} aria-label="${esc(this.t("ART.Aspect.stepsNow"))}">
          <span>/</span>
          <input type="number" class="art-num" value="${x.max ?? ""}" placeholder="—" ${fld(base, "max")} aria-label="${esc(this.t("ART.Aspect.stepsMax"))}">
          <button type="button" class="art-icon-btn" data-action="stepLevel" data-id="${esc(id)}" data-path="${esc(lvlPath)}" data-n="${n}" data-delta="1" title="+1" aria-label="+1">${icon("plus")}</button>
        </span>
        <button type="button" class="art-icon-btn" ${remove} title="${esc(this.t("ART.Aspect.detach"))}" aria-label="${esc(this.t("ART.Aspect.detach"))}">${icon("xmark")}</button></div>`;
    };
    const statuses = (st.system.statuses ?? []).map((x, n) => row(x, "statuses", n, false)).join("");
    const aspects = (st.system.aspects ?? []).map((a, n) => {
      const inner = (a.statuses ?? []).map((x, m) => row(x, `aspects.${n}.statuses`, m, false)).join("");
      const open = p?.featureId === id && p.aspectN === n;
      return `<div class="art-ebox">${row(a, "aspects", n, true)}
        <div class="art-ebox-in">${inner}
          <button type="button" class="art-link art-small${open ? " active" : ""}" data-action="aspectPickOpen" data-id="${esc(id)}" data-n="${n}">${icon("plus")} ${esc(this.t("ART.Aspect.addStatusInto"))}</button>
          ${open ? this.uAspectPicker() : ""}</div></div>`;
    }).join("");
    const openTop = p?.featureId === id && p.aspectN === null && !p.slot && !p.form;
    const empty = !statuses && !aspects ? `<p class="art-empty">${esc(this.t("ART.Card.noStatusesYet"))}</p>` : "";
    return `<section class="art-sub-block art-entries" data-drop-feature="${esc(id)}"><h5>${icon("art-star4")} ${esc(this.t("ART.Card.statusesAspects"))}
        <span class="art-sp"></span><button type="button" class="art-btn art-sm art-dashed${openTop ? " active" : ""}" data-action="aspectPickOpen" data-id="${esc(id)}">${icon("plus")} ${esc(this.t("ART.Aspect.add"))}</button></h5>
      ${openTop ? this.uAspectPicker() : ""}
      ${statuses}${aspects}${empty}
    </section>`;
  },

  /** Раздел карточки: «Зоны 2 [+]». «+» открывает окно инструмента с этим гексом. */
  uCardSection(key, list, note) {
    const s = this.studio;
    const plus = key === "lines"
      ? `<button type="button" class="art-icon-btn" data-action="hudLine" title="${esc(this.t("ART.Hud.line"))}">${icon("plus")}</button>`
      : `<button type="button" class="art-icon-btn" data-action="toolHere" data-kind="${key === "zones" ? "zone" : "mark"}" title="${esc(this.t("ART.Hud.newHere"))}">${icon("plus")}</button>`;
    const ic = { zones: "draw-polygon", marks: "location-dot", lines: "route" }[key];
    return `<section class="art-csec"><div class="art-lab">${icon(ic)} ${esc(this.t(`ART.Card.${key}`))} <span class="art-cnt">${list.length}</span><span class="art-sp"></span>${plus}</div>
      ${list.map(st => this.renderCardItem(s.stateOf(st.id) ?? st, note(st.id))).join("")}</section>`;
  },

  /* ---------------------------------------------------------------- */
  /*  Перетаскивание аспектов                                          */
  /* ---------------------------------------------------------------- */

  /** id предмета из перетаскивания: своя плитка или предмет из боковой панели Foundry. */
  _dropItemId(ev) {
    if ( this._dragAspect ) return this._dragAspect;
    let raw = "";
    try { raw = ev.dataTransfer?.getData("text/plain") ?? ""; } catch { raw = ""; }
    try {
      const d = JSON.parse(raw);
      if ( d.artariusAspect ) return d.artariusAspect;
      if ( d.type === "Item" && d.uuid ) return String(d.uuid).split(".").pop();
    } catch { /* не JSON */ }
    return null;
  },

  /** Плитки окна «Аспекты» тянутся; карточки и формы их принимают. */
  _bindAspectDrag(target) {
    target.addEventListener("dragstart", ev => {
      const el = ev.target.closest?.("[data-drag-aspect]");
      if ( !el ) return;
      this._dragAspect = el.dataset.dragAspect;
      // Как предмет Foundry: тогда его можно бросить и на холст, и в другие окна.
      ev.dataTransfer?.setData("text/plain", JSON.stringify({ type: "Item", uuid: `Item.${this._dragAspect}`, artariusAspect: this._dragAspect }));
      if ( ev.dataTransfer ) ev.dataTransfer.effectAllowed = "copy";
    });
    target.addEventListener("dragend", () => {
      this._dragAspect = null;
      for ( const x of document.querySelectorAll(".art-drop-on") ) x.classList.remove("art-drop-on");
    });
    const zone = ev => ev.target.closest?.("[data-drop-feature], [data-drop-slot]");
    target.addEventListener("dragover", ev => {
      const el = zone(ev);
      if ( !el ) return;
      ev.preventDefault();
      if ( ev.dataTransfer ) ev.dataTransfer.dropEffect = "copy";
      for ( const x of target.querySelectorAll(".art-drop-on") ) if ( x !== el ) x.classList.remove("art-drop-on");
      el.classList.add("art-drop-on");
    });
    target.addEventListener("dragleave", ev => {
      const el = zone(ev);
      if ( el && !el.contains(ev.relatedTarget) ) el.classList.remove("art-drop-on");
    });
    target.addEventListener("drop", ev => {
      const el = zone(ev);
      if ( !el ) return;
      const id = this._dropItemId(ev);
      this._dragAspect = null;
      el.classList.remove("art-drop-on");
      if ( !id ) return;
      ev.preventDefault();
      ev.stopPropagation();
      const s = this.studio;
      const run = el.dataset.dropFeature ? s.attachAspect(el.dataset.dropFeature, id) : Promise.resolve(s.addPending(el.dataset.dropSlot, id));
      Promise.resolve(run).catch(err => console.error("artarius | drop aspect", err));
    });
  },

  /* ---------------------------------------------------------------- */
  /*  Обработчики                                                       */
  /* ---------------------------------------------------------------- */

  unifiedActions() {
    const s = this.studio;
    return {
      newType: el => s.openTypeForm(el.dataset.kind),
      editType: el => s.openTypeForm(el.dataset.kind, el.dataset.id),
      cancelType: () => { s.typeForm = null; s.changed("ui"); },
      newFolder: el => s.newFolder(el.dataset.kind),
      folderMenu: el => s.toggleFolderMenu(el.dataset.kind, el.dataset.id),
      folderFold: el => {
        const key = `${el.dataset.kind}:${el.dataset.id}`;
        this.uShut ??= new Set();
        if ( this.uShut.has(key) ) this.uShut.delete(key); else this.uShut.add(key);
        this.render();
      },
      folderRename: el => s.renameFolder(el.dataset.kind, el.dataset.id),
      folderColor: el => s.colorFolder(el.dataset.kind, el.dataset.id, el.dataset.color),
      folderColorPick: el => s.colorFolder(el.dataset.kind, el.dataset.id, el.value),
      folderNewIn: el => s.newInFolder(el.dataset.kind, el.dataset.id),
      folderRemove: el => s.removeFolder(el.dataset.kind, el.dataset.id),
      formLabel: el => s.setFormLabel(el.dataset.slot, el.dataset.lkey, el.value),
      aspectPickOpen: el => s.toggleAspectPick({ slot: el.dataset.slot || null, featureId: el.dataset.id || null, aspectN: el.dataset.n ?? null, form: !!el.dataset.form }),
      aspectPickRow: el => s.pickFromList(el.dataset.id),
      aspectPickCreate: el => s.createFromPick(el.dataset.kind),
      // Enter в поиске: точное совпадение или единственная строка выбирается, иначе заводится новый статус.
      aspectPickEnter: () => {
        const q = String(s.aspectPick?.q ?? "").trim().toLowerCase();
        const list = s.pickList();
        const hit = list.find(i => i.name.trim().toLowerCase() === q) ?? (list.length === 1 ? list[0] : null);
        if ( hit ) return s.pickFromList(hit.id);
        const kinds = s.pickCreateKinds();
        if ( q && kinds.length ) return s.createFromPick(kinds[0]);
      },
      formStatusRemove: el => s.removeFormStatus(el.dataset.id),
      collectLoose: () => s.collectLoose(),
      pendingRemove: el => s.removePending(el.dataset.slot, el.dataset.id),
      openAspects: () => s.toggleAspects(true),
      toggleAspects: () => s.toggleAspects(),
      pickAspect: el => s.pickAspect(el.dataset.id),
      newAspect: el => s.newAspect("", el.dataset.kind || "status"),
      aspectKind: el => s.setAspectKind(el.dataset.v),
      aspectIcon: el => s.setAspectIcon(el.dataset.v),
      aspectIconPick: el => s.setAspectIcon(el.dataset.icon),
      aspectIconCat: el => { if ( s.aspectForm ) { s.aspectForm.iconCat = el.dataset.cat; s.aspectForm.iconQuery = ""; s.changed("ui"); } },
      aspectBrowse: () => this.backend.pickFile?.(isImageIcon(s.aspectForm?.icon) ? s.aspectForm.icon : "", path => s.setAspectIcon(path)),
      saveAspect: () => s.saveAspectForm(),
      deleteAspect: el => s.deleteAspect(el.dataset.id),
      seedAspects: () => s.seedAspects(),
      detachAspect: el => s.detachAspect(el.dataset.feature, el.dataset.id),
      pickLayer: el => s.pickLayer(el.dataset.id),
      newLayer: () => s.newLayer(""),
      layerLook: el => s.setLayerLook(el.dataset.id, el.dataset.look, el.value),
      layerLookReset: el => s.setLayerLook(el.dataset.id, el.dataset.look, ""),
      coastSet: el => s.setCoast(el.dataset.ckey, el.type === "checkbox" ? el.checked : (el.dataset.v ?? el.value)),
      coastReset: () => s.resetCoast(),
      editItem: el => s.editItem(el.dataset.id),
      hudLine: () => s.lineFromHere(),
      toolHere: el => s.openToolHere(el.dataset.kind),
      toggleLayerPanel: () => s.toggleLayers()
    };
  }
};
