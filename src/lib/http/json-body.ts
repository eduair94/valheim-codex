import type { z } from 'zod';

/**
 * Reads a JSON request body with a size ceiling, a content-type check and a
 * schema, for every mutating route.
 *
 * - `application/json` only. A cross-site page can POST `text/plain` without
 *   a preflight, and `request.json()` parses that just the same; requiring the
 *   JSON type forces any cross-origin caller through CORS, which refuses it.
 * - A byte ceiling enforced while streaming. Next's proxy buffers up to 10 MB
 *   by default and *truncates* rather than rejecting, so the route has to
 *   enforce its own, smaller limit.
 * - Schema validation, so a handler only ever sees the shape it declared.
 */

export type JsonBodyResult<T> = { ok: true; data: T } | { ok: false; response: Response };

export const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

function fail(status: number, error: string): JsonBodyResult<never> {
  return { ok: false, response: Response.json({ error }, { status }) };
}

async function readLimited(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function readJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<JsonBodyResult<z.infer<S>>> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) return fail(415, 'unsupported_media_type');

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) return fail(413, 'payload_too_large');

  const text = await readLimited(request, maxBytes);
  if (text === null) return fail(413, 'payload_too_large');

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail(400, 'invalid_json');
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) return fail(400, 'invalid_request');
  return { ok: true, data: parsed.data };
}
