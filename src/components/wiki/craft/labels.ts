import type { RecipeMethod } from '@/lib/craft/types';
import type { Strings } from '@/lib/i18n/strings';

/**
 * The words the crafting surfaces put around a recipe, shared by the craft
 * card (a client island, which reads its table with `useStrings`) and the
 * server's sections (which use `strings(lang)`): each passes its own table.
 * Pure, and importing nothing but types, so the card carries no copy.
 */

/** The copy keys whose values are plain strings: the only ones a label can be. */
type TextKey = { [K in keyof Strings]: Strings[K] extends string ? K : never }[keyof Strings];

const METHOD_LABEL: Record<RecipeMethod, TextKey> = {
  craft: 'craftMethodCraft',
  build: 'craftMethodBuild',
  smelt: 'craftMethodSmelt',
  cook: 'craftMethodCook',
  bake: 'craftMethodBake',
  brew: 'craftMethodBrew',
  ferment: 'craftMethodFerment',
  refine: 'craftMethodRefine',
  mill: 'craftMethodMill',
  spin: 'craftMethodSpin',
  kiln: 'craftMethodKiln',
  prepare: 'craftMethodPrepare',
};

/** "Fabricar", "Construir", "Fundir": a recipe's heading, from how it is made. */
export function methodLabel(t: Strings, method: RecipeMethod): string {
  return t[METHOD_LABEL[method]];
}

/**
 * Where a step is made: "Forja · nivel 2", "Cerca de Banco de trabajo · nivel
 * 2" for a piece built beside its station, "A mano" with no station.
 *
 * The first level goes unsaid ("Forja", "Cerca de Banco de trabajo"): it is
 * the station as built, which its name already says, and on the many
 * stations with no levels at all (a smelter, a fermenter) "nivel 1" would
 * suggest an upgrade that does not exist.
 *
 * A piece with no station is built with the hammer, never "by hand": the
 * graph has no station for 66 pieces only because their list pages name
 * none (banners, chairs), and nothing here can tell those from a campfire,
 * which truly needs none. How it is built is what can be said of all of them.
 */
export function stationLabel(t: Strings, method: RecipeMethod, station: string | null, level: number): string {
  if (station === null) return method === 'build' ? t.craftWithHammer : t.craftByHand;
  const n = String(level);
  if (method === 'build') {
    return level > 1 ? t.craftNear.replace('{station}', station).replace('{n}', n) : t.craftNearStation.replace('{station}', station);
  }
  return level > 1 ? t.craftStationLevel.replace('{station}', station).replace('{n}', n) : station;
}
