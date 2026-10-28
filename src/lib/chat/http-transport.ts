import { DefaultChatTransport } from 'ai';
import type { ValheimUIMessage } from '@/lib/chat-types';
import { ChatRequestError, errorFromResponse, isAbortError } from './errors';

/**
 * The transport for readers whose model runs on this server: the shared
 * password (the operator's models) and a reader's own Gemini key.
 *
 * Two differences from the SDK's default:
 *
 * - Only the new question is sent. The server rebuilds the history from what
 *   it stored itself; the whole thread used to be uploaded with every
 *   question, any size, and stored as the client described it.
 * - A refused request becomes a `ChatRequestError` with the server's code
 *   before the SDK can turn its body into an error message (it used to show
 *   `{"error":"unauthorized"}`, or a gateway's HTML page, verbatim). An abort
 *   passes through untouched, or a Stop would read as a failure.
 */

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function guardedFetch(fetchImpl?: FetchLike): FetchLike {
  return async (input, init) => {
    let response: Response;
    try {
      response = await (fetchImpl ?? globalThis.fetch)(input, init);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ChatRequestError({ code: 'network' });
    }
    if (!response.ok) throw await errorFromResponse(response);
    return response;
  };
}

/**
 * `{ conversationId, lang }` travel in each request's `body` option (see the
 * chat's `send` and `retry`); `message` is the last one in the thread: the new
 * question, or the one being asked again.
 */
export function createServerTransport(fetchImpl?: FetchLike): DefaultChatTransport<ValheimUIMessage> {
  return new DefaultChatTransport<ValheimUIMessage>({
    api: '/api/chat',
    fetch: guardedFetch(fetchImpl),
    prepareSendMessagesRequest: ({ messages, body }) => ({ body: { ...body, message: messages.at(-1) } }),
  });
}
