/** Общие константы модуля. Файл не зависит от Foundry, его читают и тесты. */

export const MODULE_ID = "artarius";

/** Подтип страницы журнала для зоны, метки и линии. */
export const FEATURE_TYPE = `${MODULE_ID}.feature`;

/**
 * Три вида элементов карты. Внутренние имена остались с версии 0.1,
 * чтобы старые атласы читались без переноса:
 * area — зона (набор гексов), object — метка (на одном гексе), line — линия (точки).
 */
export const KINDS = ["object", "line", "area"];

/** Инструмент → вид элемента, который он создаёт. */
export const TOOL_KIND = { zone: "area", mark: "object", line: "line" };
export const KIND_TOOL = { area: "zone", object: "mark", line: "line" };

/** Режимы наложения зоны (с 0.3 решает слой, поле осталось для старых данных). */
export const BLENDS = ["replace", "overlay"];

/** Статусы заявки игрока. */
export const CLAIM_STATUS = {
  pending: "pending",     // ждёт решения мастера
  check: "check",         // мастер назначил проверку, ждём бросок
  rolled: "rolled",       // бросок сделан, мастер решает по результату
  rejected: "rejected",   // отклонена, игрок может вернуть её в черновик
  applied: "applied"      // принята и внесена в атлас
};

/** Вид по умолчанию для каждого вида элемента. Тип и сам элемент переопределяют поля поверх. */
export const DEFAULT_STYLES = {
  object: {
    icon: "modules/artarius/assets/icons/village.svg",
    color: "#e8d6c3",
    size: 0.62,           // доля размера гекса
    labelSize: 20,
    labelColor: "#fff0e0"
  },
  line: {
    color: "#5b8fd6",
    widthStart: 3,
    widthEnd: 8,
    outlineColor: "#1d2a3a",
    outlineWidth: 0,
    dash: 0,
    gap: 0,
    meander: 0.15,
    alpha: 1,
    labelSize: 0,
    labelColor: "#fff0e0"
  },
  area: {
    color: "#c96f4a",
    alpha: 0.35,
    borderColor: "",       // пусто — цвет зоны
    borderWidth: 3,
    borderAlpha: 0.95,
    labelSize: 26,
    labelColor: "#fff0e0"
  }
};

/**
 * Слои зон. В исключающем слое гекс принадлежит только одной зоне:
 * новая зона забирает гекс у старой. В свободном слое зоны могут перекрываться.
 * Порядок в списке — порядок рисования снизу вверх.
 */
export const STARTER_LAYERS = [
  { id: "terrain", name: "Местность", sort: 0, visible: true, exclusive: true },
  { id: "regions", name: "Области", sort: 1, visible: true, exclusive: true },
  { id: "politics", name: "Владения", sort: 2, visible: true, exclusive: true },
  { id: "phenomena", name: "Явления природы", sort: 3, visible: true, exclusive: false },
  { id: "overlay", name: "Прочее", sort: 4, visible: true, exclusive: false }
];

const terrain = (id, name, color) => ({
  id, kind: "area", name, layerId: "terrain",
  style: { color, alpha: 1, borderWidth: 0, labelSize: 0 }
});

/** Природные явления и бедствия: свободный слой, зоны с штриховкой поверх местности. */
const phenomenon = (id, name, color, pattern) => ({
  id, kind: "area", name, layerId: "phenomena",
  style: { color, alpha: 0.18, borderWidth: 3, labelSize: 18, pattern, patternColor: color }
});
export const PHENOMENA_TYPES = [
  phenomenon("hurricane", "Ураган", "#8fb4d9", "cross"),
  phenomenon("rockfall", "Шаткие скалы", "#9c8b7a", "dots"),
  phenomenon("wildfire", "Горящий лес", "#e0562f", "hatch"),
  phenomenon("flood", "Наводнение", "#4f8fd0", "vertical"),
  phenomenon("drought", "Засуха", "#d9a441", "dots"),
  phenomenon("quake", "Землетрясение", "#a35f3d", "crosshatch"),
  phenomenon("eruption", "Извержение", "#c2381f", "crosshatch"),
  phenomenon("blight", "Мор", "#7a8f3a", "hatch")
];

/** Типы, которые атлас получает при создании. Мастер может их менять и удалять, игроки добавляют свои. */
export const STARTER_TYPES = [
  terrain("plains", "Равнина", "#9bb164"),
  terrain("forest", "Лес", "#3f6b3a"),
  terrain("hills", "Холмы", "#a8975c"),
  terrain("mountains", "Горы", "#8a8079"),
  terrain("swamp", "Болото", "#5e6b4b"),
  terrain("desert", "Пустыня", "#dcc48e"),
  terrain("snow", "Снега", "#e4ecee"),
  terrain("water", "Вода", "#3c6f9e"),
  terrain("savanna", "Саванна", "#c8b45e"),
  terrain("jungle", "Тропический лес", "#2c6a3c"),
  terrain("taiga", "Тайга", "#3f5a4c"),
  terrain("tundra", "Тундра", "#a7ab92"),
  terrain("mangrove", "Мангры", "#4c6e58"),
  ...PHENOMENA_TYPES,
  { id: "realm", kind: "area", name: "Держава", layerId: "politics", style: { color: "#c96f4a", alpha: 0.28, borderWidth: 4 } },
  { id: "region", kind: "area", name: "Область", layerId: "regions", style: { color: "#d9c39a", alpha: 0.12, borderWidth: 2, labelSize: 20 } },
  { id: "city", kind: "object", name: "Город", style: { icon: "modules/artarius/assets/icons/castle.svg", color: "#f2e3c9" } },
  { id: "village", kind: "object", name: "Деревня", style: { icon: "modules/artarius/assets/icons/village.svg", color: "#e8d6c3", size: 0.5, labelSize: 16 } },
  { id: "fortress", kind: "object", name: "Крепость", style: { icon: "modules/artarius/assets/icons/military-fort.svg", color: "#d9c39a" } },
  { id: "temple", kind: "object", name: "Святилище", style: { icon: "modules/artarius/assets/icons/greek-temple.svg", color: "#f4d27a" } },
  { id: "ruins", kind: "object", name: "Руины", style: { icon: "modules/artarius/assets/icons/castle-ruins.svg", color: "#b9b2a6", size: 0.5 } },
  { id: "marker", kind: "object", name: "Отметка", style: { icon: "modules/artarius/assets/icons/flying-flag.svg", color: "#ff8562", size: 0.5 } },
  { id: "river", kind: "line", name: "Река", style: { color: "#5b8fd6", widthStart: 2, widthEnd: 9, meander: 0.2 } },
  { id: "road", kind: "line", name: "Дорога", style: { color: "#d8c3a0", widthStart: 3, widthEnd: 3, outlineColor: "#3a2d22", outlineWidth: 1, dash: 12, gap: 7, meander: 0.05 } },
  { id: "border", kind: "line", name: "Граница", style: { color: "#ff6a5a", widthStart: 3, widthEnd: 3, dash: 6, gap: 6, meander: 0 } }
];

/** Цвета для новых держав и областей: следующий берётся по кругу. */
export const REALM_COLORS = [
  "#d64545", "#3f7fd6", "#e0b23c", "#8e5bd6", "#2fa37a", "#e07b39", "#c2459c", "#5bb8d6", "#9bbf3a", "#7a5230"
];

/** Настройки сцены по умолчанию. */
export const WORLD_DEFAULTS = {
  enabled: false,
  baseColor: "#24496b",     // цвет пустого гекса: море
  gridColor: "#000000",
  gridAlpha: 0.18,
  rough: false              // неровные границы местности (данные всё равно по гексам)
};
