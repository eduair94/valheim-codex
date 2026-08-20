import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import type { Section } from './types';
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
  '.mw-editsection',
  'sup.reference',
  '.reference',
  '.navbox',
  'table.navbox',
  '.toc',
  '#toc',
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

  for (const node of root.contents().toArray()) {
    if (node.type === 'text') {
      if (!isSkipped()) inline += node.data ?? '';
      continue;
    }
    if (node.type !== 'tag') continue;

    const el = node as Element;
    const tag = el.tagName?.toLowerCase() ?? '';

    if (HEADING_TAGS.has(tag)) {
      flush();
      const level = Number(tag.slice(1)) - 2; // h2 -> 0
      const heading = cleanText(headingText($, el));
      stack.length = Math.max(0, level);
      stack[level] = heading;
      current = { path: stack.filter(Boolean).join(' > '), text: '', tables: [] };
      continue;
    }

    if (isSkipped()) continue;

    if (tag === 'br') {
      inline += '\n';
      continue;
    }

    if (INLINE_TAGS.has(tag)) {
      inline += $(el).text();
      continue;
    }

    // From here on the element is block-level, so the inline run ends.
    flushInline();

    if (tag === 'table') {
      const flat = flattenTable($, $(el));
      if (flat) current.tables.push(flat);
      continue;
    }

    // Tables nested inside a wrapper div still count as tables.
    for (const t of $(el).find('table').toArray()) {
      const flat = flattenTable($, $(t));
      if (flat) current.tables.push(flat);
    }
    $(el).find('table').remove();

    const text = cleanBlockText($(el).text());
    if (text) prose.push(text);
  }
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
 */
export function flattenTable($: Api, $table: cheerio.Cheerio<AnyNode>): string {
  const el = $table.get(0);
  if (!el) return '';
  const cls = (el as Element).attribs?.['class'] ?? '';
  if (/navbox|toc|collapsible-toggle/.test(cls)) return '';

  const caption = cleanText($table.children('caption').first().text());
  const rows = $table.find('tr').toArray();

  let headers: string[] = [];
  let groupLabel = '';
  const lines: string[] = [];

  for (const row of rows) {
    const $row = $(row);
    const cells = $row.children('th, td').toArray();
    if (cells.length === 0) continue;

    const isHeaderRow = cells.every((c) => (c as Element).tagName?.toLowerCase() === 'th');
    const values = cells.map((c) => cleanText($(c).text()));

    // A lone `th` spanning the table is a sub-heading for the rows beneath it.
    if (isHeaderRow && cells.length === 1) {
      groupLabel = values[0] ?? '';
      continue;
    }

    if (isHeaderRow && headers.length === 0) {
      headers = values;
      continue;
    }
    if (isHeaderRow) {
      // A repeated header row inside a long table: refresh and move on.
      headers = values;
      continue;
    }

    const pairs: string[] = [];
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i] ?? '';
      // Icon columns are empty once the image is stripped; a bare "Icon:" adds
      // nothing but tokens.
      if (!value) continue;
      const header = headers[i] ?? '';
      pairs.push(header ? `${header}: ${value}` : value);
    }
    if (pairs.length === 0) continue;
    lines.push([groupLabel, pairs.join('; ')].filter(Boolean).join(' — '));
  }

  if (lines.length === 0) return '';
  return [caption, ...lines].filter(Boolean).join('\n');
}
