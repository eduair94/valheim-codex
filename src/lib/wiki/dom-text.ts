import type { AnyNode, Element } from 'domhandler';
import { cleanBlockText, cleanText } from './text';

/**
 * Reading text out of MediaWiki HTML without losing where its lines break.
 *
 * cheerio's `.text()` concatenates text nodes and nothing else, so a `<br>`, a
 * list item or a paragraph boundary simply disappears. The wiki writes every
 * recipe, upgrade cost and damage split that way:
 *
 *   `10 <a>Wood</a><br>8 <a>Iron</a><br>4 <a>Root</a>`
 *
 * came out as "10 Wood8 Iron4 Root": unreadable, and unlinkable too, because
 * "Wood8" is not a word the linker can find. Every reader of cells, list items
 * and infobox values goes through here instead, and gets the same text with a
 * `\n` wherever the browser would start a new line.
 */

/** Elements that start a new line in the browser, before and after them. */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'center', 'dd', 'details',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

/** Elements whose content is never reading text. */
const SILENT_TAGS = new Set(['script', 'style', 'noscript', 'img', 'audio', 'video', 'math']);

export type TextOptions = {
  /**
   * Leave out descendants this returns true for, e.g. a table nested in a
   * cell, which is read as a table of its own.
   */
  skip?: (el: Element) => boolean;
  /**
   * Keep line breaks that are only in the HTML source, inside text nodes.
   *
   * A browser renders those as spaces, which is what cells, list items and
   * infobox values want. Paragraphs have always kept them, and keep doing so:
   * changing every stored paragraph's whitespace would mark every translation
   * stale for nothing.
   */
  keepSourceBreaks?: boolean;
};

/**
 * The text of `node`'s descendants, with `\n` at every line boundary and
 * whitespace otherwise left as found. Callers normalise it; this is the raw
 * material for {@link lineText} and for the reader's inline paragraph buffer.
 */
export function collectText(node: AnyNode, options: TextOptions = {}): string {
  const parts: string[] = [];
  let pre = 0;

  const visit = (current: AnyNode): void => {
    if (current.type === 'text') {
      const data = (current as unknown as { data: string }).data;
      parts.push(pre > 0 || options.keepSourceBreaks ? data : data.replace(/\s+/g, ' '));
      return;
    }
    if (current.type !== 'tag') return;

    const el = current as Element;
    const tag = el.tagName?.toLowerCase() ?? '';
    if (tag === 'br') {
      parts.push('\n');
      return;
    }
    if (SILENT_TAGS.has(tag) || options.skip?.(el)) return;

    const block = BLOCK_TAGS.has(tag);
    if (block) parts.push('\n');
    if (tag === 'pre') pre += 1;
    for (const child of el.children) visit(child);
    if (tag === 'pre') pre -= 1;
    if (block) parts.push('\n');
  };

  if (node.type === 'tag') {
    for (const child of (node as Element).children) visit(child);
  } else {
    visit(node);
  }
  return parts.join('');
}

/**
 * An element's text as lines: one per `<br>`, list item or block, trimmed,
 * with empty lines dropped. "10 Wood\n8 Iron\n4 Root".
 */
export function lineText(node: AnyNode, options: TextOptions = {}): string {
  const raw = collectText(node, options);
  if (options.keepSourceBreaks) return cleanBlockText(raw);
  return raw
    .split('\n')
    .map((line) => cleanText(line))
    .filter(Boolean)
    .join('\n');
}

/**
 * An element's text on one line, for labels and headings: "Damage Types
 * (Min/Max)" from `Damage Types<br>(Min/Max)`, not "Damage Types(Min/Max)".
 */
export function inlineText(node: AnyNode, options: TextOptions = {}): string {
  return lineText(node, options).replace(/\n/g, ' ');
}
