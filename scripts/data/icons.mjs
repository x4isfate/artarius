/**
 * Встроенные значки меток: подборка из game-icons.net (CC BY 3.0, авторы в assets/icons/CREDITS.md).
 * Все значки белые, Foundry красит их цветом типа. Свои картинки берутся через FilePicker.
 * Чистый код без Foundry.
 */

export const ICON_ROOT = "modules/artarius/assets/icons";

/** Раздел → [имя файла, подпись для поиска]. */
export const ICON_LIBRARY = {
  resources: [
    ["wheat", "Зерно"], ["wood-pile", "Древесина"], ["log", "Бревно"], ["stone-pile", "Камень"], ["ore", "Руда"],
    ["gold-bar", "Золото"], ["gold-nuggets", "Самородки"], ["anvil", "Железо, кузня"], ["coal-wagon", "Уголь"],
    ["emerald", "Самоцветы"], ["crystal-cluster", "Кристаллы"], ["fishing", "Рыба"], ["cow", "Скот"], ["sheep", "Овцы, шерсть"],
    ["horse-head", "Лошади"], ["grapes", "Виноград"], ["wine-bottle", "Вино"], ["salt-shaker", "Соль"], ["hot-spices", "Пряности"],
    ["herbs-bundle", "Травы"], ["mushroom", "Грибы"], ["honeycomb", "Мёд"]
  ],
  settlements: [
    ["castle", "Замок"], ["capitol", "Столица"], ["village", "Деревня"], ["house", "Дом"], ["hut", "Хижина"],
    ["white-tower", "Башня"], ["watchtower", "Дозорная башня"], ["tower-flag", "Застава"], ["military-fort", "Форт"],
    ["hill-fort", "Городище"], ["castle-ruins", "Руины замка"], ["ancient-ruins", "Древние руины"], ["harbor-dock", "Гавань"],
    ["wooden-pier", "Пристань"], ["sailboat", "Корабль"], ["lighthouse", "Маяк"], ["mining", "Рудник"], ["barn", "Ферма"],
    ["windmill", "Мельница"], ["water-mill", "Водяная мельница"], ["stone-bridge", "Мост"], ["camping-tent", "Лагерь"],
    ["shop", "Рынок, лавка"], ["tavern-sign", "Таверна"]
  ],
  sacred: [
    ["greek-temple", "Храм"], ["church", "Церковь"], ["pagoda", "Пагода"], ["shinto-shrine", "Врата святилища"],
    ["fire-shrine", "Святилище огня"], ["crystal-shrine", "Кристальное святилище"], ["star-altar", "Алтарь"],
    ["obelisk", "Обелиск"], ["menhir", "Менгир"], ["dolmen", "Дольмен"], ["totem", "Тотем"], ["magic-portal", "Портал"],
    ["crystal-ball", "Оракул"], ["holy-symbol", "Святой символ"], ["ankh", "Анх"], ["tombstone", "Могила"]
  ],
  nature: [
    ["mountains", "Горы"], ["peaks", "Пики"], ["volcano", "Вулкан"], ["pine-tree", "Лес"], ["tree-face", "Древний лес"],
    ["swamp", "Болото"], ["cave-entrance", "Пещера"], ["whirlwind", "Буря"]
  ],
  danger: [
    ["dragon-head", "Дракон"], ["crowned-skull", "Король-лич"], ["death-skull", "Смерть, проклятие"], ["crossed-swords", "Битва"],
    ["shield", "Оборона"], ["campfire", "Стоянка"], ["flying-flag", "Флаг"], ["open-treasure-chest", "Сокровище"],
    ["crossroad", "Перекрёсток"], ["direction-signs", "Указатель"], ["scroll-unfurled", "Свиток, событие"],
    ["sword-in-stone", "Реликвия"], ["ship-wreck", "Кораблекрушение"]
  ]
};

export const iconPath = name => `${ICON_ROOT}/${name}.svg`;

/** Все значки списком: { path, name, label, category }. */
export function allIcons() {
  return Object.entries(ICON_LIBRARY).flatMap(([category, list]) =>
    list.map(([name, label]) => ({ path: iconPath(name), name, label, category })));
}

/** Значок из встроенной библиотеки (его можно красить без потерь). */
export const isLibraryIcon = path => String(path ?? "").includes("/assets/icons/") || String(path ?? "").includes("/assets/res/");

/** Поиск по подписи и имени файла, без учёта регистра. */
export function searchIcons(query) {
  const q = String(query ?? "").trim().toLowerCase();
  const all = allIcons();
  if ( !q ) return all;
  return all.filter(i => i.label.toLowerCase().includes(q) || i.name.includes(q));
}
