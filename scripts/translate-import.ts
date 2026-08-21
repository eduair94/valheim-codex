import './_env';
import { readFileSync } from 'node:fs';
import { createDb } from '../src/lib/db/create-db';
import { getArticleBySlug, saveTranslation } from '../src/lib/db/wiki-repo';
import { applyStrings, extractStrings } from '../src/lib/wiki/translate';

/**
 * Applies a batch of translations produced outside the provider chain.
 *
 *   pnpm translate:import --in batch.json --model claude
 *
 * Expects what `translate:export` produced, with a `translations` array added
 * to each article. The strings are re-extracted from the database rather than
 * trusted from the file, so the slots they map to are computed here from the
 * article as it stands right now.
 *
 * An article whose translation count does not match its current string count
 * is skipped whole. That mismatch means the article changed since it was
 * exported, and applying the list anyway would shift every translation onto
 * the following field — a page that renders perfectly and describes the wrong
 * things, which is far worse than one still in English.
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const lang = flag('lang') ?? 'es';
const file = flag('in') ?? 'translate-batch.json';
const model = flag('model') ?? 'claude';

type Entry = { slug: string; translations: string[] };
const batch: Entry[] = JSON.parse(readFileSync(file, 'utf8'));

const handle = await createDb({ databaseUrl: process.env.DATABASE_URL });

let saved = 0;
const skipped: string[] = [];

for (const entry of batch) {
  const article = await getArticleBySlug(handle.db, entry.slug);
  if (!article) {
    skipped.push(`${entry.slug} (no existe)`);
    continue;
  }

  const extraction = extractStrings(article.doc, article.title);
  if (extraction.strings.length !== entry.translations.length) {
    skipped.push(
      `${entry.slug} (${entry.translations.length} traducciones para ${extraction.strings.length} cadenas)`,
    );
    continue;
  }

  const { doc, title } = applyStrings(article.doc, article.title, extraction, entry.translations);

  await saveTranslation(handle.db, {
    pageKey: article.pageKey,
    lang,
    title,
    doc,
    model,
    sourceUpdatedAt: article.updatedAt,
  });
  saved += 1;
}

console.log(`Guardados ${saved} de ${batch.length} artículos en "${lang}".`);
for (const line of skipped) console.log(`  omitido: ${line}`);

await handle.close();
