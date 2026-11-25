const { fields } = foundry.data;

/**
 * Предмет «Аспект Artarius» (0.9.9): аспект или статус как отдельный документ Foundry.
 * Его можно сложить в папку, в компендиум, перенести в другой мир и перетащить на зону, метку или линию.
 * На элемент карты кладётся копия (название, значок, ступени) со ссылкой itemId.
 */
export default class AspectModel extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      /** aspect — аспект (может держать свои статусы), status — статус. */
      kind: new fields.StringField({ required: true, initial: "status", choices: ["aspect", "status"] }),
      /** Значок: имя Font Awesome без префикса ("sun") или путь к картинке ("modules/…/castle.svg"). */
      icon: new fields.StringField({ required: true, blank: true, initial: "" }),
      /** Эмодзи вместо значка (1.0). */
      emoji: new fields.StringField({ required: true, blank: true, initial: "" }),
      /** Красить картинку цветом предмета: белые значки библиотеки — да, свои картинки — нет (1.0). */
      tint: new fields.BooleanField({ initial: true }),
      color: new fields.StringField({ required: true, blank: true, initial: "#c9a45c" }),
      description: new fields.StringField({ required: true, blank: true, initial: "" }),
      /** Ступени: 0 — без уровня, иначе сколько всего (любое число до 999). */
      steps: new fields.NumberField({ required: true, integer: true, min: 0, max: 999, initial: 0 }),
      /** С какой ступени статус ложится на элемент: «1 / 5». Пусто — с первой (1.0). */
      start: new fields.NumberField({ required: false, nullable: true, integer: true, min: 0, initial: null }),
      /** Статусы аспекта: id предметов-статусов (1.0). Аспект ложится на элемент вместе с ними. */
      statusIds: new fields.ArrayField(new fields.StringField({ required: true, blank: false })),
      /** До 1.0: статус входил в один аспект, id предмета-аспекта. Читается и сейчас. */
      parentId: new fields.StringField({ required: true, blank: true, initial: "" }),
      /** Базовый статус, из которого предмет заведён (siege, fire…). */
      key: new fields.StringField({ required: true, blank: true, initial: "" })
    };
  }
}
