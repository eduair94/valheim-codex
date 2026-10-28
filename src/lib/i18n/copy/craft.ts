/**
 * Copy for crafting: the article's craft card, "Usado en", a station's
 * upgrades, and the planner ("Taller", `/wiki/craft`).
 *
 * Merged into `STRINGS` by `../strings.ts`. Keys added here override a base
 * key of the same name, so an area can reword its own existing copy without
 * touching the base table. Both languages must carry the same keys; the unit
 * test in `tests/unit/strings.test.ts` fails the build otherwise, and
 * `tests/unit/craft-copy.test.ts` checks that both languages have the same
 * placeholders.
 *
 * Placeholders are filled with `.replace`, which fills the first occurrence
 * only, so none appears twice in one string. A count that can be 1 has a
 * `…One` twin, as `articleStarOne` does, picked with `Intl.PluralRules`:
 * "1 vez", never "1 veces".
 */
export const CRAFT_COPY = {
  es: {
    // The card's heading, from how the recipe is made.
    craftMethodCraft: 'Fabricar',
    craftMethodBuild: 'Construir',
    craftMethodSmelt: 'Fundir',
    craftMethodCook: 'Cocinar',
    craftMethodBake: 'Hornear',
    craftMethodBrew: 'Elaborar',
    craftMethodFerment: 'Fermentar',
    craftMethodRefine: 'Refinar',
    craftMethodMill: 'Moler',
    craftMethodSpin: 'Hilar',
    craftMethodKiln: 'Quemar',
    craftMethodPrepare: 'Preparar',

    craftStationLevel: '{station} · nivel {n}',
    craftByHand: 'A mano',
    // A building piece is placed near its station rather than made at it.
    craftNear: 'Cerca de {station} · nivel {n}',

    craftModes: 'Qué mostrar',
    craftModeStep: 'Este nivel',
    craftModeTotal: 'Del 1 al {n}',
    craftModeRaw: 'Materias primas',

    craftQuantity: 'Cantidad',
    craftFewer: 'Uno menos',
    craftMore: 'Uno más',
    // A stepper that moves by a craft's yield: 20 nails at a time.
    craftStepFewer: '{n} menos',
    craftStepMore: '{n} más',
    craftYield: 'Rinde ×{n}',
    craftMakes: '{n} en total',

    // The totals line. At the first level the item is made, not upgraded.
    craftTotalsNew: 'Necesitás:',
    craftTotalsStep: 'Para subir al nivel {n}:',
    craftTotalsAll: 'Del nivel 1 al {n}:',
    craftTotalsRaw: 'Todo, en materias primas:',
    craftFuel: 'Combustible',
    craftSteps: 'Pasos intermedios',
    craftTimes: '{n} veces',
    craftTimesOne: '{n} vez',
    // The name follows "de" in both, so a plural or feminine name reads right ("Clavos de bronce").
    craftUnknownYield: 'La wiki no dice cuántas unidades de {name} da la receta: el desglose se detiene ahí para no inventar un número.',
    // A cycle can close several recipes down the tree, not only in the item's own.
    craftCycle: 'La receta de {name} termina pidiendo el mismo objeto: el desglose se detiene ahí.',

    craftAdd: 'Agregar al taller',
    craftInList: 'En tu taller',
    craftOpen: 'Ver',
    craftAdded: 'Agregado al taller.',
    // The number is MAX_PLAN_ITEMS (`src/lib/craft/planner-store.ts`); a test keeps them equal.
    craftListFull: 'Tu taller está lleno (100 objetos). Quitá algo para sumar más.',

    craftUsedIn: 'Usado en',
    craftUsedInMore: 'Ver {n} más',
    craftUsedInLevel: 'nivel {n}',

    craftStationPath: 'Mejoras de la estación',
    craftStationBase: 'La estación sola llega al nivel 1; cada mejora construida cerca suma uno, en cualquier orden.',
    craftStationMax: 'Nivel máximo: {n}',
    craftStationMakes: 'Qué se fabrica acá',

    craftPageTitle: 'Taller',
    craftMetaTitle: 'Taller — Valheim Codex',
    craftPageLede: 'Armá tu lista, mirá cuánto te falta juntar y qué podés fabricar con lo que tenés.',
    craftSaved: 'Se guarda en este dispositivo.',
    // Storage blocked, or full: either way, what the page shows is lost when it closes.
    craftNotSaved: 'Este navegador no está guardando: los cambios se pierden al cerrar la página. Compartí tu lista para no perderla.',
    craftNoScript: 'El taller necesita JavaScript. Cada artículo sigue mostrando su receta sin él.',

    craftViewList: 'Mi lista',
    craftViewHave: 'Lo que tengo',
    craftAddLabel: 'Agregar al taller',
    craftAddPlaceholder: 'Espada de hierro, karve, hidromiel…',
    craftNoMatch: 'No hay nada que se fabrique con ese nombre.',
    // "Lo que tengo" searches every item, raw materials included.
    craftHaveNoMatch: 'No hay ningún objeto con ese nombre.',
    craftEmpty: 'Tu lista está vacía. Buscá algo arriba o tocá «Agregar al taller» en cualquier artículo.',

    craftLevel: 'Nivel',
    // A level saved by a build whose recipes went higher: shown as saved, never lowered.
    craftLevelAboveMax: 'Las recetas de ahora llegan hasta el nivel {n}.',
    craftFrom: 'Ya tengo',
    craftFromNone: 'Nada',
    craftRemove: 'Quitar {name}',
    craftClear: 'Vaciar lista',
    craftClearConfirm: 'Sí, vaciar',

    craftGather: 'Para juntar',
    craftDirect: 'Directo',
    craftGot: 'Lo tengo',
    craftHaveCount: 'Cuántos tenés de {name}',
    craftLeft: 'Te faltan {n} de {total}',
    craftLeftOne: 'Te falta {n} de {total}',
    craftDone: 'Tenés todo. ¡A fabricar!',

    // The shopping list's groups: how each material is had.
    craftObtainMine: 'Se mina',
    craftObtainChop: 'Se tala',
    craftObtainGather: 'Se recolecta',
    craftObtainDrop: 'Lo sueltan las criaturas',
    craftObtainLoot: 'Se encuentra',
    craftObtainFarm: 'Se cultiva',
    craftObtainFish: 'Se pesca',
    craftObtainBuy: 'Se compra',
    craftObtainOther: 'Otros',
    craftObtainMade: 'Se fabrica',

    craftStationsNeeded: 'Estaciones que necesitás',
    craftUnknownTargets: '{n} objetos de tu lista ya no están en las recetas: los guardamos por si vuelven.',
    craftUnknownTargetsOne: '{n} objeto de tu lista ya no está en las recetas: lo guardamos por si vuelve.',
    craftMissingSteps: 'La wiki no tiene las recetas de los niveles {levels} de {name}.',
    craftMissingStepsOne: 'La wiki no tiene la receta del nivel {levels} de {name}.',
    craftLeftover: 'sobran {n}',
    craftLeftoverOne: 'sobra {n}',

    craftHaveIntro: 'Anotá lo que tenés en el cofre y te decimos qué podés fabricar.',
    craftHaveAdd: 'Agregar material',
    craftCanNow: 'Podés fabricar ya',
    craftAlmost: 'Te falta poco',
    craftMissing: 'falta: {list}',

    craftShare: 'Compartir lista',
    // Where neither the share sheet nor the clipboard is there: the link, to copy by hand.
    craftShareLink: 'Enlace a tu lista',
    craftShareCopied: 'Enlace copiado.',
    // A list whose ids are too long for one link (`sharedCount` in src/lib/craft/share.ts).
    craftShareCut: 'El enlace lleva los primeros {n} de los {total} objetos de tu lista: el resto no entra.',
    craftShared: 'Te pasaron una lista con {n} objetos.',
    craftSharedOne: 'Te pasaron una lista con {n} objeto.',
    craftReplace: 'Reemplazar mi lista',
    craftMerge: 'Sumar a mi lista',
    craftCancel: 'Cancelar',

    craftLoading: 'Cargando recetas…',
    craftUnavailable: 'No se pudieron cargar las recetas.',
    craftRetry: 'Probá de nuevo',
  },
  en: {
    craftMethodCraft: 'Craft',
    craftMethodBuild: 'Build',
    craftMethodSmelt: 'Smelt',
    craftMethodCook: 'Cook',
    craftMethodBake: 'Bake',
    craftMethodBrew: 'Brew',
    craftMethodFerment: 'Ferment',
    craftMethodRefine: 'Refine',
    craftMethodMill: 'Mill',
    craftMethodSpin: 'Spin',
    craftMethodKiln: 'Burn',
    craftMethodPrepare: 'Prepare',

    craftStationLevel: '{station} · level {n}',
    craftByHand: 'By hand',
    craftNear: 'Near {station} · level {n}',

    craftModes: 'Show',
    craftModeStep: 'This level',
    craftModeTotal: 'Levels 1–{n}',
    craftModeRaw: 'Raw materials',

    craftQuantity: 'Quantity',
    craftFewer: 'One fewer',
    craftMore: 'One more',
    craftStepFewer: '{n} fewer',
    craftStepMore: '{n} more',
    craftYield: 'Makes ×{n}',
    craftMakes: '{n} in total',

    craftTotalsNew: 'You need:',
    craftTotalsStep: 'To reach level {n}:',
    craftTotalsAll: 'Levels 1 to {n}:',
    craftTotalsRaw: 'Everything, as raw materials:',
    craftFuel: 'Fuel',
    craftSteps: 'Steps in between',
    craftTimes: '{n} times',
    craftTimesOne: '{n} time',
    craftUnknownYield: 'The wiki does not say how many {name} one craft makes, so the breakdown stops there instead of guessing.',
    craftCycle: 'The recipe for {name} ends up needing the item itself, so the breakdown stops there.',

    craftAdd: 'Add to Craft',
    craftInList: 'In your list',
    craftOpen: 'View',
    craftAdded: 'Added to your list.',
    craftListFull: 'Your list is full (100 items). Remove something to add more.',

    craftUsedIn: 'Used in',
    craftUsedInMore: 'Show {n} more',
    craftUsedInLevel: 'level {n}',

    craftStationPath: 'Station upgrades',
    craftStationBase: 'The station alone is level 1; each upgrade built nearby adds one, in any order.',
    craftStationMax: 'Highest level: {n}',
    craftStationMakes: 'What is made here',

    craftPageTitle: 'Craft',
    craftMetaTitle: 'Craft — Valheim Codex',
    craftPageLede: 'Build your list, see what is left to gather and what you can make with what you have.',
    craftSaved: 'Saved on this device.',
    craftNotSaved: 'This browser is not saving: changes are lost when the page closes. Share your list to keep it.',
    craftNoScript: 'The planner needs JavaScript. Every article still shows its recipe without it.',

    craftViewList: 'My list',
    craftViewHave: 'What I have',
    craftAddLabel: 'Add to your list',
    craftAddPlaceholder: 'Iron sword, karve, mead…',
    craftNoMatch: 'Nothing craftable goes by that name.',
    craftHaveNoMatch: 'No item goes by that name.',
    craftEmpty: 'Your list is empty. Search above, or tap “Add to Craft” on any article.',

    craftLevel: 'Level',
    craftLevelAboveMax: 'The current recipes only go up to level {n}.',
    craftFrom: 'Already have',
    craftFromNone: 'Nothing',
    craftRemove: 'Remove {name}',
    craftClear: 'Clear list',
    craftClearConfirm: 'Yes, clear it',

    craftGather: 'To gather',
    craftDirect: 'Direct',
    craftGot: 'Got it',
    craftHaveCount: 'How many {name} you have',
    craftLeft: '{n} of {total} still to gather',
    craftLeftOne: '{n} of {total} still to gather',
    craftDone: 'You have everything. Go craft!',

    craftObtainMine: 'Mined',
    craftObtainChop: 'Chopped',
    craftObtainGather: 'Gathered',
    craftObtainDrop: 'Dropped by creatures',
    craftObtainLoot: 'Found',
    craftObtainFarm: 'Farmed',
    craftObtainFish: 'Fished',
    craftObtainBuy: 'Bought',
    craftObtainOther: 'Other',
    craftObtainMade: 'Crafted',

    craftStationsNeeded: 'Stations you need',
    craftUnknownTargets: '{n} items in your list are no longer in the recipes; they are kept in case they return.',
    craftUnknownTargetsOne: '{n} item in your list is no longer in the recipes; it is kept in case it returns.',
    craftMissingSteps: 'The wiki has no recipes for levels {levels} of {name}.',
    craftMissingStepsOne: 'The wiki has no recipe for level {levels} of {name}.',
    craftLeftover: '{n} left over',
    craftLeftoverOne: '{n} left over',

    craftHaveIntro: 'Note what is in your chests and see what you can make.',
    craftHaveAdd: 'Add a material',
    craftCanNow: 'You can make now',
    craftAlmost: 'Almost there',
    craftMissing: 'missing: {list}',

    craftShare: 'Share list',
    craftShareLink: 'Link to your list',
    craftShareCopied: 'Link copied.',
    craftShareCut: 'The link carries the first {n} of the {total} items in your list: the rest do not fit.',
    craftShared: 'Someone shared a list of {n} items.',
    craftSharedOne: 'Someone shared a list of {n} item.',
    craftReplace: 'Replace my list',
    craftMerge: 'Add to my list',
    craftCancel: 'Cancel',

    craftLoading: 'Loading recipes…',
    craftUnavailable: 'The recipes did not load.',
    craftRetry: 'Try again',
  },
} as const;
