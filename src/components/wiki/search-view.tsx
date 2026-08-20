'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { TitleIndexEntry } from '@/lib/db/wiki-repo';
import { searchTitles } from '@/lib/wiki/title-search';
import { strings, type Lang } from '@/lib/i18n/strings';
import { articleHref } from '@/lib/routes';

type ContentHit = { slug: string; title: string; sectionPath: string; snippet: string };

/** Below this, a content search matches too much to be worth the request. */
const MIN_CONTENT_QUERY = 3;

/**
 * Search.
 *
 * Titles are matched in the browser against an index downloaded once: a
 * thousand entries filter in well under a frame, so results appear as you
 * type with no request and no spinner — and it keeps working offline. The
 * server is asked only for the harder question, "the words are in the body,
 * not the name", and only once typing pauses.
 */
export function SearchView({
  lang,
  totalArticles,
}: {
  lang: Lang;
  totalArticles: number;
}) {
  const t = strings(lang);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState<TitleIndexEntry[] | null>(null);
  const [hits, setHits] = useState<ContentHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/wiki/index');
        if (!response.ok) return;
        const data = (await response.json()) as { entries: TitleIndexEntry[] };
        if (!cancelled) setIndex(data.entries);
      } catch {
        // Offline with no cached index: title search is unavailable, but the
        // page still works and the content search will report its own failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const matches = useMemo(
    () => (index ? searchTitles(index, query) : []),
    [index, query],
  );

  // Content search waits for a pause: it is a request per query, and while
  // someone is still typing the answer is about to be thrown away.
  useEffect(() => {
    const q = query.trim();
    // Too short to search: no request, and the stale hits are filtered out
    // below rather than cleared here — clearing would be a state update inside
    // an effect for something that is simply derived from the query.
    if (q.length < MIN_CONTENT_QUERY) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/wiki/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = (await response.json()) as { hits: ContentHit[] };
        setHits(data.hits);
      } catch {
        setHits([]);
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const titleSlugs = new Set(matches.map((m) => m.entry.s));
  const extraHits =
    query.trim().length >= MIN_CONTENT_QUERY
      ? hits.filter((h) => !titleSlugs.has(h.slug))
      : [];

  return (
    <div>
      <div className="sticky top-0 z-20 -mx-4 bg-bog/95 px-4 pb-3 pt-1 backdrop-blur sm:-mx-6 sm:px-6">
        <label htmlFor="wiki-search" className="sr-only">
          {t.wikiSearchPlaceholder}
        </label>
        <input
          id="wiki-search"
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.wikiSearchPlaceholder}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="w-full rounded-md border border-moss bg-peat px-3.5 py-3 text-[1rem] text-birch transition-colors placeholder:text-ash/60 focus:border-forge/50 focus:outline-none"
        />
      </div>

      {query.trim() === '' ? (
        <p className="mt-6 text-sm text-ash">
          {t.wikiSearchEmpty.replace('1027', String(totalArticles))}
        </p>
      ) : matches.length === 0 && extraHits.length === 0 ? (
        <p className="mt-6 text-sm text-ash">{t.wikiNoResults}</p>
      ) : (
        <div className="mt-3 flex flex-col gap-5">
          {matches.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {matches.map(({ entry }) => (
                <li key={entry.s}>
                  <ResultRow entry={entry} />
                </li>
              ))}
            </ul>
          ) : null}

          {extraHits.length > 0 ? (
            <section>
              <h2 className="label mb-2">{t.wikiInContent}</h2>
              <ul className="flex flex-col gap-0.5">
                {extraHits.map((hit) => (
                  <li key={hit.slug}>
                    <Link
                      href={articleHref(hit.slug)}
                      className="block rounded-md px-2 py-2 transition-colors hover:bg-peat"
                    >
                      <span className="block text-sm text-birch">{hit.title}</span>
                      <span className="mt-0.5 block text-[0.78rem] leading-snug text-ash">
                        <Snippet text={hit.snippet} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ResultRow({ entry }: { entry: TitleIndexEntry }) {
  return (
    <Link
      href={articleHref(entry.s)}
      className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-peat"
    >
      {entry.i ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={entry.i}
          alt=""
          width={32}
          height={32}
          loading="lazy"
          className="h-8 w-8 shrink-0 rounded-sm border border-moss bg-peat object-contain p-0.5"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-moss bg-peat text-xs text-ash"
        >
          ᛚ
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.95rem] text-birch">{entry.t}</span>
        <span className="block truncate font-mono text-[0.65rem] text-ash">
          {[entry.y, ...entry.c.slice(0, 2)].filter(Boolean).join(' · ')}
        </span>
      </span>
    </Link>
  );
}

/**
 * Renders the `«…»` markers Postgres puts around matched words.
 *
 * Delimiters rather than HTML, so a snippet is inert text all the way from the
 * database to the DOM and cannot inject markup.
 */
function Snippet({ text }: { text: string }) {
  return (
    <>
      {text.split(/(«[^»]*»)/).map((part, i) =>
        part.startsWith('«') && part.endsWith('»') ? (
          <mark key={i} className="bg-transparent font-medium text-forge">
            {part.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
