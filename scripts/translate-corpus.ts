import './_env';
import { createDb } from '../src/lib/db/create-db';
import { rawQuery } from '../src/lib/db/create-db';
import { sql } from 'drizzle-orm';
import { getArticleBySlug, getTranslation, saveTranslation } from '../src/lib/db/wiki-repo';
import { translateArticle } from '../src/lib/wiki/translate';

/**
 * Translates the corpus a bit at a time, and picks up where it left off.
 *
 *   pnpm translate:es                 # until the budget runs out
 *   pnpm translate:es --limit 20      # at most twenty articles
 *   pnpm translate:es --lang es
 *
 * The free tiers this runs on are measured in tokens per day — Groq allows
 * 200,000, which is roughly fifty articles — so translating a thousand
 * articles is not one job, it is a job run repeatedly over a couple of weeks.
 * That makes resumability the whole design: every article is committed as soon
 * as it is done, nothing is held in memory between articles, and a run that
 * dies halfway costs only the article it was on.
 *
 * Articles are taken largest-first. A long article is the one a reader is most
 * likely to be reading when they wish it were in their language, and it is
 * also the one they would wait longest for if it had to be translated on
 * demand.
 *
 * Stops on the first article where every provider refuses, rather than
 * grinding through the rest to fail identically: when the budget is gone it is
 * gone, and a hundred more failures only make the log harder to read.
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const lang = flag('lang') ?? 'es';
const limit = Number(flag('limit') ?? '0') || Number.POSITIVE_INFINITY;

const handle = await createDb({ databaseUrl: process.env.DATABASE_URL });

const pending = await rawQuery<{ slug: string; strings: number }>(
  handle.db,
  sql`
    SELECT a.slug,
           length(a.lead) + length(a.blocks::text) AS strings
    FROM articles a
    LEFT JOIN article_translations t
      ON t.page_key = a.page_key AND t.lang = ${lang}
    WHERE t.page_key IS NULL
       OR t.source_updated_at < a.updated_at
    ORDER BY strings DESC
  `,
);

console.log(`${pending.length} artículos sin traducir a "${lang}".`);
if (pending.length === 0) {
  await handle.close();
  process.exit(0);
}

let done = 0;
let stopped = '';

for (const row of pending) {
  if (done >= limit) break;

  const article = await getArticleBySlug(handle.db, row.slug);
  if (!article) continue;

  const started = Date.now();
  const { doc, title, model, failed } = await translateArticle(article.doc, article.title, lang);

  if (model === 'none') {
    // Not one string got through: every provider is out of budget.
    stopped = row.slug;
    break;
  }

  /*
   * A partial translation is still stored. Most of the article in Spanish
   * beats none of it, the untranslated strings stayed in English rather than
   * becoming wrong, and re-running later will not redo the ones that worked —
   * the article is only revisited when the wiki itself changes.
   */
  await saveTranslation(handle.db, {
    pageKey: article.pageKey,
    lang,
    title,
    doc,
    model,
    sourceUpdatedAt: article.updatedAt,
  });

  done += 1;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `  ${String(done).padStart(4)}. ${row.slug.padEnd(34)} ${seconds}s  ${model}` +
      (failed > 0 ? `  (${failed} cadenas quedaron en inglés)` : ''),
  );

  if (failed > 0) {
    // Budget is running out mid-article; the next one would mostly fail too.
    const check = await getTranslation(handle.db, article.pageKey, lang);
    if (!check) {
      stopped = row.slug;
      break;
    }
  }
}

console.log(`\nTraducidos ${done} artículos.`);
if (stopped) {
  console.log(
    `Se detuvo en "${stopped}": ningún proveedor tenía presupuesto.\n` +
      'Volvé a correrlo cuando los cupos se renueven; retoma donde quedó.',
  );
}

await handle.close();
