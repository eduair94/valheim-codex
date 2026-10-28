'use client';

import type { ErrorInfo } from 'next/error';
import { ErrorView } from '@/components/shell/error-view';
import { useServerLang } from '@/components/shell/lang-context';

/**
 * Anything below the root layout that threw: the chat, the sign-in page, or
 * the wiki layout itself (a segment's `error.tsx` never wraps its own layout).
 */
export default function AppError({ error, retry }: ErrorInfo) {
  return <ErrorView lang={useServerLang()} error={error} retry={retry} />;
}
