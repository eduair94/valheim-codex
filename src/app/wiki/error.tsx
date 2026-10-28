'use client';

import type { ErrorInfo } from 'next/error';
import { ErrorView } from '@/components/shell/error-view';
import { useServerLang } from '@/components/shell/lang-context';

/**
 * A reader page that threw while rendering. The wiki layout stays, so the nav
 * is still there; only the page area shows the error and the retry.
 */
export default function WikiError({ error, retry }: ErrorInfo) {
  return <ErrorView lang={useServerLang()} error={error} retry={retry} inFrame />;
}
