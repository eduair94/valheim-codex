import { sql } from 'drizzle-orm';
import type { Db } from '@/lib/db/create-db';
import { saveTranslation, upsertArticle } from '@/lib/db/wiki-repo';
import type { ArticleDoc, ArticleInfobox, InfoboxGroup } from '@/lib/wiki/article-types';
import { slugify } from '@/lib/wiki/slug';

/**
 * A small corpus for the search and data layer, written by hand so each
 * article exists to prove one thing: a translation with a gloss, an accented
 * Old Norse name, a shield that stops at level 3, a creature with star tabs,
 * a recipe that needs an upgraded cauldron, a place whose biome is only in
 * its Location row.
 */

const icon = (name: string) =>
  `https://static.wikia.nocookie.net/valheim/images/a/a1/${name}.png/revision/latest?cb=20210215131319`;

const rows = (pairs: [string, string][]) => pairs.map(([label, value]) => ({ label, value }));
const group = (pairs: [string, string][], label = ''): InfoboxGroup => ({ label, rows: rows(pairs) });

function infobox(title: string, common: InfoboxGroup[], tabs: { label: string; groups: InfoboxGroup[] }[] = []): ArticleInfobox {
  return { title, image: { url: icon(title.replace(/\s/g, '_')), alt: title }, common, tabs };
}

type SeedArticle = {
  title: string;
  categories: string[];
  lead: string;
  chunks: { section?: string; content: string }[];
  infobox?: ArticleInfobox | null;
  facets?: ArticleDoc['facets'];
  translation?: { title: string; lead: string; infobox?: ArticleInfobox | null; stale?: boolean };
};

const swordTab = (level: string, durability: string) => ({
  label: level,
  groups: [group([['Durability', durability], ['Slash', String(Number(durability) / 5)]], 'Properties')],
});
const shieldTab = (level: string, durability: string) => ({
  label: level,
  groups: [group([['Durability', durability], ['Block armor', String(Number(durability) / 4)]], 'Properties')],
});

export const SEED: SeedArticle[] = [
  {
    title: 'Iron',
    categories: ['Materials', 'Metals'],
    lead: 'Iron is a metal smelted from scrap iron.',
    chunks: [{ content: 'Iron\nIron is a metal smelted from scrap iron at the Smelter.' }],
    infobox: infobox('Iron', [group([['Type', 'Metal'], ['Weight', '1.0']])]),
    facets: { type: 'Metal' },
    translation: { title: 'Hierro (Iron)', lead: 'El hierro es un metal que se funde a partir de chatarra.' },
  },
  {
    title: 'Iron Sword',
    categories: ['Weapons', 'Swords', 'Forge recipes'],
    lead: 'The iron sword is the second sword.',
    chunks: [{ content: 'Iron Sword\nThe iron sword is the second sword, crafted at the Forge.' }],
    infobox: infobox(
      'Iron Sword',
      [group([['Type', 'Sword'], ['Source', 'Forge'], ['Crafting Materials', 'Iron x20'], ['Weight', '0.8']])],
      [swordTab('1', '200'), swordTab('2', '250'), swordTab('3', '300'), swordTab('4', '350')],
    ),
    facets: { type: 'Sword', station: 'Forge' },
    translation: {
      title: 'Espada de hierro (Iron Sword)',
      lead: 'La espada de hierro es la segunda espada.',
      infobox: infobox(
        'Espada de hierro',
        [group([['Tipo', 'Espada'], ['Origen', 'Forja (Forge)'], ['Materiales de fabricación', 'Hierro (Iron) x20'], ['Peso', '0.8']])],
        [1, 2, 3, 4].map((n) => ({
          label: String(n),
          groups: [group([['Durabilidad', String(150 + n * 50)], ['Cortante', String((150 + n * 50) / 5)]], 'Propiedades')],
        })),
      ),
    },
  },
  {
    title: 'Black Metal Shield',
    categories: ['Weapons', 'Shields', 'Forge recipes'],
    lead: 'A shield of black metal.',
    chunks: [{ content: 'Black Metal Shield\nA shield of black metal, crafted at the Forge.' }],
    infobox: infobox(
      'Black Metal Shield',
      [group([['Type', 'Shield'], ['Source', 'Forge'], ['Crafting Materials', 'Black metal x8'], ['Weight', '5.0']])],
      [shieldTab('1', '200'), shieldTab('2', '250'), shieldTab('3', '300')],
    ),
    facets: { type: 'Shield', station: 'Forge' },
    translation: { title: 'Escudo de metal negro (Black Metal Shield)', lead: 'Un escudo de metal negro.', stale: true },
  },
  {
    title: 'Fire Arrow',
    categories: ['Weapons', 'Arrows'],
    lead: 'Fire arrows set the target alight.',
    chunks: [{ content: 'Fire Arrow\nFire arrows set the target alight.' }],
    infobox: infobox(
      'Fire Arrow',
      [group([['Type', 'Arrow'], ['Source', 'Workbench'], ['Crafting Materials', 'Wood x8'], ['Weight', '0.1']])],
      [{ label: '1', groups: [group([['Durability', '1'], ['Pierce', '22']])] }],
    ),
    facets: { type: 'Arrow', station: 'Workbench' },
  },
  {
    title: 'Troll',
    categories: ['Creatures'],
    lead: 'Trolls roam the Black Forest.',
    chunks: [{ content: 'Troll\nTrolls roam the Black Forest and drop troll hide.' }],
    infobox: infobox(
      'Troll',
      [group([['Type', 'Boss'], ['Main biome', 'Black Forest'], ['Weight', '-']])],
      ['0★', '1★', '2★'].map((label, i) => ({ label, groups: [group([['Durability', String(600 * (i + 1))]])] })),
    ),
    facets: { type: 'Boss', biome: 'Black Forest' },
  },
  {
    title: 'Eikthyr',
    categories: ['Creatures', 'Bosses'],
    lead: 'Eikthyr is the first boss.',
    chunks: [{ section: 'Summoning', content: 'Eikthyr › Summoning\nEikthyr is summoned at the Mystical altar with two deer trophies.' }],
    infobox: null,
  },
  {
    title: 'Jörmundling',
    categories: ['Trinket'],
    lead: 'Jörmundling is an Ashlands-tier trinket.',
    chunks: [{ content: 'Jörmundling\nJörmundling is an Ashlands-tier trinket.' }],
    infobox: null,
    translation: { title: 'Jörmundling', lead: 'El Jörmundling es un abalorio de las Tierras cenicientas.' },
  },
  {
    title: 'Thistle',
    categories: ['Materials'],
    lead: 'Thistle is a plant found in the Black Forest.',
    chunks: [{ content: 'Thistle\nThistle is a plant found in the Black Forest.' }],
    infobox: null,
    translation: { title: 'Cardo (Thistle)', lead: 'El cardo crece en el Bosque Negro y en el Pantano.' },
  },
  {
    title: 'Surtling Core',
    categories: ['Materials'],
    lead: 'Surtling cores are dropped by Surtlings.',
    chunks: [{ content: 'Surtling Core\nSurtling cores are dropped by Surtlings.' }],
    infobox: null,
    translation: { title: 'Núcleo de Surtling (Surtling Core)', lead: 'Los núcleos de Surtling los sueltan los Surtlings.' },
  },
  {
    title: 'Wolf Jerky',
    categories: ['Food', 'Cooking recipes'],
    lead: 'Wolf jerky needs an upgraded cauldron.',
    chunks: [{ content: 'Wolf Jerky\nWolf jerky needs a cauldron at level 3.' }],
    infobox: infobox('Wolf Jerky', [group([['Type', 'Food'], ['Source', 'Cauldron (level 3)'], ['Crafting Materials', 'Wolf meat x1']])]),
    facets: { type: 'Food', station: 'Cauldron (level 3)' },
  },
  {
    title: 'Carrot Soup',
    categories: ['Food', 'Cooking recipes'],
    lead: 'A soup of carrots.',
    chunks: [{ content: 'Carrot Soup\nA soup of carrots.' }],
    infobox: infobox('Carrot Soup', [group([['Type', 'Food'], ['Source', 'Cauldron'], ['Crafting Materials', 'Carrot x3']])]),
    facets: { type: 'Food', station: 'Cauldron' },
  },
  {
    title: 'Abandoned House',
    // Two of the wiki's bookkeeping categories, ahead of the real ones as the
    // banners put them: the search index must skip them before it cuts to three.
    categories: ['Unfinished', 'Points of interest', 'Work in progress', 'Structures', 'Meadows locations'],
    lead: 'A ruined house.',
    chunks: [{ content: 'Abandoned House\nA ruined house found in the Meadows.' }],
    infobox: infobox('Abandoned House', [group([['Type', 'Point of interest'], ['Location', 'Meadows']])]),
    facets: { type: 'Point of interest' },
  },
  {
    title: 'Workbench',
    categories: ['Crafting structures'],
    lead: 'The workbench is the first crafting station.',
    chunks: [{ content: 'Workbench\nThe workbench is the first crafting station.' }],
    infobox: null,
  },
  {
    title: 'Fishing (skill)',
    categories: ['Skills'],
    lead: 'Fishing is a skill.',
    chunks: [{ content: 'Fishing (skill)\nFishing is a skill.' }],
    infobox: null,
    translation: { title: 'Pesca (Fishing) (habilidad)', lead: 'La pesca es una habilidad.' },
  },
];

/** Writes the corpus: pages, chunks, articles, and translations (a stale one dated before its article). */
export async function seedSearchCorpus(db: Db): Promise<void> {
  for (const [i, article] of SEED.entries()) {
    const pageKey = `fandom:${1000 + i}`;
    const url = `https://valheim.fandom.com/wiki/${encodeURIComponent(article.title.replace(/ /g, '_'))}`;
    await db.execute(sql`
      INSERT INTO pages (key, source, page_id, title, url, revid)
      VALUES (${pageKey}, 'fandom', ${1000 + i}, ${article.title}, ${url}, 1)
      ON CONFLICT (key) DO NOTHING
    `);
    for (const [c, chunk] of article.chunks.entries()) {
      await db.execute(sql`
        INSERT INTO chunks (id, page_key, source, title, url, section_path, kind, content, token_count, content_hash)
        VALUES (${`${pageKey}:prose:${c}`}, ${pageKey}, 'fandom', ${article.title}, ${url}, ${chunk.section ?? ''},
                'prose', ${chunk.content}, ${Math.ceil(chunk.content.length / 4)}, ${`h-${pageKey}-${c}`})
      `);
    }
    const doc: ArticleDoc = {
      lead: article.lead,
      blocks: [],
      infobox: article.infobox ?? null,
      images: [],
      facets: article.facets ?? {},
    };
    await upsertArticle(db, {
      pageKey,
      source: 'fandom',
      title: article.title,
      slug: slugify(article.title),
      url,
      categories: article.categories,
      doc,
    });
    if (article.translation) {
      const { title, lead, infobox: box, stale } = article.translation;
      await saveTranslation(db, {
        pageKey,
        lang: 'es',
        title,
        doc: { lead, blocks: [], infobox: box ?? null, images: [], facets: {} },
        model: 'test',
        // A translation is stale when it predates its article.
        sourceUpdatedAt: stale ? new Date('2001-01-01T00:00:00Z') : new Date(Date.now() + 60_000),
      });
    }
  }
}
