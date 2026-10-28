import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { newByokSubject, sealByok, BYOK_COOKIE, type ByokModel } from '@/lib/auth/byok';
import { createPuterSessionToken, PUTER_COOKIE } from '@/lib/auth/puter';
import { byokEncryptionKey, purposeKey } from '@/lib/auth/secrets';
import { createSessionToken, SESSION_COOKIE } from '@/lib/auth/session';

/**
 * Shared pieces for the chat route tests: cookies for each kind of reader,
 * request builders, an SSE reader and mock models. No network, no real keys.
 */

export const TEST_SECRET = 'test-session-secret-that-is-long-enough-0123456789';

export type Jar = Map<string, string>;

export async function passwordCookie(jar: Jar, profile: string): Promise<void> {
  jar.clear();
  jar.set(SESSION_COOKIE, await createSessionToken({ profile }, TEST_SECRET));
}

export async function byokCookie(
  jar: Jar,
  key: string,
  model: ByokModel = 'gemini-3.5-flash-lite',
  sub: string = newByokSubject(),
): Promise<string> {
  const encryption = await byokEncryptionKey({ SESSION_SECRET: TEST_SECRET });
  if (!encryption) throw new Error('no BYOK key');
  jar.clear();
  jar.set(BYOK_COOKIE, await sealByok({ sub, key, model }, encryption));
  return sub;
}

export async function puterCookie(jar: Jar, uuid: string, name = 'ana'): Promise<string> {
  const signing = await purposeKey('puter-session', { SESSION_SECRET: TEST_SECRET });
  if (!signing) throw new Error('no Puter key');
  const sub = `puter:${uuid}`;
  jar.clear();
  jar.set(PUTER_COOKIE, await createPuterSessionToken({ sub, name }, signing));
  return sub;
}

export function jsonRequest(
  url: string,
  body: unknown,
  init: { headers?: Record<string, string>; signal?: AbortSignal; method?: string } = {},
): Request {
  return new Request(url, {
    method: init.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      'cf-connecting-ip': '203.0.113.9',
      ...init.headers,
    },
    body: JSON.stringify(body),
    signal: init.signal,
  });
}

export function chatBody(conversationId: string, text: string, id = 'm1', lang: 'es' | 'en' = 'es') {
  return { conversationId, lang, message: { id, role: 'user', parts: [{ type: 'text', text }] } };
}

export type Chunk = { type: string; [key: string]: unknown };

/** Every JSON chunk of an SSE UI message stream. */
export async function readChunks(response: Response): Promise<Chunk[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)) as Chunk);
}

export function streamedText(chunks: Chunk[]): string {
  return chunks
    .filter((c) => c.type === 'text-delta')
    .map((c) => String(c.delta))
    .join('');
}

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

type StreamResult = Awaited<ReturnType<MockLanguageModelV3['doStream']>>;
type V3StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never;

/** A model whose answer streams as the given words, then finishes the given way. */
export function streamingModel(
  words: string[],
  finish: string = 'stop',
  options: { chunkDelayInMs?: number } = {},
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream<V3StreamPart>({
        chunkDelayInMs: options.chunkDelayInMs ?? null,
        initialDelayInMs: null,
        chunks: [
          { type: 'stream-start', warnings: [] },
          ...(words.length > 0 ? [{ type: 'text-start', id: 't' }] : []),
          ...words.map((delta) => ({ type: 'text-delta', id: 't', delta })),
          ...(words.length > 0 ? [{ type: 'text-end', id: 't' }] : []),
          { type: 'finish', finishReason: { unified: finish, raw: finish }, usage: USAGE },
        ] as V3StreamPart[],
      }),
    }),
  });
}

/**
 * A model that writes one word, then one more every `everyMs` until its call
 * is aborted — the shape a real provider has when the reader presses Stop.
 */
export function endlessModel(everyMs = 10): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async ({ abortSignal }) => {
      let n = 0;
      let timer: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<V3StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 't' });
          controller.enqueue({ type: 'text-delta', id: 't', delta: 'a0 ' });
          timer = setInterval(() => {
            n += 1;
            controller.enqueue({ type: 'text-delta', id: 't', delta: `a${n} ` });
          }, everyMs);
          abortSignal?.addEventListener('abort', () => {
            clearInterval(timer);
            controller.error(abortSignal.reason ?? new DOMException('aborted', 'AbortError'));
          });
        },
        cancel() {
          clearInterval(timer);
        },
      });
      return { stream };
    },
  });
}

/** A rewrite model answering with fixed queries. */
export function rewriteModel(queries: string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify({ queries }) }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: USAGE,
      warnings: [],
    }),
  });
}

/** Polls until `check` returns a value, for writes that finish after the response. */
export async function eventually<T>(check: () => Promise<T | null | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
