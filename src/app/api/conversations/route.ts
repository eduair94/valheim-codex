import { getSession, unauthorizedResponse } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { listConversations } from '@/lib/db/repo';

export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const db = await getDb();
  const rows = await listConversations(db, session.profile);
  return Response.json({
    conversations: rows.map((r) => ({
      id: r.id,
      title: r.title,
      lang: r.lang,
      updatedAt: r.updatedAt.toISOString(),
    })),
  });
}
