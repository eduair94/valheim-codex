'use client';

import { useEffect } from 'react';
import { useStrings } from '@/components/shell/lang-context';
import type { ErrorCopy } from '@/lib/i18n/error-copy';
import type { Lang } from '@/lib/i18n/strings';

type ErrorProps = {
  error: unknown;
  retry: () => void;
  inFrame?: boolean;
};

/**
 * What the reader sees when a page fails to render: what happened, a retry
 * that re-renders without a reload, and a way back that always works.
 *
 * Its words come from the page's `LangProvider`. `global-error.tsx`, which
 * replaces the root layout and so has no provider, renders `ErrorPage` with
 * a copy of its own instead.
 */
export function ErrorView({ lang, ...props }: ErrorProps & { lang: Lang }) {
  const t = useStrings(lang);
  return <ErrorPage copy={t} {...props} />;
}

/**
 * `inFrame` when the wiki's nav is already on screen (a reader page failed
 * inside the wiki layout). Otherwise the error replaced everything below the
 * root layout, or the root layout itself, and this draws a page of its own.
 *
 * The way back is a plain link, not a client-side navigation: if what failed
 * is shared by every page, a full load is the recovery most likely to work.
 * The reference is the digest Next logs on the server, so a report can be
 * matched to the log line; the message itself is never shown, because in
 * production it is a placeholder and in development it can carry internals.
 */
export function ErrorPage({ copy: t, error, retry, inFrame = false }: ErrorProps & { copy: ErrorCopy }) {
  const digest =
    error instanceof Error && 'digest' in error && typeof error.digest === 'string' ? error.digest : null;

  useEffect(() => {
    console.error(error);
  }, [error]);

  const body = (
    <section aria-labelledby="error-title" className="max-w-xl">
      <p className="label text-forge">{t.shellErrorLabel}</p>
      <h1 id="error-title" className="display mt-2 text-2xl leading-tight text-balance text-birch sm:text-3xl">
        {t.shellErrorTitle}
      </h1>
      <p className="mt-4 text-ash">{t.shellErrorBody}</p>
      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => retry()}
          className="inline-flex h-11 items-center rounded-md bg-forge px-4 text-sm text-bog transition-colors hover:bg-forge/90"
        >
          {t.retry}
        </button>
        <a
          href="/wiki"
          className="inline-flex h-11 items-center rounded-md border border-moss px-4 text-sm text-birch transition-colors hover:border-lichen hover:bg-peat"
        >
          {t.shellErrorHome}
        </a>
      </div>
      {digest ? (
        <p className="mt-8 font-mono text-xs text-ash">
          {t.shellErrorReference}: {digest}
        </p>
      ) : null}
    </section>
  );

  if (inFrame) return <div className="pt-2 pb-10 sm:pt-4">{body}</div>;

  return (
    <main className="flex min-h-dvh flex-col bg-bog px-4 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6">
      <p className="display text-sm text-birch">{t.appName}</p>
      <div className="flex flex-1 items-center py-10">{body}</div>
    </main>
  );
}
