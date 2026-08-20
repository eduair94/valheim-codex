import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import type {
  ArticleBlock,
  ArticleDoc,
  ArticleFacets,
  ArticleImage,
  ArticleInfobox,
  InfoboxGroup,

} from './article-types';
import { extractInfobox, infoboxTabs } from './infobox';
import type { InfoboxNode } from './types';
import { cleanBlockText, cleanText } from './text';

type Api = cheerio.CheerioAPI;

/**
 * Elements with no place in a readable article.
 *
 * Deliberately shorter than the chunking pass's list: figures stay, because
 * this is the reading path and an item icon is how a player recognises the
 * item. Navboxes and edit links still go — they are Fandom's chrome, and
 * escaping that chrome is the point of this reader.
 */
const NOISE = [
  'script',
  'style',
  '.mw-editsection',
  'sup.reference',
  '.reference',
  '.navbox',
  'table.navbox',
  '.va-navbox',
  '.toc',
  '#toc',
  '.mw-empty-elt',
  '.noprint',
  '.mw-collapsible-toggle',
  'audio',
  'video',
].join(', ');

const HEADINGS = new Set(['h2', 'h3', 'h4', 'h5', 'h6']);

/** Sections whose content is chrome rather than article. */
const SKIPPED = new Set(['references', 'see also', 'external links', 'navigation']);

const INLINE = new Set([
  'a', 'abbr', 'b', 'bdi', 'big', 'cite', 'code', 'em', 'font', 'i', 'kbd', 'mark',
  'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'wbr',
]);

/**
 * Builds the reading representation of an article.
 *
 * Separate from `extractSections`, which feeds the retrieval index. The two
 * want different things — retrieval wants self-contained text, reading wants
 * ordered blocks, images and structure — and trying to serve both from one
 * shape produced chunks that read badly and a page that searched badly.
 */
export async function extractArticle(html: string): Promise<ArticleDoc> {
  const infobox = buildInfobox(html);

  const $ = cheerio.load(`<div id="wv-root">${html}</div>`);
  const inner = $('#wv-root .mw-parser-output').first();
  const root = inner.length > 0 ? inner : $('#wv-root');

  // The infobox is rendered separately; leaving it in would duplicate every
  // stat as prose.
  root.find('aside.portable-infobox').remove();
  root.find(NOISE).remove();

  const blocks: ArticleBlock[] = [];
  const images: ArticleImage[] = [];
  const stack: string[] = [];
  let inline = '';

  const section = (): string => stack.filter(Boolean).join(' > ');
  const skipped = (): boolean => stack.some((h) => SKIPPED.has(h.toLowerCase()));

  const flushInline = (): void => {
    const text = cleanBlockText(inline);
    inline = '';
    if (text && !skipped()) blocks.push({ kind: 'paragraph', section: section(), text });
  };

  for (const node of root.contents().toArray()) {
    if (node.type === 'text') {
      inline += node.data ?? '';
      continue;
    }
    if (node.type !== 'tag') continue;

    const el = node as Element;
    const tag = el.tagName?.toLowerCase() ?? '';

    if (HEADINGS.has(tag)) {
      flushInline();
      const level = Number(tag.slice(1)) - 2;
      stack.length = Math.max(0, level);
      stack[level] = cleanText(headingText($, el));
      continue;
    }

    if (tag === 'br') {
      inline += '\n';
      continue;
    }
    if (INLINE.has(tag)) {
      inline += $(el).text();
      continue;
    }

    flushInline();
    if (skipped()) continue;

    collectImages($, $(el), images);

    /*
     * Drop `<noscript>` once its images are collected. MediaWiki wraps every
     * lazy-loaded image in one, and a parser exposes that element's content as
     * text — so leaving it in puts a literal `<img …>` string into the article
     * as a paragraph.
     */
    $(el).find('noscript').remove();

    // A gallery is its images. What remains is repeated captions.
    if (isGallery($, el)) continue;

    appendBlock($, el, section(), blocks);
  }
  flushInline();

  const lead = takeLead(blocks);
  const mainImage = infobox?.image?.url;

  return {
    lead,
    blocks,
    infobox,
    // The identity strip already shows the main image; repeating it in the
    // gallery reads as a duplicate rather than as another view.
    images: dedupeImages(images).filter((i) => i.url !== mainImage),
    facets: liftFacets(infobox),
  };
}

/**
 * Pulls the opening summary out of the block list.
 *
 * It is displayed under the title rather than in the body, so leaving it in
 * `blocks` would render the same sentence twice.
 */
function takeLead(blocks: ArticleBlock[]): string {
  const first = blocks[0];
  if (first?.kind === 'paragraph' && first.section === '') {
    blocks.shift();
    return first.text;
  }
  return '';
}

function isGallery($: Api, el: Element): boolean {
  const cls = el.attribs?.['class'] ?? '';
  return /wikia-gallery|gallery/.test(cls) || $(el).find('.wikia-gallery').length > 0;
}

function headingText($: Api, el: Element): string {
  const headline = $(el).find('.mw-headline').first();
  return headline.length > 0 ? headline.text() : $(el).text();
}

/** Turns one block-level element into zero or more article blocks. */
function appendBlock($: Api, el: Element, section: string, out: ArticleBlock[]): void {
  const tag = el.tagName?.toLowerCase() ?? '';

  if (tag === 'table') {
    const table = readTable($, $(el), section);
    if (table) out.push(table);
    return;
  }

  if (tag === 'ul' || tag === 'ol') {
    const list = readList($, $(el), section, tag === 'ol');
    if (list) out.push(list);
    return;
  }

  // A wrapper: walk into it so nested tables and lists keep their position
  // instead of collapsing into one paragraph.
  const children = $(el).children().toArray();
  const hasStructure = children.some((c) =>
    ['table', 'ul', 'ol'].includes((c as Element).tagName?.toLowerCase() ?? ''),
  );

  if (hasStructure) {
    for (const child of children) appendBlock($, child as Element, section, out);
    return;
  }

  const text = cleanBlockText($(el).text());
  if (text) out.push({ kind: 'paragraph', section, text });
}

function readList(
  $: Api,
  $list: cheerio.Cheerio<AnyNode>,
  section: string,
  ordered: boolean,
): ArticleBlock | null {
  const items = $list
    .children('li')
    .toArray()
    .map((li) => cleanText($(li).text()))
    .filter(Boolean);
  return items.length > 0 ? { kind: 'list', section, ordered, items } : null;
}

/**
 * Reads a table into headers plus equal-length rows.
 *
 * Rows are padded to the header width: a ragged row would misalign every cell
 * after it once the reader renders a sticky first column.
 */
function readTable($: Api, $table: cheerio.Cheerio<AnyNode>, section: string): ArticleBlock | null {
  const el = $table.get(0) as Element | undefined;
  const cls = el?.attribs?.['class'] ?? '';
  if (/navbox|collapsible-toggle/.test(cls)) return null;

  const caption = cleanText($table.children('caption').first().text());
  let headers: string[] = [];
  const rows: string[][] = [];

  for (const tr of $table.find('tr').toArray()) {
    const cells = $(tr).children('th, td').toArray();
    if (cells.length === 0) continue;

    const values = cells.map((c) => cleanText($(c).text()));
    const allHeaders = cells.every((c) => (c as Element).tagName?.toLowerCase() === 'th');

    if (allHeaders) {
      // A lone spanning `th` is a sub-heading; keep it as a row so the grouping
      // it expresses is not lost.
      if (cells.length === 1 && headers.length > 0) {
        rows.push(pad([values[0] ?? ''], headers.length));
        continue;
      }
      if (headers.length === 0) headers = values;
      continue;
    }
    if (values.every((v) => v === '')) continue;
    rows.push(values);
  }

  if (rows.length === 0) return null;
  if (headers.length === 0) headers = rows[0]!.map((_, i) => `Column ${i + 1}`);

  const width = Math.max(headers.length, ...rows.map((r) => r.length));
  return {
    kind: 'table',
    section,
    caption,
    headers: pad(headers, width),
    rows: rows.map((r) => pad(r, width)),
  };
}

function pad(row: string[], width: number): string[] {
  return Array.from({ length: width }, (_, i) => row[i] ?? '');
}

/**
 * Collects images from an element, including those hidden inside `<noscript>`.
 *
 * Fandom galleries put every image in a `<noscript>` fallback, and an HTML
 * parser treats that element's content as *text*, not markup. Walking elements
 * alone therefore finds no images at all and drops the raw `<img …>` string
 * into the article as a paragraph. Re-parsing the text is what recovers them.
 */
function collectImages($: Api, $el: cheerio.Cheerio<AnyNode>, out: ArticleImage[]): void {
  const take = (element: Element, $scope: Api): void => {
    const url = element.attribs['src'] ?? '';
    if (!url.startsWith('http')) return;
    // Fandom's chrome: logos and tracking pixels carry no article information.
    if (/Site-logo|\/thumbnails?\/transparent/i.test(url)) return;

    const alt = cleanText(element.attribs['alt'] ?? '');
    const caption =
      cleanText(element.attribs['data-caption'] ?? '') ||
      cleanText($scope(element).closest('figure').find('figcaption').first().text());
    out.push(caption ? { url, alt, caption } : { url, alt });
  };

  for (const img of $el.find('img').toArray()) take(img as Element, $);

  for (const noscript of $el.find('noscript').toArray()) {
    const inner = cheerio.load(`<div>${$(noscript).text()}</div>`);
    for (const img of inner('img').toArray()) take(img as Element, inner);
  }
}

function dedupeImages(images: ArticleImage[]): ArticleImage[] {
  const seen = new Set<string>();
  return images.filter((image) => {
    if (seen.has(image.url)) return false;
    seen.add(image.url);
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* Infobox                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Converts the retrieval infobox tree into the reading shape: shared rows in
 * `common`, per-level rows under their tab.
 */
function buildInfobox(html: string): ArticleInfobox | null {
  const tree = extractInfobox(html);
  if (!tree) return null;

  const common: InfoboxGroup[] = [];
  const tabs = infoboxTabs(tree).map((label) => ({ label, groups: [] as InfoboxGroup[] }));

  for (const node of tree.nodes) {
    if (node.kind === 'tabs') {
      for (const [i, tab] of node.tabs.entries()) {
        const target = tabs[i];
        if (target) target.groups.push(...toGroups(tab.children));
      }
      continue;
    }
    common.push(...toGroups([node]));
  }

  return {
    title: tree.title,
    image: extractInfoboxImage(html),
    common: common.filter((g) => g.rows.length > 0),
    tabs: tabs.map((t) => ({ ...t, groups: t.groups.filter((g) => g.rows.length > 0) })),
  };
}

/** Flattens a node list into labelled groups of label/value rows. */
function toGroups(nodes: InfoboxNode[], inherited = ''): InfoboxGroup[] {
  const groups: InfoboxGroup[] = [];
  let current: InfoboxGroup = { label: inherited, rows: [] };

  const flush = (): void => {
    if (current.rows.length > 0) groups.push(current);
    current = { label: inherited, rows: [] };
  };

  for (const node of nodes) {
    if (node.kind === 'data') {
      current.rows.push({ label: node.label, value: node.value });
      continue;
    }
    if (node.kind === 'group') {
      if (node.label) {
        flush();
        groups.push(...toGroups(node.children, node.label));
      } else {
        // An unlabelled group is a horizontal row: its values belong with the
        // rows around them, not under a heading of their own.
        for (const child of node.children) {
          if (child.kind === 'data') current.rows.push({ label: child.label, value: child.value });
          else {
            flush();
            groups.push(...toGroups([child], inherited));
          }
        }
      }
      continue;
    }
    // A nested tabber inside a group: flatten it, since tabs are handled above.
    flush();
    for (const tab of node.tabs) groups.push(...toGroups(tab.children, tab.label));
  }
  flush();
  return groups;
}

function extractInfoboxImage(html: string): ArticleImage | null {
  const $ = cheerio.load(html);
  const img = $('aside.portable-infobox .pi-image img').first();
  const url = img.attr('src');
  if (!url || !url.startsWith('http')) return null;
  return { url, alt: cleanText(img.attr('alt') ?? '') };
}

/* -------------------------------------------------------------------------- */
/* Facets                                                                      */
/* -------------------------------------------------------------------------- */

/** Infobox labels that carry a browsable facet, lowercased. */
const FACET_LABELS: Record<string, keyof ArticleFacets> = {
  'main biome': 'biome',
  biome: 'biome',
  biomes: 'biome',
  'crafting station': 'station',
  station: 'station',
  type: 'type',
  'internal id': 'internalId',
};

/**
 * `Source` means two different things on this wiki.
 *
 * On an item it names the crafting station ("Source: Forge"). On a creature or
 * a location it names where the thing comes from ("Source: Plains biome",
 * "Source: Fuling Village in the Plains biome"). Treating both as a station
 * filled the station facet with places, so "browse by crafting station" listed
 * biomes.
 *
 * A crafting station is only read from `Source` when the same infobox also
 * states crafting materials — which is exactly what makes the value a station
 * rather than an origin.
 */
const CRAFTING_EVIDENCE = /^(crafting materials|materials|crafting level|repair level)$/i;

/**
 * Promotes a few infobox rows to queryable fields.
 *
 * Only the first value is kept when a row lists several ("Plains; Mistlands"
 * becomes "Plains"): a facet is for narrowing a list, and the article itself
 * still shows the full row.
 */
function liftFacets(infobox: ArticleInfobox | null): ArticleFacets {
  if (!infobox) return {};

  const allRows = [
    ...infobox.common.flatMap((g) => g.rows),
    ...infobox.tabs.flatMap((t) => t.groups.flatMap((g) => g.rows)),
  ];

  const isCraftable = allRows.some((r) => CRAFTING_EVIDENCE.test(r.label.trim()));
  const facets: ArticleFacets = {};

  for (const row of allRows) {
    const label = row.label.trim().toLowerCase();
    const key = label === 'source' ? (isCraftable ? 'station' : undefined) : FACET_LABELS[label];
    if (!key || facets[key]) continue;

    const value = row.value.split(';')[0]?.split(',')[0]?.trim();
    // A long value is a sentence, not a facet: "Fuling Village in the Plains
    // biome" is prose that happens to sit in a labelled row.
    if (value && value.length <= 40) facets[key] = value;
  }
  return facets;
}
