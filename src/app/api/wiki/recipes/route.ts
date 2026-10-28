import { encodeGraph } from '@/lib/craft/codec';
import { getRecipeGraphData } from '@/lib/craft/data';
import { logError } from '@/lib/log';

export const runtime = 'nodejs';

/**
 * The whole recipe graph, for the crafting planner, which works it out in
 * the browser and keeps it for offline use.
 *
 * Compact (`encodeGraph`): items as tuples, recipes pointing at items by
 * position. `{ v: 1, version, graph }`, where `version` names the graph's
 * content as the ingest built it; the names in it are the articles' names
 * today (`getRecipeGraphData`), and can be newer.
 *
 * The names and pictures travel in it, though the title index carries those
 * of every article: the planner names and pictures items from the graph
 * alone (`item-search.ts`, and the rows built on it). On the graph built
 * from the live wiki (853 items) they are 8.5 KB of the 30.3 KB this sends
 * gzipped, about the planner's budget of 30 KB; leaving them to the title
 * index would cost a reader who does not hold it 37.0 KB more, the index's
 * own weight.
 *
 * `?v=1` is the shape, and asking for it is required. Unlike the title
 * index, there is no older shape to fall back to, and a payload in a shape
 * the caller did not ask for would be decoded by code written for another:
 * a planner computing from a misread graph shows wrong numbers. A later
 * shape is served at `?v=2`, while `v=1` keeps answering for a release.
 *
 * Every answer but the graph is `no-store`: no graph written yet (503), a
 * stored graph no planner could read (503 as well: it is not served), a
 * database failure (500). A cache keeping one would go on answering it after
 * it was over.
 */

/**
 * The same caching as the title index (`/api/wiki/index?v=2`): the graph is
 * the same for every reader, so the CDN can answer for it, and it changes
 * only when the wiki is ingested again. A browser rechecks hourly, the edge
 * holds it for a day, and either may serve it for a week while it refills.
 */
const CACHEABLE = { 'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800' };

/** Errors are about this moment; no cache should keep them. */
const UNCACHEABLE = { 'Cache-Control': 'no-store' };

export async function GET(request: Request): Promise<Response> {
  // Public, like the reader it serves: recipes from a public wiki, answered
  // from the data cache. Nothing here spends tokens.
  if (new URL(request.url).searchParams.get('v') !== '1') {
    return Response.json({ error: 'version_required' }, { status: 400, headers: UNCACHEABLE });
  }

  try {
    const graph = await getRecipeGraphData();
    if (!graph) return Response.json({ error: 'recipes_unavailable' }, { status: 503, headers: UNCACHEABLE });
    return Response.json({ v: 1, version: graph.version, graph: encodeGraph(graph) }, { headers: CACHEABLE });
  } catch (error) {
    logError('wiki-recipes', error);
    return Response.json({ error: 'recipes_unavailable' }, { status: 500, headers: UNCACHEABLE });
  }
}
