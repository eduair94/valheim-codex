'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { chatAboutHref } from '@/lib/routes';
import { strings, type Lang } from '@/lib/i18n/strings';

/** Movement below this is noise from a thumb resting on the screen. */
const THRESHOLD_PX = 12;

/**
 * "Ask about this", floating above the article.
 *
 * Fixed rather than in the flow because the reason to ask is usually something
 * noticed halfway down a long page, and scrolling back to a button at the top
 * is exactly the friction this reader exists to remove.
 *
 * It hides while scrolling down and returns on the way up. A permanently fixed
 * button sits on top of a stat row — which on this page is the content someone
 * came for — and pushing the article down by its height would waste a strip of
 * a phone screen on every article, including the ones nobody asks about.
 */
export function AskButton({ title, lang }: { title: string; lang: Lang }) {
  const t = strings(lang);
  const [visible, setVisible] = useState(true);
  const lastY = useRef(0);

  useEffect(() => {
    lastY.current = window.scrollY;

    const onScroll = (): void => {
      const y = window.scrollY;
      const delta = y - lastY.current;
      if (Math.abs(delta) < THRESHOLD_PX) return;
      lastY.current = y;

      // Always available at the very top, where there is nothing to cover.
      setVisible(delta < 0 || y < 80);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div
      className={`pointer-events-none fixed inset-x-0 bottom-16 z-20 flex justify-center px-4 transition-all duration-200 sm:bottom-6 ${
        visible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-4 opacity-0'
      }`}
      aria-hidden={!visible}
    >
      <Link
        href={chatAboutHref(title)}
        tabIndex={visible ? undefined : -1}
        className="pointer-events-auto rounded-full border border-forge/40 bg-peat px-4 py-2 text-sm text-forge shadow-lg transition-colors hover:border-forge hover:bg-forge/20"
      >
        💬 {t.wikiAskAbout}
      </Link>
    </div>
  );
}
