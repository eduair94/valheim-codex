import { getSession, unauthorizedResponse } from '@/lib/auth/server';
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
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const db = await getDb();
  const entries = await getTitleIndex(db);

  return Response.json(
    { entries },
    {
      headers: {
        'Cache-Control': 'private, max-age=3600, stale-while-revalidate=86400',
      },
    },
  );
}
