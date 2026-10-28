import { thumbnailImageUrl } from '@/lib/wiki/image-url';

/**
 * Where nearly every article picture lives. The recipe graph keeps icons as
 * the title index sends them, a path under this root (`a/a1/Iron.png?cb=1`).
 */
const ICON_ROOT = 'https://static.wikia.nocookie.net/valheim/images/';

/**
 * The URL to draw a graph icon at `px` CSS pixels: the full address, asked
 * for at the size it is drawn (`thumbnailImageUrl`).
 *
 * The address is rebuilt as `expandIcon` (`src/lib/wiki/title-search.ts`)
 * rebuilds it, and a test keeps the two equal. It is not imported from
 * there: that module carries the search's glossary, which would ride into
 * the article's craft card, a client island with a budget of a few
 * kilobytes, for one string join.
 */
export function iconUrl(icon: string, px: number): string {
  if (/^https?:\/\//.test(icon)) return thumbnailImageUrl(icon, px);
  const [path, query] = icon.split('?');
  return thumbnailImageUrl(`${ICON_ROOT}${path}/revision/latest${query ? `?${query}` : ''}`, px);
}
