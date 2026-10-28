import { decodeGraph, GraphShapeError } from './codec';
import { indexGraph, type GraphIndex } from './math';
import type { RecipeGraph } from './types';

/**
 * The whole recipe graph, downloaded by the planner once per page.
 *
 * Module scope rather than component state, as the search keeps its title
 * index (`src/components/wiki/search-view.tsx`): the planner unmounts
 * whenever the reader follows a link out of it, and coming Back must find the
 * graph in the first frame instead of downloading and indexing it again.
 *
 * Versioned (`v=1`): the route answers each shape at its own address, and
 * the service worker keeps this one for offline use, so a worker or a CDN
 * holding another shape never hands it to this code.
 */
export const GRAPH_URL = '/api/wiki/recipes?v=1';

/** The graph, indexed once for every computation the planner makes, and the version it was built as. */
export type LoadedGraph = { graph: RecipeGraph; index: GraphIndex; version: string };

/**
 * The route's answer, `{ v: 1, version, graph }` with the graph in its
 * compact form (`./codec.ts`), read into the graph and its version.
 *
 * Throws `GraphShapeError` for anything else: an error body, a newer shape,
 * a truncated cache entry. The planner then offers to try again, rather than
 * computing from a graph read halfway. The one place that knows the route's
 * envelope, so a change to it is made here.
 */
export function parseGraphResponse(body: unknown): { graph: RecipeGraph; version: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new GraphShapeError('the response is not an object');
  }
  const { v, version, graph } = body as Record<string, unknown>;
  if (v !== 1) throw new GraphShapeError(`response version ${JSON.stringify(v)}, this code reads 1`);
  if (typeof version !== 'string') throw new GraphShapeError('the response names no version');
  return { graph: decodeGraph(graph), version };
}

let loaded: LoadedGraph | null = null;
let loading: Promise<LoadedGraph> | null = null;

async function fetchGraph(): Promise<LoadedGraph> {
  const response = await fetch(GRAPH_URL);
  if (!response.ok) throw new Error(`recipes ${response.status}`);
  const { graph, version } = parseGraphResponse(await response.json());
  return { graph, index: indexGraph(graph), version };
}

/** The graph, downloaded once per page however many ask; a failure lets the next call try again. */
export function loadGraph(): Promise<LoadedGraph> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= fetchGraph().then(
    (graph) => {
      loaded = graph;
      loading = null;
      return graph;
    },
    (error: unknown) => {
      // Let the reader's retry try again, rather than failing for the life of the page.
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** The graph if it is already here, so a remounted planner can render it in its first frame. */
export function loadedGraph(): LoadedGraph | null {
  return loaded;
}
