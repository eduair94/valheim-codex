import './_env';
import { writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { createDb, rawQuery } from '../src/lib/db/create-db';
import { getArticleBySlug } from '../src/lib/db/wiki-repo';
import { extractStrings } from '../src/lib/wiki/translate';

/**
 * Dumps untranslated articles as flat string lists, for translating by hand or
 * by an agent rather than by an API key.
 *
 *   pnpm translate:export --limit 12 --out batch.json
 *
 * The provider chain is metered in tokens per day and the corpus is a thousand
 * articles, so the API path translates the site over weeks. Whoever is already
 * reading this repository can translate a batch directly and skip the queue.
 *
 * The format is the same list `translate.ts` builds for a model: no structure,
 * no numbers, no identifiers. Nothing here can reshape an article, because
 * nothing here describes its shape.
 *
 * Smallest first, the opposite of the API job. That job runs unattended and
 * should spend its budget where it helps most; this one is done in batches by
 * someone waiting for it, and short articles mean more articles finished per
 * batch.
 */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const lang = flag('lang') ?? 'es';
const limit = Number(flag('limit') ?? '10');
const out = flag('out') ?? 'translate-batch.json';
const maxStrings = Number(flag('max-strings') ?? '0') || Number.POSITIVE_INFINITY;

const handle = await createDb({ databaseUrl: process.env.DATABASE_URL });

const pending = await rawQuery<{ slug: string; size: number }>(
  handle.db,
  sql`
    SELECT a.slug, length(a.lead) + length(a.blocks::text) AS size
    FROM articles a
    LEFT JOIN article_translations t
      ON t.page_key = a.page_key AND t.lang = ${lang}
    WHERE t.page_key IS NULL OR t.source_updated_at < a.updated_at
    ORDER BY size ASC
  `,
);

const batch: { slug: string; title: string; strings: string[] }[] = [];

for (const row of pending) {
  if (batch.length >= limit) break;

  const article = await getArticleBySlug(handle.db, row.slug);
  if (!article) continue;

  const { strings } = extractStrings(article.doc, article.title);
  if (strings.length === 0 || strings.length > maxStrings) continue;

  batch.push({ slug: article.slug, title: article.title, strings });
}

writeFileSync(out, JSON.stringify(batch, null, 1));

const total = batch.reduce((n, a) => n + a.strings.length, 0);
console.log(`${pending.length} artículos pendientes en "${lang}".`);
console.log(`Exportados ${batch.length} a ${out} — ${total} cadenas en total.`);

await handle.close();
