import { getChatPrincipal } from '@/lib/auth/principal-server';
import { logFailure } from '@/lib/chat-server/failure-log';
import { jsonError, privateJson } from '@/lib/chat-server/http';
import { getDb } from '@/lib/db/client';
import { listConversations } from '@/lib/db/repo';

export const runtime = 'nodejs';

/**
 * The signed-in reader's conversations, newest first. Any kind of reader:
 * history belongs to `principal.profile`, whoever pays for their model.
 */
export async function GET(): Promise<Response> {
  const principal = await getChatPrincipal();
  if (!principal) return jsonError(401, 'unauthorized');

  try {
    const db = await getDb();
    const rows = await listConversations(db, principal.profile);
    return privateJson({
      conversations: rows.map((r) => ({
        id: r.id,
        title: r.title,
        lang: r.lang,
        updatedAt: r.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    // A code the client can map, rather than an empty 500. Reduced: the
    // statement's one parameter is the reader's profile.
    logFailure('conversations', error, { stage: 'list' });
    return jsonError(503, 'unavailable', {}, { 'Retry-After': '30' });
  }
}
