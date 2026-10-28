import type { Route } from 'next';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { Chat } from '@/components/chat';
import type { IndexInfo } from '@/components/sidebar';
import { hasChatIntent, loginHref, PUBLIC_HOME } from '@/lib/auth/access';
import { mayReindex } from '@/lib/auth/admin';
import { BYOK_MODELS, DEFAULT_BYOK_MODEL, keyHint } from '@/lib/auth/byok';
import type { ChatPrincipal } from '@/lib/auth/principal';
import { getChatPrincipal } from '@/lib/auth/principal-server';
import type { ChatAccount } from '@/lib/chat/account';
import { limitConversationRead } from '@/lib/chat-server/read-limit';
import { conversationFromParams } from '@/lib/chat/conversation-url';
import type { ConversationSummary } from '@/lib/chat/conversations';
import { toLoadedConversation, type LoadedConversation } from '@/lib/chat/history';
import { getDb, type Db } from '@/lib/db/client';
import { rawQuery } from '@/lib/db/create-db';
import { getConversation, listConversations, listRecentMessages } from '@/lib/db/repo';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
// The chat's own styles: answer prose, answer tables, citation chips. The shell's are in globals.css.
import '@/app/styles/prose.css';
import '@/app/styles/tables.css';
import '@/app/styles/chat.css';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

/** The query as it came, for sending a signed-out reader to sign in and back. */
function queryString(params: SearchParams): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of [value].flat()) if (typeof item === 'string') query.append(key, item);
  }
  return query.toString();
}

/**
 * What the browser may know about who is asking, field by field. A reader's
 * Gemini key never reaches a client component: only its last four characters.
 */
function accountFor(principal: ChatPrincipal): ChatAccount {
  switch (principal.kind) {
    case 'password':
      return { mode: 'password', profile: principal.profile };
    case 'byok':
      return {
        mode: 'byok',
        profile: principal.profile,
        keyHint: keyHint(principal.apiKey),
        model: principal.model,
        models: [...BYOK_MODELS],
        defaultModel: DEFAULT_BYOK_MODEL,
      };
    case 'puter':
      return { mode: 'puter', profile: principal.profile, name: principal.name };
  }
}

/**
 * The conversation `?c=` names, if it is this reader's: its newest messages,
 * within the same bounds as `GET /api/conversations/:id`, and whether older
 * ones were left out, so the thread can say so.
 */
async function openedConversation(db: Db, id: string | null, profile: string): Promise<LoadedConversation | null> {
  if (!id) return null;
  const [conversation, recent] = await Promise.all([
    getConversation(db, id, profile),
    listRecentMessages(db, id, profile),
  ]);
  return conversation ? toLoadedConversation(id, recent.messages, recent.truncated) : null;
}

/**
 * The chat shell.
 *
 * Conversations, index stats, the language preference and, for `?c=`, the
 * open conversation are all resolved here and handed down as props. Fetching
 * them from the client instead would add a request waterfall after first
 * paint and a flash of the wrong language — and a reload of a conversation
 * would open on an empty chat.
 */
export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;

  /*
   * Verified here as well as in the proxy: the proxy handles routing, this is
   * the gate that actually stands between a request and someone's model
   * bill. Any way of connecting opens the chat. Without one, the same rule as
   * the proxy: a visit to the bare domain (tracking parameters included) is
   * someone arriving at the site, and opens the reader; one carrying the
   * chat's own parameters was headed for the chat, and signs in first.
   */
  const principal = await getChatPrincipal();
  if (!principal) {
    if (hasChatIntent(params)) redirect(loginHref(`/?${queryString(params)}`) as Route);
    redirect(PUBLIC_HOME);
  }

  /*
   * Counted with `limitConversationRead`, as `GET /api/conversations/[id]`
   * counts its reads: a reload of `/?c=` reads the same megabyte, so it is
   * bounded too. One count for both only if read-limit.ts keeps its limiter
   * on `globalThis`, as `getDb` keeps its handle: Turbopack bundles that
   * module once for pages and once for route handlers, each copy with its
   * own module state, so a limiter kept there is one per bundle, and a
   * reader gets the ceiling twice (sixty page loads and sixty API reads a
   * minute, by default). Refused, the chat opens without the thread, and the
   * browser's own read of it says how long to wait.
   */
  const addressed = conversationFromParams(params);
  const requested = addressed && !limitConversationRead(principal.profile, await headers()) ? addressed : null;
  const db = await getDb();
  const [rows, statsRows, opened, cookieStore] = await Promise.all([
    listConversations(db, principal.profile),
    rawQuery<{ chunks: string; pages: string; last_indexed: string | null }>(
      db,
      sql`
        SELECT
          (SELECT count(*)::text FROM chunks) AS chunks,
          (SELECT count(*)::text FROM pages) AS pages,
          (SELECT max(indexed_at)::text FROM pages) AS last_indexed
      `,
    ),
    openedConversation(db, requested, principal.profile),
    cookies(),
  ]);

  const conversations: ConversationSummary[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    lang: r.lang,
    updatedAt: r.updatedAt.toISOString(),
  }));

  const statsRow = statsRows[0];
  const reindexAllowed = mayReindex(principal);
  const index: IndexInfo = {
    stats: {
      chunks: Number(statsRow?.chunks ?? 0),
      pages: Number(statsRow?.pages ?? 0),
      lastIndexedAt: statsRow?.last_indexed ?? null,
    },
    canTrigger: Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO) && reindexAllowed,
    mayReindex: reindexAllowed,
  };

  return (
    <Chat
      account={accountFor(principal)}
      initialLang={parseLang(cookieStore.get(LANG_COOKIE)?.value)}
      initialConversations={conversations}
      initialIndex={index}
      initialConversation={opened}
    />
  );
}
