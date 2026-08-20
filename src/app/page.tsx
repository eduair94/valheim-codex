import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { Chat } from '@/components/chat';
import { getSession } from '@/lib/auth/server';
import { PUBLIC_HOME } from '@/lib/auth/access';
import { getDb } from '@/lib/db/client';
import { rawQuery } from '@/lib/db/create-db';
import { listConversations } from '@/lib/db/repo';
import type { ConversationSummary, IndexInfo } from '@/components/sidebar';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';

export const dynamic = 'force-dynamic';

/**
 * The chat shell.
 *
 * Conversations, index stats and the language preference are all resolved
 * here and handed down as props. Fetching them from the client instead would
 * add a request waterfall after first paint and a flash of the wrong language,
 * and would put state updates inside effects.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ about?: string }>;
}) {
  // Verified here as well as in the proxy: the proxy handles routing, this is
  // the gate that actually stands between a request and the model bill.
  // Signed-out visitors go to the reader rather than a password prompt: they
  // are far likelier to have wanted the wiki than an account they do not have.
  const session = await getSession();
  if (!session) redirect(PUBLIC_HOME);

  const db = await getDb();
  const [rows, statsRows, cookieStore] = await Promise.all([
    listConversations(db, session.profile),
    rawQuery<{ chunks: string; pages: string; last_indexed: string | null }>(
      db,
      sql`
        SELECT
          (SELECT count(*)::text FROM chunks) AS chunks,
          (SELECT count(*)::text FROM pages) AS pages,
          (SELECT max(indexed_at)::text FROM pages) AS last_indexed
      `,
    ),
    cookies(),
  ]);

  // Set by "Ask about this" on an article, so the question arrives with its
  // subject already filled in rather than needing to be retyped.
  const { about } = await searchParams;

  const conversations: ConversationSummary[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    lang: r.lang,
    updatedAt: r.updatedAt.toISOString(),
  }));

  const statsRow = statsRows[0];
  const index: IndexInfo = {
    stats: {
      chunks: Number(statsRow?.chunks ?? 0),
      pages: Number(statsRow?.pages ?? 0),
      lastIndexedAt: statsRow?.last_indexed ?? null,
    },
    canTrigger: Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO),
  };

  return (
    <Chat
      profile={session.profile}
      initialLang={parseLang(cookieStore.get(LANG_COOKIE)?.value)}
      initialConversations={conversations}
      initialIndex={index}
      about={about?.slice(0, 120)}
    />
  );
}
