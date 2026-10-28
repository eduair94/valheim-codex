import { describe, expect, it } from 'vitest';
import {
  chatBodySchema,
  MAX_QUESTION_CHARS,
  questionFromChatBody,
  storedMessageIds,
} from '@/lib/chat-server/request';
import { historyFromRows, HISTORY_TEXT_MAX, HISTORY_TURNS } from '@/lib/chat-server/turn';
import type { HistoryRow } from '@/lib/db/repo';

const CID = '3f0c6c1e-6a52-4a52-9a36-0d6c0d3a8f10';

describe('storedMessageIds', () => {
  /*
   * The client's id used to be the global primary key. Production had a
   * conversation with an answer and no question: a reused id hit
   * ON CONFLICT DO NOTHING somewhere else and the question vanished.
   */
  it('scopes a client id to its conversation', () => {
    const a = storedMessageIds(CID, 'AbCdEf0123456789');
    const b = storedMessageIds('another-conversation', 'AbCdEf0123456789');
    expect(a).toEqual({ user: `${CID}:AbCdEf0123456789`, answer: `${CID}:AbCdEf0123456789:a` });
    expect(a?.user).not.toBe(b?.user);
  });

  it('names the same row again for a retry of the same message', () => {
    expect(storedMessageIds(CID, 'm1')).toEqual(storedMessageIds(CID, 'm1'));
  });

  it('takes an id that already carries this conversation’s prefix as it is', () => {
    // A reopened conversation hands the stored ids back to the client.
    expect(storedMessageIds(CID, `${CID}:m1`)?.user).toBe(`${CID}:m1`);
  });

  it('refuses ids outside the alphabet, including another conversation’s prefix', () => {
    expect(storedMessageIds(CID, 'has space')).toBeNull();
    expect(storedMessageIds(CID, 'other:m1')).toBeNull();
    expect(storedMessageIds(CID, '')).toBeNull();
    expect(storedMessageIds(CID, `${CID}:m1:a`)).toBeNull();
  });
});

function body(input: Record<string, unknown>) {
  const parsed = chatBodySchema.safeParse({ conversationId: CID, lang: 'es', ...input });
  if (!parsed.success) throw new Error('schema rejected the body');
  return parsed.data;
}

describe('questionFromChatBody', () => {
  it('reads the single new message', () => {
    const result = questionFromChatBody(
      body({ message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: '  ¿Hierro?  ' }] } }),
    );
    expect(result).toMatchObject({ ok: true, question: '¿Hierro?', ids: { user: `${CID}:m1` } });
  });

  it('still reads the last message of an older client’s whole thread', () => {
    const result = questionFromChatBody(
      body({
        messages: [
          { id: 'm0', role: 'user', parts: [{ type: 'text', text: 'antes' }] },
          { id: 'a0', role: 'assistant', parts: [{ type: 'data-status', data: {} }, { type: 'text', text: 'x' }] },
          { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'ahora' }] },
        ],
      }),
    );
    expect(result).toMatchObject({ ok: true, question: 'ahora' });
  });

  it('refuses a last message that is not a question', async () => {
    const result = questionFromChatBody(body({ message: { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'x' }] } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it('refuses a message without parts instead of crashing on it', () => {
    const result = questionFromChatBody(body({ message: { id: 'm1', role: 'user' } }));
    expect(result.ok).toBe(false);
  });

  it('refuses an empty question with 400 and a long one with 413', async () => {
    const empty = questionFromChatBody(body({ message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: '   ' }] } }));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(await empty.response.json()).toEqual({ error: 'empty_question' });

    const long = questionFromChatBody(
      body({ message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'a'.repeat(MAX_QUESTION_CHARS + 1) }] } }),
    );
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.response.status).toBe(413);
  });

  it('counts characters, not UTF-16 units', () => {
    const emoji = '😅'.repeat(MAX_QUESTION_CHARS);
    const result = questionFromChatBody(body({ message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: emoji }] } }));
    expect(result.ok).toBe(true);
  });

  it('makes the question well-formed', () => {
    const result = questionFromChatBody(
      body({ message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hola \ud83d' }] } }),
    );
    expect(result).toMatchObject({ ok: true, question: 'hola �' });
  });

  /*
   * Postgres refuses a NUL: a question carrying one used to fail with a 500
   * on every retry, charging the reader's quota each time.
   */
  it('drops NULs and other control characters before measuring the question', async () => {
    const withNul = questionFromChatBody(
      body({ message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: '¿Dónde vive\u0000 Bonemass?' }] } }),
    );
    expect(withNul).toMatchObject({ ok: true, question: '¿Dónde vive Bonemass?' });

    const onlyNuls = questionFromChatBody(
      body({ message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: '\u0000\u0000 \u0001' }] } }),
    );
    expect(onlyNuls.ok).toBe(false);
    if (!onlyNuls.ok) expect(await onlyNuls.response.json()).toEqual({ error: 'empty_question' });

    const padded = `${'a'.repeat(MAX_QUESTION_CHARS)}${'\u0000'.repeat(10)}`;
    expect(questionFromChatBody(body({ message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: padded }] } })).ok).toBe(
      true,
    );
  });
});

describe('historyFromRows', () => {
  const user = (text: string): HistoryRow => ({ role: 'user', parts: [{ type: 'text', text }], outcome: 'complete' });
  const answer = (text: string, outcome: HistoryRow['outcome'] = 'complete'): HistoryRow => ({
    role: 'assistant',
    parts: [{ type: 'text', text }],
    outcome,
  });

  it('drops empty answers, which Gemini rejects as a turn with no parts', () => {
    const turns = historyFromRows([user('¿Hierro?'), answer('', 'error'), user('¿y el cobre?')]);
    expect(turns).toEqual([
      { role: 'user', text: '¿Hierro?' },
      { role: 'user', text: '¿y el cobre?' },
    ]);
  });

  it('strips citation and image markers from earlier answers', () => {
    expect(historyFromRows([answer('Necesitás 20 de hierro [1][2].\n\n[img:1]')])).toEqual([
      { role: 'assistant', text: 'Necesitás 20 de hierro.' },
    ]);
  });

  it('keeps a stopped answer’s text: it is what the reader saw', () => {
    expect(historyFromRows([answer('Necesitás 20 de', 'stopped')])).toEqual([
      { role: 'assistant', text: 'Necesitás 20 de' },
    ]);
  });

  it('caps each message and keeps only the most recent ones', () => {
    const rows = Array.from({ length: 10 }, (_, i) => user(`${i} ${'x'.repeat(HISTORY_TEXT_MAX * 2)}`));
    const turns = historyFromRows(rows);
    expect(turns).toHaveLength(HISTORY_TURNS);
    expect(turns[0]!.text.startsWith('4 ')).toBe(true);
    expect(turns.every((t) => t.text.length <= HISTORY_TEXT_MAX)).toBe(true);
  });

  it('ignores anything in an old row that is not text', () => {
    const turns = historyFromRows([
      { role: 'assistant', parts: [{ type: 'data-sources', data: {} }, null, { type: 'text', text: 'ok' }], outcome: 'complete' },
    ]);
    expect(turns).toEqual([{ role: 'assistant', text: 'ok' }]);
  });

  it('skips empty turns before counting the ones it keeps', () => {
    const rows = [
      user('q0'),
      answer('a0'),
      user('q1'),
      answer('', 'error'),
      user('q2'),
      answer('a2'),
      user('q3'),
      answer('', 'stopped'),
      user('q4'),
      answer('a4'),
    ];
    expect(historyFromRows(rows).map((t) => t.text)).toEqual(['q1', 'q2', 'a2', 'q3', 'q4', 'a4']);
  });

  /*
   * Runs on every question, synchronously, over answers a Puter reader wrote
   * themselves. Eight answers of 12,000 spaces between two letters blocked
   * the server for well over a second on each later question in that
   * conversation, wiki pages included.
   */
  it('builds a history out of hostile answers in no time', () => {
    const hostile = `a${' '.repeat(11_998)}b`;
    const rows = Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? user(`q${i}`) : answer(hostile)));
    const started = performance.now();
    const turns = historyFromRows(rows);
    expect(performance.now() - started).toBeLessThan(50);
    expect(turns).toHaveLength(HISTORY_TURNS);
    expect(turns.at(-1)).toEqual({ role: 'assistant', text: 'a' });
  });

  it('reads only the rows it keeps, newest first', () => {
    const read: number[] = [];
    const rows = Array.from({ length: 16 }, (_, i): HistoryRow => {
      const row = user(`q${i}`);
      return {
        ...row,
        get parts() {
          read.push(i);
          return row.parts;
        },
      };
    });
    expect(historyFromRows(rows).map((t) => t.text)).toEqual(['q10', 'q11', 'q12', 'q13', 'q14', 'q15']);
    expect(read).toEqual([15, 14, 13, 12, 11, 10]);
  });
});
