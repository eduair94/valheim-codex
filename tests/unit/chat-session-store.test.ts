import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatTransport, UIMessageChunk } from 'ai';
import type { ValheimUIMessage } from '@/lib/chat-types';
import { ChatRequestError } from '@/lib/chat/errors';
import { ChatSession, endSession, sessionFor } from '@/lib/chat/session-store';

/*
 * The tab's chat session: one `Chat` that outlives the page's component, and
 * the bookkeeping beside it (how answers ended, the last stream's error code).
 * A scripted transport stands in for the server.
 */

type Script = (signal: AbortSignal | undefined) => ReadableStream<UIMessageChunk> | Promise<never>;

function scripted(script: Script): ChatTransport<ValheimUIMessage> {
  return {
    sendMessages: async ({ abortSignal }) => script(abortSignal),
    reconnectToStream: async () => null,
  };
}

function stream(chunks: UIMessageChunk[], options: { hold?: boolean } = {}): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (!options.hold) controller.close();
    },
  });
}

function session(script: Script, init: Partial<ConstructorParameters<typeof ChatSession>[0]> = {}) {
  return new ChatSession({
    profile: 'Ragnhild',
    mode: 'password',
    transport: () => scripted(script),
    conversation: null,
    conversations: [],
    ...init,
  });
}

afterEach(() => {
  endSession();
  vi.unstubAllGlobals();
});

describe('ChatSession', () => {
  it('captures the code a failed stream sends before its error', async () => {
    const s = session(() =>
      stream([
        { type: 'start', messageId: 'c:q:a' },
        { type: 'data-error', data: { code: 'byok_quota', retryAfter: 12 }, transient: true },
        { type: 'error', errorText: 'Tu clave…' },
      ]),
    );
    await s.chat.sendMessage({ text: 'hola' }, { body: { conversationId: 'c', lang: 'es' } });
    expect(s.chat.status).toBe('error');
    expect(s.getSnapshot().streamError).toEqual({ code: 'byok_quota', retryAfter: 12 });
  });

  it('records a stopped answer as stopped, and a question stopped before any answer as unanswered', async () => {
    const s = session((signal) =>
      new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'start', messageId: 'c:q:a' });
          controller.enqueue({ type: 'text-start', id: 't' });
          controller.enqueue({ type: 'text-delta', id: 't', delta: 'Primero' });
          signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
        },
      }),
    );
    const sending = s.chat.sendMessage({ text: 'hola' }, { body: { conversationId: 'c', lang: 'es' } });
    await vi.waitFor(() => expect(s.chat.messages.at(-1)?.role).toBe('assistant'));
    await s.chat.stop();
    await sending;
    expect(s.getSnapshot().outcomes).toEqual({ 'c:q:a': 'stopped' });

    const t = session((signal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = t.chat.sendMessage({ text: 'otra' }, { body: { conversationId: 'c2', lang: 'es' } });
    await vi.waitFor(() => expect(t.chat.status).toBe('submitted'));
    await t.chat.stop();
    await pending;
    const question = t.chat.messages.at(-1)!;
    expect(question.role).toBe('user');
    expect(t.getSnapshot().outcomes).toEqual({ [question.id]: 'stopped' });
  });

  it('clears a finished answer’s mark when it is asked again', async () => {
    let fail = true;
    const s = session(() =>
      fail
        ? Promise.reject(new ChatRequestError({ code: 'network' }))
        : stream([{ type: 'start', messageId: 'c:q:a' }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Ok' }, { type: 'text-end', id: 't' }, { type: 'finish' }]),
    );
    await s.chat.sendMessage({ text: 'hola' }, { body: { conversationId: 'c', lang: 'es' } });
    expect(s.chat.error).toBeInstanceOf(ChatRequestError);
    fail = false;
    s.prepareRequest();
    await s.chat.regenerate({ body: { conversationId: 'c', lang: 'es' } });
    expect(s.chat.status).toBe('ready');
    expect(s.chat.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(s.getSnapshot().outcomes).toEqual({});
  });

  it('shows another conversation with its outcomes, and a new one empty', () => {
    const s = session(() => stream([]));
    const listener = vi.fn();
    s.subscribe(listener);
    s.show({
      id: 'old',
      messages: [{ id: 'old:q', role: 'user', parts: [{ type: 'text', text: 'Q' }] }],
      outcomes: { 'old:q:a': 'error' },
      truncated: true,
    });
    expect(s.getSnapshot()).toMatchObject({ conversationId: 'old', outcomes: { 'old:q:a': 'error' }, truncated: true });
    expect(s.chat.messages).toHaveLength(1);
    s.show(null);
    expect(s.chat.messages).toHaveLength(0);
    expect(s.getSnapshot().conversationId).not.toBe('old');
    // A new conversation has nothing left out.
    expect(s.getSnapshot().truncated).toBe(false);
    expect(listener).toHaveBeenCalled();
  });

  it('says from the start whether the conversation it opened on was cut', () => {
    const conversation = { id: 'long', messages: [], outcomes: {}, truncated: true };
    expect(session(() => stream([]), { conversation }).getSnapshot().truncated).toBe(true);
    expect(session(() => stream([])).getSnapshot().truncated).toBe(false);
  });
});

describe('sessionFor', () => {
  it('keeps one session per tab for the same reader, and replaces it for another', () => {
    vi.stubGlobal('window', {});
    const make = (profile: string) => () => session(() => stream([]), { profile });
    const first = sessionFor({ profile: 'Ragnhild', mode: 'password' }, make('Ragnhild'));
    expect(sessionFor({ profile: 'Ragnhild', mode: 'password' }, make('Ragnhild'))).toBe(first);
    const other = sessionFor({ profile: 'byok:1', mode: 'byok' }, make('byok:1'));
    expect(other).not.toBe(first);
  });

  it('never keeps a session on the server, where a module serves every reader', () => {
    const make = () => session(() => stream([]));
    const a = sessionFor({ profile: 'Ragnhild', mode: 'password' }, make);
    const b = sessionFor({ profile: 'Ragnhild', mode: 'password' }, make);
    expect(a).not.toBe(b);
  });
});
