import Link from 'next/link';
import { cookies } from 'next/headers';
import { getDb } from '@/lib/db/client';
import { listCategories, listFacetValues, type CategorySummary } from '@/lib/db/wiki-repo';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { strings } from '@/lib/i18n/strings';
import { categoryHref } from '@/lib/routes';

export const dynamic = 'force-dynamic';

/**
 * Browsing, for when you do not know what you are looking for.
 *
 * Three axes, because they answer three different questions: categories are
 * "what kind of thing", biomes are "what will I meet where I am going", and
 * stations are "what can I make at this bench".
 */
export default async function BrowsePage() {
  const db = await getDb();
  const [categories, biomes, stations, cookieStore] = await Promise.all([
    listCategories(db, 5),
    listFacetValues(db, 'biome'),
    listFacetValues(db, 'station'),
    cookies(),
  ]);
  const t = strings(parseLang(cookieStore.get(LANG_COOKIE)?.value));

  return (
    <div className="flex flex-col gap-8">
      <Facets title={t.wikiBiomes} items={biomes} param="biome" />
      <Facets title={t.wikiStations} items={stations} param="station" />
      <Section title={t.wikiCategories}>
        <ul className="flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <li key={c.name}>
              <Link
                href={categoryHref(c.name)}
                className="flex items-baseline gap-1.5 rounded-md border border-moss bg-peat px-2.5 py-1.5 text-sm text-birch/90 transition-colors hover:border-forge/40 hover:text-birch"
              >
                {c.name}
                <span className="font-mono text-[0.65rem] text-ash">{c.count}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2.5 flex items-center gap-3">
        <h2 className="label">{title}</h2>
        <span className="h-px flex-1 bg-moss" aria-hidden="true" />
      </div>
      {children}
    </section>
  );
}

function Facets({
  title,
  items,
  param,
}: {
  title: string;
  items: CategorySummary[];
  param: 'biome' | 'station';
}) {
  if (items.length === 0) return null;
  return (
    <Section title={title}>
      <ul className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li key={item.name}>
            <Link
              href={categoryHref('all', { [param]: item.name })}
              className="flex items-baseline gap-1.5 rounded-md border border-moss bg-peat px-2.5 py-1.5 text-sm text-birch/90 transition-colors hover:border-forge/40 hover:text-birch"
            >
              {item.name}
              <span className="font-mono text-[0.65rem] text-ash">{item.count}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}
