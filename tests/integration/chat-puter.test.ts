import { sql } from 'drizzle-orm';
import { SignJWT } from 'jose';
import type { TitleIndexEntry } from '@/lib/db/wiki-repo';
import type * as RetrieveModule from '@/lib/rag/retrieve';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  process.env.EMBEDDING_PROVIDER = 'local';
  return {
    jar: new Map<string, string>(),
    db: null as unknown,
    /** `empty`: nothing found; `fail`: retrieval throws. One database serves every case. */
    retrieval: 'real' as 'real' | 'empty' | 'fail',
    /** The title index the chat links names through (`getSearchIndexData`). */
    titles: [{ s: 'resin', t: 'Resin', c: [], e: 'Resina' }] as TitleIndexEntry[],
  };
});

vi.mock('server-only', () => ({}));
// The search's cached index: `unstable_cache` needs Next's cache, which a test has not got.
vi.mock('@/lib/wiki/data', () => ({ getSearchIndexData: async () => state.titles }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (state.jar.has(name) ? { name, value: state.jar.get(name)! } : undefined),
  }),
}));
vi.mock('@/lib/db/client', () => ({ getDb: async () => state.db }));
vi.mock('@/lib/rag/embed-local', async () => {
  const { fakeEmbed } = await import('../helpers/fake-embed');
  return {
    localEmbeddingProvider: {
      id: 'local',
      label: 'fake',
      dimensions: 768,
      embedDocuments: async (texts: string[]) => texts.map(fakeEmbed),
      embedQuery: async (text: string) => fakeEmbed(text),
    },
    embedQueriesLocally: async (texts: string[]) => texts.map(fakeEmbed),
  };
});
vi.mock('@/lib/rag/retrieve', async (importOriginal) => {
  const real = await importOriginal<typeof RetrieveModule>();
  return {
    ...real,
    retrieve: async (...args: Parameters<typeof real.retrieve>) => {
      if (state.retrieval === 'empty') return [];
      if (state.retrieval === 'fail') throw new Error('embedder down');
      return real.retrieve(...args);
    },
  };
});
// The Puter routes must never reach for a server-side model.
vi.mock('@/lib/rag/provider', () => ({
  answerCandidates: () => {
    throw new Error('no operator model for a Puter reader');
  },
  rewriteCandidates: () => {
    throw new Error('no operator model for a Puter reader');
  },
}));

import { POST as complete } from '@/app/api/chat/complete/route';
import { POST as prepare } from '@/app/api/chat/prepare/route';
import { purposeKey } from '@/lib/auth/secrets';
import { signAnswerGrant } from '@/lib/chat-server/grant';
import type { DbHandle } from '@/lib/db/create-db';
import { deleteConversation, listMessages } from '@/lib/db/repo';
import { createTestDb } from '../helpers/db';
import { seedChunks } from '../helpers/seed';
import { jsonRequest, passwordCookie, puterCookie, TEST_SECRET } from '../helpers/chat-fixtures';

const PREPARE = 'http://localhost:3100/api/chat/prepare';
const COMPLETE = 'http://localhost:3100/api/chat/complete';

const ANA = '11111111-1111-4111-8111-111111111111';
const BETO = '22222222-2222-4222-8222-222222222222';

let handle: DbHandle;
let counter = 0;
const newConversation = () => `puter-${(counter += 1)}-${Date.now().toString(36)}`;

type Prepared = {
  assistantId: string;
  citations: { n: number; title: string }[];
  grant?: string;
  empty?: string;
  messages?: { role: string; content: string }[];
  maxTokens: number;
};

const savedSecret = process.env.SESSION_SECRET;

beforeAll(async () => {
  // One PGlite for the whole file: booting two is what timed this suite out
  // under a loaded full run.
  handle = await createTestDb();
  state.db = handle.db;
  await seedChunks(handle.db, [
    { id: 'bonemass', title: 'Bonemass', content: 'Bonemass is the third boss. Bonemass lives in the Swamp.' },
    { id: 'swamp', title: 'Swamp', content: 'The Swamp biome holds sunken crypts and Bonemass.' },
    // Resin's Usage section, split as the chunker splits it.
    { id: 'fandom:3:prose:2', title: 'Resin', sectionPath: 'Usage > Building', content: 'Resin › Usage › Building\nFermenter\nRaft' },
    { id: 'fandom:3:prose:3', title: 'Resin', sectionPath: 'Usage > Crafting', content: 'Resin › Usage › Crafting\nTorch\nFire arrow' },
  ]);
  await handle.db.execute(sql`
    INSERT INTO articles (page_key, source, title, slug, url)
    SELECT key, 'fandom', title, 'resin', url FROM pages WHERE title = 'Resin'
  `);
  process.env.SESSION_SECRET = TEST_SECRET;
  process.env.CHAT_GUEST_PER_MINUTE = '1000';
  process.env.CHAT_GUEST_IP_PER_MINUTE = '1000';
});

afterAll(async () => {
  if (savedSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = savedSecret;
  await handle?.close();
});

beforeEach(() => {
  state.retrieval = 'real';
});

const ask = (conversationId: string, text: string, id = 'm1', lang: 'es' | 'en' = 'es') =>
  prepare(jsonRequest(PREPARE, { conversationId, lang, message: { id, text } }));

const finish = (grant: string, text: string, outcome = 'complete') =>
  complete(jsonRequest(COMPLETE, { grant, text, outcome }));

describe('prepare', () => {
  it('is only for Puter readers', async () => {
    await passwordCookie(state.jar, 'ana');
    const response = await ask(newConversation(), '¿Bonemass?');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'use_server_transport' });

    state.jar.clear();
    expect((await ask(newConversation(), '¿Bonemass?')).status).toBe(401);
  });

  it('stores the question and returns the prompt, the citations and a grant', async () => {
    const sub = await puterCookie(state.jar, ANA);
    const cid = newConversation();
    const response = await ask(cid, '¿Dónde vive Bonemass?');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');

    const body = (await response.json()) as Prepared;
    expect(body.assistantId).toBe(`${cid}:m1:a`);
    expect(body.maxTokens).toBe(1200);
    expect(body.grant).toEqual(expect.any(String));
    expect(body.citations.map((c) => c.title)).toContain('Bonemass');
    expect(body.messages?.[0]?.role).toBe('system');
    expect(body.messages?.at(-1)).toMatchObject({ role: 'user' });
    expect(body.messages?.at(-1)?.content).toContain('Bonemass is the third boss');
    expect(body.messages?.at(-1)?.content).toContain('¿Dónde vive Bonemass?');

    const rows = await listMessages(handle.db, cid, sub);
    expect(rows.map((m) => m.role)).toEqual(['user']);
  });

  /*
   * With no model to rewrite it, a Puter reader's question about what a thing
   * is for relies on the section retrieval pins from the question itself.
   */
  it('puts the section a question asks for at the head of the prompt', async () => {
    await puterCookie(state.jar, ANA);
    const body = (await (await ask(newConversation(), '¿Para qué sirve la resina?')).json()) as Prepared;
    expect(body.citations[0]).toMatchObject({ title: 'Resin', sectionPath: 'Usage' });
    const prompt = body.messages?.at(-1)?.content ?? '';
    expect(prompt).toContain('Building: Fermenter, Raft\nCrafting: Torch, Fire arrow');
    expect(prompt.indexOf('Fermenter')).toBeLessThan(prompt.indexOf('Bonemass'));
  });

  it('folds the previous question into the search and replays the history', async () => {
    await puterCookie(state.jar, ANA);
    const cid = newConversation();
    const first = (await (await ask(cid, '¿Qué es Bonemass?')).json()) as Prepared;
    await finish(first.grant!, 'Un jefe del pantano [1].');

    const second = (await (await ask(cid, '¿y dónde está?', 'm2')).json()) as Prepared;
    const roles = second.messages?.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    // The earlier answer comes back without its stale marker.
    expect(second.messages?.[2]?.content).toBe('Un jefe del pantano.');
    expect(second.citations.map((c) => c.title)).toContain('Bonemass');
  });

  it('answers directly, and stores the answer, when nothing is retrieved', async () => {
    state.retrieval = 'empty';
    const sub = await puterCookie(state.jar, ANA);
    const cid = newConversation();
    const body = (await (await ask(cid, '¿Qué es un dragón?')).json()) as Prepared;
    expect(body.empty).toMatch(/No encontré/);
    expect(body.grant).toBeUndefined();
    expect(body.messages).toBeUndefined();

    const rows = await listMessages(handle.db, cid, sub);
    expect(rows.map((m) => [m.role, m.outcome])).toEqual([
      ['user', 'complete'],
      ['assistant', 'complete'],
    ]);
  });

  /*
   * The browser has no grant to report this failure with, so the server
   * stores it, as /api/chat does: a bare question would read back as one
   * still waiting for its answer.
   */
  it('stores the turn as failed when retrieval breaks after the question was stored', async () => {
    state.retrieval = 'fail';
    const sub = await puterCookie(state.jar, ANA);
    const cid = newConversation();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await ask(cid, '¿Dónde vive Bonemass?');
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'internal_error' });
    } finally {
      logged.mockRestore();
    }

    const rows = await listMessages(handle.db, cid, sub);
    expect(rows.map((m) => [m.role, m.outcome])).toEqual([
      ['user', 'complete'],
      ['assistant', 'error'],
    ]);
  });

  it('refuses someone else’s conversation', async () => {
    await puterCookie(state.jar, ANA);
    const cid = newConversation();
    await ask(cid, '¿Bonemass?');

    await puterCookie(state.jar, BETO);
    const response = await ask(cid, 'quiero leer', 'm2');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'conversation_not_found' });
  });

  it('stores a question with a NUL in it, without it, rather than failing with a 500', async () => {
    const sub = await puterCookie(state.jar, ANA);
    const cid = newConversation();
    const response = await ask(cid, '¿Dónde vive\u0000 Bonemass?');
    expect(response.status).toBe(200);
    const rows = await listMessages(handle.db, cid, sub);
    expect(rows.map((m) => m.parts)).toEqual([[{ type: 'text', text: '¿Dónde vive Bonemass?' }]]);
  });

  it('counts against the guest quota before writing anything', async () => {
    process.env.CHAT_GUEST_PER_MINUTE = '0';
    try {
      await puterCookie(state.jar, ANA);
      const cid = newConversation();
      const response = await ask(cid, '¿Bonemass?');
      expect(response.status).toBe(429);
      const rows = await handle.db.execute(sql`SELECT id FROM conversations WHERE id = ${cid}`);
      expect((rows as unknown as { rows: unknown[] }).rows).toEqual([]);
    } finally {
      process.env.CHAT_GUEST_PER_MINUTE = '1000';
    }
  });
});

describe('complete', () => {
  it('stores the answer with the citations the server chose', async () => {
    const sub = await puterCookie(state.jar, ANA);
    const cid = newConversation();
    const prepared = (await (await ask(cid, '¿Dónde vive Bonemass?')).json()) as Prepared;

    const response = await finish(prepared.grant!, 'Vive en el pantano [1].');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const rows = await listMessages(handle.db, cid, sub);
    expect(rows.map((m) => [m.role, m.outcome])).toEqual([
      ['user', 'complete'],
      ['assistant', 'complete'],
    ]);
    expect(rows[1]!.id).toBe(prepared.assistantId);
    expect(rows[1]!.citations.map((c) => c.title)).toEqual(prepared.citations.map((c) => c.title));
  });

  it('is idempotent: the same completion twice is one answer', async () => {
    const sub = await puterCookie(state.jar, ANA);
    const cid = newConversation();
    const prepared = (await (await ask(cid, '¿Dónde vive Bonemass?')).json()) as Prepared;

    expect((await finish(prepared.grant!, 'Vive en el pantano.')).status).toBe(200);
    expect((await finish(prepared.grant!, 'Vive en el pantano.')).status).toBe(200);
    const answers = (await listMessages(handle.db, cid, sub)).filter((m) => m.role === 'assistant');
    expect(answers).toHaveLength(1);
  });

  /*
   * A grant is good for fifteen minutes; without a ceiling one could rewrite
   * its row, 12,000 characters at a time, as often as a script liked.
   */
  it('saves a few times per grant, then refuses, and a new grant starts afresh', async () => {
    const sub = await puterCookie(state.jar, ANA);
    const cid = newConversation();
    const prepared = (await (await ask(cid, '¿Dónde vive Bonemass?')).json()) as Prepared;

    for (let n = 1; n <= 4; n++) expect((await finish(prepared.grant!, `versión ${n}`)).status).toBe(200);
    const refused = await finish(prepared.grant!, 'versión 5');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await refused.json()).toMatchObject({ error: 'rate_limited', bucket: 'chat:complete' });

    let answer = (await listMessages(handle.db, cid, sub)).find((m) => m.role === 'assistant');
    expect(answer?.parts).toEqual([{ type: 'text', text: 'versión 4' }]);

    // Regenerating the answer issues a new grant for the same row, a second later.
    const key = await purposeKey('answer-grant');
    const issuedLater = await new SignJWT({ cid, cit: prepared.citations })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('wiki-valheim')
      .setAudience('wiki-valheim-answer')
      .setSubject(sub)
      .setJti(prepared.assistantId)
      .setIssuedAt(Math.floor(Date.now() / 1000) + 1)
      .setExpirationTime('5m')
      .sign(key!);
    expect((await finish(issuedLater, 'regenerada')).status).toBe(200);
    answer = (await listMessages(handle.db, cid, sub)).find((m) => m.role === 'assistant');
    expect(answer?.parts).toEqual([{ type: 'text', text: 'regenerada' }]);
  });

  it('keeps a stopped answer marked as stopped', async () => {
    const sub = await puterCookie(state.jar, ANA);
    const cid = newConversation();
    const prepared = (await (await ask(cid, '¿Dónde vive Bonemass?')).json()) as Prepared;
    await finish(prepared.grant!, 'Vive en el', 'stopped');

    const answer = (await listMessages(handle.db, cid, sub)).find((m) => m.role === 'assistant');
    expect(answer).toMatchObject({ outcome: 'stopped', parts: [{ type: 'text', text: 'Vive en el' }] });
  });

  it('does not record an empty "complete" as a whole answer', async () => {
    const sub = await puterCookie(state.jar, ANA);
    const cid = newConversation();
    const prepared = (await (await ask(cid, '¿Dónde vive Bonemass?')).json()) as Prepared;
    await finish(prepared.grant!, '   ', 'complete');
    const answer = (await listMessages(handle.db, cid, sub)).find((m) => m.role === 'assistant');
    expect(answer?.outcome).toBe('error');
  });

  /*
   * Postgres refuses a NUL in jsonb: an answer a model wrote one into failed
   * with a 500 and was lost, leaving the question unanswered.
   */
  it('keeps an answer with a NUL in it, without it, and a "complete" of nothing but NULs as failed', async () => {
    const sub = await puterCookie(state.jar, ANA);
    const cid = newConversation();
    const prepared = (await (await ask(cid, '¿Dónde vive Bonemass?')).json()) as Prepared;
    expect((await finish(prepared.grant!, 'Vive en el\u0000 pantano [1].')).status).toBe(200);
    let answer = (await listMessages(handle.db, cid, sub)).find((m) => m.role === 'assistant');
    expect(answer).toMatchObject({ outcome: 'complete', parts: [{ type: 'text', text: 'Vive en el pantano [1].' }] });

    expect((await finish(prepared.grant!, '\u0000\u0000', 'complete')).status).toBe(200);
    answer = (await listMessages(handle.db, cid, sub)).find((m) => m.role === 'assistant');
    expect(answer).toMatchObject({ outcome: 'error', parts: [{ type: 'text', text: '' }] });
  });

  /*
   * The server allows edits (the same message id, new text). A grant issued
   * for the old text used to save anyway: the edited question then read back
   * with an answer to the old one, and that one's sources.
   */
  it('saves nothing under a question edited since its grant was issued', async () => {
    const sub = await puterCookie(state.jar, ANA);
    const cid = newConversation();
    const first = (await (await ask(cid, '¿Dónde vive Bonemass?')).json()) as Prepared;
    const edited = (await (await ask(cid, '¿Qué suelta Bonemass?')).json()) as Prepared;
    expect(edited.grant).toEqual(expect.any(String));

    const stale = await finish(first.grant!, 'Bonemass vive en el pantano [1].');
    expect(stale.status).toBe(409);
    expect(stale.headers.get('cache-control')).toBe('private, no-store');
    expect(await stale.json()).toEqual({ error: 'question_superseded' });
    expect((await listMessages(handle.db, cid, sub)).filter((m) => m.role === 'assistant')).toEqual([]);

    expect((await finish(edited.grant!, 'Hierro [1].')).status).toBe(200);
    // Nor can the stale grant replace the answer to the edited question.
    expect((await finish(first.grant!, 'Bonemass vive', 'stopped')).status).toBe(409);
    const rows = await listMessages(handle.db, cid, sub);
    expect(rows.map((m) => (m.parts[0] as { text: string }).text)).toEqual(['¿Qué suelta Bonemass?', 'Hierro [1].']);
  });

  /*
   * An edit deletes the turns after the edited question. A late save for one
   * of them used to be stored at the end: an answer to nothing.
   */
  it('saves nothing for a question an edit removed', async () => {
    const sub = await puterCookie(state.jar, ANA);
    const cid = newConversation();
    const first = (await (await ask(cid, '¿Qué es Bonemass?')).json()) as Prepared;
    await finish(first.grant!, 'Un jefe del pantano [1].');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = (await (await ask(cid, '¿Y qué suelta?', 'm2')).json()) as Prepared;
    expect(second.grant).toEqual(expect.any(String));

    await ask(cid, '¿Dónde vive Bonemass?');
    const late = await finish(second.grant!, 'Suelta hierro [1].');
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: 'question_superseded' });
    const rows = await listMessages(handle.db, cid, sub);
    expect(rows.map((m) => [m.id, m.role])).toEqual([
      [`${cid}:m1`, 'user'],
      [`${cid}:m1:a`, 'assistant'],
    ]);
  });

  it('answers 404 once the conversation itself is gone', async () => {
    const sub = await puterCookie(state.jar, ANA);
    const cid = newConversation();
    const prepared = (await (await ask(cid, '¿Dónde vive Bonemass?')).json()) as Prepared;
    await deleteConversation(handle.db, cid, sub);
    const response = await finish(prepared.grant!, 'Vive en el pantano.');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'conversation_not_found' });
  });

  it('still saves with a grant issued before grants named their question', async () => {
    const sub = await puterCookie(state.jar, ANA);
    const cid = newConversation();
    const prepared = (await (await ask(cid, '¿Dónde vive Bonemass?')).json()) as Prepared;
    const key = await purposeKey('answer-grant');
    const older = await signAnswerGrant(
      { profile: sub, answerId: prepared.assistantId, conversationId: cid, citations: [] },
      key!,
    );
    expect((await finish(older, 'Vive en el pantano.')).status).toBe(200);
  });

  it('refuses a grant issued to someone else', async () => {
    await puterCookie(state.jar, ANA);
    const cid = newConversation();
    const prepared = (await (await ask(cid, '¿Dónde vive Bonemass?')).json()) as Prepared;

    const betoSub = await puterCookie(state.jar, BETO);
    const response = await finish(prepared.grant!, 'escrito por Beto');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'invalid_grant' });
    expect(await listMessages(handle.db, cid, betoSub)).toEqual([]);
  });

  it('refuses a tampered grant', async () => {
    const sub = await puterCookie(state.jar, ANA);
    const cid = newConversation();
    const prepared = (await (await ask(cid, '¿Dónde vive Bonemass?')).json()) as Prepared;

    const [header, payload, signature] = prepared.grant!.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
    claims['cit'] = [{ n: 1, title: 'Inventada', url: 'https://evil.test', sectionPath: '', source: 'x', score: 1 }];
    const forged = [header, Buffer.from(JSON.stringify(claims)).toString('base64url'), signature].join('.');

    expect((await finish(forged, 'texto')).status).toBe(403);
    expect((await listMessages(handle.db, cid, sub)).filter((m) => m.role === 'assistant')).toEqual([]);
  });

  it('refuses a grant whose answer id does not belong to its conversation', async () => {
    const sub = await puterCookie(state.jar, ANA);
    const key = await purposeKey('answer-grant');
    const grant = await signAnswerGrant(
      { profile: sub, answerId: 'other-conversation:m1:a', conversationId: 'mine', citations: [] },
      key!,
    );
    expect((await finish(grant, 'texto')).status).toBe(403);
  });

  it('is only for Puter readers', async () => {
    await passwordCookie(state.jar, 'ana');
    const response = await finish('x.y.z', 'texto');
    expect(response.status).toBe(409);
  });
});
