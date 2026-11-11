# Artarius: API для модулей-расширений

Artarius задуман как основа: свои кнопки, данные и правила другие модули добавляют поверх, не меняя его код. Всё доступно через `game.modules.get("artarius").api`.

## Когда подключаться

```js
Hooks.once("artarius.init", api => {
  // api уже собран, мир ещё грузится: регистрируйте кнопки и слушатели здесь
});
Hooks.once("artarius.ready", api => {
  // мир загружен, игра идёт
});
```

## Кнопка в меню быстрых действий

```js
Hooks.once("artarius.init", api => {
  api.registerQuickAction({
    id: "my-module.weather",            // уникальный id, лучше с именем модуля
    module: "my-module",                // покажется в настройке меню
    label: "MYMOD.Weather",             // ключ перевода или просто текст
    icon: "fa-solid fa-cloud-sun",      // классы Font Awesome
    gmOnly: false,                      // true — только у мастера
    onClick: event => openWeather(),
    badge: () => pendingStorms(),       // число на кнопке, необязательно
    active: () => weatherOpen(),        // подсветка, необязательно
    visible: () => !!canvas.scene       // скрыть кнопку, необязательно
  });
});
```

Новая кнопка появляется в списке «Настроить меню». Игрок включает её глазом. Чтобы она была у всех сразу, мастер включает её у себя и жмёт «Сделать набором для всех».

`api.unregisterQuickAction(id)` убирает кнопку, `api.refreshQuickMenu()` перерисовывает меню, `api.quickActions` — все зарегистрированные кнопки.

## Свои данные у элементов карты

У каждого элемента есть поле `system.ext`. Artarius его не трогает. Храните свои данные под id своего модуля:

```js
const page = api.getAtlas().pages.get(featureId);
await page.update({ "system.ext.my-module": { morale: 7 } });
```

Импорт из Azgaar пишет в `system.ext.azgaar` номер и вид исходного объекта.

## Правки и заявки

| Хук | Когда | Аргументы |
|---|---|---|
| `artarius.preCommit` | перед записью правки; `return false` отменяет её | `op, { scene, direct }` |
| `artarius.commit` | правка записана: у мастера в атлас, у игрока в черновик | `op, { scene, direct }` |
| `artarius.claimsApplied` | мастер принял заявки | `entries` |
| `artarius.claimsRejected` | мастер отклонил заявки | `entries, comment` |
| `artarius.importAzgaar` | импорт из Azgaar закончен | `{ scene, atlas, data, built, removed }` |

`op` — это `{ action: "create" | "update" | "delete", id, state }`. `state` — `{ id, name, text, system }`. `entries` — `[{ user, claim }]`.

Окна модуля сделаны на ApplicationV2, поэтому Foundry сам зовёт хуки `renderFeatureSheet`, `renderClaimsApp`, `renderAtlasConfig`, `renderAzgaarApp`, `renderQuickMenuConfig`. Через них можно дописать в окно свои поля.

## Данные напрямую

`api.store` открывает функции хранилища:

- `getAtlas(scene)`, `ensureAtlas(scene)`: журнал атласа сцены;
- `getTypes(atlas)`, `setTypes(atlas, types)`, `getLayers(atlas)`, `setLayers(atlas, layers)`: типы и слои;
- `atlasStates(atlas)`: все элементы атласа, `effectiveStates(scene)`: то, что видит этот пользователь вместе с черновиком;
- `commit(op)`: записать правку так же, как это делает интерфейс: мастер сразу, игрок в черновик;
- `getDraft`, `getClaims`: черновик и заявки пользователя.

## Окна и действия

`openFeature(id)`, `openClaims()`, `openGuide()`, `openAtlasConfig()`, `openAzgaar()`, `openAzgaarGenerator()`, `openQuickMenuConfig()`, `findFeature()`, `activateLayer(tool)`, `layer()`, `refreshMap()`.

`importAzgaar(data, scene, { parts, image, setBackground, replace })` импортирует разобранный JSON из Azgaar без окна, например из макроса.

`api.version` растёт, когда API меняется несовместимо. Сейчас это 1.
