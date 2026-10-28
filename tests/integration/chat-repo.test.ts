import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '@/lib/db/create-db';
import { rawQuery } from '@/lib/db/create-db';
import {
  beginTurn,
  CONVERSATION_READ_MAX_MESSAGES,
  deleteConversation,
  getConversation,
  listMessages,
  listRecentMessages,
  questionHash,
  renameConversation,
  saveAnswer,
  type TurnStart,
} from '@/lib/db/repo';
import { storedMessageIds } from '@/lib/chat-server/request';
import { createTestDb } from '../helpers/db';

/**
 * The conversation store: who owns what, which ids name which rows, and in
 * which order a conversation reads back. All against a real (in-memory)
 * Postgres, because every one of these rules lives in SQL.
 */

let handle: DbHandle;

beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(async () => {
  await handle?.close();
});

function turn(conversationId: string, profile: string, clientId: string, question: string): TurnStart {
  const ids = storedMessageIds(conversationId, clientId)!;
  return {
    conversationId,
    profile,
    title: question.slice(0, 60),
    lang: 'es',
    userMessageId: ids.user,
    answerId: ids.answer,
    question,
  };
}

async function answer(
  t: TurnStart,
  text: string,
  outcome: 'complete' | 'stopped' | 'error' = 'complete',
  asked?: string,
) {
  return saveAnswer(handle.db, {
    id: t.answerId,
    conversationId: t.conversationId,
    profile: t.profile,
    userMessageId: t.userMessageId,
    questionHash: asked,
    text,
    citations: [],
    outcome,
  });
}

/** A conversation as `role:text` lines, oldest first. */
const texts = async (cid: string, profile = 'ana') =>
  (await listMessages(handle.db, cid, profile)).map((m) => `${m.role}:${(m.parts[0] as { text: string }).text}`);

describe('beginTurn', () => {
  it('creates the conversation with its first question and no history', async () => {
    const t = turn('c-new', 'ana', 'm1', '¿Hierro?');
    expect(await beginTurn(handle.db, t)).toEqual({ owned: true, history: [] });

    const conversation = await getConversation(handle.db, 'c-new', 'ana');
    expect(conversation).toMatchObject({ title: '¿Hierro?', lang: 'es' });
    expect((await listMessages(handle.db, 'c-new', 'ana')).map((m) => m.role)).toEqual(['user']);
  });

  it('refuses a conversation id that belongs to another profile, writing nothing', async () => {
    await beginTurn(handle.db, turn('c-owned', 'ana', 'm1', 'mía'));
    const intruder = await beginTurn(handle.db, turn('c-owned', 'beto', 'm2', 'quiero leer'));
    expect(intruder).toEqual({ owned: false });

    const rows = await listMessages(handle.db, 'c-owned', 'ana');
    expect(rows.map((m) => (m.parts[0] as { text: string }).text)).toEqual(['mía']);
  });

  it('survives two first questions of one conversation arriving together', async () => {
    const results = await Promise.all([
      beginTurn(handle.db, turn('c-race', 'ana', 'm1', 'uno')),
      beginTurn(handle.db, turn('c-race', 'ana', 'm2', 'dos')),
    ]);
    expect(results.every((r) => r.owned)).toBe(true);
    expect(await listMessages(handle.db, 'c-race', 'ana')).toHaveLength(2);
  });

  it('stores a retried question once', async () => {
    const t = turn('c-retry', 'ana', 'm1', '¿Cobre?');
    await beginTurn(handle.db, t);
    await beginTurn(handle.db, t);
    expect(await listMessages(handle.db, 'c-retry', 'ana')).toHaveLength(1);
  });

  it('keeps the same client id in two conversations apart', async () => {
    await beginTurn(handle.db, turn('c-a', 'ana', 'same-id', 'en A'));
    await beginTurn(handle.db, turn('c-b', 'ana', 'same-id', 'en B'));
    expect(await listMessages(handle.db, 'c-a', 'ana')).toHaveLength(1);
    expect(await listMessages(handle.db, 'c-b', 'ana')).toHaveLength(1);
  });

  it('returns the earlier turns, oldest first, without the question being asked', async () => {
    const first = turn('c-history', 'ana', 'm1', 'primera');
    await beginTurn(handle.db, first);
    await answer(first, 'respuesta uno [1]');
    const second = turn('c-history', 'ana', 'm2', 'segunda');
    const started = await beginTurn(handle.db, second);

    expect(started).toEqual({
      owned: true,
      history: [
        { role: 'user', parts: [{ type: 'text', text: 'primera' }], outcome: 'complete' },
        { role: 'assistant', parts: [{ type: 'text', text: 'respuesta uno [1]' }], outcome: 'complete' },
      ],
    });

    // A retry of the second question leaves itself, and its earlier answer, out.
    await answer(second, '', 'error');
    const retried = await beginTurn(handle.db, second);
    expect(retried.owned && retried.history).toHaveLength(2);
  });

  it('follows the language of the latest question', async () => {
    await beginTurn(handle.db, turn('c-lang', 'ana', 'm1', 'hola'));
    await beginTurn(handle.db, { ...turn('c-lang', 'ana', 'm2', 'hello'), lang: 'en' });
    expect((await getConversation(handle.db, 'c-lang', 'ana'))?.lang).toBe('en');
  });

  /*
   * The AI SDK resends a stored question for a retry, for regenerating an
   * earlier answer and for an edit (`sendMessage` with its id). In each the
   * browser's thread then ends at that question.
   */
  describe('a question sent again', () => {
    async function twoTurns(cid: string) {
      const q1 = turn(cid, 'ana', 'm1', 'Q1');
      await beginTurn(handle.db, q1);
      await answer(q1, 'A1');
      await new Promise((resolve) => setTimeout(resolve, 5));
      const q2 = turn(cid, 'ana', 'm2', 'Q2');
      await beginTurn(handle.db, q2);
      await answer(q2, 'A2');
      return q1;
    }

    it('sees only what came before it, never the turns after it', async () => {
      const q1 = await twoTurns('c-again');
      const retried = await beginTurn(handle.db, q1);
      expect(retried).toEqual({ owned: true, history: [] });
    });

    it('deletes nothing when its text is the same: the resend may come from a tab that never saw the rest', async () => {
      const q1 = await twoTurns('c-again-same');
      await beginTurn(handle.db, q1);
      expect(await texts('c-again-same')).toEqual(['user:Q1', 'assistant:A1', 'user:Q2', 'assistant:A2']);
    });

    it('takes an edit’s new text and drops the turns that answered the old one', async () => {
      const q1 = await twoTurns('c-edit');
      const edited = { ...q1, question: 'Q1 editada' };
      expect(await beginTurn(handle.db, edited)).toEqual({ owned: true, history: [] });
      await answer(edited, 'A1 nueva');

      expect(await texts('c-edit')).toEqual(['user:Q1 editada', 'assistant:A1 nueva']);
    });

    it('keeps what came before an edited question', async () => {
      const q0 = turn('c-edit-later', 'ana', 'm0', 'Q0');
      await beginTurn(handle.db, q0);
      await answer(q0, 'A0');
      await new Promise((resolve) => setTimeout(resolve, 5));
      const q1 = await twoTurns('c-edit-later');
      const started = await beginTurn(handle.db, { ...q1, question: 'Q1 editada' });

      expect(started.owned && started.history.map((h) => h.role)).toEqual(['user', 'assistant']);
      expect(await texts('c-edit-later')).toEqual(['user:Q0', 'assistant:A0', 'user:Q1 editada', 'assistant:A1']);
    });

    it('touches nothing in a conversation it does not own', async () => {
      const q1 = await twoTurns('c-edit-owned');
      expect(await beginTurn(handle.db, { ...q1, profile: 'beto', question: 'Q1 de Beto' })).toEqual({ owned: false });
      expect(await texts('c-edit-owned')).toEqual(['user:Q1', 'assistant:A1', 'user:Q2', 'assistant:A2']);
    });
  });
});

describe('saveAnswer', () => {
  it('places an answer right after its question, even when saved after the next one', async () => {
    const first = turn('c-order', 'ana', 'm1', 'uno');
    const second = turn('c-order', 'ana', 'm2', 'dos');
    await beginTurn(handle.db, first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await beginTurn(handle.db, second);
    // The first answer, abandoned and saved late.
    await answer(first, 'respuesta uno', 'stopped');
    await answer(second, 'respuesta dos');

    const rows = await listMessages(handle.db, 'c-order', 'ana');
    expect(rows.map((m) => `${m.role}:${(m.parts[0] as { text: string }).text}`)).toEqual([
      'user:uno',
      'assistant:respuesta uno',
      'user:dos',
      'assistant:respuesta dos',
    ]);
    expect(rows.map((m) => m.outcome)).toEqual(['complete', 'stopped', 'complete', 'complete']);
  });

  it('replaces a failed answer when the question is retried', async () => {
    const t = turn('c-replace', 'ana', 'm1', 'uno');
    await beginTurn(handle.db, t);
    await answer(t, '', 'error');
    await answer(t, 'ahora sí');

    const rows = await listMessages(handle.db, 'c-replace', 'ana');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ outcome: 'complete', parts: [{ type: 'text', text: 'ahora sí' }] });
  });

  it('writes nothing into a conversation the profile does not own', async () => {
    const t = turn('c-guarded', 'ana', 'm1', 'uno');
    await beginTurn(handle.db, t);
    const saved = await saveAnswer(handle.db, {
      id: t.answerId,
      conversationId: t.conversationId,
      profile: 'beto',
      userMessageId: t.userMessageId,
      text: 'inyectado',
      citations: [],
      outcome: 'complete',
    });
    expect(saved).toBe(false);
    expect(await listMessages(handle.db, 'c-guarded', 'ana')).toHaveLength(1);
  });

  it('writes nothing once the conversation is gone', async () => {
    const t = turn('c-gone', 'ana', 'm1', 'uno');
    await beginTurn(handle.db, t);
    await deleteConversation(handle.db, 'c-gone', 'ana');
    expect(await answer(t, 'tarde')).toBe(false);
  });

  /*
   * A stream cut between the two halves of an emoji leaves half a surrogate
   * pair at the end of the answer, and the `::jsonb` cast refuses it — the
   * whole row used to be lost, leaving a question nobody answered.
   */
  it('stores an answer that ends on half an emoji', async () => {
    const t = turn('c-surrogate', 'ana', 'm1', 'uno \uD83D');
    await beginTurn(handle.db, t);
    expect(await answer(t, 'Hola \uD83D', 'error')).toBe(true);

    const rows = await listMessages(handle.db, 'c-surrogate', 'ana');
    expect(rows.map((m) => (m.parts[0] as { text: string }).text)).toEqual(['uno �', 'Hola �']);
  });

  /*
   * Postgres refuses a NUL in text and in jsonb, on PGlite and Neon alike:
   * the question failed with a 500 on every retry, and an answer a model
   * wrote one into was lost whole.
   */
  it('stores a question, an answer and a title with NULs and control characters, without them', async () => {
    const t = { ...turn('c-nul', 'ana', 'm1', '¿Dónde\u0000 vive Bonemass?'), title: 'Bonemass\u0000' };
    expect((await beginTurn(handle.db, t)).owned).toBe(true);
    expect(await answer(t, 'Vive en el\u0000 pantano\u0001 [1].')).toBe(true);
    expect(await texts('c-nul')).toEqual(['user:¿Dónde vive Bonemass?', 'assistant:Vive en el pantano [1].']);

    expect(await renameConversation(handle.db, 'c-nul', 'ana', 'Pantano\u0000 y hierro')).toBe(true);
    expect((await getConversation(handle.db, 'c-nul', 'ana'))?.title).toBe('Pantano y hierro');
  });

  /*
   * An edit (the same id, new text) deletes the turns after the edited
   * question. An answer still on its way for one of them — another tab's
   * stream, a Puter browser saving late — used to be stored at the end of
   * the conversation: an answer to nothing, replayed to the model as if it
   * answered the edited question.
   */
  it('writes nothing for a question an edit has since removed', async () => {
    const q1 = turn('c-orphan', 'ana', 'm1', 'Q1');
    await beginTurn(handle.db, q1);
    await answer(q1, 'A1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const q2 = turn('c-orphan', 'ana', 'm2', 'Q2');
    await beginTurn(handle.db, q2);

    await beginTurn(handle.db, { ...q1, question: 'Q1 editada' });
    expect(await answer(q2, 'A2, tarde')).toBe(false);
    expect(await texts('c-orphan')).toEqual(['user:Q1 editada', 'assistant:A1']);

    const next = await beginTurn(handle.db, turn('c-orphan', 'ana', 'm3', 'Q3'));
    expect(next.owned && next.history.map((h) => h.role)).toEqual(['user', 'assistant']);
  });

  it('writes nothing under a question whose text changed since the answer was asked for', async () => {
    const q1 = turn('c-stale', 'ana', 'm1', '¿Dónde vive Bonemass?');
    await beginTurn(handle.db, q1);
    const askedFirst = questionHash(q1.question);

    const edited = { ...q1, question: '¿Dónde vive Moder?' };
    await beginTurn(handle.db, edited);
    expect(await answer(q1, 'En el pantano.', 'complete', askedFirst)).toBe(false);
    expect(await texts('c-stale')).toEqual(['user:¿Dónde vive Moder?']);

    expect(await answer(edited, 'En las montañas.', 'complete', questionHash(edited.question))).toBe(true);
    // A late save for the old text cannot replace the new answer either.
    expect(await answer(q1, 'En el pantano.', 'stopped', askedFirst)).toBe(false);
    expect(await texts('c-stale')).toEqual(['user:¿Dónde vive Moder?', 'assistant:En las montañas.']);
  });

  it('fingerprints a question exactly as it is stored, odd characters and all', async () => {
    const question = 'uno \uD83D dos 😅 ñ\u0000 "comillas" \\ fin';
    const t = turn('c-hash', 'ana', 'm1', question);
    await beginTurn(handle.db, t);
    expect(await answer(t, 'respuesta', 'complete', questionHash(question))).toBe(true);
  });
});

describe('listRecentMessages', () => {
  /** A conversation of `count` messages a second apart, questions on the even ones, each `size` characters long. */
  async function seedConversation(cid: string, count: number, size = 10) {
    await handle.db.execute(sql`INSERT INTO conversations (id, profile, title) VALUES (${cid}, 'ana', 'larga')`);
    await handle.db.execute(sql`
      INSERT INTO messages (id, conversation_id, role, parts, created_at)
      SELECT ${cid} || ':m' || g, ${cid},
             CASE WHEN g % 2 = 0 THEN 'user' ELSE 'assistant' END,
             jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'm' || g || repeat('x', ${size}))),
             timestamptz '2026-01-01T00:00:00Z' + g * interval '1 second'
      FROM generate_series(0, ${count - 1}) AS g
    `);
  }

  const ids = (window: { messages: { id: string }[] }) => window.messages.map((m) => m.id.split(':')[1]);

  it('returns a short conversation whole', async () => {
    await seedConversation('c-short', 4);
    const window = await listRecentMessages(handle.db, 'c-short', 'ana');
    expect(ids(window)).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(window.truncated).toBe(false);
  });

  /*
   * A guest's daily quota alone fills a conversation with 150 turns of
   * 12,000 characters, and every open used to send all of it.
   */
  it('returns only the newest messages, oldest first, and says older ones exist', async () => {
    await seedConversation('c-long', 10);
    const window = await listRecentMessages(handle.db, 'c-long', 'ana', { maxMessages: 4 });
    expect(ids(window)).toEqual(['m6', 'm7', 'm8', 'm9']);
    expect(window.truncated).toBe(true);
    expect(await listMessages(handle.db, 'c-long', 'ana')).toHaveLength(10);
    expect(CONVERSATION_READ_MAX_MESSAGES).toBe(200);
  });

  it('opens a cut window on a question, never on an answer whose question it left out', async () => {
    await seedConversation('c-odd', 10);
    const window = await listRecentMessages(handle.db, 'c-odd', 'ana', { maxMessages: 5 });
    expect(ids(window)).toEqual(['m6', 'm7', 'm8', 'm9']);
    expect(window.truncated).toBe(true);
  });

  it('stops at a budget in bytes, as JSON, keeping the newest message whatever its size', async () => {
    await seedConversation('c-heavy', 10, 1_000);
    const two = await listRecentMessages(handle.db, 'c-heavy', 'ana', { maxBytes: 2_500 });
    expect(ids(two)).toEqual(['m8', 'm9']);
    expect(two.truncated).toBe(true);

    const one = await listRecentMessages(handle.db, 'c-heavy', 'ana', { maxBytes: 10 });
    expect(ids(one)).toEqual(['m9']);

    // JSON writes a control character in six bytes; the budget counts them so.
    await handle.db.execute(sql`
      UPDATE messages SET parts = jsonb_build_array(jsonb_build_object('type', 'text', 'text', repeat(chr(1), 500)))
      WHERE id = 'c-heavy:m8'
    `);
    const escaped = await listRecentMessages(handle.db, 'c-heavy', 'ana', { maxBytes: 3_500 });
    expect(ids(escaped)).toEqual(['m9']);
  });

  it('reads nothing of a conversation the profile does not own', async () => {
    await seedConversation('c-theirs', 4);
    expect(await listRecentMessages(handle.db, 'c-theirs', 'beto')).toEqual({ messages: [], truncated: false });
  });
});

describe('ownership of the conversation routes’ queries', () => {
  it('reads, renames and deletes only what the profile owns', async () => {
    await beginTurn(handle.db, turn('c-mine', 'ana', 'm1', 'mía'));

    expect(await listMessages(handle.db, 'c-mine', 'beto')).toEqual([]);
    expect(await renameConversation(handle.db, 'c-mine', 'beto', 'robada')).toBe(false);
    expect(await deleteConversation(handle.db, 'c-mine', 'beto')).toBe(false);

    expect(await renameConversation(handle.db, 'c-mine', 'ana', 'renombrada')).toBe(true);
    expect((await getConversation(handle.db, 'c-mine', 'ana'))?.title).toBe('renombrada');
    expect(await deleteConversation(handle.db, 'c-mine', 'ana')).toBe(true);
    expect(await getConversation(handle.db, 'c-mine', 'ana')).toBeNull();
  });
});

/*
 * Last in the file on purpose: it drops a column from the suite's database
 * (rather than booting a second PGlite, which under a loaded full run is what
 * times suites out) and leaves it to the code under test to put back.
 */
describe('a database that predates the outcome column', () => {
  /*
   * Deploys are a pull and a rebuild; nothing runs migrations. A missing
   * column would take the whole chat down, so the app adds it on first use.
   */
  it('adds the column on first use and carries on', async () => {
    const old = handle.db;
    await old.execute(sql`ALTER TABLE messages DROP COLUMN outcome`);

    const t = turn('c-old', 'ana', 'm1', 'uno');
    expect((await beginTurn(old, t)).owned).toBe(true);
    expect(
      await saveAnswer(old, {
        id: t.answerId,
        conversationId: t.conversationId,
        profile: 'ana',
        userMessageId: t.userMessageId,
        text: 'cortada',
        citations: [],
        outcome: 'stopped',
      }),
    ).toBe(true);

    const columns = await rawQuery<{ column_name: string }>(
      old,
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'messages'`,
    );
    expect(columns.map((c) => c.column_name)).toContain('outcome');
    expect((await listMessages(old, 'c-old', 'ana')).map((m) => m.outcome)).toEqual(['complete', 'stopped']);
  });
});
