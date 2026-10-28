import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { rawQuery, type Db } from './create-db';
import { chunks, conversations, ingestRuns, pages, settings, type Citation } from './schema';
import { storableText } from '@/lib/chat-server/text';
import { isMessageOutcome, type MessageOutcome } from '@/lib/chat-types';
import type { WikiChunk } from '@/lib/wiki/types';

/* -------------------------------------------------------------------------- */
/* Pages and chunks                                                            */
/* -------------------------------------------------------------------------- */

export type StoredPage = { key: string; pageId: number; revid: number };

/** Revision ids already indexed for a source, keyed by page id. */
export async function getIndexedRevisions(db: Db, source: string): Promise<Map<number, StoredPage>> {
  const rows = await db
    .select({ key: pages.key, pageId: pages.pageId, revid: pages.revid })
    .from(pages)
    .where(eq(pages.source, source));
  return new Map(rows.map((r) => [r.pageId, r]));
}

/** Content hash -> embedding, for every chunk of a page. */
export async function getExistingEmbeddings(
  db: Db,
  pageKey: string,
): Promise<Map<string, string>> {
  const rows = await rawQuery<{ content_hash: string; embedding: string | null }>(
    db,
    sql`SELECT content_hash, embedding::text AS embedding FROM chunks WHERE page_key = ${pageKey}`,
  );
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.embedding) out.set(r.content_hash, r.embedding);
  }
  return out;
}

export type PageUpsert = {
  key: string;
  source: string;
  pageId: number;
  title: string;
  url: string;
  revid: number;
  categories: string[];
};

export async function upsertPage(db: Db, page: PageUpsert): Promise<void> {
  await db
    .insert(pages)
    .values({ ...page, fetchedAt: new Date(), indexedAt: new Date() })
    .onConflictDoUpdate({
      target: pages.key,
      set: {
        title: page.title,
        url: page.url,
        revid: page.revid,
        categories: page.categories,
        fetchedAt: new Date(),
        indexedAt: new Date(),
      },
    });
}

/**
 * Replaces every chunk of a page.
 *
 * Delete-then-insert rather than a diff: a page's chunk ids shift whenever a
 * section is added, so reconciling them individually is more code and more
 * ways to leave an orphan behind. Embeddings are still reused by content hash,
 * which is where the actual cost is.
 */
export async function replacePageChunks(
  db: Db,
  pageKey: string,
  rows: (WikiChunk & { embedding: string | null })[],
): Promise<void> {
  await db.delete(chunks).where(eq(chunks.pageKey, pageKey));
  if (rows.length === 0) return;

  /*
   * One statement per page rather than one per chunk.
   *
   * Against a local database the difference is invisible; against a managed
   * Postgres a round trip is ~150 ms, and a row-at-a-time insert turned a
   * full ingest into an hour. Batching cuts it to roughly a sixth.
   *
   * Batched at 50 rows so a page with an unusual number of sections cannot
   * approach the parameter limit.
   */
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const values = batch.map(
      (row) => sql`(${row.id}, ${row.pageKey}, ${row.source}, ${row.sourceRank}, ${row.title},
                    ${row.url}, ${row.sectionPath}, ${row.kind}, ${row.content}, ${row.tokenCount},
                    ${row.contentHash},
                    ${row.embedding === null ? null : sql`${row.embedding}::vector`})`,
    );

    await db.execute(sql`
      INSERT INTO chunks (id, page_key, source, source_rank, title, url, section_path, kind,
                          content, token_count, content_hash, embedding)
      VALUES ${sql.join(values, sql`, `)}
    `);
  }
}

/**
 * Removes pages that no longer exist upstream. Chunks cascade.
 *
 * The id list is passed as a single `int[]` literal rather than as one bound
 * parameter per id: Drizzle renders a JS array as a tuple, which Postgres
 * rejects for `ALL(...)`, and a thousand-parameter `IN` list would not survive
 * Neon's HTTP query size limit anyway.
 */
export async function deleteMissingPages(
  db: Db,
  source: string,
  livePageIds: number[],
): Promise<number> {
  if (livePageIds.length === 0) return 0;
  const ids = livePageIds.map(Number).filter(Number.isInteger);
  if (ids.length === 0) return 0;
  const literal = `{${ids.join(',')}}`;

  const rows = await rawQuery<{ count: string }>(
    db,
    sql`
      WITH deleted AS (
        DELETE FROM pages
        WHERE source = ${source} AND page_id <> ALL(${literal}::int[])
        RETURNING key
      )
      SELECT count(*)::text AS count FROM deleted
    `,
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Drops chunks from a lower-priority wiki that duplicate one from a preferred
 * wiki. A no-op while only one source is configured; it exists so adding a
 * second source does not double every answer's context.
 */
export async function dedupeAcrossSources(db: Db, threshold = 0.95): Promise<number> {
  const rows = await rawQuery<{ count: string }>(
    db,
    sql`
      WITH deleted AS (
        DELETE FROM chunks c
        USING chunks p
        WHERE c.source_rank > p.source_rank
          AND lower(c.title) = lower(p.title)
          AND c.embedding IS NOT NULL
          AND p.embedding IS NOT NULL
          AND (1 - (c.embedding <=> p.embedding)) > ${threshold}
        RETURNING c.id
      )
      SELECT count(*)::text AS count FROM deleted
    `,
  );
  return Number(rows[0]?.count ?? 0);
}

export async function countChunks(db: Db): Promise<number> {
  const rows = await rawQuery<{ count: string }>(db, sql`SELECT count(*)::text AS count FROM chunks`);
  return Number(rows[0]?.count ?? 0);
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export const EMBEDDING_PROVIDER_KEY = 'embedding_provider';

export async function getSetting(db: Db, key: string): Promise<string | null> {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

export async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

/** Drops every stored vector, so the next ingest recomputes them all. */
export async function clearEmbeddings(db: Db): Promise<void> {
  await db.execute(sql`UPDATE chunks SET embedding = NULL`);
}

/* -------------------------------------------------------------------------- */
/* Ingest runs                                                                 */
/* -------------------------------------------------------------------------- */

export type IngestRunStats = {
  pagesSeen: number;
  pagesChanged: number;
  chunksWritten: number;
  embeddingsComputed: number;
  errors: { title: string; message: string }[];
};

export async function startIngestRun(db: Db, id: string, trigger: string): Promise<void> {
  await db.insert(ingestRuns).values({ id, trigger, status: 'running', startedAt: new Date() });
}

export async function finishIngestRun(
  db: Db,
  id: string,
  status: 'ok' | 'failed',
  stats: IngestRunStats,
  durationMs: number,
): Promise<void> {
  await db
    .update(ingestRuns)
    .set({ status, finishedAt: new Date(), durationMs, ...stats })
    .where(eq(ingestRuns.id, id));
}

export async function latestIngestRuns(db: Db, limit = 5) {
  return db.select().from(ingestRuns).orderBy(desc(ingestRuns.startedAt)).limit(limit);
}

/* -------------------------------------------------------------------------- */
/* Conversations                                                               */
/* -------------------------------------------------------------------------- */

/*
 * Every query below names the profile that owns the conversation inside the
 * SQL itself, so a guessed or reused id reaches nothing that belongs to
 * someone else — not even for the moment between a check and a write.
 */

export async function listConversations(db: Db, profile: string, limit = 50) {
  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      lang: conversations.lang,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(eq(conversations.profile, profile))
    .orderBy(desc(conversations.updatedAt))
    .limit(limit);
}

/**
 * Fetches a conversation only if it belongs to this profile.
 *
 * Ownership is checked in the query rather than after loading, so a guessed id
 * cannot reach another profile's history even for a moment.
 */
export async function getConversation(db: Db, id: string, profile: string) {
  const rows = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.profile, profile)))
    .limit(1);
  return rows[0] ?? null;
}

/** Deletes a conversation (its messages cascade). False when there was nothing of this profile's to delete. */
export async function deleteConversation(db: Db, id: string, profile: string): Promise<boolean> {
  const rows = await db
    .delete(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.profile, profile)))
    .returning({ id: conversations.id });
  return rows.length > 0;
}

/**
 * Renames a conversation. False when it does not exist or is not this profile's.
 * The title is made storable here too, whoever calls (see `storableText`).
 */
export async function renameConversation(
  db: Db,
  id: string,
  profile: string,
  title: string,
): Promise<boolean> {
  const rows = await db
    .update(conversations)
    .set({ title: storableText(title), updatedAt: new Date() })
    .where(and(eq(conversations.id, id), eq(conversations.profile, profile)))
    .returning({ id: conversations.id });
  return rows.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

/*
 * Message ids.
 *
 * `messages.id` is one primary key across every conversation, and it used to
 * be whatever id the browser sent. A browser that reused an id — another tab,
 * an old client with a two-character generator — had its question silently
 * dropped by `ON CONFLICT DO NOTHING` while the answer was saved: production
 * had a conversation with an answer and no question. Ids are now built here
 * from the conversation id, so they are unique per conversation by
 * construction (see `storedMessageIds`), and a retry of the same message still
 * lands on the same row instead of adding another.
 *
 * Answers are keyed by their question, so a regenerated answer replaces the
 * failed or stopped one before it rather than piling up next to it.
 *
 * Every text is made storable on its way into a statement, whoever wrote it
 * (`storableText`). A model's answer can end on half a surrogate pair — a
 * stream cut between the two halves of an emoji — and the `::jsonb` cast
 * refuses a lone surrogate, on PGlite and Neon alike, as it refuses a NUL:
 * the whole answer row was lost, and the turn read back as a question nobody
 * answered.
 */

function outcomeOf(value: unknown): MessageOutcome {
  return isMessageOutcome(value) ? value : 'complete';
}

/** Postgres SQLSTATE of an error, looking through driver wrappers. */
function sqlState(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

let outcomeColumnEnsured = false;

/**
 * Runs a statement that reads or writes `messages.outcome`, adding the column
 * first if this database predates drizzle/0006.
 *
 * Deploys here are a pull and a rebuild; nothing runs migrations, and a
 * missing column would take the whole chat down with it. Same DDL as the
 * migration, so the migration still applies cleanly afterwards. A role that
 * may not alter the table fails here, loudly, as before.
 */
async function withOutcomeColumn<T>(db: Db, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // 42703: undefined_column.
    if (outcomeColumnEnsured || sqlState(error) !== '42703') throw error;
    await db.execute(sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'complete'`);
    outcomeColumnEnsured = true;
    return run();
  }
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export type StoredMessage = {
  id: string;
  role: 'user' | 'assistant';
  parts: unknown[];
  citations: Citation[];
  outcome: MessageOutcome;
  createdAt: Date;
};

/** Most messages one read of a conversation returns: the newest hundred turns. */
export const CONVERSATION_READ_MAX_MESSAGES = 200;

/**
 * Most bytes of message content (`parts` and `citations`, as JSON) one read
 * returns, give or take the newest message, which is always returned.
 */
export const CONVERSATION_READ_MAX_BYTES = 1_000_000;

export type MessageWindow = {
  /** Oldest first. */
  messages: StoredMessage[];
  /** Older messages exist that this window leaves out. */
  truncated: boolean;
};

/**
 * A conversation's newest messages, oldest first, only if it belongs to this
 * profile: at most `maxMessages`, and no more than `maxBytes` of content.
 *
 * Bounded because a whole conversation used to come back on every open,
 * however long it had grown. Guests can open conversations now, and a guest's
 * daily quota alone fills one with 150 turns of 12,000 characters — several
 * megabytes the database sent, and this process parsed and serialized again
 * on its only thread, per read. Bytes are counted as well as messages
 * because a message's size on the wire is not its length: JSON escapes some
 * characters in six bytes.
 *
 * Only the newest `maxMessages + 1` rows are measured (the one extra tells
 * whether older ones exist), and only the rows within budget leave the
 * database. A window that leaves older messages out opens on a question,
 * never on an answer whose question it left out.
 */
export async function listRecentMessages(
  db: Db,
  conversationId: string,
  profile: string,
  {
    maxMessages = CONVERSATION_READ_MAX_MESSAGES,
    maxBytes = CONVERSATION_READ_MAX_BYTES,
  }: { maxMessages?: number; maxBytes?: number } = {},
): Promise<MessageWindow> {
  const rows = await withOutcomeColumn(db, () =>
    rawQuery<{
      id: string;
      role: string;
      parts: unknown;
      citations: unknown;
      outcome: string | null;
      created_at: string | Date;
      available: number | string;
    }>(
      db,
      sql`
        WITH recent AS (
          SELECT m.id
          FROM messages m
          WHERE m.conversation_id = ${conversationId}
            AND EXISTS (
              SELECT 1 FROM conversations c WHERE c.id = ${conversationId} AND c.profile = ${profile}
            )
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT ${maxMessages + 1}
        ),
        measured AS (
          SELECT m.id, m.role, m.parts, m.citations, m.outcome, m.created_at,
                 row_number() OVER newest AS rn,
                 sum(octet_length(m.parts::text) + octet_length(m.citations::text)) OVER newest AS running
          FROM recent r
          JOIN messages m ON m.id = r.id
          WINDOW newest AS (ORDER BY m.created_at DESC, m.id DESC ROWS UNBOUNDED PRECEDING)
        )
        SELECT id, role, parts, citations, outcome, created_at, (SELECT count(*) FROM recent) AS available
        FROM measured
        WHERE rn <= ${maxMessages} AND (running <= ${maxBytes} OR rn = 1)
        ORDER BY created_at, id
      `,
    ),
  );

  let messages = rows.map((row): StoredMessage => {
    const parts = jsonValue(row.parts);
    const citations = jsonValue(row.citations);
    return {
      id: row.id,
      role: row.role === 'assistant' ? 'assistant' : 'user',
      parts: Array.isArray(parts) ? parts : [],
      citations: Array.isArray(citations) ? (citations as Citation[]) : [],
      outcome: outcomeOf(row.outcome),
      createdAt: new Date(row.created_at),
    };
  });
  const truncated = messages.length < Number(rows[0]?.available ?? 0);
  if (truncated && messages.length > 1 && messages[0]?.role === 'assistant') messages = messages.slice(1);
  return { messages, truncated };
}

/**
 * A conversation's messages in order, only if it belongs to this profile —
 * the newest ones, within the bounds `listRecentMessages` explains.
 */
export async function listMessages(db: Db, conversationId: string, profile: string): Promise<StoredMessage[]> {
  return (await listRecentMessages(db, conversationId, profile)).messages;
}

export type TurnStart = {
  conversationId: string;
  profile: string;
  /** Used only when this turn creates the conversation. */
  title: string;
  lang: 'es' | 'en';
  /** Stored ids, from `storedMessageIds`. */
  userMessageId: string;
  answerId: string;
  question: string;
};

/** An earlier message, as the prompt's history is built from it. */
export type HistoryRow = { role: 'user' | 'assistant'; parts: unknown[]; outcome: MessageOutcome };

export type TurnStartResult = { owned: false } | { owned: true; history: HistoryRow[] };

/**
 * Opens a turn: creates the conversation if this is its first question,
 * stores the question, and reads back the conversation so far — in one
 * statement, which is one round trip instead of the three that used to delay
 * the first byte by half a second against Neon.
 *
 * Ownership without a race. The conversation is inserted, and on a conflict
 * only touched when the existing row belongs to the same profile; a row that
 * belongs to anyone else returns nothing, and the caller answers 404. The old
 * check-then-insert let two first questions of one conversation race into a
 * primary-key violation, and an id taken by another profile reach the insert
 * and fail with a 500.
 *
 * The conversation's language follows the latest question rather than
 * staying whatever the first one was, and its `updated_at` moves with every
 * turn so the sidebar's order reflects activity.
 *
 * `history` is read from before this statement, so the question being asked
 * is never part of it, nor is anything stored after it.
 *
 * A question that already exists is being sent again. The AI SDK does that
 * for three reasons, and the browser's thread afterwards ends at that
 * question in each: a retry after a failure (`regenerate()`), regenerating an
 * earlier answer, and an edit (`sendMessage` with the message's id), which
 * also changes its text. So the stored question takes the text it arrives
 * with, the history is what came before it — never the turns after it, which
 * the reader no longer sees — and its old answer is left for the new one to
 * replace. When the text changed, the turns that followed the old question
 * are deleted as well: they answered a question that no longer exists, and
 * the browser has dropped them. When it did not, nothing is deleted, because
 * the same resend also comes from a second tab that never saw those turns,
 * and deleting them would lose that tab's conversation.
 */
export async function beginTurn(db: Db, input: TurnStart, scan = 16): Promise<TurnStartResult> {
  const parts = JSON.stringify([{ type: 'text', text: storableText(input.question) }]);
  const rows = await withOutcomeColumn(db, () =>
    rawQuery<{ owned: number | string; history: unknown }>(
      db,
      sql`
        WITH conv AS (
          INSERT INTO conversations (id, profile, title, lang)
          VALUES (${input.conversationId}, ${input.profile}, ${storableText(input.title)}, ${input.lang})
          ON CONFLICT (id) DO UPDATE
            SET lang = EXCLUDED.lang, updated_at = now()
            WHERE conversations.profile = EXCLUDED.profile
          RETURNING id
        ),
        asked AS (
          SELECT m.created_at, m.parts IS DISTINCT FROM ${parts}::jsonb AS edited
          FROM messages m
          WHERE m.id = ${input.userMessageId}
            AND m.conversation_id = ${input.conversationId}
            AND m.role = 'user'
            AND EXISTS (SELECT 1 FROM conv)
        ),
        question AS (
          INSERT INTO messages (id, conversation_id, role, parts)
          SELECT ${input.userMessageId}, conv.id, 'user', ${parts}::jsonb FROM conv
          ON CONFLICT (id) DO UPDATE
            SET parts = EXCLUDED.parts
            WHERE messages.conversation_id = EXCLUDED.conversation_id
              AND messages.role = 'user'
              AND messages.parts IS DISTINCT FROM EXCLUDED.parts
          RETURNING id
        ),
        superseded AS (
          DELETE FROM messages m
          USING asked a
          WHERE a.edited
            AND m.conversation_id = ${input.conversationId}
            AND m.created_at > a.created_at
            AND m.id <> ${input.answerId}
          RETURNING m.id
        ),
        earlier AS (
          SELECT m.id, m.role, m.parts, m.outcome, m.created_at
          FROM messages m
          WHERE m.conversation_id = ${input.conversationId}
            AND m.id <> ${input.userMessageId}
            AND m.id <> ${input.answerId}
            AND EXISTS (SELECT 1 FROM conv)
            AND NOT EXISTS (SELECT 1 FROM asked a WHERE m.created_at >= a.created_at)
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT ${scan}
        )
        SELECT
          (SELECT count(*) FROM conv) AS owned,
          COALESCE(
            (SELECT json_agg(json_build_object('role', e.role, 'parts', e.parts, 'outcome', e.outcome)
                             ORDER BY e.created_at, e.id)
             FROM earlier e),
            '[]'::json
          ) AS history
      `,
    ),
  );

  const row = rows[0];
  if (!row || Number(row.owned) === 0) return { owned: false };

  const history = jsonValue(row.history);
  return {
    owned: true,
    history: (Array.isArray(history) ? history : []).map((entry) => {
      const e = entry as { role?: unknown; parts?: unknown; outcome?: unknown };
      return {
        role: e.role === 'assistant' ? 'assistant' : 'user',
        parts: Array.isArray(e.parts) ? e.parts : [],
        outcome: outcomeOf(e.outcome),
      };
    }),
  };
}

/**
 * A question's fingerprint: sha256 of its text as `beginTurn` stores it, in
 * hex — what `saveAnswer` compares the stored question with, computed the
 * same way in SQL. Short enough to ride in a Puter grant, where the question
 * itself (up to 2,000 characters) might not fit.
 */
export function questionHash(question: string): string {
  return createHash('sha256').update(storableText(question), 'utf8').digest('hex');
}

export type AnswerSave = {
  /** The answer's stored id, from `storedMessageIds`. */
  id: string;
  conversationId: string;
  /** Who must own the conversation for the answer to be saved. */
  profile: string;
  /** The question it answers, which places it in the history. */
  userMessageId: string;
  /**
   * The fingerprint (`questionHash`) of the question as it was when this
   * answer was asked for. Given, the answer is saved only if the question
   * still reads the same; without it, only if the question still exists.
   */
  questionHash?: string;
  text: string;
  citations: Citation[];
  outcome: MessageOutcome;
};

/**
 * Stores, or replaces, the answer to a question.
 *
 * Placed one millisecond after its question rather than at the moment it was
 * written, so the history reads question, answer, question, answer even when
 * an abandoned answer is saved after the reader has already asked the next
 * one — the order used to come out as two questions and then two answers.
 *
 * Only while its question is there to answer. An edit (the same message id
 * sent with new text, see `beginTurn`) deletes the turns after the edited
 * question, and changes its text; an answer still being written for either —
 * in another tab, or by a Puter browser saving late — used to be stored
 * anyway: at the end of the conversation, an answer to nothing that the next
 * question replayed to the model as if it answered the edited one, or under
 * the edited question with the sources of the old one. Both are refused now:
 * the question must exist, and, given `questionHash`, still read the same.
 *
 * Otherwise the last save wins, as it always has: two attempts at the same
 * question (a regenerate in a second tab while the first still streams) both
 * answer it, and whichever is saved later is the one kept.
 *
 * Idempotent: the same answer saved twice is one row. False when nothing was
 * written: the conversation is gone or belongs to someone else, or the
 * question is gone or was edited.
 */
export async function saveAnswer(db: Db, input: AnswerSave): Promise<boolean> {
  const parts = JSON.stringify([{ type: 'text', text: storableText(input.text) }]);
  const citations = JSON.stringify(input.citations);
  // The SQL half of `questionHash`: the same bytes, the same digest.
  const unedited =
    input.questionHash === undefined
      ? sql`true`
      : sql`encode(sha256(convert_to(q.parts->0->>'text', 'UTF8')), 'hex') = ${input.questionHash}`;
  const rows = await withOutcomeColumn(db, () =>
    rawQuery<{ id: string }>(
      db,
      sql`
        INSERT INTO messages (id, conversation_id, role, parts, citations, outcome, created_at)
        SELECT ${input.id}, c.id, 'assistant', ${parts}::jsonb, ${citations}::jsonb, ${input.outcome},
               q.created_at + interval '1 millisecond'
        FROM conversations c
        JOIN messages q ON q.id = ${input.userMessageId} AND q.conversation_id = c.id AND q.role = 'user'
        WHERE c.id = ${input.conversationId} AND c.profile = ${input.profile} AND ${unedited}
        ON CONFLICT (id) DO UPDATE
          SET parts = EXCLUDED.parts, citations = EXCLUDED.citations, outcome = EXCLUDED.outcome
          WHERE messages.conversation_id = EXCLUDED.conversation_id AND messages.role = 'assistant'
        RETURNING id
      `,
    ),
  );
  return rows.length > 0;
}
