'use client';

import { useRouter } from 'next/navigation';
import { setLangCookie } from '@/lib/i18n/lang-cookie';
import { strings, type Lang } from '@/lib/i18n/strings';

/**
 * The two-letter language switch, shared by the chat and the reader.
 *
 * It lived only in the chat sidebar, which a signed-out visitor never sees —
 * so the public half of the site, the half most likely to be read by someone
 * who wanted Spanish, had no way to ask for it.
 *
 * Writes the cookie and refreshes rather than holding the choice in React
 * state: the server renders the language, including which stored translation
 * to serve, so the server has to be told before anything can change.
 */
export function LangToggle({
  lang,
  onChange,
  className = '',
}: {
  lang: Lang;
  /** The chat manages its own state; the reader lets the cookie and a refresh do it. */
  onChange?: (lang: Lang) => void;
  className?: string;
}) {
  const router = useRouter();
  const t = strings(lang);

  const choose = (code: Lang): void => {
    if (code === lang) return;
    if (onChange) {
      onChange(code);
      return;
    }
    setLangCookie(code);
    router.refresh();
  };

  return (
    <div
      className={`flex overflow-hidden rounded-sm border border-moss ${className}`}
      role="group"
      aria-label={t.language}
    >
      {(['es', 'en'] as const).map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => choose(code)}
          aria-pressed={lang === code}
          className={`px-2 py-1 font-mono text-[0.65rem] uppercase transition-colors ${
            lang === code ? 'bg-forge text-bog' : 'text-ash hover:text-birch'
          }`}
        >
          {code}
        </button>
      ))}
    </div>
  );
}
