import { z } from 'zod';
import { getSession, unauthorizedResponse } from '@/lib/auth/server';
import { getDb } from '@/lib/db/client';
import { deleteConversation, getConversation, listMessages, renameConversation } from '@/lib/db/repo';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id } = await params;
  const db = await getDb();

  // Ownership is enforced by the query, so a guessed id reads nothing.
  const conversation = await getConversation(db, id, session.profile);
  if (!conversation) return Response.json({ error: 'not_found' }, { status: 404 });

  const rows = await listMessages(db, id);
  return Response.json({
    conversation: {
      id: conversation.id,
      title: conversation.title,
      lang: conversation.lang,
    },
    messages: rows.map((m) => ({
      id: m.id,
      role: m.role,
      parts: m.parts,
      citations: m.citations,
      createdAt: m.createdAt.toISOString(),
    })),
  });
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const { id } = await params;
  const db = await getDb();
  const deleted = await deleteConversation(db, id, session.profile);
  if (!deleted) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json({ ok: true });
}

const patchSchema = z.object({ title: z.string().min(1).max(120) });

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const session = await getSession();
  if (!session) return unauthorizedResponse();

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });

  const { id } = await params;
  const db = await getDb();
  if (!(await getConversation(db, id, session.profile))) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  await renameConversation(db, id, session.profile, parsed.data.title);
  return Response.json({ ok: true });
}
