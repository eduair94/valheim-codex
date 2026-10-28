import { revalidateTag } from 'next/cache';
import { getChatPrincipal } from '@/lib/auth/principal-server';
import { getDb } from '@/lib/db/client';
import { handleTranslateGet, handleTranslatePost, type TranslateDeps } from './handler';

export const runtime = 'nodejs';

/**
 * `GET` reads a stored translation, `POST` creates or refreshes one. The
 * reasoning lives in `handler.ts`; this file only supplies the request-bound
 * dependencies, which a test cannot construct.
 */
const deps: TranslateDeps = {
  db: getDb,
  principal: getChatPrincipal,
  /*
   * `expire: 0` rather than the recommended 'max'. With 'max' the next request
   * is served the cached page — still in English — while it revalidates, and
   * the next request is precisely the reader who asked for the translation,
   * refreshing to see it.
   */
  revalidate: (tag) => revalidateTag(tag, { expire: 0 }),
};

export function GET(request: Request): Promise<Response> {
  return handleTranslateGet(request, deps);
}

export function POST(request: Request): Promise<Response> {
  return handleTranslatePost(request, deps);
}
