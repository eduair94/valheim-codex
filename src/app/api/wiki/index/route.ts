import { getLegacyTitleIndex, getSearchIndexData } from '@/lib/wiki/data';
import { logError } from '@/lib/log';

export const runtime = 'nodejs';

/**
 * The full title list, for search that runs in the browser.
 *
 * Sent once and cached: filtering a thousand titles locally is instant and
 * works offline, which a round trip per keystroke never can. It changes only
 * when the wiki is re-indexed, so it is safe to hold for a day and revalidate
 * in the background.
 *
 * `?v=2` is the current shape — Spanish names, icon paths, only the
 * categories a row shows (`getSearchIndex`). Without it the route answers in
 * the original shape, for a browser or service worker still holding the
 * previous build's script: the old code reading the new payload would show a
 * list of broken icons. The current search reads it too, as its offline
 * fallback: the service worker stores this URL when it installs.
 */
export async function GET(request: Request): Promise<Response> {
  // Public, like the reader it serves: article text already published on a
  // public wiki, answered by one indexed query. Nothing here spends tokens.
  const current = new URL(request.url).searchParams.get('v') === '2';

  try {
    const entries = current ? await getSearchIndexData() : await getLegacyTitleIndex();
    return Response.json(
      { entries },
      {
        headers: {
          // `public`, not `private`: the list is identical for every visitor now
          // that the reader needs no account, so the CDN in front can answer for
          // it. `s-maxage` is the long one — a browser rechecks hourly, the edge
          // holds it for a day, and it only changes on a re-index.
          'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
        },
      },
    );
  } catch (error) {
    logError('wiki-index', error, { current });
    return Response.json({ error: 'index_unavailable' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
