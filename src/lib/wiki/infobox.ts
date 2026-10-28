import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import type { Infobox, InfoboxNode } from './types';
import { inlineText, lineText } from './dom-text';
import { cleanText } from './text';

type Api = cheerio.CheerioAPI;

/**
 * Turns a Fandom `portable-infobox` into a label/value tree.
 *
 * Plain text extraction is not usable here: a `pi-horizontal-group` renders as
 * a header row followed by a value row, so flattening it yields
 * "Weight Durability 0.8 200" and every number loses its label. The tree keeps
 * each value attached to its own label and to the upgrade level it belongs to.
 */
export function extractInfobox(html: string): Infobox | null {
  const $ = cheerio.load(html);
  const aside = $('aside.portable-infobox').first();
  if (aside.length === 0) return null;

  const title = cleanText(aside.find('.pi-title').first().text()) || cleanText($('h1').first().text());
  const nodes = collectChildren($, aside.get(0) as Element);

  return { title, nodes };
}

/** Direct infobox children of `el`, in document order, skipping decoration. */
function collectChildren($: Api, el: Element): InfoboxNode[] {
  const out: InfoboxNode[] = [];
  for (const child of relevantDescendants($, el)) {
    const node = toNode($, child);
    if (node) out.push(node);
  }
  return out;
}

/**
 * Walks down from `el` and yields the nearest meaningful elements: a data pair,
 * a horizontal group, a nested group, or a tabber. Anything else (wrappers,
 * images, whitespace) is descended through rather than emitted.
 */
function relevantDescendants($: Api, el: Element): Element[] {
  const found: Element[] = [];

  const visit = (node: AnyNode): void => {
    if (node.type !== 'tag') return;
    const element = node as Element;
    const cls = element.attribs['class'] ?? '';

    if (element.name === 'aside' ? false : isTabber(cls)) {
      found.push(element);
      return;
    }
    if (element.name === 'table' && cls.includes('pi-horizontal-group')) {
      found.push(element);
      return;
    }
    if (cls.includes('pi-data') && !cls.includes('pi-data-label') && !cls.includes('pi-data-value')) {
      found.push(element);
      return;
    }
    if (cls.includes('pi-group')) {
      found.push(element);
      return;
    }
    for (const c of element.children) visit(c);
  };

  for (const c of el.children) visit(c);
  return found;
}

function isTabber(cls: string): boolean {
  return cls.includes('wds-tabber') || cls.includes('pi-panel');
}

function toNode($: Api, el: Element): InfoboxNode | null {
  const cls = el.attribs['class'] ?? '';

  if (isTabber(cls)) return tabsNode($, el);
  if (el.name === 'table' && cls.includes('pi-horizontal-group')) return horizontalGroupNode($, el);
  if (cls.includes('pi-group')) return groupNode($, el);
  if (cls.includes('pi-data')) return dataNode($, el);
  return null;
}

function dataNode($: Api, el: Element): InfoboxNode | null {
  const $el = $(el);
  const label = labelText($el.find('.pi-data-label').first());
  const value = renderValue($el.find('.pi-data-value').first());
  if (!value) return null;
  // Some entries (the flavour-text description) carry a value but no label.
  return { kind: 'data', label: label || 'Description', value };
}

/**
 * `<thead>` holds the labels and `<tbody>` the values, one column each.
 * Zipping by column index is what keeps "Weight" bound to "0.8".
 */
function horizontalGroupNode($: Api, el: Element): InfoboxNode | null {
  const $table = $(el);
  const labels = $table
    .find('th.pi-data-label')
    .toArray()
    .map((th) => labelText($(th)));
  const values = $table
    .find('td.pi-data-value')
    .toArray()
    .map((td) => renderValue($(td)));

  const children: InfoboxNode[] = [];
  for (let i = 0; i < Math.max(labels.length, values.length); i += 1) {
    const label = labels[i] ?? '';
    const value = values[i] ?? '';
    if (!value) continue;
    children.push({ kind: 'data', label: label || `Value ${i + 1}`, value });
  }
  if (children.length === 0) return null;
  return { kind: 'group', label: '', children };
}

function groupNode($: Api, el: Element): InfoboxNode | null {
  const label = cleanText($(el).children('.pi-header').first().text());
  const children = collectChildren($, el);
  if (children.length === 0) return null;
  return { kind: 'group', label, children };
}

/** Zips `.wds-tabs__tab-label` with the `.wds-tab__content` panels that follow. */
function tabsNode($: Api, el: Element): InfoboxNode | null {
  const $el = $(el);
  const labels = $el
    .find('.wds-tabs__tab-label')
    .toArray()
    .map((n) => cleanText($(n).text()));
  const panels = $el.find('.wds-tab__content').toArray();

  if (labels.length === 0 || panels.length === 0) {
    const children = collectChildren($, el);
    return children.length > 0 ? { kind: 'group', label: '', children } : null;
  }

  const tabs = panels.map((panel, i) => ({
    label: labels[i] ?? String(i + 1),
    children: collectChildren($, panel as Element),
  }));

  return { kind: 'tabs', tabs: tabs.filter((t) => t.children.length > 0) };
}

/**
 * A value, one entry per line.
 *
 * Value cells hold `<ul>` lists (crafting materials), `<br>`-separated runs
 * and the odd `<p>`; each entry becomes its own line, `Finewood x10\nBronze
 * x3`, so the reader can show them as a list and nothing runs together.
 *
 * The previous reading joined every `<li>` it could find with "; ", nested
 * ones included, and also kept each parent item's whole text — so a creature's
 * abilities read "Unarmed:Punch (4s)Ground slam (20s); Punch (4s); Ground
 * slam (20s)", every attack twice and the first copy glued together. An
 * `<a>Oden</a><p><a>Munin</a></p>` read "OdenMunin".
 */
function renderValue($value: cheerio.Cheerio<AnyNode>): string {
  const el = $value.get(0);
  return el ? lineText(el) : '';
}

/** A label on one line: `Damaged by<br>Rain?` is one label, not two run together. */
function labelText($label: cheerio.Cheerio<AnyNode>): string {
  const el = $label.get(0);
  return el ? inlineText(el) : '';
}

export type RenderInfoboxOptions = {
  /** Render only this tab (upgrade level) plus everything outside the tabber. */
  tab?: string;
  /** Word prefixed to numeric tab headings. Defaults to `Level`. */
  tabWord?: string;
};

/**
 * Names a tab for the breadcrumb.
 *
 * Item infoboxes tab by upgrade level (`1`..`4`), where "Level 3" is the
 * natural reading. Creature infoboxes tab by star level and variant (`0★`,
 * `Trophy`), where prefixing a word would produce nonsense like "Level Trophy",
 * so those labels stand alone.
 */
function tabHeading(label: string, tabWord: string): string {
  return /^\d+$/.test(label) ? `${tabWord} ${label}` : label;
}

/** Merges consecutive lines that share a breadcrumb, so it is not repeated. */
function mergeByBreadcrumb(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const sep = line.indexOf(': ');
    const prefix = sep === -1 ? null : line.slice(0, sep);
    const rest = sep === -1 ? line : line.slice(sep + 2);
    const previous = out[out.length - 1];
    if (prefix !== null && previous !== undefined && previous.startsWith(`${prefix}: `)) {
      out[out.length - 1] = `${previous}; ${rest}`;
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * A value as one run of text: its lines joined with "; ".
 *
 * A rendered infobox is one line per breadcrumb, and the chunker relies on
 * that, so a value's own line breaks cannot survive into it.
 */
function oneLine(value: string): string {
  return value.replace(/\n/g, '; ');
}

/**
 * Flattens the tree to labelled lines, e.g.
 * `Level 1 › Properties: Weight: 0.8; Durability: 200`.
 */
export function renderInfobox(box: Infobox, options: RenderInfoboxOptions = {}): string {
  const { tab, tabWord = 'Level' } = options;
  const lines: string[] = [];

  const walk = (nodes: InfoboxNode[], breadcrumb: string[]): void => {
    const pairs: string[] = [];

    const flushPairs = (): void => {
      if (pairs.length === 0) return;
      const prefix = breadcrumb.length > 0 ? `${breadcrumb.join(' › ')}: ` : '';
      lines.push(`${prefix}${pairs.join('; ')}`);
      pairs.length = 0;
    };

    for (const node of nodes) {
      if (node.kind === 'data') {
        pairs.push(`${node.label}: ${oneLine(node.value)}`);
        continue;
      }
      if (node.kind === 'group') {
        if (node.label) {
          flushPairs();
          walk(node.children, [...breadcrumb, node.label]);
        } else {
          // Unlabelled group (a horizontal row): keep it on the current line.
          for (const child of node.children) {
            if (child.kind === 'data') pairs.push(`${child.label}: ${oneLine(child.value)}`);
            else {
              flushPairs();
              walk([child], breadcrumb);
            }
          }
        }
        continue;
      }
      // tabs
      flushPairs();
      for (const t of node.tabs) {
        if (tab !== undefined && t.label !== tab) continue;
        walk(t.children, [...breadcrumb, tabHeading(t.label, tabWord)]);
      }
    }
    flushPairs();
  };

  walk(box.nodes, []);
  return [box.title, ...mergeByBreadcrumb(lines)].filter(Boolean).join('\n');
}

/**
 * Tab labels present in the infobox, or `[]` when it has no tabber: those of
 * the first tabber with a tab that holds data.
 *
 * The first tabber of all used to answer. On every armor piece that is the
 * picture's ("Icon", no data, so no tabs), and the quality levels after it —
 * armor, durability, weight, the recipe of each level — had no tab to go to:
 * the reading document dropped them. No armor piece's infobox showed them
 * (66 in the Armor category, and Megingjord and the Wisplight besides), and
 * the Armor comparison had none to compare.
 */
export function infoboxTabs(box: Infobox): string[] {
  const tabs = box.nodes.find((n) => n.kind === 'tabs' && n.tabs.length > 0);
  return tabs?.kind === 'tabs' ? tabs.tabs.map((t) => t.label) : [];
}
