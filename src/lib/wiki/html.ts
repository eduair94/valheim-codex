import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import type { Section } from './types';
import { collectText, lineText } from './dom-text';
import { nestedTables, readNotice, readTableGrid } from './table';
import { dropEmptyTabbers, dropTabLabels, isTabber, opensWithHeading, tabberPanels } from './tabber';
import { cleanBlockText, cleanText } from './text';

type Api = cheerio.CheerioAPI;

/**
 * Elements that carry no article content. Navboxes and galleries in particular
 * are large and almost pure link soup, so leaving them in would flood the index
 * with chunks that match everything and answer nothing.
 */
const NOISE_SELECTORS = [
  'script',
  'style',
  'aside.portable-infobox',
  // Tabs between infoboxes ("Raw" / "Cooked"): only their labels would remain.
  '.infobox-tabber',
  '.mw-editsection',
  'sup.reference',
  '.reference',
  '.navbox',
  'table.navbox',
  '.toc',
  '#toc',
  // Maths is emitted three times over — MathML, a TeX annotation and an
  // image — and plain text extraction concatenates the first two into
  // glyph soup. A formula contributes nothing to an embedding anyway.
  '.mwe-math-element',
  'math',
  'annotation',
  '.wikia-gallery',
  '.gallery',
  '.mw-empty-elt',
  '.noprint',
  '.mw-collapsible-toggle',
  '.va-navbox',
  'figure',
  'audio',
  'video',
].join(', ');

const HEADING_TAGS = new Set(['h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * Inline elements.
 *
 * MediaWiki does not wrap a lead paragraph in `<p>`: it emits bare text nodes
 * interleaved with `<b>` and `<a>` directly under `.mw-parser-output`. Walking
 * only element children would therefore drop every word that is not inside a
 * link — the summary sentence of every article. These tags, plus raw text
 * nodes, are accumulated into one synthetic paragraph instead.
 */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'big', 'cite', 'code', 'em', 'font', 'i', 'kbd', 'mark',
  'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr',
]);

/** Headings whose whole section is not worth indexing. */
const SKIPPED_HEADINGS = new Set(['gallery', 'references', 'see also', 'external links', 'navigation']);

/**
 * Splits rendered article HTML into heading-delimited sections.
 *
 * Prose and tables are kept apart so the chunker can treat them differently: a
 * table row must never be cut in half by a size-based split.
 */
export async function extractSections(html: string): Promise<Section[]> {
  // Wrap in a known container so the root is always an element, never the
  // document node: `$.root()` and a selection have different types, and the
  // traversal below needs `.children()` on an element.
  const $ = cheerio.load(`<div id="wv-root">${html}</div>`);
  const inner = $('#wv-root .mw-parser-output').first();
  const root = inner.length > 0 ? inner : $('#wv-root');

  root.find(NOISE_SELECTORS).remove();
  // What a tabbed infobox leaves once the infoboxes are gone: its tab labels.
  dropEmptyTabbers($, root);

  const sections: Section[] = [];
  /** Heading stack: index 0 is the h2 level, 1 is h3, and so on. */
  const stack: string[] = [];
  let current: Section = { path: '', text: '', tables: [] };
  const prose: string[] = [];
  /** Buffer for loose text and inline elements between two block elements. */
  let inline = '';

  const flushInline = (): void => {
    const text = cleanBlockText(inline);
    inline = '';
    if (text) prose.push(text);
  };

  const flush = (): void => {
    flushInline();
    current.text = cleanBlockText(prose.join('\n\n'));
    prose.length = 0;
    if (current.text.length > 0 || current.tables.length > 0) {
      sections.push(current);
    }
  };

  const isSkipped = (): boolean => stack.some((h) => SKIPPED_HEADINGS.has(h.toLowerCase()));

  /** Starts a section at the heading stack as it is now. */
  const open = (): void => {
    current = { path: stack.filter(Boolean).join(' > '), text: '', tables: [] };
  };

  const visit = (node: AnyNode): void => {
    if (node.type === 'text') {
      if (!isSkipped()) inline += node.data ?? '';
      return;
    }
    if (node.type !== 'tag') return;

    const el = node as Element;
    const tag = el.tagName?.toLowerCase() ?? '';

    if (HEADING_TAGS.has(tag)) {
      flush();
      const level = Number(tag.slice(1)) - 2; // h2 -> 0
      const heading = cleanText(headingText($, el));
      stack.length = Math.max(0, level);
      stack[level] = heading;
      open();
      return;
    }

    if (isSkipped()) return;

    if (tag === 'br') {
      inline += '\n';
      return;
    }

    if (INLINE_TAGS.has(tag)) {
      inline += collectText(el, { keepSourceBreaks: true });
      return;
    }

    // From here on the element is block-level, so the inline run ends.
    flushInline();

    const tabs = isTabber(el) ? tabberPanels($, el) : [];
    if (tabs.length > 0) {
      readTabs(tabs);
      return;
    }
    // A tabber deeper inside is read as one run of text: without its labels.
    dropTabLabels($, el);

    // Tables, including those nested inside a wrapper div or inside another
    // table's cells, each count as a table of their own.
    const outermost =
      tag === 'table'
        ? [el]
        : ($(el).find('table').toArray() as Element[]).filter((t) => $(t).parentsUntil(el, 'table').length === 0);
    const withNested = (t: Element): Element[] => [t, ...nestedTables($, t).flatMap(withNested)];
    for (const table of outermost.flatMap(withNested)) {
      // A status banner ("This article is about removed content") is a
      // sentence about the article, so it is prose; a maintenance banner is
      // nothing at all.
      const notice = readNotice($, table);
      if (notice) {
        if (notice.kind !== 'maintenance') prose.push(notice.text);
        continue;
      }
      const flat = flattenTable($, $(table));
      if (flat) current.tables.push(flat);
    }
    if (tag === 'table') return;
    $(el).find('table').remove();

    const text = lineText(el, { keepSourceBreaks: true });
    if (text) prose.push(text);
  };

  /*
   * A tabber in the body, tab by tab, as the reading document reads it
   * (article.ts): each tab is a section of its own — its own heading, or its
   * label one level below the tabber's section — so a table says which
   * quality level it lists ("Armor pieces > Quality 3"), and the labels are
   * never prose. What follows the tabber is the tabber's section again.
   */
  const readTabs = (tabs: { label: string; panel: Element }[]): void => {
    // A copy with its holes (an h4 under an h2 leaves one), which a spread would fill.
    const outer = stack.slice();
    for (const { label, panel } of tabs) {
      if (label && !opensWithHeading(panel)) {
        flush();
        stack.push(label);
        open();
      }
      for (const child of panel.children) visit(child);
      flush();
      stack.length = 0;
      outer.forEach((heading, level) => {
        stack[level] = heading;
      });
      stack.length = outer.length;
      open();
    }
  };

  for (const node of root.contents().toArray()) visit(node);
  flush();

  return sections;
}

/**
 * MediaWiki 1.43 wraps heading text in `.mw-headline` on some skins and puts it
 * directly in the tag on others; take whichever is present.
 */
function headingText($: Api, el: Element): string {
  const headline = $(el).find('.mw-headline').first();
  return headline.length > 0 ? headline.text() : $(el).text();
}

/**
 * Renders a table as one line per row, each cell prefixed by its column header.
 *
 * Reading a table as plain text yields a run of headers followed by a run of
 * values, which is unusable in a RAG context — a question about the damage of
 * one sword would retrieve a blob where no number is attached to any weapon.
 *
 * The grid comes from the same reader as the article's tables, so spans are
 * applied before any value is paired with a header: reading cells by
 * position told the index that a bow's "Spread" was its velocity.
 */
export function flattenTable($: Api, $table: cheerio.Cheerio<AnyNode>): string {
  const el = $table.get(0) as Element | undefined;
  if (!el) return '';
  const cls = el.attribs?.['class'] ?? '';
  if (/navbox|toc|collapsible-toggle/.test(cls)) return '';
  if (readNotice($, el)) return '';

  const grid = readTableGrid($, el);
  if (!grid) return '';

  const groups = new Set(grid.groupRows);
  let groupLabel = '';
  const lines: string[] = [];

  grid.rows.forEach((row, r) => {
    // A full-width row is a sub-heading for the rows beneath it.
    if (groups.has(r)) {
      groupLabel = oneLine(row[0] ?? '');
      return;
    }
    const pairs: string[] = [];
    row.forEach((value, c) => {
      // Icon columns are already gone; an empty cell adds nothing but tokens.
      if (!value) return;
      const header = grid.headers[c] ?? '';
      pairs.push(header ? `${header}: ${oneLine(value)}` : oneLine(value));
    });
    if (pairs.length > 0) lines.push([groupLabel, pairs.join('; ')].filter(Boolean).join(' — '));
  });

  if (lines.length === 0) return '';
  return [grid.caption, ...lines].filter(Boolean).join('\n');
}

/**
 * A cell's lines as one run: "10 Wood, 8 Iron, 4 Root". A row is one line of
 * the flattened table and the chunker splits tables on lines, so a cell's own
 * breaks cannot survive; commas keep its entries apart where "; " already
 * separates the cells. A line that ends a sentence needs no comma after it.
 */
function oneLine(value: string): string {
  return value.replace(/([.!?…])\n/g, '$1 ').replace(/\n/g, ', ');
}
