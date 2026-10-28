import 'server-only';

import { cache } from 'react';
import type { Lang } from '@/lib/i18n/strings';
import { getLinkTargets } from '@/lib/wiki/data';
import { loadGuideLinks, NO_GUIDE_LINKS, type GuideLinks } from './guide-links';

type GuideRequest = { lang: Lang; links: GuideLinks };

/**
 * What every chip on the page needs to know about this request: the reader's
 * language and where each name links.
 *
 * Held in a request-scoped `cache()` slot rather than passed down as props.
 * The chips are written inline in the guide's text, three hundred of them, as
 * `<Item>Wood</Item>`; threading a lookup table through every sentence would
 * bury the content under plumbing, and a server component has no context to
 * carry it instead. `cache()` gives each request its own object, so two
 * readers never see each other's language.
 */
const current = cache((): GuideRequest => ({ lang: 'es', links: NO_GUIDE_LINKS }));

/**
 * Fills the slot. The page awaits this before it renders the guide, so every
 * chip reads a finished table.
 *
 * The English link index comes from the shared data cache (`getLinkTargets`),
 * kept across requests and processes, so this is almost never database work.
 * When the index is slow or the database cannot be reached the guide renders
 * anyway, with every chip pointing at the original wiki (`loadGuideLinks`):
 * the guide is hand-written text, and an outage of the corpus is no reason to
 * lose it or to make it slow.
 */
export async function prepareGuide(lang: Lang): Promise<void> {
  const state = current();
  state.lang = lang;
  state.links = await loadGuideLinks(() => getLinkTargets('en'));
}

export function guideRequest(): Readonly<GuideRequest> {
  return current();
}
