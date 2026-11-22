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
      /** Значок Font Awesome без префикса: "sun", "shield". */
      icon: new fields.StringField({ required: true, blank: true, initial: "" }),
      color: new fields.StringField({ required: true, blank: true, initial: "#c9a45c" }),
      description: new fields.StringField({ required: true, blank: true, initial: "" }),
      /** Ступени: 0 — без уровня, иначе максимум (2, 3, 5…). */
      steps: new fields.NumberField({ required: true, integer: true, min: 0, max: 20, initial: 0 }),
      /** Статус может входить в аспект: id предмета-аспекта. */
      parentId: new fields.StringField({ required: true, blank: true, initial: "" }),
      /** Базовый статус, из которого предмет заведён (siege, fire…). */
      key: new fields.StringField({ required: true, blank: true, initial: "" })
    };
  }
}
