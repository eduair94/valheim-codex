import { sql } from 'drizzle-orm';
import { rawQuery, type Db } from '@/lib/db/create-db';
import { getRecipeBasis, writeRecipeGraph } from '@/lib/db/recipe-repo';
import type { MediaWikiClient } from '@/lib/wiki/mediawiki';
import type { PageRecipes } from '@/lib/wiki/recipes';
import { slugify } from '@/lib/wiki/slug';
import type { WikiSource } from '@/lib/wiki/types';
import { assembleGraph, redirectTitles, type AssemblyPage, type AssemblyReport } from './assemble';
import { encodeGraph } from './codec';

/**
 * Builds the recipe graph from what the ingest stored, and stores it: how
 * every ingest run that changed a page's recipes ends, and all `pnpm ingest
 * --recipes` does once the recipes it reads are in.
 *
 * The recipes are read from the database rather than handed over by the run,
 * because the run that reads a page is not always the one that assembles: a
 * run that stopped partway, or whose assembly failed, leaves its recipes for
 * the next run to assemble (`isRecipeGraphBehind`), and that run may have
 * read nothing new. The wiki is asked about redirects once, for the titles
 * the recipes name (`redirectTitles`, about ten requests for the whole
 * wiki), since a link's title is often a redirect to the thing it means.
 *
 * Nothing is stored unless the whole graph is: readers keep the previous
 * graph until this one is written, in one statement.
 */

/** The graph a build stored: its version, and the report of what the assembly found. */
export type BuiltGraph = { version: string; report: AssemblyReport };

/**
 * Assembles a graph from every page's stored recipes and stores it as the
 * newest. `source` is the wiki asked about redirects; `builtAt` is the time
 * stamped on the graph, now unless a test says otherwise.
 *
 * Throws, storing nothing, when there are no recipes to assemble, when the
 * wiki cannot be asked about redirects, or when the graph comes out one no
 * reader could decode.
 */
export async function buildRecipeGraph(
  db: Db,
  client: MediaWikiClient,
  source: WikiSource,
  builtAt: string = new Date().toISOString(),
): Promise<BuiltGraph> {
  // Taken before the recipes are read, so that recipes another run stores
  // meanwhile count as newer than this graph (see `getRecipeBasis`).
  const basis = await getRecipeBasis(db);
  const { pages, recipesVersion } = await readStoredRecipes(db);
  const redirects = await client.fetchRedirects(source, redirectTitles(pages));
  const { graph, report } = assembleGraph(pages, redirects, builtAt);

  // A graph of nothing would take the place of the one readers have, and
  // every crafting card would go blank with it.
  if (graph.recipes.length === 0) throw new Error('no recipes to assemble: the graph would be empty');
  // The checks every reader's `decodeGraph` makes, made before the graph is
  // stored: a graph that names an item it lacks is refused by the server
  // that serves it, which then has no graph at all to serve.
  encodeGraph(graph);

  await writeRecipeGraph(db, graph, report, recipesVersion, basis);
  return { version: graph.version, report };
}

/**
 * Every page's stored recipes as the assembly takes them, with the page's
 * title and categories as the ingest last stored them, and the slug of its
 * article. A page `--recipes` found before any ordinary run derived its
 * article has none yet; it gets the slug its article will have, which the
 * ingest makes from the title the same way.
 *
 * Also the oldest extractor version that read any of them, which the graph
 * records as its own: the graph is as current as the oldest page in it.
 */
async function readStoredRecipes(db: Db): Promise<{ pages: AssemblyPage[]; recipesVersion: number }> {
  const rows = await rawQuery<{
    title: string;
    categories: string[] | null;
    slug: string | null;
    data: PageRecipes;
    recipes_version: number;
  }>(
    db,
    sql`SELECT p.title, p.categories, a.slug, r.data, r.recipes_version
        FROM page_recipes r
        JOIN pages p ON p.key = r.page_key
        LEFT JOIN articles a ON a.page_key = r.page_key`,
  );
  const pages = rows.map((row) => ({
    slug: row.slug ?? slugify(row.title),
    title: row.title,
    categories: row.categories ?? [],
    recipes: row.data,
  }));
  const versions = rows.map((row) => Number(row.recipes_version));
  return { pages, recipesVersion: versions.length > 0 ? Math.min(...versions) : 0 };
}
