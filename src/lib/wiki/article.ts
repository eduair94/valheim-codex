import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import type {
  ArticleBlock,
  ArticleDoc,
  ArticleFacets,
  ArticleImage,
  ArticleInfobox,
  InfoboxGroup,
  InfoboxRow,
  TableBlock,
} from './article-types';
import { collectText, lineText } from './dom-text';
import { extractInfobox, infoboxTabs } from './infobox';
import { nestedTableLabel, nestedTables, readNotice, readTableGrid } from './table';
import { dropEmptyTabbers, dropTabLabels, isTabber, opensWithHeading, tabberPanels } from './tabber';
import { texToText } from './tex';
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
 *
 * The shape is documented, with its history, in article-types.ts.
 */
export async function extractArticle(html: string): Promise<ArticleDoc> {
  const infobox = buildInfobox(html);

  const $ = cheerio.load(`<div id="wv-root">${html}</div>`);
  const inner = $('#wv-root .mw-parser-output').first();
  const root = inner.length > 0 ? inner : $('#wv-root');

  // The infobox is rendered separately; leaving it in would duplicate every
  // stat as prose. A tabbed infobox ("Raw" / "Cooked") goes with its tabs:
  // without the infoboxes, the tab labels were all that was left, and as the
  // first text on the page they became the lead — "Raw Cooked" (tabber.ts).
  root.find('aside.portable-infobox').remove();
  root.find(NOISE).remove();
  dropEmptyTabbers($, root);
  collapseMath($, root);

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

  const visit = (node: AnyNode): void => {
    if (node.type === 'text') {
      inline += node.data ?? '';
      return;
    }
    if (node.type !== 'tag') return;

    const el = node as Element;
    const tag = el.tagName?.toLowerCase() ?? '';

    if (HEADINGS.has(tag)) {
      flushInline();
      const level = Number(tag.slice(1)) - 2;
      stack.length = Math.max(0, level);
      stack[level] = cleanText(headingText($, el));
      return;
    }

    if (tag === 'br') {
      inline += '\n';
      return;
    }
    if (INLINE.has(tag)) {
      // A `<br>` inside a link or a span is still a line break.
      inline += collectText(el, { keepSourceBreaks: true });
      return;
    }

    flushInline();
    if (skipped()) return;

    const tabs = isTabber(el) ? tabberPanels($, el) : [];
    if (tabs.length > 0) {
      readTabs(tabs);
      return;
    }

    collectImages($, $(el), images);

    /*
     * Drop `<noscript>` once its images are collected. MediaWiki wraps every
     * lazy-loaded image in one, and a parser exposes that element's content as
     * text — so leaving it in puts a literal `<img …>` string into the article
     * as a paragraph.
     */
    $(el).find('noscript').remove();

    // A gallery is its images. What remains is repeated captions.
    if (isGallery($, el)) return;

    // A tabber deeper inside is read as one run of text: without its labels.
    dropTabLabels($, el);
    appendBlock($, el, section(), blocks);
  };

  /*
   * A tabber in the body, tab by tab, as if its panels were the page: an
   * armor set's "Armor pieces" has one tab per quality level, each opening
   * with its own heading ("Quality 1") over a paragraph and a table. A tab
   * without a heading of its own is headed by its label, one level below the
   * section the tabber sits in. After each tab the section is the tabber's
   * again: what follows the tabber is not the last tab's. Never part of the
   * lead, then, and its labels never read as text. A tabber with no panels
   * where they belong is read like any other element instead.
   */
  const readTabs = (tabs: { label: string; panel: Element }[]): void => {
    // A copy with its holes (an h4 under an h2 leaves one), which a spread would fill.
    const outer = stack.slice();
    for (const { label, panel } of tabs) {
      if (label && !opensWithHeading(panel)) stack.push(label);
      for (const child of panel.children) visit(child);
      flushInline();
      stack.length = 0;
      outer.forEach((heading, level) => {
        stack[level] = heading;
      });
      stack.length = outer.length;
    }
  };

  for (const node of root.contents().toArray()) visit(node);
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
 *
 * The first paragraph before any heading, rather than block 0: a notice
 * banner or a table can come first, and taking only block 0 left 33 articles
 * with no summary at all because a "work in progress" banner sat there.
 */
function takeLead(blocks: ArticleBlock[]): string {
  const index = blocks.findIndex((b) => b.section === '' && b.kind === 'paragraph' && !b.notice);
  if (index === -1) return '';
  const [lead] = blocks.splice(index, 1);
  return lead?.kind === 'paragraph' ? lead.text : '';
}

function isGallery($: Api, el: Element): boolean {
  const cls = el.attribs?.['class'] ?? '';
  return /wikia-gallery|gallery/.test(cls) || $(el).find('.wikia-gallery').length > 0;
}

function headingText($: Api, el: Element): string {
  const headline = $(el).find('.mw-headline').first();
  return headline.length > 0 ? headline.text() : $(el).text();
}

/** Turns one block-level element into zero or more article blocks. */
function appendBlock($: Api, el: Element, section: string, out: ArticleBlock[]): void {
  const tag = el.tagName?.toLowerCase() ?? '';

  /*
   * A figure is an image and its caption, and the image is already in
   * `images` with that caption. Kept as a block, the caption became a
   * one-line paragraph in the body — and, as the first paragraph of the
   * article, could even be taken for the lead.
   */
  if (tag === 'figure') return;

  if (tag === 'table') {
    appendTable($, el, section, out);
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

  const text = lineText(el, { keepSourceBreaks: true, skip: (child) => child.tagName === 'figure' });
  if (text) out.push({ kind: 'paragraph', section, text });
}

function appendTable(
  $: Api,
  el: Element,
  section: string,
  out: ArticleBlock[],
  fallbackCaption = '',
): void {
  const cls = el.attribs?.['class'] ?? '';
  if (/navbox|collapsible-toggle/.test(cls)) return;

  const notice = readNotice($, el);
  if (notice) {
    if (notice.kind !== 'maintenance') {
      out.push({ kind: 'paragraph', section, text: notice.text, notice: notice.kind });
    }
    return;
  }

  const table = readTable($, el, section);
  if (table) out.push(table.caption || !fallbackCaption ? table : { ...table, caption: fallbackCaption });

  // Tables laid out inside this one's cells are tables of their own, captioned
  // by the column they sat under ("Level 1-50").
  for (const inner of nestedTables($, el)) {
    appendTable($, inner, section, out, nestedTableLabel($, el, inner));
  }
}

function readList(
  $: Api,
  $list: cheerio.Cheerio<AnyNode>,
  section: string,
  ordered: boolean,
): ArticleBlock | null {
  // One string per item; a nested list's items become further lines of the
  // item they belong to, rather than being glued onto its text.
  const items = $list
    .children('li')
    .toArray()
    .map((li) => lineText(li))
    .filter(Boolean);
  return items.length > 0 ? { kind: 'list', section, ordered, items } : null;
}

/** Reads a table as laid out by the browser. See table.ts. */
function readTable($: Api, el: Element, section: string): TableBlock | null {
  const grid = readTableGrid($, el);
  if (!grid) return null;
  const block: TableBlock = {
    kind: 'table',
    section,
    caption: grid.caption,
    headers: grid.headers,
    rows: grid.rows,
  };
  if (grid.groupRows.length > 0) block.groupRows = grid.groupRows;
  return block;
}

/* -------------------------------------------------------------------------- */
/* Images                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * At or below this, an image is an icon: the 30px sprite the wiki's item-link
 * template puts in front of every item name, or the 64px item picture in a
 * recipe table. In a gallery that is a smudge on a 128px tile, and on some
 * articles the gallery was nothing but — Amber's only picture was the Coins
 * icon from "sold for 5 Coins".
 */
const ICON_MAX_PX = 64;

/** The largest size the markup declares for an image, or null when it does not say. */
function declaredSize(img: Element, url: string): number | null {
  const sizes = [img.attribs['width'], img.attribs['height']]
    .map((v) => Number.parseInt(v ?? '', 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (sizes.length > 0) return Math.max(...sizes);
  const scaled = /\/scale-to-width-down\/(\d+)/.exec(url)?.[1];
  return scaled ? Number(scaled) : null;
}

/**
 * Collects images from an element, including those hidden inside `<noscript>`.
 *
 * Fandom galleries put every image in a `<noscript>` fallback, and an HTML
 * parser treats that element's content as *text*, not markup. Walking elements
 * alone therefore finds no images at all and drops the raw `<img …>` string
 * into the article as a paragraph. Re-parsing the text is what recovers them.
 *
 * Icons are left out unless the editors put them in a gallery themselves.
 */
function collectImages($: Api, $el: cheerio.Cheerio<AnyNode>, out: ArticleImage[]): void {
  // `anchor` is where the image sits in the page: the image itself, or the
  // `<noscript>` a re-parsed image came out of.
  const take = (element: Element, anchor: cheerio.Cheerio<AnyNode>): void => {
    const src = element.attribs['src'] ?? '';
    const url = src.startsWith('http') ? src : (element.attribs['data-src'] ?? '');
    if (!url.startsWith('http')) return;
    // Fandom's chrome: logos and tracking pixels carry no article information.
    if (/Site-logo|\/thumbnails?\/transparent/i.test(url)) return;
    // A formula's rendered fallback; the formula itself is in the text.
    if (/mwe-math/.test(element.attribs['class'] ?? '') || url.includes('/media/math/render/')) return;

    const inGallery = anchor.closest('.wikia-gallery, .gallery').length > 0;
    const size = declaredSize(element, url);
    if (!inGallery && size !== null && size <= ICON_MAX_PX) return;

    const alt = cleanText(element.attribs['alt'] ?? '');
    const caption =
      cleanText(element.attribs['data-caption'] ?? '') ||
      cleanText(anchor.closest('figure').find('figcaption').first().text());
    out.push(caption ? { url, alt, caption } : { url, alt });
  };

  for (const img of $el.find('img').toArray()) take(img as Element, $(img));

  for (const noscript of $el.find('noscript').toArray()) {
    const inner = cheerio.load(`<div>${$(noscript).text()}</div>`);
    for (const img of inner('img').toArray()) take(img as Element, $(noscript));
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

  const $ = cheerio.load(html);
  const variants = infoboxVariants($);
  return {
    title: tree.title,
    image: extractInfoboxImage($),
    common: common.filter((g) => g.rows.length > 0),
    tabs: tabs.map((t) => ({ ...t, groups: t.groups.filter((g) => g.rows.length > 0) })),
    ...(variants.length > 0 ? { variants } : {}),
  };
}

/**
 * The tabs of a page that shows one infobox per tab, or `[]` when it shows
 * one: "Raw", "Cooked" on a meat, "Head", "Chest", "Legs" on an armor set.
 * The infobox read is the first tab's: the page's own on the meat, a piece's
 * (the helmet's) on the set, which is why the comparison wants to know
 * (`isOwnInfobox` in wiki-repo.ts).
 */
function infoboxVariants($: Api): string[] {
  const tabber = $('aside.portable-infobox').first().closest('.wds-tab__content').parent().get(0);
  if (!tabber || !isTabber(tabber as Element)) return [];
  const holding = tabberPanels($, tabber as Element).filter(({ panel }) => $(panel).find('aside.portable-infobox').length > 0);
  return holding.length >= 2 ? holding.map(({ label }, i) => label || String(i + 1)) : [];
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

function extractInfoboxImage($: Api): ArticleImage | null {
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
 * states a recipe — which is exactly what makes the value a station rather
 * than an origin (`statesRecipe`).
 */
const RECIPE_LABELS = /^(crafting materials|materials)$/i;

/** What the wiki writes in a recipe row for "none": "n/a", "N/A", "nil", "-". */
const NO_VALUE = /^(n\/?a|none|nil|unknown|-+|—|–)?$/i;

/**
 * Whether an infobox row states a recipe: materials that name something
 * ("Wood x6"), or a crafting level that is a number.
 *
 * Not the row's label alone. A repair level says the item can be repaired,
 * which anything worn can: Hildir's 31 dresses, tunics and caps state one
 * ("Repair Level: 1", "Repair Station: Workbench") and their Source is Hildir,
 * who sells them. Haldor's Dverger circlet and Yule hat state "Crafting
 * Materials: N/A"; the Sparkler and the console-only shields "Crafting Level:
 * nil". Read as recipes, once parser version 2 read the armor pieces' level
 * tabs, they made both traders crafting stations, with 32 and 2 items.
 */
function statesRecipe(row: InfoboxRow): boolean {
  const label = row.label.trim();
  const value = row.value.trim();
  if (RECIPE_LABELS.test(label)) return !NO_VALUE.test(value);
  return /^crafting level$/i.test(label) && /\d/.test(value);
}

/**
 * Promotes a few infobox rows to queryable fields.
 *
 * Only the first value is kept when a row lists several ("Plains\nMistlands",
 * or "Plains; Mistlands" on rows stored before values kept their lines,
 * becomes "Plains"): a facet is for narrowing a list, and the article itself
 * still shows the full row. The first value, not the first line: a value
 * that groups its entries starts with a heading for them ("Inside Sunken
 * Crypts:\nmudpile2 (whole)"), and the heading is no biome, station or id.
 */
function liftFacets(infobox: ArticleInfobox | null): ArticleFacets {
  if (!infobox) return {};

  const allRows = [
    ...infobox.common.flatMap((g) => g.rows),
    ...infobox.tabs.flatMap((t) => t.groups.flatMap((g) => g.rows)),
  ];

  const isCraftable = allRows.some(statesRecipe);
  const facets: ArticleFacets = {};

  for (const row of allRows) {
    const label = row.label.trim().toLowerCase();
    const key = label === 'source' ? (isCraftable ? 'station' : undefined) : FACET_LABELS[label];
    if (!key || facets[key]) continue;

    const value = row.value
      .split(/[;\n]/)
      .map((entry) => entry.trim())
      .find((entry) => entry && !entry.endsWith(':'))
      ?.split(',')[0]
      ?.trim();
    // A long value is a sentence, not a facet: "Fuling Village in the Plains
    // biome" is prose that happens to sit in a labelled row.
    if (value && value.length <= 40) facets[key] = value;
  }
  return facets;
}

/**
 * Collapses MediaWiki's maths markup to a single readable expression.
 *
 * MediaWiki emits every formula three times: MathML for screen readers, a
 * TeX annotation inside it, and a rendered image. Plain text extraction takes
 * the first two and concatenates them, which is why an article about drop
 * rates read
 *
 *   "…with the formula ∑ i = 0 k ( n i ) p i ( 1 − p ) n − i
 *    {\displaystyle \sum _{i=0}^{k}{n \choose i}p^{i}(1-p)^{n-i}}"
 *
 * — the glyphs stripped of their layout, then the source, neither of which is
 * a formula. The TeX annotation is the honest one, and it is rendered as the
 * plain text it describes ("total damage / duration"), since the reader has
 * no maths renderer and TeX source is noise to anyone who does not write it.
 *
 * Built as a text node rather than spliced in as HTML: a formula such as
 * `armor<b` would otherwise open a bold tag.
 */
function collapseMath($: Api, root: cheerio.Cheerio<AnyNode>): void {
  for (const el of root.find('.mwe-math-element').toArray()) {
    const tex = $(el).find('annotation[encoding="application/x-tex"]').first().text().trim();
    const formula = tex ? texToText(tex) : '';
    if (formula) $(el).replaceWith($('<code></code>').text(formula));
    else $(el).remove();
  }
  // Any maths outside that wrapper: the MathML is glyph soup without layout.
  root.find('math, annotation').remove();
}
