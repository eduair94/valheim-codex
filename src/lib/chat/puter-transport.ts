import type { ChatTransport, UIMessageChunk } from 'ai';
import { messageText, type MessageOutcome, type ValheimDataParts, type ValheimUIMessage } from '@/lib/chat-types';
import type { Citation } from '@/lib/db/schema';
import { ChatRequestError, errorFromResponse, isAbortError } from './errors';
import { DEFAULT_PUTER_MODEL } from './models';
import {
  exchangePuterToken,
  storedPuterToken,
  type PuterChatChunk,
  type PuterChatMessage,
  type PuterLike,
} from './puter-client';
import { puterChatErrorCode } from './puter-errors';

/**
 * Answers a Puter reader's question with their own Puter account.
 *
 * The model runs in the browser, on the reader's Puter balance; this server
 * never holds their Puter credential. It does what only it can do on either
 * side of the model call:
 *
 * 1. `POST /api/chat/prepare` checks the quota and the conversation, stores
 *    the question, retrieves the wiki excerpts and returns the whole prompt
 *    with a signed grant (or the stored no-context answer, when nothing was
 *    found and no model is needed).
 * 2. `puter.ai.chat(messages, { stream: true, … })` writes the answer here,
 *    turned into the same UI message chunks `/api/chat` streams, so the chat
 *    renders both alike.
 * 3. `POST /api/chat/complete` stores what was written and how it ended, with
 *    the grant, so a reopened conversation reads the same.
 *
 * Reasoning chunks are dropped: a model's thinking is not the answer, and
 * nothing renders it. `max_tokens` is always set: Puter reserves the reader's
 * credit for it up front, and without it one question could hold their whole
 * balance and get a second one refused.
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Chunk = UIMessageChunk<unknown, ValheimDataParts>;

export type PuterTransportOptions = {
  loadPuter: () => Promise<PuterLike>;
  /** The model, read at send time: the reader may change it between questions. */
  model: () => string;
  fetch?: FetchLike;
  /** The Puter token this browser holds now (`storedPuterToken`), checked before sending and renewing. */
  storedToken?: () => string | null | undefined;
  /** How long to wait for the answer to be saved before the stream finishes. */
  saveTimeoutMs?: number;
  /** Silence allowed before the first word, and between words after it. */
  firstTextTimeoutMs?: number;
  gapTimeoutMs?: number;
};

/** The prepared turn (`/api/chat/prepare`). */
type Prepared = {
  assistantId: string;
  citations: Citation[];
  maxTokens: number;
} & ({ kind: 'empty'; text: string } | { kind: 'model'; grant: string; messages: PuterChatMessage[] });

/** Longest answer `/api/chat/complete` stores, in UTF-16 code units (`MAX_ANSWER_CHARS`). */
const MAX_ANSWER_CHARS = 12_000;
/** Browsers refuse `keepalive` bodies above 64 KB in flight. */
const KEEPALIVE_MAX_BYTES = 60_000;
const DEFAULT_MAX_TOKENS = 1200;
const TEXT_ID = 'answer';

/**
 * How a model says it stopped early: a length cap or a safety stop. Stored as
 * a cut answer, not a whole one, the way `/api/chat` stores them.
 */
const CUT_SHORT = new Set(['length', 'max_tokens', 'content_filter', 'safety', 'recitation']);

/** Stops before the end of a string, never in the middle of a surrogate pair. */
export function clampAnswer(text: string, max: number = MAX_ANSWER_CHARS): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

function parsePrepared(body: unknown): Prepared | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b['assistantId'] !== 'string') return null;
  const citations = Array.isArray(b['citations']) ? (b['citations'] as Citation[]) : [];
  const maxTokens =
    typeof b['maxTokens'] === 'number' && b['maxTokens'] > 0 ? Math.floor(b['maxTokens']) : DEFAULT_MAX_TOKENS;
  const base = { assistantId: b['assistantId'], citations, maxTokens };
  const empty = b['empty'];
  if (typeof empty === 'string') return { ...base, kind: 'empty', text: empty };
  if (typeof b['grant'] === 'string' && Array.isArray(b['messages'])) {
    return { ...base, kind: 'model', grant: b['grant'], messages: b['messages'] as PuterChatMessage[] };
  }
  return null;
}

const ABORTED = Symbol('aborted');

function abortion(signal: AbortSignal | undefined): Promise<typeof ABORTED> | null {
  if (!signal) return null;
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(ABORTED), { once: true }));
}

/**
 * Iterates until the stream ends or the reader stops. puter.js 2.6.4 does not
 * pass an abort signal on to its request, so a stopped answer is let go
 * rather than cancelled: the page stops reading at once, and Puter's request
 * runs out on its own (Puter's docs: the model still finishes and is billed).
 */
async function* untilAborted<T>(iterable: AsyncIterable<T>, signal: AbortSignal | undefined): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  const aborted = abortion(signal);
  try {
    for (;;) {
      const next = iterator.next();
      // Abandoned on abort; it must not surface later as an unhandled rejection.
      next.catch(() => {});
      const result = aborted ? await Promise.race([next, aborted]) : await next;
      if (result === ABORTED || result.done) return;
      yield result.value;
    }
  } finally {
    void Promise.resolve(iterator.return?.()).catch(() => {});
  }
}

/** A promise, given up on when the signal aborts (puter.js would not notice the abort itself). */
async function untilAbortedOnce<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  promise.catch(() => {});
  const result = await Promise.race([promise, abortion(signal) ?? promise]);
  if (result === ABORTED) throw new DOMException('Aborted', 'AbortError');
  return result as T;
}

/** `promise`, or nothing once `ms` have passed, whichever comes first. The timer never outlives the wait. */
async function within(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

type Generated = { text: string; outcome: MessageOutcome; failure?: string };

const DEFAULT_SAVE_TIMEOUT_MS = 8000;

export class PuterChatTransport implements ChatTransport<ValheimUIMessage> {
  private readonly options: PuterTransportOptions;
  /**
   * The latest model answer, from the moment it starts until its save
   * (`/api/chat/complete`) settles — stopped or not. The next question waits
   * for it (`afterSave`).
   */
  private pending: Promise<void> | null = null;

  constructor(options: PuterTransportOptions) {
    this.options = options;
  }

  private fetch(input: string, init?: RequestInit): Promise<Response> {
    return (this.options.fetch ?? globalThis.fetch)(input, init);
  }

  private get saveTimeoutMs(): number {
    return this.options.saveTimeoutMs ?? DEFAULT_SAVE_TIMEOUT_MS;
  }

  /**
   * Marks an answer as on its way to being saved. The function it returns
   * hands over that save, whose end — whatever it was — releases the mark.
   */
  private hold(): (save: Promise<void>) => void {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    this.pending = held;
    void held.then(() => {
      if (this.pending === held) this.pending = null;
    });
    return (save) => void save.then(release, release);
  }

  /**
   * Waits for the previous answer to be saved before the next prepare goes
   * out: for at most `saveTimeoutMs`, and not past a stop.
   *
   * A stopped answer is saved without the stream waiting for it, so a stop
   * followed at once by another question, by "Reintentar", or a save that
   * first had to renew the session after a 401, used to send the next
   * prepare before that complete. The next turn then began without the
   * stopped answer: a new question's history, which prepare reads, left it
   * out, and a retry's fresh answer could be overwritten by the stale
   * stopped text arriving after it. (A question edited in the meantime still
   * refuses the stale save, with 409 `question_superseded`; see `save`.)
   */
  private async afterSave(signal: AbortSignal | undefined): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    const saved = within(pending, this.saveTimeoutMs);
    const result = await Promise.race([saved, abortion(signal) ?? saved]);
    if (result === ABORTED) throw new DOMException('Aborted', 'AbortError');
  }

  async sendMessages({
    messages,
    abortSignal,
    body,
  }: Parameters<ChatTransport<ValheimUIMessage>['sendMessages']>[0]): Promise<ReadableStream<Chunk>> {
    const puter = await this.options.loadPuter();
    /*
     * The token lives in this browser's storage and can be gone while this
     * site's cookie is not: Safari clears script storage after a week without
     * a visit, and Puter's own sign-out clears it. Without this check
     * `puter.ai.chat` would open Puter's sign-in by itself, in the middle of
     * sending, where the browser blocks the popup.
     *
     * And this tab's copy must still be this browser's token (see
     * `PUTER_TOKEN_KEY`): a tab left open keeps its copy after a sign-out, or
     * a sign-in with another Puter account, in another tab, and answering
     * with it would bill an account this browser has let go of.
     */
    if (!puter.auth.isSignedIn() || this.staleToken(puter)) throw new ChatRequestError({ code: 'puter_signed_out' });

    const question = messages.at(-1);
    const extra = (body ?? {}) as { conversationId?: unknown; lang?: unknown };
    if (!question || question.role !== 'user' || typeof extra.conversationId !== 'string') {
      throw new ChatRequestError({ code: 'invalid_request' });
    }

    await this.afterSave(abortSignal);
    const prepared = await this.prepare(
      puter,
      {
        conversationId: extra.conversationId,
        lang: extra.lang === 'en' ? 'en' : 'es',
        message: { id: question.id, text: messageText(question) },
      },
      abortSignal,
    );
    return this.answer(puter, prepared, abortSignal);
  }

  /** Nothing to resume: the answer was being written by this very page. */
  async reconnectToStream(): Promise<ReadableStream<Chunk> | null> {
    return null;
  }

  /**
   * One POST to this site's chat API, renewing this site's Puter session once
   * when it has lapsed (the cookie lasts a day; the Puter token much longer),
   * so a reader does not have to sign in again for that.
   */
  private async post(
    puter: PuterLike,
    path: string,
    payload: unknown,
    init: { signal?: AbortSignal; keepalive?: boolean } = {},
  ): Promise<Response> {
    const body = JSON.stringify(payload);
    const send = (): Promise<Response> =>
      this.fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: init.signal,
        keepalive: init.keepalive && new TextEncoder().encode(body).length < KEEPALIVE_MAX_BYTES,
      });
    let response = await send();
    if (response.status === 401 && (await this.renew(puter))) response = await send();
    return response;
  }

  private storedToken(): string | null | undefined {
    return (this.options.storedToken ?? storedPuterToken)();
  }

  /** This tab's token is not the one this browser holds any more (where storage can tell). */
  private staleToken(puter: PuterLike): boolean {
    const stored = this.storedToken();
    return stored !== undefined && stored !== puter.authToken;
  }

  /**
   * Renews only with a token this browser is known to hold still. The SDK's
   * copy in this tab outlives a sign-out in another one (see
   * `PUTER_TOKEN_KEY`), and renewing with it signed a reader straight back
   * in, with no click: on a shared computer, the previous reader's Puter
   * balance and history in whichever chat tab was left open. A token gone
   * from storage, replaced there by another account's, or unverifiable
   * because storage cannot be read, is not renewed: the reader is asked to
   * reconnect, which takes a click.
   */
  private async renew(puter: PuterLike): Promise<boolean> {
    const token = puter.authToken;
    if (!token || this.storedToken() !== token) return false;
    const result = await exchangePuterToken(token, (input, init) => this.fetch(input, init));
    return result.ok;
  }

  private async prepare(
    puter: PuterLike,
    payload: { conversationId: string; lang: 'es' | 'en'; message: { id: string; text: string } },
    signal: AbortSignal | undefined,
  ): Promise<Prepared> {
    let response: Response;
    try {
      response = await this.post(puter, '/api/chat/prepare', payload, { signal });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ChatRequestError({ code: 'network' });
    }
    if (response.status === 401) {
      // The session could not be renewed with the token this browser holds:
      // the reader has to sign in to Puter again.
      throw new ChatRequestError({ code: 'puter_signed_out', status: 401 });
    }
    if (!response.ok) throw await errorFromResponse(response);
    const prepared = parsePrepared(await response.json().catch(() => null));
    if (!prepared) throw new ChatRequestError({ code: 'generic', status: response.status });
    return prepared;
  }

  private answer(puter: PuterLike, prepared: Prepared, signal: AbortSignal | undefined): ReadableStream<Chunk> {
    return new ReadableStream<Chunk>({
      start: async (controller) => {
        // After a stop the reader has let the stream go; writing to it then throws.
        const send = (chunk: Chunk): void => {
          try {
            controller.enqueue(chunk);
          } catch {
            /* closed */
          }
        };
        const close = (): void => {
          try {
            controller.close();
          } catch {
            /* closed */
          }
        };

        send({ type: 'start', messageId: prepared.assistantId });
        send({ type: 'data-sources', id: 'sources', data: { citations: prepared.citations } });

        if (prepared.kind === 'empty') {
          // Nothing in the wiki matched; the server stored this answer already.
          send({ type: 'text-start', id: TEXT_ID });
          send({ type: 'text-delta', id: TEXT_ID, delta: prepared.text });
          send({ type: 'text-end', id: TEXT_ID });
          send({ type: 'finish' });
          close();
          return;
        }

        send({ type: 'data-status', id: 'status', data: { stage: 'answering' } });
        // From now until this answer is saved, the next question waits for it
        // (`afterSave`): a stop releases the reader at once, and their next
        // question can be on its way before this one has even begun saving.
        const release = this.hold();
        let save: Promise<void> = Promise.resolve();
        let started = false;
        let result: Generated;
        try {
          result = await this.generate(puter, prepared, signal, (delta) => {
            if (!started) send({ type: 'text-start', id: TEXT_ID });
            started = true;
            send({ type: 'text-delta', id: TEXT_ID, delta });
          });
          save = this.save(puter, prepared.grant, result);
        } finally {
          release(save);
        }

        if (result.outcome === 'stopped') {
          // The reader stopped; the chat has already moved on.
          close();
          return;
        }
        // Saved before the stream ends, as `/api/chat` does: the next
        // question's history is read from the database, and an answer still
        // being written when it is asked would be missing from it.
        await within(save, this.saveTimeoutMs);

        if (started) send({ type: 'text-end', id: TEXT_ID });
        if (result.failure) {
          // The code first, as the server does, so the interface can say what
          // to do; the error text itself is never shown.
          send({ type: 'data-error', data: { code: result.failure }, transient: true });
          send({ type: 'error', errorText: result.failure });
        } else {
          send({ type: 'finish' });
        }
        close();
      },
    });
  }

  /** The model's answer, and how it ended. */
  private async generate(
    puter: PuterLike,
    prepared: Extract<Prepared, { kind: 'model' }>,
    signal: AbortSignal | undefined,
    onText: (delta: string) => void,
  ): Promise<Generated> {
    let text = '';
    let finish: string | undefined;

    /*
     * A model that goes quiet is given up on, as `/api/chat` does: Puter
     * itself waits up to ten minutes for a reply to start. The deadline is
     * longer before the first word (a cold model, a long prompt) than
     * between words.
     */
    const local = new AbortController();
    const stop = (): void => local.abort();
    signal?.addEventListener('abort', stop, { once: true });
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          stalled = true;
          local.abort();
        },
        text ? (this.options.gapTimeoutMs ?? 30_000) : (this.options.firstTextTimeoutMs ?? 60_000),
      );
    };

    const attempt = async (model: string): Promise<void> => {
      arm();
      const stream = await untilAbortedOnce(
        puter.ai.chat(prepared.messages, {
          model,
          stream: true,
          temperature: 0.2,
          max_tokens: prepared.maxTokens,
          signal: local.signal,
        }),
        local.signal,
      );
      for await (const chunk of untilAborted<PuterChatChunk>(stream, local.signal)) {
        arm();
        if (chunk?.type === 'text' && typeof chunk.text === 'string' && chunk.text) {
          text += chunk.text;
          onText(chunk.text);
        } else if (chunk?.type === 'error') {
          throw chunk;
        } else if (chunk?.type === 'usage') {
          finish = chunk.finish_reason ?? chunk.stopReason;
        }
        // `reasoning*`, `tool_*` and the rest: not part of the answer.
      }
    };

    const model = this.options.model();
    try {
      try {
        await attempt(model);
      } catch (error) {
        /*
         * One more try, on another model, when the chosen one failed before
         * writing anything for a reason that is not the reader's account (a
         * model withdrawn or failing upstream). Their balance, plan, rate and
         * session are the same on any model, so those go straight to the
         * reader.
         */
        const fallback = model === DEFAULT_PUTER_MODEL ? 'gemini-3.5-flash-lite' : DEFAULT_PUTER_MODEL;
        if (text || local.signal.aborted || puterChatErrorCode(error) !== 'puter_failed') throw error;
        await attempt(fallback);
      }
    } catch (error) {
      if (signal?.aborted) return { text, outcome: 'stopped' };
      if (stalled) return { text, outcome: 'error', failure: 'timeout' };
      return { text, outcome: 'error', failure: puterChatErrorCode(error) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }

    if (signal?.aborted) return { text, outcome: 'stopped' };
    if (stalled) return { text, outcome: 'error', failure: text ? 'interrupted' : 'timeout' };
    if (finish && CUT_SHORT.has(finish.toLowerCase())) return { text, outcome: 'error', failure: 'interrupted' };
    if (!text.trim()) return { text, outcome: 'error', failure: 'empty_answer' };
    return { text, outcome: 'complete' };
  }

  /**
   * Stores the answer with the grant `prepare` issued. Sent with `keepalive`
   * so a stop followed by closing the tab still saves what was read.
   *
   * Never retried, and never an error for the reader, whatever comes back
   * (only a 401 is sent again, once, after renewing the session):
   *
   * - 429: this grant already saved its allowance; the answer is stored.
   * - 409 `question_superseded`: the question was edited or removed since,
   *   perhaps in another tab; there is no turn left for this answer.
   * - 404 `conversation_not_found`: the conversation itself is gone.
   *
   * Other failures leave the answer on screen and the stored turn marked as
   * failed, which is what it is from the server's side.
   */
  private async save(puter: PuterLike, grant: string, result: Generated): Promise<void> {
    try {
      // No abort signal: a stop is exactly when this must still go out.
      await this.post(
        puter,
        '/api/chat/complete',
        { grant, text: clampAnswer(result.text), outcome: result.outcome },
        { keepalive: true },
      );
    } catch {
      /* best effort; see above */
    }
  }
}
