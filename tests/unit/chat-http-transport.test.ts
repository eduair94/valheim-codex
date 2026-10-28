import { describe, expect, it, vi } from 'vitest';
import type { ValheimUIMessage } from '@/lib/chat-types';
import { ChatRequestError } from '@/lib/chat/errors';
import { createServerTransport, guardedFetch } from '@/lib/chat/http-transport';

/*
 * The transport for password and own-key readers: one question per request,
 * and failures as codes rather than response bodies.
 */

const THREAD: ValheimUIMessage[] = [
  { id: 'q0', role: 'user', parts: [{ type: 'text', text: '¿Qué es Bonemass?' }] },
  { id: 'c:q0:a', role: 'assistant', parts: [{ type: 'text', text: 'Un jefe [1].' }] },
  { id: 'q1', role: 'user', parts: [{ type: 'text', text: '¿Y cómo lo invoco?' }] },
];

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('createServerTransport', () => {
  it('sends only the new question, with the conversation and the language', async () => {
    const fetch = vi.fn(async () => sse([{ type: 'start', messageId: 'c:q1:a' }, { type: 'finish' }]));
    const transport = createServerTransport(fetch);
    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: 'valheim-codex',
      messageId: undefined,
      messages: THREAD,
      abortSignal: undefined,
      body: { conversationId: 'c', lang: 'en' },
    });
    await stream.pipeTo(new WritableStream());

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/chat');
    expect(JSON.parse(String(init.body))).toEqual({ conversationId: 'c', lang: 'en', message: THREAD[2] });
  });

  it('turns a refused request into its code instead of its body', async () => {
    const fetch = vi.fn(async () => Response.json({ error: 'unauthorized' }, { status: 401 }));
    const transport = createServerTransport(fetch);
    const error = await transport
      .sendMessages({
        trigger: 'regenerate-message',
        chatId: 'valheim-codex',
        messageId: undefined,
        messages: THREAD,
        abortSignal: undefined,
        body: { conversationId: 'c', lang: 'es' },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatRequestError);
    expect(error).toMatchObject({ code: 'unauthorized', status: 401, message: 'unauthorized' });
  });
});

describe('guardedFetch', () => {
  it('reads a gateway page by its status', async () => {
    const fetch = guardedFetch(async () => new Response('<html>502 Bad gateway</html>', { status: 502 }));
    await expect(fetch('/api/chat')).rejects.toMatchObject({ code: 'unavailable', status: 502 });
    const other = guardedFetch(async () => new Response('<html>Internal error</html>', { status: 500 }));
    await expect(other('/api/chat')).rejects.toMatchObject({ code: 'http_500', status: 500 });
  });

  it('calls a failed connection the network', async () => {
    const fetch = guardedFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fetch('/api/chat')).rejects.toMatchObject({ code: 'network', status: null });
  });

  it('lets an abort through untouched, so a stop is not a failure', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    const fetch = guardedFetch(async () => {
      throw abort;
    });
    await expect(fetch('/api/chat')).rejects.toBe(abort);
  });

  it('passes a good response through', async () => {
    const ok = new Response('fine');
    await expect(guardedFetch(async () => ok)('/api/chat')).resolves.toBe(ok);
  });
});
