import type * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { cleanText } from './text';

/**
 * Fandom's `<tabber>` in an article body, for both readers of the page: the
 * reading document (article.ts) and the retrieval sections (html.ts).
 *
 * A tabber renders as a list of labels and one panel per label, only one of
 * them shown at a time:
 *
 *   <div class="tabber wds-tabber">
 *     <div class="wds-tabs__wrapper"><ul class="wds-tabs">
 *       <li><div class="wds-tabs__tab-label"><a href="#">Raw</a></div></li> …
 *     </ul></div>
 *     <div class="wds-tab__content"> … </div> …
 *   </div>
 *
 * Read as text, the labels run together — "RawCooked", "Baked\n\nUnbaked",
 * "HeadChestLegs" — and they were the lead of the articles that open with
 * tabbed infoboxes (the meats, breads and pies, meads, armor sets), and the
 * first line of every armor set's "Armor pieces": "1\n\n2\n\n3\n\n4\n\n
 * Quality 1…", with the tables of all four levels read into the same
 * paragraph.
 *
 * Tabbers inside an infobox (`pi-panel`) are the infobox reader's
 * (infobox.ts); they leave with the infobox before these readers see it.
 */

type Api = cheerio.CheerioAPI;

/** Tabbers by their class token: "infobox-tabber" is a wrapper around one, not a tabber. */
const TABBER = '.wds-tabber, .tabber';

/** Whether an element is a tabber. */
export function isTabber(el: Element): boolean {
  const classes = (el.attribs?.['class'] ?? '').split(/\s+/);
  return classes.includes('wds-tabber') || classes.includes('tabber');
}

/** A tabber's own tabs: each label with the panel it shows. A nested tabber keeps its own. */
export function tabberPanels($: Api, el: Element): { label: string; panel: Element }[] {
  const labels = $(el)
    .children('.wds-tabs__wrapper')
    .find('.wds-tabs__tab-label')
    .toArray()
    .map((label) => cleanText($(label).text()));
  return $(el)
    .children('.wds-tab__content')
    .toArray()
    .map((panel, i) => ({ label: labels[i] ?? '', panel: panel as Element }));
}

/** Whether a panel holds nothing to read: no text, no picture, no table or list. */
function isEmptyPanel($: Api, panel: Element): boolean {
  return cleanText($(panel).text()) === '' && $(panel).find('img, table, ul, ol').length === 0;
}

/**
 * Removes the tabbers that only held infoboxes, once the infoboxes are out.
 *
 * The wiki wraps most of them in `.infobox-tabber`. Frosted Sweetbread
 * floats its Baked / Unbaked pair in a plain div instead, and its lead was
 * "Baked\n\nUnbaked". Either way all that is left is the labels of tabs that
 * show nothing. Innermost first, so a tabber of emptied tabbers goes too.
 */
export function dropEmptyTabbers($: Api, root: cheerio.Cheerio<AnyNode>): void {
  root.find('.infobox-tabber').remove();
  for (const el of root.find(TABBER).toArray().reverse() as Element[]) {
    const panels = tabberPanels($, el).map((tab) => tab.panel);
    if (panels.length > 0 && panels.every((panel) => isEmptyPanel($, panel))) $(el).remove();
  }
}

/**
 * Removes the label lists of `el` and of every tabber inside it, for a reader
 * that takes `el` as one run of text: the panels still read, one after
 * another, and the labels no longer run into them.
 */
export function dropTabLabels($: Api, el: Element): void {
  $(el).find(TABBER).addBack(TABBER).children('.wds-tabs__wrapper').remove();
}

/** Whether a panel's first content is a heading of its own ("Quality 1"). */
export function opensWithHeading(panel: Element): boolean {
  for (const child of panel.children) {
    if (child.type === 'text') {
      if ((child as unknown as { data: string }).data.trim() === '') continue;
      return false;
    }
    if (child.type !== 'tag') continue;
    return /^h[2-6]$/i.test((child as Element).tagName ?? '');
  }
  return false;
}
