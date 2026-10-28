import type { InfoboxGroup } from '@/lib/wiki/article-types';
import type { IngredientTarget } from '@/lib/db/wiki-repo';
import type { Linker } from '@/lib/wiki/links';
import { isRecipeLabel } from '@/lib/wiki/recipe';
import type { Lang } from '@/lib/i18n/strings';
import { LinkedText } from '../linked-text';
import { Recipe } from '../recipe';
import { statLayout } from './infobox-model';

/** A stacked value past this is a sentence, which reads better across both columns of a tablet's pairs. */
const SENTENCE = 48;

/**
 * A block of stats: label left, value right, values monospaced so digits line
 * up down the column and can be compared without reading each row. A value
 * that is a sentence, or a list, drops below its label and reads as text.
 *
 * Nothing here clips. The list used to be `overflow-hidden` just to round its
 * corners, and silently cut off any value a long label pushed out (LM-01);
 * now the label wraps, the value keeps its room, and the corners are rounded
 * on the first and last rows instead (`.stat-list`, tables.css).
 *
 * Styled by short classes rather than utilities: an item with four upgrade
 * levels renders about a hundred rows, each sent twice (in the HTML and in
 * the payload React hydrates from).
 *
 * On a tablet the rows pair up in two columns, so a stat block uses the width
 * instead of putting its label and value 600px apart (LD-07); on a phone, and
 * in the narrow infobox column of a desktop, it is one column.
 */
export function StatGroup({
  group,
  lang,
  uiLang,
  ingredientTargets,
  recipeSources,
  linker,
}: {
  group: InfoboxGroup;
  lang: Lang;
  /** Set when the article is in another language than the interface. */
  uiLang?: Lang;
  ingredientTargets: Record<string, IngredientTarget>;
  recipeSources: Record<string, string>;
  linker: Linker;
}) {
  return (
    <section className="stat-group">
      {group.label ? <h3 className="label mb-2">{group.label}</h3> : null}
      <dl className={`stat-list ${group.rows.length > 1 ? 'stat-list-pairs' : ''}`}>
        {group.rows.map((row, i) => {
          /*
           * A recipe is the one row whose parts are separately findable
           * things, so it gets pictures and links rather than a value, and
           * the whole width of the block.
           */
          if (isRecipeLabel(row.label)) {
            return (
              <div key={i} className="stat-row stat-row-recipe stat-row-span">
                <dt className="label mb-2">{row.label}</dt>
                <dd>
                  <Recipe
                    value={row.value}
                    sourceValue={recipeSources[row.value]}
                    targets={ingredientTargets}
                    lang={lang}
                    uiLang={uiLang}
                  />
                </dd>
              </div>
            );
          }

          if (statLayout(row.label, row.value) === 'stacked') {
            return (
              <div key={i} className={`stat-row stat-stacked ${row.value.length > SENTENCE ? 'stat-row-span' : ''}`}>
                <dt>{row.label}</dt>
                <dd>
                  <LinkedText text={row.value} linker={linker} lines repair="value" />
                </dd>
              </div>
            );
          }

          return (
            <div key={i} className="stat-row stat-inline">
              <dt>{row.label}</dt>
              <dd>
                <LinkedText text={row.value} linker={linker} lines repair="value" />
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
