import { describe, expect, it } from 'vitest';
import { MAX_PLAN_ITEMS } from '@/lib/craft/planner-store';
import type { Obtain, RecipeMethod } from '@/lib/craft/types';
import { CRAFT_COPY } from '@/lib/i18n/copy/craft';
import { STRINGS } from '@/lib/i18n/strings';

/*
 * The words of the crafting surfaces (`src/lib/i18n/copy/craft.ts`): the
 * article's craft card, "Usado en", the station's upgrades and the planner.
 * `tests/unit/strings.test.ts` checks that both languages carry the same
 * keys; this checks what the craft area adds to that.
 */

const LANGS = ['es', 'en'] as const;

/** The key suffix for each way a recipe is made: a method added to the graph without a heading fails to compile here. */
const METHODS = {
  craft: 'Craft',
  build: 'Build',
  smelt: 'Smelt',
  cook: 'Cook',
  bake: 'Bake',
  brew: 'Brew',
  ferment: 'Ferment',
  refine: 'Refine',
  mill: 'Mill',
  spin: 'Spin',
  kiln: 'Kiln',
  prepare: 'Prepare',
} satisfies Record<RecipeMethod, string>;

/** The same for each way a material is had, which groups the shopping list. */
const HOWS = {
  mine: 'Mine',
  chop: 'Chop',
  gather: 'Gather',
  drop: 'Drop',
  loot: 'Loot',
  farm: 'Farm',
  fish: 'Fish',
  buy: 'Buy',
} satisfies Record<Obtain['how'], string>;

const placeholders = (text: string): string[] => (text.match(/\{\w+\}/g) ?? []).sort();

describe('craft copy', () => {
  it('heads a recipe for every way one is made', () => {
    for (const lang of LANGS) {
      for (const suffix of Object.values(METHODS)) expect(CRAFT_COPY[lang], `${lang}.craftMethod${suffix}`).toHaveProperty(`craftMethod${suffix}`);
    }
  });

  it('names a group for every way a material is had, for what the graph does not say, and for what is made', () => {
    for (const lang of LANGS) {
      for (const suffix of [...Object.values(HOWS), 'Other', 'Made']) {
        expect(CRAFT_COPY[lang], `${lang}.craftObtain${suffix}`).toHaveProperty(`craftObtain${suffix}`);
      }
    }
  });

  it('gives each string the same placeholders in both languages', () => {
    for (const [key, es] of Object.entries(CRAFT_COPY.es)) {
      const en = (CRAFT_COPY.en as Record<string, string>)[key] ?? '';
      expect(placeholders(en), key).toEqual(placeholders(es));
    }
  });

  it('uses each placeholder once, since `.replace` fills only the first', () => {
    for (const lang of LANGS) {
      for (const [key, text] of Object.entries(CRAFT_COPY[lang])) {
        const found = placeholders(text);
        expect(new Set(found).size, `${lang}.${key}`).toBe(found.length);
      }
    }
  });

  it('states the size of a full list as the store caps it', () => {
    for (const lang of LANGS) expect(CRAFT_COPY[lang].craftListFull).toContain(String(MAX_PLAN_ITEMS));
  });

  it('has words for what the planner does beyond the first table', () => {
    for (const lang of LANGS) {
      const copy = CRAFT_COPY[lang] as Record<string, string>;
      // A link that carries only part of a list says how much of it.
      expect(placeholders(copy.craftShareCut ?? ''), `${lang}.craftShareCut`).toEqual(['{n}', '{total}']);
      // A stepper that moves by a craft's yield says by how many.
      expect(placeholders(copy.craftStepFewer ?? ''), `${lang}.craftStepFewer`).toEqual(['{n}']);
      expect(placeholders(copy.craftStepMore ?? ''), `${lang}.craftStepMore`).toEqual(['{n}']);
      // "Lo que tengo" searches every item, so its empty result cannot speak of crafting.
      expect(copy.craftHaveNoMatch, `${lang}.craftHaveNoMatch`).toBeTruthy();
      expect(copy.craftHaveNoMatch).not.toBe(copy.craftNoMatch);
    }
  });

  it('names an item where its gender and number change nothing', () => {
    // "Clavos de bronce termina necesitándose a sí mismo" reads wrong: the name follows a preposition instead.
    for (const key of ['craftUnknownYield', 'craftCycle'] as const) expect(CRAFT_COPY.es[key], key).toMatch(/\bde \{name\}/);
  });

  it('reaches the table unchanged in both languages', () => {
    for (const lang of LANGS) {
      for (const [key, text] of Object.entries(CRAFT_COPY[lang])) {
        expect((STRINGS[lang] as Record<string, unknown>)[key], `${lang}.${key}`).toBe(text);
      }
    }
  });

  it('speaks to the reader as vos', () => {
    // The unambiguous tú forms; "busca" or "prueba" could be a third person or a noun.
    const tuteo = /\b(puedes|tienes|necesitas|quieres|sabes|eres|agrégala|compártela|quítalo)\b/i;
    for (const [key, text] of Object.entries(CRAFT_COPY.es)) expect(text, key).not.toMatch(tuteo);
  });
});
