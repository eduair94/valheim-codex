'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { strings, type Lang } from '@/lib/i18n/strings';

/**
 * Asks for an article to be translated, once, while it is being read.
 *
 * Rendered only when the reader has chosen Spanish and no translation exists
 * yet. The page has already been served in English, so nothing is waiting on
 * this: it runs in the background and refreshes the route when it succeeds,
 * which is the point at which the server can render the Spanish version.
 *
 * Translation costs model tokens, so the endpoint only creates one for a
 * signed-in reader. A signed-out visitor gets a 403 here, which is not a
 * failure worth showing — they are already reading the article, in English,
 * exactly as they were a moment ago.
 */
export function TranslateOnView({ slug, lang }: { slug: string; lang: Lang }) {
  const router = useRouter();
  const t = strings(lang);
  const [state, setState] = useState<'working' | 'done' | 'unavailable'>('working');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(
          `/api/wiki/translate?slug=${encodeURIComponent(slug)}&lang=${lang}`,
        );
        if (cancelled) return;

        if (!response.ok) {
          setState('unavailable');
          return;
        }
        setState('done');
        // The server can now render the translation it just stored.
        router.refresh();
      } catch {
        if (!cancelled) setState('unavailable');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [slug, lang, router]);

  if (state === 'done') return null;

  return (
    <p className="mt-3 text-[0.8rem] text-ash" role="status">
      {state === 'working' ? (
        <>
          <span aria-hidden="true" className="ember mr-2" />
          {t.wikiTranslating}
        </>
      ) : (
        t.wikiTranslationUnavailable
      )}
    </p>
  );
}
