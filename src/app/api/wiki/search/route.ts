import { getDb } from '@/lib/db/client';
import { searchContent } from '@/lib/db/wiki-repo';

export const runtime = 'nodejs';

/**
 * Full-text search over article bodies.
 *
 * The companion to the client-side title search: titles are matched in the
 * browser, and this answers "the words I remember are in the article, not its
 * name".
 */
export async function GET(request: Request): Promise<Response> {
  // Public, like the reader it serves: article text already published on a
  // public wiki, answered by one indexed query. Nothing here spends tokens.
  const query = new URL(request.url).searchParams.get('q')?.slice(0, 200) ?? '';
  if (!query.trim()) return Response.json({ hits: [] });

  const db = await getDb();
  return Response.json({ hits: await searchContent(db, query) });
}
