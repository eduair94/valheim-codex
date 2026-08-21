import Link from 'next/link';
import { cookies } from 'next/headers';
import type { Metadata } from 'next';
import { GuideContent } from '@/components/wiki/guide/guide-content';
import { LANG_COOKIE, parseLang } from '@/lib/i18n/lang-cookie';
import { strings } from '@/lib/i18n/strings';

export const metadata: Metadata = {
  title: 'Codex de Valheim — Guía 100%',
  description:
    'Checklist paso a paso, bioma por bioma, para completar el 100% de Valheim. Nombres de ítems en inglés.',
};

/**
 * The completion guide.
 *
 * Every other page under `/wiki` reads its content from Postgres — this one
 * doesn't, because there is no wiki page titled "how do I finish the game".
 * `GuideContent` is hand-written and lives in the repo instead of the DB.
 *
 * Spanish only for now. The translation pipeline other articles use
 * (`getTranslation` in `wiki-repo.ts`) is keyed to a DB article row, and this
 * page has none — translating ~3000 words of hand-written prose by hand is
 * future work, not a gap to paper over with a machine pass no one reviewed.
 */
export default async function GuidePage() {
  const lang = parseLang((await cookies()).get(LANG_COOKIE)?.value);
  const t = strings(lang);

  if (lang !== 'es') {
    return (
      <div className="flex flex-col items-start gap-3 py-10">
        <p className="text-sm text-ash">{t.wikiGuideEnNotice}</p>
        <Link href="/wiki" className="text-sm text-forge hover:underline">
          ← {t.wikiGuideEnBack}
        </Link>
      </div>
    );
  }

  return <GuideContent />;
}
