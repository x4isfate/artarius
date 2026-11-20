# Artarius: API для модулей-расширений

Artarius задуман как основа: свои кнопки, данные и правила другие модули добавляют поверх, не меняя его код. Всё доступно через `game.modules.get("artarius").api`.

`api.version` растёт, когда API меняется несовместимо. С гекс-миром (0.3) это 2.

## Когда подключаться

```js
Hooks.once("artarius.init", api => {
  // api собран, мир ещё грузится: регистрируйте кнопки и слушатели здесь
});
Hooks.once("artarius.ready", api => {
  // мир загружен, панели на месте
});
```

## Кнопка в группе Артария

```js
Hooks.once("artarius.init", api => {
  api.registerQuickAction({
    id: "my-module.weather",            // уникальный id, лучше с именем модуля
    label: "MYMOD.Weather",             // ключ перевода или просто текст
    icon: "cloud-sun",                  // имя Font Awesome или классы "fa-solid fa-cloud-sun"
    gmOnly: false,                      // true — только у мастера
    onClick: () => openWeather(),
    visible: () => true                 // скрыть кнопку, необязательно
  });
});
```

Кнопка встаёт в группу Артария в колонке инструментов слева, после встроенных. `api.unregisterQuickAction(id)` её убирает.

## Сцена и инструменты

- `isWorldScene(scene?)`: включён ли на сцене режим Артария. `worldOf(scene?)`: настройки мира сцены (`enabled`, `baseColor`, `gridColor`, `gridAlpha`, `rough` — неровные берега).
- `sceneDims(scene?)`: размер поля `{ cols, rows, size }`. `resizeWorld({ cols, rows, size }, scene?)`: перестроить поле; зоны и метки переезжают, линии растягиваются, гексы за краем пропадают.
- `debugInput(on)`: писать в консоль каждое нажатие мыши на холсте (инструмент, активная группа, точка, гекс).
- `createWorldScene({ name, cols, rows, size })`: новая сцена с гекс-сеткой. Без аргумента спрашивает мастера.
- `setTool(tool)`: `"select" | "zone" | "mark" | "line"`, `null` убирает инструменты.
- `inspect([i, j])`: выбрать гекс, вокруг него встанет панель кнопок. Окно подробностей открывает `studio.openDetails(id?)`.
- `studio.markSlots()`: где на карте стоят метки (группы по гексам, как в Civ 5) и сколько их на каждом гексе. `studio.moveMark(id, [i, j])`: перенести метку на другой гекс.
- `showFeature(id)`: найти элемент, открыть его гекс и навести камеру.
- `layer()`: слой холста Артария. `refresh()`: перерисовать панели и холст.
- `studio`: состояние интерфейса (инструмент, выбор, панели). `backend`: доступ к данным Foundry, в том числе `backend.grid` с `cellAt`, `center`, `vertices`, `allCells`.

## Данные элементов

Зона, метка и линия — это страницы журнала атласа сцены. Состояние элемента: `{ id, name, text, system }`.

| `system.kind` | Что это | `system.geometry` |
|---|---|---|
| `area` | зона | `{ cells: [[i, j], …] }` |
| `object` | метка | `{ x, y, cell: [i, j] }` |
| `line` | линия | `{ points: [[x, y], …] }` |

Кроме этого: `typeId`, `layerId`, `demiurge` (id актёра), `statuses`, `aspects`, `style` (поверх вида типа), `links`, `ext`.

Поле `system.ext` Artarius не трогает. Храните свои данные под id своего модуля:

```js
const page = api.getAtlas().pages.get(featureId);
await page.update({ "system.ext.my-module": { morale: 7 } });
```

Импорт из Azgaar пишет в `system.ext.azgaar` номер и вид исходного объекта.

## Правки и заявки

| Хук | Когда | Аргументы |
|---|---|---|
| `artarius.preCommit` | перед записью правки; `return false` отменяет её | `op, { scene, direct }` |
| `artarius.commit` | правка записана: у мастера в атлас, у игрока в черновик | `op, { scene, direct, before }` |
| `artarius.claimsApplied` | мастер принял заявки | `entries, bases` |
| `artarius.claimsRejected` | мастер отклонил заявки | `entries, comment` |
| `artarius.importAzgaar` | импорт из Azgaar закончен | `{ scene, atlas, data, built, removed }` |

`op` — это `{ action: "create" | "update" | "delete", id, state }`. `entries` — `[{ user, claim }]`. `before` — элемент до правки мастера (у игрока нет). `bases` — `Map` id сцены → элементы атласа до применения заявок.

## Хранилище

`api.store` открывает функции хранилища:

- `getAtlas(scene)`, `ensureAtlas(scene)`: журнал атласа сцены;
- `getTypes(atlas)`: типы атласа вместе с личными типами игроков, `saveType(type)`, `deleteType(id)`;
- `getLayers(atlas)`, `setLayers(atlas, layers)`: слои;
- `atlasStates(atlas)`: все элементы атласа, `effectiveStates(scene)`: то, что видит этот пользователь вместе с черновиком;
- `commitOps(ops, scene)`: записать правки так же, как это делает интерфейс: мастер сразу, игрок в черновик;
- `getDraft`, `getClaims`: черновик и заявки пользователя.

## Окна

`openGuide()`, `openWorldSettings()`, `openAzgaar()`, `openAzgaarGenerator()`, `openGenerator()`.

`generateTestWorld({ seed, water, mountains, resources, realmCount, realms, clear, cols, rows, size, rough })` создаёт тестовый мир без окна. `cols`, `rows`, `size` перестраивают поле до генерации, `rough` включает неровные берега. `realms` — свои державы `[{ name, color, demiurge }]`, без них по державе на игрока. После генерации вызывается хук `artarius.generate` с `{ scene, atlas, built, removed }`. Элементы генератора помечены `system.ext.artariusGen = { seed, kind }`.

`importAzgaar(data, scene, { parts, replace, fit, cols })` импортирует разобранный JSON из Azgaar без окна, например из макроса. `parts`: `{ terrain, states, provinces, burgs, rivers, routes }`. `fit: true` подгоняет поле под пропорции карты: `cols` гексов по ширине, высота по карте.

## Вид карты

Что скрыто у пользователя, лежит в клиентской настройке `hiddenLayers`: id слоёв зон и виды элементов `@marks`, `@resources`, `@lines`, `@labels`. Ресурс — метка, у которой тип начинается с `res-`. `backend.hiddenIds()` и `backend.setHidden(ids)` читают и меняют этот список, `studio.applyPreset(id)` включает набор слоёв (`all`, `political`, `physical`, `resources`, `admin`, `terrain` или свой). Свои наборы лежат в `layerPresets`.

У типа метки в `style` есть `icon` (путь к картинке), `tint` (`false` — не красить картинку цветом типа) и необязательный `iconColor` (цвет значка, если он должен отличаться от цвета кольца). Встроенные значки лежат в `modules/artarius/assets/icons/`, их список с подписями — в `scripts/data/icons.mjs`.

У типа зоны в `style` есть штриховка: `pattern` (`none`, `hatch`, `crosshatch`, `cross`, `dots`, `vertical`), `patternColor`, `patternAlpha`.

## Что изменилось с API 1 (0.2)

- Нет `openFeature`, `openClaims`, `openAtlasConfig`, `openQuickMenuConfig`, `findFeature`, `activateLayer`, `refreshMap`, `quickActions`, `refreshQuickMenu`. Вместо них `showFeature`, `setTool`, `refresh`.
- Окна `FeatureSheet`, `ClaimsApp`, `AtlasConfig`, `QuickMenuConfig` убраны, их заменили панели поверх холста. Хуки `render…` для них больше не вызываются.
- `importAzgaar` больше не ставит картинку фоном: карта ложится на гексы.
