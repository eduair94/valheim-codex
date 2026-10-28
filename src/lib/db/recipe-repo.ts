import { desc, eq, sql } from 'drizzle-orm';
import { rawQuery, type Db } from './create-db';
import { recipeGraph } from './schema';
import type { GraphReport, RecipeGraph } from '@/lib/craft/types';
import { logWarn } from '@/lib/log';
import type { PageRecipes } from '@/lib/wiki/recipes';

/**
 * Where the recipe graph is kept between ingest runs (drizzle/0010): what the
 * extractor read from each page, and the graphs assembled from all of it.
 *
 * Every write is a single statement. Production reaches its database through
 * Neon's HTTP driver, which has no transactions, so whatever has to happen
 * together happens in one statement, and a run that stops between two of them
 * leaves nothing half written.
 */

/* -------------------------------------------------------------------------- */
/* Page recipes                                                                */
/* -------------------------------------------------------------------------- */

export type PageRecipesWrite = {
  pageKey: string;
  /** `RECIPES_VERSION` of the extractor that read the page. */
  recipesVersion: number;
  /** The page revision the recipes were read from. */
  revid: number;
  /** What the extractor read from the page (`extractRecipes`). */
  data: PageRecipes;
};

/**
 * Stores what the extractor read from one page, in place of whatever an
 * earlier run stored for it, and says whether this write changed the stored
 * recipes.
 *
 * Every page gets a row, whether it states a recipe or not, so the next run
 * knows it was read at this revision by this extractor and reads it again
 * only when one of them changes. The page's own row must already exist:
 * recipes for a page that is not stored could never be assembled, and the
 * foreign key refuses them.
 *
 * Most edits to a page leave its recipes alone. `updated_at` moves only when
 * they change, and only then is the answer true. The answer is about this
 * write alone, and never a reason to leave the graph as it is: an earlier run
 * may have stored a change and stopped before assembling it, after which
 * every write of that page answers false. Whether the graph is behind is for
 * `isRecipeGraphBehind` to say. The recipes as they were are read by the same
 * statement (`old`, which sees the table as it was before the write), so
 * nothing can come between the comparison and the write.
 */
export async function writePageRecipes(db: Db, row: PageRecipesWrite): Promise<boolean> {
  const rows = await rawQuery<{ changed: boolean }>(
    db,
    sql`
      WITH old AS (SELECT data FROM page_recipes WHERE page_key = ${row.pageKey})
      INSERT INTO page_recipes AS r (page_key, recipes_version, revid, data, updated_at)
      VALUES (${row.pageKey}, ${row.recipesVersion}, ${row.revid}, ${JSON.stringify(row.data)}::jsonb, now())
      ON CONFLICT (page_key) DO UPDATE SET
        recipes_version = EXCLUDED.recipes_version,
        revid = EXCLUDED.revid,
        data = EXCLUDED.data,
        updated_at = CASE WHEN r.data IS DISTINCT FROM EXCLUDED.data THEN EXCLUDED.updated_at ELSE r.updated_at END
      RETURNING r.data IS DISTINCT FROM (SELECT data FROM old) AS changed
    `,
  );
  return Boolean(rows[0]?.changed);
}

/** How a page's stored recipes were read: by which extractor, from which revision. */
export type RecipeState = { recipesVersion: number; revid: number };

/**
 * How every page of a source had its recipes read, keyed by page id. A page
 * missing from the map has never had its recipes read.
 */
export async function getRecipeStates(db: Db, source: string): Promise<Map<number, RecipeState>> {
  const rows = await rawQuery<{ page_id: number; recipes_version: number; revid: number }>(
    db,
    sql`SELECT p.page_id, r.recipes_version, r.revid
        FROM page_recipes r JOIN pages p ON p.key = r.page_key
        WHERE p.source = ${source}`,
  );
  return new Map(
    rows.map((r) => [Number(r.page_id), { recipesVersion: Number(r.recipes_version), revid: Number(r.revid) }]),
  );
}

/* -------------------------------------------------------------------------- */
/* Recipe graphs                                                               */
/* -------------------------------------------------------------------------- */

/** Graphs kept of each shape: the one served, and the two before it to fall back on. */
export const RECIPE_GRAPHS_KEPT = 3;

/**
 * The graph shape this code reads and writes (`RecipeGraph.v`). A newer
 * ingest can store a graph of a newer shape before the server that reads it
 * is deployed; this one goes on serving the newest graph it understands
 * meanwhile, rather than misreading the new one into wrong numbers.
 */
const GRAPH_SHAPE: RecipeGraph['v'] = 1;

/**
 * What a graph assembled from page_recipes as they stand would be built from:
 * a fingerprint of every page's stored recipes and of the revision each was
 * read from, the same for the same rows whatever order they were written in.
 *
 * The revision counts as well as the recipes because the graph also takes
 * from each page its title, its categories and the slug of its article, and a
 * page moved to a new title is a new revision whose recipes read the same. A
 * newer extractor that reads a page the same changes nothing here, since the
 * graph would come out the same. Computed by the database from what it
 * stores, so no clock enters into it and nothing large crosses the network:
 * about 15 ms for the whole wiki on PGlite.
 */
const RECIPES_BASIS = sql`(
  SELECT md5(coalesce(string_agg(page_key || ' ' || revid || ' ' || md5(data::text), ' ' ORDER BY page_key COLLATE "C"), ''))
  FROM page_recipes
)`;

/**
 * The basis of a graph assembled now (`RECIPES_BASIS`), to store with it.
 *
 * Taken before the pages are read for the assembly, not when the graph is
 * written. Recipes stored in between, by another run while this one fetches
 * redirects, then count as newer than the graph, and the next run assembles
 * them; a basis taken at the write would count them as part of a graph that
 * never saw them, and nothing would assemble them until the wiki changed
 * again.
 */
export async function getRecipeBasis(db: Db): Promise<string> {
  const rows = await rawQuery<{ basis: string }>(db, sql`SELECT ${RECIPES_BASIS} AS basis`);
  return rows[0]!.basis;
}

/**
 * Stores an assembled graph with its report as the newest of its shape, and
 * lets go of all but the newest RECIPE_GRAPHS_KEPT of that shape. `basis` is
 * what `getRecipeBasis` said before the graph's pages were read.
 *
 * One statement, so the graph is stored whole or not at all, and readers keep
 * the previous one until it is. The pruning is part of the same statement, so
 * a write that fails lets go of nothing. It sees the table as it was before
 * the insert, which is why it keeps one fewer than the limit, counting every
 * graph of the shape but this one. Graphs of another shape are never what
 * makes room: they are the newest a server reading that shape has.
 *
 * A graph whose version is already stored is the same content built again,
 * after the wiki went back to what it said then, or after pages were read
 * again without changing it. It takes the stored copy's place as the newest,
 * with this run's basis, instead of being ignored while a graph of what the
 * wiki said in between went on being served, or went on looking behind.
 *
 * `built_at` is the time the builder stamped on the graph, unless a stored
 * graph is already dated as late or later (a builder whose clock runs behind,
 * two writes within one millisecond): it is then a microsecond after the
 * latest one, so the graph written last is always the one served. Postgres
 * ignores the NULL `max()` gives an empty table.
 *
 * The graph is a few hundred kilobytes of JSON, sent as one text parameter.
 * Every value inserted is cast, so no type is left to be inferred through the
 * SELECT from parameters that both drivers send untyped.
 */
export async function writeRecipeGraph(
  db: Db,
  graph: RecipeGraph,
  report: GraphReport,
  recipesVersion: number,
  basis: string,
): Promise<void> {
  await db.execute(sql`
    WITH pruned AS (
      DELETE FROM recipe_graph
      WHERE shape = ${graph.v}
        AND version <> ${graph.version}
        AND version NOT IN (
          SELECT version FROM recipe_graph
          WHERE shape = ${graph.v} AND version <> ${graph.version}
          ORDER BY built_at DESC, version DESC
          LIMIT ${RECIPE_GRAPHS_KEPT - 1}
        )
    )
    INSERT INTO recipe_graph (version, built_at, recipes_version, shape, basis, graph, report)
    SELECT ${graph.version}::text,
           GREATEST(${graph.builtAt}::timestamptz, max(built_at) + interval '1 microsecond'),
           ${recipesVersion}::integer,
           ${graph.v}::integer,
           ${basis}::text,
           ${JSON.stringify(graph)}::jsonb,
           ${JSON.stringify(report)}::jsonb
    FROM recipe_graph
    ON CONFLICT (version) DO UPDATE SET
      built_at = EXCLUDED.built_at,
      recipes_version = EXCLUDED.recipes_version,
      shape = EXCLUDED.shape,
      basis = EXCLUDED.basis,
      graph = EXCLUDED.graph,
      report = EXCLUDED.report
  `);
}

/**
 * Whether a run should assemble a new graph: true when there is no graph of
 * the shape this code serves, or when page_recipes no longer matches what the
 * newest one was assembled from (its basis).
 *
 * Asked of what is stored, never of what this run happened to write. A run
 * that stored new recipes and then stopped, or whose assembly failed, leaves
 * a next run that finds nothing new on the wiki and writes nothing new: only
 * the graph's basis still says that the graph is behind. Whatever a run does
 * write that could change the graph (a page read at a new revision, a page
 * gone) changes the basis as well, so this one question covers both.
 */
export async function isRecipeGraphBehind(db: Db): Promise<boolean> {
  const rows = await rawQuery<{ behind: boolean }>(
    db,
    sql`
      SELECT NOT EXISTS (
        SELECT 1 FROM (
          SELECT basis FROM recipe_graph
          WHERE shape = ${GRAPH_SHAPE}
          ORDER BY built_at DESC, version DESC
          LIMIT 1
        ) AS newest
        WHERE newest.basis = ${RECIPES_BASIS}
      ) AS behind
    `,
  );
  return Boolean(rows[0]?.behind);
}

export type StoredRecipeGraph = { graph: RecipeGraph; report: GraphReport };

const UNDEFINED_TABLE = '42P01';
const INSUFFICIENT_PRIVILEGE = '42501';

/** The SQLSTATE of a Postgres error, looking through the wrappers the drivers put around it. */
function sqlState(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * The graph to serve, with its report: the newest stored, of the shape this
 * code reads. Null until the first graph is written.
 *
 * Null as well, and said in the log, where the table is missing or the
 * database role may not read it. Deploys here are a pull and a rebuild and
 * nothing runs migrations, so a server can start before drizzle/0010 is
 * applied, or under an app role created without its grant; item pages must
 * go on working meanwhile, only without their crafting data.
 */
export async function getLatestRecipeGraph(db: Db): Promise<StoredRecipeGraph | null> {
  let rows: { graph: unknown; report: unknown }[];
  try {
    rows = await db
      .select({ graph: recipeGraph.graph, report: recipeGraph.report })
      .from(recipeGraph)
      .where(eq(recipeGraph.shape, GRAPH_SHAPE))
      .orderBy(desc(recipeGraph.builtAt), desc(recipeGraph.version))
      .limit(1);
  } catch (error) {
    const state = sqlState(error);
    if (state === UNDEFINED_TABLE) {
      logWarn('recipes', 'no recipe graph to serve: recipe_graph does not exist; apply drizzle/0010 with the owner credential');
      return null;
    }
    if (state === INSUFFICIENT_PRIVILEGE) {
      logWarn(
        'recipes',
        'no recipe graph to serve: this role may not read recipe_graph; with the owner credential, GRANT SELECT ON recipe_graph TO valheim_app',
      );
      return null;
    }
    throw error;
  }
  const row = rows[0];
  return row ? { graph: row.graph as RecipeGraph, report: row.report as GraphReport } : null;
}
