import { describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import type { ValheimUIMessage } from '@/lib/chat-types';
import { ChatRequestError } from '@/lib/chat/errors';
import type { PuterChatChunk, PuterChatOptions, PuterLike } from '@/lib/chat/puter-client';
import { puterChatErrorCode, puterSignInErrorCode } from '@/lib/chat/puter-errors';
import { clampAnswer, PuterChatTransport } from '@/lib/chat/puter-transport';

/*
 * The transport against a stand-in for puter.js and for this site's API: no
 * request leaves the process, and no Puter account is involved.
 */

type Call = { path: string; body: Record<string, unknown>; keepalive?: boolean };

const QUESTION: ValheimUIMessage = { id: 'q1', role: 'user', parts: [{ type: 'text', text: '¿Cómo invoco a Bonemass?' }] };
const BODY = { conversationId: 'conv-1', lang: 'es' };
const CITATIONS = [{ n: 1, title: 'Bonemass', url: 'https://valheim.fandom.com/wiki/Bonemass', sectionPath: '', source: 'fandom', score: 1 }];
const PREPARED = {
  assistantId: 'conv-1:q1:a',
  citations: CITATIONS,
  grant: 'grant-token',
  messages: [
    { role: 'system', content: 'You answer from the wiki.' },
    { role: 'user', content: 'Q + excerpts' },
  ],
  maxTokens: 1200,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fake of this site's API, answering by path from a queue of responses. */
function api(routes: Record<string, Array<() => Response>>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    calls.push({ path: input, body: JSON.parse(String(init?.body ?? '{}')), keepalive: init?.keepalive });
    const queue = routes[input];
    const next = queue?.length && queue.length > 1 ? queue.shift() : queue?.[0];
    if (!next) throw new Error(`unexpected ${input}`);
    return next();
  });
  return { fetch, calls };
}

async function* chunks(list: PuterChatChunk[], options: { delayMs?: number; failWith?: unknown } = {}) {
  for (const chunk of list) {
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    yield chunk;
  }
  if (options.failWith) throw options.failWith;
}

function fakePuter(overrides: Partial<{ signedIn: boolean; token: string | null; chat: PuterLike['ai']['chat'] }> = {}) {
  const chat = vi.fn(
    overrides.chat ??
      (async () =>
        chunks([
          { type: 'reasoning', text: 'thinking about Bonemass' } as PuterChatChunk,
          { type: 'text', text: 'Ofrendá ' },
          { type: 'text', text: 'diez Wither bones [1].' },
          { type: 'usage', finish_reason: 'stop' },
        ])),
  );
  const puter: PuterLike = {
    authToken: overrides.token === undefined ? 'puter-app-token' : overrides.token,
    auth: {
      signIn: vi.fn(async () => ({ success: true, token: 'puter-app-token' })),
      isSignedIn: vi.fn(() => overrides.signedIn ?? true),
      signOut: vi.fn(),
    },
    ai: { chat },
  };
  return { puter, chat };
}

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

function transport(
  puter: PuterLike,
  fetch: ReturnType<typeof api>['fetch'],
  model = 'gemini-2.5-flash-lite',
  // What puter.js keeps in this browser's storage: by default the same token this tab's SDK holds.
  storedToken: () => string | null | undefined = () => 'puter-app-token',
  options: { saveTimeoutMs?: number } = {},
) {
  return new PuterChatTransport({
    loadPuter: async () => puter,
    model: () => model,
    fetch,
    storedToken,
    firstTextTimeoutMs: 200,
    gapTimeoutMs: 200,
    ...options,
  });
}

function send(
  t: PuterChatTransport,
  abortSignal?: AbortSignal,
  options: { messages?: ValheimUIMessage[]; trigger?: 'submit-message' | 'regenerate-message' } = {},
) {
  return t.sendMessages({
    trigger: options.trigger ?? 'submit-message',
    chatId: 'valheim-codex',
    messageId: undefined,
    messages: options.messages ?? [QUESTION],
    abortSignal,
    body: BODY,
  });
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Like `api`, but each answer may take its time, and the log says when each
 * request left (`→ chat/complete#1`) and when its answer came back
 * (`← chat/complete#1 200`): what the server saw first, not only what was
 * asked first.
 */
function timedApi(routes: Record<string, Array<() => Response | Promise<Response>>>) {
  const calls: Call[] = [];
  const events: string[] = [];
  const counts = new Map<string, number>();
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    calls.push({ path: input, body: JSON.parse(String(init?.body ?? '{}')), keepalive: init?.keepalive });
    const n = (counts.get(input) ?? 0) + 1;
    counts.set(input, n);
    const label = `${input.replace('/api/', '')}#${n}`;
    events.push(`→ ${label}`);
    const queue = routes[input];
    const next = queue?.length && queue.length > 1 ? queue.shift() : queue?.[0];
    if (!next) throw new Error(`unexpected ${input}`);
    const response = await next();
    events.push(`← ${label} ${response.status}`);
    return response;
  });
  return { fetch, calls, events };
}

const QUESTION_2: ValheimUIMessage = { id: 'q2', role: 'user', parts: [{ type: 'text', text: '¿Y Moder?' }] };
const STOPPED_ANSWER: ValheimUIMessage = { id: 'conv-1:q1:a', role: 'assistant', parts: [{ type: 'text', text: 'Primero ' }] };
const PREPARED_2 = { ...PREPARED, assistantId: 'conv-1:q2:a', grant: 'grant-2' };

/**
 * Puter writing a first answer that the reader stops halfway ('Primero ',
 * then silence), and a whole second one. `written` settles once the first
 * answer's text has been read.
 */
function stoppablePuter() {
  let written!: () => void;
  const firstWritten = new Promise<void>((resolve) => (written = resolve));
  let answers = 0;
  const { puter, chat } = fakePuter({
    chat: async () => {
      answers += 1;
      if (answers > 1) return chunks([{ type: 'text', text: 'Segunda.' }, { type: 'usage', finish_reason: 'stop' }]);
      return (async function* () {
        yield { type: 'text', text: 'Primero ' } as PuterChatChunk;
        written();
        await new Promise(() => {});
      })();
    },
  });
  return { puter, chat, firstWritten };
}

type NextRequest = { messages: ValheimUIMessage[]; trigger: 'submit-message' | 'regenerate-message' };

/** Another question, after the stopped answer. */
const ASK_ANOTHER: NextRequest = { messages: [QUESTION, STOPPED_ANSWER, QUESTION_2], trigger: 'submit-message' };
/** "Reintentar": the same question again, its stopped answer dropped from the thread. */
const RETRY: NextRequest = { messages: [QUESTION], trigger: 'regenerate-message' };

/** The next question the chat sends after a stop. */
const NEXT_REQUESTS: [string, NextRequest][] = [
  ['a new question', ASK_ANOTHER],
  ['Reintentar', RETRY],
];

const text = (out: UIMessageChunk[]) =>
  out
    .filter((c): c is Extract<UIMessageChunk, { type: 'text-delta' }> => c.type === 'text-delta')
    .map((c) => c.delta)
    .join('');

describe('PuterChatTransport', () => {
  it('prepares, streams the answer, and saves it before finishing', async () => {
    const { puter, chat } = fakePuter();
    const { fetch, calls } = api({
      '/api/chat/prepare': [() => json(200, PREPARED)],
      '/api/chat/complete': [() => json(200, { ok: true })],
    });

    const out = await drain(await send(transport(puter, fetch)));

    expect(calls[0]).toMatchObject({
      path: '/api/chat/prepare',
      body: { conversationId: 'conv-1', lang: 'es', message: { id: 'q1', text: '¿Cómo invoco a Bonemass?' } },
    });
    expect(chat).toHaveBeenCalledWith(PREPARED.messages, expect.objectContaining({ model: 'gemini-2.5-flash-lite', stream: true, temperature: 0.2, max_tokens: 1200 }));
    expect(out[0]).toEqual({ type: 'start', messageId: 'conv-1:q1:a' });
    expect(out[1]).toEqual({ type: 'data-sources', id: 'sources', data: { citations: CITATIONS } });
    expect(text(out)).toBe('Ofrendá diez Wither bones [1].');
    expect(out.at(-1)).toEqual({ type: 'finish' });

    const complete = calls.find((c) => c.path === '/api/chat/complete');
    expect(complete).toMatchObject({
      body: { grant: 'grant-token', text: 'Ofrendá diez Wither bones [1].', outcome: 'complete' },
      keepalive: true,
    });
    // Saved before the stream's end, so the next question's history has it.
    expect(calls.indexOf(complete!)).toBe(1);
  });

  it('never renders reasoning', async () => {
    const { puter } = fakePuter();
    const { fetch } = api({
      '/api/chat/prepare': [() => json(200, PREPARED)],
      '/api/chat/complete': [() => json(200, { ok: true })],
    });
    const out = await drain(await send(transport(puter, fetch)));
    expect(JSON.stringify(out)).not.toContain('thinking about Bonemass');
    expect(out.some((c) => c.type.startsWith('reasoning'))).toBe(false);
  });

  it('refuses to send when this browser lost its Puter session, without asking the server', async () => {
    const { puter, chat } = fakePuter({ signedIn: false });
    const { fetch } = api({});
    await expect(send(transport(puter, fetch))).rejects.toMatchObject({ code: 'puter_signed_out' });
    expect(fetch).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it('renews this site’s session once, silently, on a 401', async () => {
    const { puter } = fakePuter();
    const { fetch, calls } = api({
      '/api/chat/prepare': [() => json(401, { error: 'unauthorized' }), () => json(200, PREPARED)],
      '/api/auth/puter': [() => json(200, { ok: true, mode: 'puter', name: 'thorgrim' })],
      '/api/chat/complete': [() => json(200, { ok: true })],
    });
    const out = await drain(await send(transport(puter, fetch)));
    expect(calls.map((c) => c.path)).toEqual([
      '/api/chat/prepare',
      '/api/auth/puter',
      '/api/chat/prepare',
      '/api/chat/complete',
    ]);
    expect(calls[1]!.body).toEqual({ token: 'puter-app-token' });
    expect(out.at(-1)).toEqual({ type: 'finish' });
  });

  it('never answers with a token this browser has let go of (signed out, or another account, in another tab)', async () => {
    const { puter, chat } = fakePuter();
    for (const stored of [null, 'another-accounts-token']) {
      const { fetch } = api({});
      const error = await send(transport(puter, fetch, undefined, () => stored)).catch((e: unknown) => e);
      expect(error, String(stored)).toMatchObject({ code: 'puter_signed_out' });
      // Nothing asked of this site, nothing billed to the stale account.
      expect(fetch).not.toHaveBeenCalled();
    }
    expect(chat).not.toHaveBeenCalled();
  });

  it('never renews a token it cannot check against this browser’s, and never with one it has lost', async () => {
    const { puter, chat } = fakePuter();
    // Unreadable storage: the tab's own copy is used, but a lapsed session is not renewed silently.
    let stored: string | null | undefined = undefined;
    const { fetch, calls } = api({ '/api/chat/prepare': [() => json(401, { error: 'unauthorized' })] });
    const unreadable = await send(transport(puter, fetch, undefined, () => stored)).catch((e: unknown) => e);
    expect(unreadable).toMatchObject({ code: 'puter_signed_out', status: 401 });
    expect(calls.map((c) => c.path)).toEqual(['/api/chat/prepare']);

    // Signed out elsewhere while this question was on its way: the token is gone by the 401.
    stored = 'puter-app-token';
    const raced = api({
      '/api/chat/prepare': [
        () => {
          stored = null;
          return json(401, { error: 'unauthorized' });
        },
      ],
    });
    const error = await send(transport(puter, raced.fetch, undefined, () => stored)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'puter_signed_out', status: 401 });
    expect(raced.calls.map((c) => c.path)).toEqual(['/api/chat/prepare']);
    expect(chat).not.toHaveBeenCalled();
  });

  it('answers with the tab’s own token where storage cannot be read', async () => {
    const { puter, chat } = fakePuter();
    const { fetch } = api({
      '/api/chat/prepare': [() => json(200, PREPARED)],
      '/api/chat/complete': [() => json(200, { ok: true })],
    });
    const out = await drain(await send(transport(puter, fetch, undefined, () => undefined)));
    expect(chat).toHaveBeenCalledTimes(1);
    expect(out.at(-1)).toEqual({ type: 'finish' });
  });

  it('asks for a Puter reconnect when the renewal is refused too', async () => {
    const { puter } = fakePuter();
    const { fetch, calls } = api({
      '/api/chat/prepare': [() => json(401, { error: 'unauthorized' })],
      '/api/auth/puter': [() => json(401, { error: 'puter_token_invalid' })],
    });
    await expect(send(transport(puter, fetch))).rejects.toMatchObject({ code: 'puter_signed_out' });
    expect(calls.filter((c) => c.path === '/api/auth/puter')).toHaveLength(1);
  });

  it('turns a refused prepare into a code the interface can act on', async () => {
    const { puter, chat } = fakePuter();
    const { fetch } = api({ '/api/chat/prepare': [() => json(429, { error: 'rate_limited', retryAfter: 20 })] });
    const error = await send(transport(puter, fetch)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatRequestError);
    expect(error).toMatchObject({ code: 'rate_limited', status: 429, retryAfter: 20 });
    expect(chat).not.toHaveBeenCalled();
  });

  it('shows the stored no-context answer without calling a model or saving again', async () => {
    const { puter, chat } = fakePuter();
    const { fetch, calls } = api({
      '/api/chat/prepare': [() => json(200, { assistantId: 'conv-1:q1:a', citations: [], empty: 'No encontré eso en la wiki.', maxTokens: 1200 })],
    });
    const out = await drain(await send(transport(puter, fetch)));
    expect(text(out)).toBe('No encontré eso en la wiki.');
    expect(chat).not.toHaveBeenCalled();
    expect(calls.map((c) => c.path)).toEqual(['/api/chat/prepare']);
  });

  it('stores a stopped answer as stopped, with what had been read', async () => {
    const controller = new AbortController();
    const { puter } = fakePuter({
      chat: async () =>
        (async function* () {
          yield { type: 'text', text: 'Primero ' };
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 50));
          yield { type: 'text', text: 'nunca leído' };
        })(),
    });
    const { fetch, calls } = api({
      '/api/chat/prepare': [() => json(200, PREPARED)],
      '/api/chat/complete': [() => json(200, { ok: true })],
    });
    const out = await drain(await send(transport(puter, fetch), controller.signal));
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/api/chat/complete')).toBe(true));
    expect(calls.find((c) => c.path === '/api/chat/complete')!.body).toMatchObject({ text: 'Primero ', outcome: 'stopped' });
    expect(out.some((c) => c.type === 'error')).toBe(false);
  });

  it('ends a failed answer with its code first, and stores it as failed', async () => {
    const { puter } = fakePuter({
      chat: async () => chunks([{ type: 'text', text: 'Medio ' }, { type: 'error', message: 'no credit', code: 'insufficient_funds', status: 402 }]),
    });
    const { fetch, calls } = api({
      '/api/chat/prepare': [() => json(200, PREPARED)],
      '/api/chat/complete': [() => json(200, { ok: true })],
    });
    const out = await drain(await send(transport(puter, fetch)));
    const tail = out.slice(-2);
    expect(tail[0]).toEqual({ type: 'data-error', data: { code: 'puter_insufficient_funds' }, transient: true });
    expect(tail[1]).toMatchObject({ type: 'error' });
    expect(calls.find((c) => c.path === '/api/chat/complete')!.body).toMatchObject({ text: 'Medio ', outcome: 'error' });
  });

  it('tries the other model once when the chosen one fails before writing', async () => {
    const models: string[] = [];
    const { puter } = fakePuter({
      chat: async (_messages, options: PuterChatOptions) => {
        models.push(options.model);
        if (models.length === 1) throw { error: 'model_unavailable', message: 'gone' };
        return chunks([{ type: 'text', text: 'Hola' }]);
      },
    });
    const { fetch } = api({
      '/api/chat/prepare': [() => json(200, PREPARED)],
      '/api/chat/complete': [() => json(200, { ok: true })],
    });
    const out = await drain(await send(transport(puter, fetch)));
    expect(models).toEqual(['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite']);
    expect(text(out)).toBe('Hola');
  });

  it('does not switch models over the reader’s own account', async () => {
    let calls = 0;
    const { puter } = fakePuter({
      chat: async () => {
        calls += 1;
        throw { status: 402, code: 'subscription_required' };
      },
    });
    const { fetch } = api({
      '/api/chat/prepare': [() => json(200, PREPARED)],
      '/api/chat/complete': [() => json(200, { ok: true })],
    });
    const out = await drain(await send(transport(puter, fetch, 'gpt-5.4-nano')));
    expect(calls).toBe(1);
    expect(out.find((c) => c.type === 'data-error')).toMatchObject({ data: { code: 'puter_subscription_required' } });
  });

  it('gives up on a model that goes quiet', async () => {
    const { puter } = fakePuter({ chat: () => new Promise(() => {}) });
    const { fetch, calls } = api({
      '/api/chat/prepare': [() => json(200, PREPARED)],
      '/api/chat/complete': [() => json(200, { ok: true })],
    });
    const out = await drain(await send(transport(puter, fetch)));
    expect(out.find((c) => c.type === 'data-error')).toMatchObject({ data: { code: 'timeout' } });
    expect(calls.find((c) => c.path === '/api/chat/complete')!.body).toMatchObject({ outcome: 'error' });
  });

  it('marks an answer cut by the length cap as cut, not complete', async () => {
    const { puter } = fakePuter({
      chat: async () => chunks([{ type: 'text', text: 'Larga…' }, { type: 'usage', finish_reason: 'length' }]),
    });
    const { fetch, calls } = api({
      '/api/chat/prepare': [() => json(200, PREPARED)],
      '/api/chat/complete': [() => json(200, { ok: true })],
    });
    const out = await drain(await send(transport(puter, fetch)));
    expect(out.find((c) => c.type === 'data-error')).toMatchObject({ data: { code: 'interrupted' } });
    expect(calls.find((c) => c.path === '/api/chat/complete')!.body).toMatchObject({ outcome: 'error' });
  });

  it('treats a 429 from complete as already saved', async () => {
    const { puter } = fakePuter();
    const { fetch, calls } = api({
      '/api/chat/prepare': [() => json(200, PREPARED)],
      '/api/chat/complete': [() => json(429, { error: 'rate_limited', bucket: 'chat:complete', retryAfter: 900 })],
    });
    const out = await drain(await send(transport(puter, fetch)));
    expect(out.at(-1)).toEqual({ type: 'finish' });
    expect(calls.filter((c) => c.path === '/api/chat/complete')).toHaveLength(1);
  });

  describe('a refused save: nothing left to save (409 question_superseded, 404 conversation_not_found)', () => {
    const refusals: [string, () => Response][] = [
      ['409 question_superseded', () => json(409, { error: 'question_superseded' })],
      ['404 conversation_not_found', () => json(404, { error: 'conversation_not_found' })],
    ];

    function watchRejections() {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      return {
        unhandled,
        async stop() {
          // Long enough for a stray rejection to be reported.
          await delay(20);
          process.off('unhandledRejection', unhandled);
        },
      };
    }

    it.each(refusals)('finishes the answer as answered, without an error or a second try: %s', async (_name, refusal) => {
      const watch = watchRejections();
      const { puter } = fakePuter();
      const { fetch, calls } = api({
        '/api/chat/prepare': [() => json(200, PREPARED)],
        '/api/chat/complete': [refusal],
      });
      const out = await drain(await send(transport(puter, fetch)));
      await watch.stop();

      expect(text(out)).toBe('Ofrendá diez Wither bones [1].');
      expect(out.at(-1)).toEqual({ type: 'finish' });
      expect(out.some((c) => c.type === 'error' || c.type === 'data-error')).toBe(false);
      expect(calls.map((c) => c.path)).toEqual(['/api/chat/prepare', '/api/chat/complete']);
      expect(watch.unhandled).not.toHaveBeenCalled();
    });

    it.each(refusals)('lets a stopped answer go, and the next question go ahead: %s', async (_name, refusal) => {
      const watch = watchRejections();
      const { puter, firstWritten } = stoppablePuter();
      const { fetch, calls, events } = timedApi({
        '/api/chat/prepare': [() => json(200, PREPARED), () => json(200, PREPARED_2)],
        '/api/chat/complete': [() => delay(20).then(refusal), () => json(200, { ok: true })],
      });
      const t = transport(puter, fetch);

      const stopped = new AbortController();
      const first = drain(await send(t, stopped.signal));
      await firstWritten;
      stopped.abort();
      const second = await drain(await send(t, undefined, ASK_ANOTHER));
      const firstOut = await first;
      await watch.stop();

      expect(firstOut.some((c) => c.type === 'error' || c.type === 'data-error')).toBe(false);
      expect(text(second)).toBe('Segunda.');
      expect(second.at(-1)).toEqual({ type: 'finish' });
      // The refused save is not sent again: one complete per answer.
      expect(calls.filter((c) => c.path === '/api/chat/complete').map((c) => c.body['grant'])).toEqual([
        'grant-token',
        'grant-2',
      ]);
      expect(events.indexOf('→ chat/prepare#2')).toBeGreaterThan(events.findIndex((e) => e.startsWith('← chat/complete#1')));
      expect(watch.unhandled).not.toHaveBeenCalled();
    });
  });

  describe('the next question after a stop (CS-R2a)', () => {
    it.each(NEXT_REQUESTS)('saves the stopped answer before preparing %s', async (_name, next) => {
      const { puter, firstWritten } = stoppablePuter();
      const { fetch, calls, events } = timedApi({
        '/api/chat/prepare': [() => json(200, PREPARED), () => json(200, PREPARED_2)],
        // Slower than the next question: before, its prepare reached the server first.
        '/api/chat/complete': [() => delay(40).then(() => json(200, { ok: true }))],
      });
      const t = transport(puter, fetch);

      const stopped = new AbortController();
      const first = drain(await send(t, stopped.signal));
      await firstWritten;
      // Stop, and ask again at once.
      stopped.abort();
      const second = await drain(await send(t, undefined, next));
      await first;

      expect(events).toEqual([
        '→ chat/prepare#1',
        '← chat/prepare#1 200',
        '→ chat/complete#1',
        '← chat/complete#1 200',
        '→ chat/prepare#2',
        '← chat/prepare#2 200',
        '→ chat/complete#2',
        '← chat/complete#2 200',
      ]);
      expect(calls[1]).toMatchObject({
        path: '/api/chat/complete',
        body: { grant: 'grant-token', text: 'Primero ', outcome: 'stopped' },
        keepalive: true,
      });
      expect(second.at(-1)).toEqual({ type: 'finish' });
    });

    it('waits for a save that had to renew the session after a 401', async () => {
      const { puter, firstWritten } = stoppablePuter();
      const { fetch, events } = timedApi({
        '/api/chat/prepare': [() => json(200, PREPARED), () => json(200, PREPARED_2)],
        '/api/chat/complete': [
          () => delay(10).then(() => json(401, { error: 'unauthorized' })),
          () => delay(20).then(() => json(200, { ok: true })),
          () => json(200, { ok: true }),
        ],
        '/api/auth/puter': [() => delay(10).then(() => json(200, { ok: true, mode: 'puter', name: 'thorgrim' }))],
      });
      const t = transport(puter, fetch);

      const stopped = new AbortController();
      const first = drain(await send(t, stopped.signal));
      await firstWritten;
      stopped.abort();
      await drain(await send(t, undefined, ASK_ANOTHER));
      await first;

      expect(events.slice(2, 9)).toEqual([
        '→ chat/complete#1',
        '← chat/complete#1 401',
        '→ auth/puter#1',
        '← auth/puter#1 200',
        '→ chat/complete#2',
        '← chat/complete#2 200',
        '→ chat/prepare#2',
      ]);
    });

    it('still asks the next question once saveTimeoutMs has passed, if the save never settles', async () => {
      const { puter, firstWritten } = stoppablePuter();
      const { fetch, events } = timedApi({
        '/api/chat/prepare': [() => json(200, PREPARED), () => json(200, PREPARED_2)],
        '/api/chat/complete': [() => new Promise<Response>(() => {}), () => json(200, { ok: true })],
      });
      const t = transport(puter, fetch, undefined, undefined, { saveTimeoutMs: 150 });

      const stopped = new AbortController();
      const first = drain(await send(t, stopped.signal));
      await firstWritten;
      stopped.abort();
      const asked = performance.now();
      const second = await drain(await send(t, undefined, ASK_ANOTHER));
      const waited = performance.now() - asked;
      await first;

      expect(events).toContain('→ chat/prepare#2');
      expect(events).not.toContain('← chat/complete#1 200');
      // Timers may fire a millisecond early; the point is that it waited, and not for long.
      expect(waited).toBeGreaterThanOrEqual(140);
      expect(waited).toBeLessThan(2000);
      expect(text(second)).toBe('Segunda.');
      expect(second.at(-1)).toEqual({ type: 'finish' });
    });

    it('lets a stop end that wait at once, without preparing anything', async () => {
      const { puter, firstWritten } = stoppablePuter();
      const { fetch, events } = timedApi({
        '/api/chat/prepare': [() => json(200, PREPARED), () => json(200, PREPARED_2)],
        '/api/chat/complete': [() => new Promise<Response>(() => {})],
      });
      const t = transport(puter, fetch, undefined, undefined, { saveTimeoutMs: 60_000 });

      const stopped = new AbortController();
      const first = drain(await send(t, stopped.signal));
      await firstWritten;
      stopped.abort();
      const again = new AbortController();
      const asking = send(t, again.signal, ASK_ANOTHER);
      await delay(20);
      again.abort();

      await expect(asking).rejects.toMatchObject({ name: 'AbortError' });
      await first;
      expect(events.filter((e) => e.startsWith('→ chat/prepare'))).toEqual(['→ chat/prepare#1']);
    });

    it('does not wait when the previous answer was saved already', async () => {
      const { puter } = fakePuter();
      const { fetch, events } = timedApi({
        '/api/chat/prepare': [() => json(200, PREPARED), () => json(200, PREPARED_2)],
        '/api/chat/complete': [() => json(200, { ok: true })],
      });
      const t = transport(puter, fetch, undefined, undefined, { saveTimeoutMs: 60_000 });
      await drain(await send(t));
      const asked = performance.now();
      await drain(await send(t, undefined, ASK_ANOTHER));
      // Nowhere near the 60 s it would have waited for a save still pending.
      expect(performance.now() - asked).toBeLessThan(5000);
      expect(events.filter((e) => e.startsWith('→'))).toEqual([
        '→ chat/prepare#1',
        '→ chat/complete#1',
        '→ chat/prepare#2',
        '→ chat/complete#2',
      ]);
    });
  });
});

describe('clampAnswer', () => {
  it('keeps answers within what complete stores, without splitting an emoji', () => {
    expect(clampAnswer('abc', 5)).toBe('abc');
    expect(clampAnswer('abcdef', 4)).toBe('abcd');
    expect(clampAnswer('abc😀', 4)).toBe('abc');
  });
});

describe('Puter error codes', () => {
  it('maps every shape puter.js rejects with', () => {
    expect(puterChatErrorCode({ status: 401, message: 'Unauthorized' })).toBe('puter_signed_out');
    expect(puterChatErrorCode({ error: { code: 'auth_canceled', message: 'Authentication canceled' } })).toBe('puter_signed_out');
    expect(puterChatErrorCode({ success: false, error: { code: 'token_auth_failed' } })).toBe('puter_signed_out');
    expect(puterChatErrorCode({ error: 'x', code: 'insufficient_funds', status: 402 })).toBe('puter_insufficient_funds');
    expect(puterChatErrorCode({ status: 402 })).toBe('puter_insufficient_funds');
    expect(puterChatErrorCode({ code: 'subscription_required', status: 402 })).toBe('puter_subscription_required');
    expect(puterChatErrorCode({ code: 'too_many_requests', status: 429 })).toBe('puter_rate_limited');
    expect(puterChatErrorCode({ errorCode: 'credits_reserved' })).toBe('puter_rate_limited');
    expect(puterChatErrorCode({ type: 'error', message: 'upstream exploded' })).toBe('puter_failed');
    expect(puterChatErrorCode(undefined)).toBe('puter_failed');
  });

  it('maps the sign-in popup’s outcomes', () => {
    expect(puterSignInErrorCode({ error: 'popup_blocked', msg: '' })).toBe('puter_popup_blocked');
    expect(puterSignInErrorCode({ error: 'auth_window_closed' })).toBe('puter_auth_closed');
    expect(puterSignInErrorCode({ error: 'not_available_in_app' })).toBe('puter_unsupported');
    expect(puterSignInErrorCode({ error: 'unsupported_origin' })).toBe('puter_unsupported');
    expect(puterSignInErrorCode({ error: 'auth_timeout' })).toBe('puter_auth_timeout');
    expect(puterSignInErrorCode(new Error('boom'))).toBe('puter_failed');
  });
});
