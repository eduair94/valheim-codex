import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  // The read ceiling one test runs into, whatever the shell running the suite says.
  process.env.CONVERSATION_READS_PER_MINUTE = '60';
  return { jar: new Map<string, string>(), db: null as unknown };
});

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (state.jar.has(name) ? { name, value: state.jar.get(name)! } : undefined),
  }),
}));
vi.mock('@/lib/db/client', () => ({ getDb: async () => state.db }));

import { DELETE, GET as getOne, PATCH } from '@/app/api/conversations/[id]/route';
import { GET as list } from '@/app/api/conversations/route';
import { storedMessageIds } from '@/lib/chat-server/request';
import type { DbHandle } from '@/lib/db/create-db';
import { beginTurn, saveAnswer } from '@/lib/db/repo';
import { createTestDb } from '../helpers/db';
import { byokCookie, jsonRequest, passwordCookie, puterCookie, TEST_SECRET } from '../helpers/chat-fixtures';

/**
 * Conversations belong to `principal.profile`, whatever kind of reader that
 * is, and every query says so in its SQL. Responses are one reader's
 * history, so no cache may keep them.
 */

const BASE = 'http://localhost:3100/api/conversations';
const KEY = 'AIzaUSERKEYuserkeyUSERKEYuserkey12345';
let handle: DbHandle;
const savedSecret = process.env.SESSION_SECRET;

beforeAll(async () => {
  handle = await createTestDb();
  state.db = handle.db;
  process.env.SESSION_SECRET = TEST_SECRET;
});
afterAll(async () => {
  if (savedSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = savedSecret;
  await handle?.close();
});

async function seed(conversationId: string, profile: string, outcome: 'complete' | 'stopped' = 'complete') {
  const ids = storedMessageIds(conversationId, 'm1')!;
  await beginTurn(handle.db, {
    conversationId,
    profile,
    title: `título ${conversationId}`,
    lang: 'es',
    userMessageId: ids.user,
    answerId: ids.answer,
    question: '¿Hierro?',
  });
  await saveAnswer(handle.db, {
    id: ids.answer,
    conversationId,
    profile,
    userMessageId: ids.user,
    text: 'Necesitás',
    citations: [],
    outcome,
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('GET /api/conversations', () => {
  it('lists only the reader’s own conversations, whatever kind of reader', async () => {
    const sub = await byokCookie(state.jar, KEY);
    await seed('byok-own', sub);
    await seed('someone-else', 'ana');

    const response = await list();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = (await response.json()) as { conversations: { id: string }[] };
    expect(body.conversations.map((c) => c.id)).toEqual(['byok-own']);
  });

  it('asks for a sign-in otherwise', async () => {
    state.jar.clear();
    const response = await list();
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('GET /api/conversations/[id]', () => {
  it('returns the messages with how each answer ended', async () => {
    const sub = await puterCookie(state.jar, '33333333-3333-4333-8333-333333333333');
    await seed('puter-own', sub, 'stopped');

    const response = await getOne(new Request(`${BASE}/puter-own`), params('puter-own'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = (await response.json()) as { truncated: boolean; messages: { role: string; outcome: string }[] };
    expect(body.messages.map((m) => [m.role, m.outcome])).toEqual([
      ['user', 'complete'],
      ['assistant', 'stopped'],
    ]);
    expect(body.truncated).toBe(false);
  });

  it('answers 404 for someone else’s conversation and for an id that could not exist', async () => {
    await passwordCookie(state.jar, 'beto');
    await seed('ana-only', 'ana');
    expect((await getOne(new Request(`${BASE}/ana-only`), params('ana-only'))).status).toBe(404);
    expect((await getOne(new Request(`${BASE}/x`), params('../../etc'))).status).toBe(404);
  });

  /*
   * Every open used to send the whole conversation, however long a guest
   * had made it: megabytes per request, unmetered.
   */
  it('returns the newest 200 messages of a long conversation, and says older ones exist', async () => {
    await passwordCookie(state.jar, 'ana-larga');
    await handle.db.execute(sql`INSERT INTO conversations (id, profile, title) VALUES ('ana-long', 'ana-larga', 'larga')`);
    await handle.db.execute(sql`
      INSERT INTO messages (id, conversation_id, role, parts, created_at)
      SELECT 'ana-long:m' || g, 'ana-long', CASE WHEN g % 2 = 0 THEN 'user' ELSE 'assistant' END,
             jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'm' || g)),
             timestamptz '2026-01-01T00:00:00Z' + g * interval '1 second'
      FROM generate_series(0, 201) AS g
    `);

    const response = await getOne(new Request(`${BASE}/ana-long`), params('ana-long'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { truncated: boolean; messages: { id: string; role: string }[] };
    expect(body.truncated).toBe(true);
    expect(body.messages).toHaveLength(200);
    expect(body.messages[0]).toMatchObject({ id: 'ana-long:m2', role: 'user' });
    expect(body.messages.at(-1)?.id).toBe('ana-long:m201');
  });

  /*
   * Opening a conversation costs no quota, so a script reopening a long one
   * in a loop would keep the server and the database busy for everyone.
   */
  it('turns away a reader who opens conversations faster than anyone reads them', async () => {
    await passwordCookie(state.jar, 'ana-script');
    await seed('ana-loop', 'ana-script');
    for (let n = 0; n < 60; n++) {
      expect((await getOne(new Request(`${BASE}/ana-loop`), params('ana-loop'))).status).toBe(200);
    }
    const refused = await getOne(new Request(`${BASE}/ana-loop`), params('ana-loop'));
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(refused.headers.get('cache-control')).toBe('private, no-store');
    expect(await refused.json()).toMatchObject({ error: 'rate_limited', bucket: 'conversations:read' });
  });
});

describe('DELETE and PATCH /api/conversations/[id]', () => {
  it('refuse a cross-site request', async () => {
    await passwordCookie(state.jar, 'ana');
    await seed('ana-csrf', 'ana');
    const crossSite = { 'sec-fetch-site': 'cross-site' };
    const del = await DELETE(jsonRequest(`${BASE}/ana-csrf`, {}, { method: 'DELETE', headers: crossSite }), params('ana-csrf'));
    expect(del.status).toBe(403);
    const patch = await PATCH(
      jsonRequest(`${BASE}/ana-csrf`, { title: 'x' }, { method: 'PATCH', headers: crossSite }),
      params('ana-csrf'),
    );
    expect(patch.status).toBe(403);
  });

  it('rename and delete only the reader’s own', async () => {
    await passwordCookie(state.jar, 'beto');
    await seed('ana-keep', 'ana');
    expect(
      (await PATCH(jsonRequest(`${BASE}/ana-keep`, { title: 'robada' }, { method: 'PATCH' }), params('ana-keep'))).status,
    ).toBe(404);
    expect((await DELETE(jsonRequest(`${BASE}/ana-keep`, {}, { method: 'DELETE' }), params('ana-keep'))).status).toBe(404);

    await passwordCookie(state.jar, 'ana');
    const renamed = await PATCH(
      jsonRequest(`${BASE}/ana-keep`, { title: '  Hierro   y cobre  ' }, { method: 'PATCH' }),
      params('ana-keep'),
    );
    expect(renamed.status).toBe(200);
    const listed = (await (await list()).json()) as { conversations: { id: string; title: string }[] };
    expect(listed.conversations.find((c) => c.id === 'ana-keep')?.title).toBe('Hierro y cobre');

    expect((await DELETE(jsonRequest(`${BASE}/ana-keep`, {}, { method: 'DELETE' }), params('ana-keep'))).status).toBe(200);
    expect((await getOne(new Request(`${BASE}/ana-keep`), params('ana-keep'))).status).toBe(404);
  });

  it('wants a JSON title', async () => {
    await passwordCookie(state.jar, 'ana');
    await seed('ana-json', 'ana');
    const request = new Request(`${BASE}/ana-json`, {
      method: 'PATCH',
      headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ title: 'x' }),
    });
    expect((await PATCH(request, params('ana-json'))).status).toBe(415);
    const blank = await PATCH(jsonRequest(`${BASE}/ana-json`, { title: '   ' }, { method: 'PATCH' }), params('ana-json'));
    expect(blank.status).toBe(400);
  });

  /*
   * Postgres refuses a NUL, and the failure came back as a 503 with
   * Retry-After: an outage the client would retry in vain.
   */
  it('renames with a NUL in the title, without it, and refuses a title of nothing but NULs', async () => {
    await passwordCookie(state.jar, 'ana');
    await seed('ana-nul', 'ana');
    const renamed = await PATCH(
      jsonRequest(`${BASE}/ana-nul`, { title: 'Hierro\u0000 y cobre' }, { method: 'PATCH' }),
      params('ana-nul'),
    );
    expect(renamed.status).toBe(200);
    const listed = (await (await list()).json()) as { conversations: { id: string; title: string }[] };
    expect(listed.conversations.find((c) => c.id === 'ana-nul')?.title).toBe('Hierro y cobre');

    const nothing = await PATCH(
      jsonRequest(`${BASE}/ana-nul`, { title: '\u0000\u0000' }, { method: 'PATCH' }),
      params('ana-nul'),
    );
    expect(nothing.status).toBe(400);
    expect(await nothing.json()).toEqual({ error: 'invalid_request' });
  });
});

/*
 * Last in the file: it renames a column of the suite's database for the
 * length of one request, and puts it back.
 */
describe('a database failure', () => {
  /*
   * A rename is a short statement, so Drizzle's error message — the SQL, then
   * every bound parameter — fit whole in the logged summary: the reader's new
   * title and their profile, in the container's logs.
   */
  it('is answered with a code and logged without the reader’s text', async () => {
    await passwordCookie(state.jar, 'perfil-de-ana');
    await seed('ana-broken', 'perfil-de-ana');
    const title = 'Título secreto de Ana';
    const logged: unknown[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation((...args) => void logged.push(...args));
    await handle.db.execute(sql`ALTER TABLE conversations RENAME COLUMN title TO title_gone`);
    let response: Response;
    try {
      response = await PATCH(jsonRequest(`${BASE}/ana-broken`, { title }, { method: 'PATCH' }), params('ana-broken'));
    } finally {
      await handle.db.execute(sql`ALTER TABLE conversations RENAME COLUMN title_gone TO title`);
      error.mockRestore();
    }

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
    expect(logged.length).toBeGreaterThan(0);
    for (const entry of logged) {
      expect(String(entry)).not.toContain(title);
      expect(String(entry)).not.toContain('perfil-de-ana');
    }
    expect(logged.join(' ')).toContain('SQLSTATE 42703');
  });
});
