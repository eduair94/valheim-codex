import { getDb } from '@/lib/db/client';
import { getTitleIndex } from '@/lib/db/wiki-repo';

export const runtime = 'nodejs';

/**
 * The full title list, for search that runs in the browser.
 *
 * Sent once and cached: filtering a thousand titles locally is instant and
 * works offline, which a round trip per keystroke never can. It changes only
 * when the wiki is re-indexed, so it is safe to hold for a day and revalidate
 * in the background.
 */
export async function GET(): Promise<Response> {
  // Public, like the reader it serves: article text already published on a
  // public wiki, answered by one indexed query. Nothing here spends tokens.
  const db = await getDb();
  const entries = await getTitleIndex(db);

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
}
