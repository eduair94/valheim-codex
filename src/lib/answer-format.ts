/**
 * Parsing for answer text, kept apart from rendering so it can be tested as
 * plain functions.
 *
 * A full markdown parser is not warranted: the model is instructed to produce
 * short prose, bullets, bold, inline code, tables, `[n]` citation markers and
 * `[img:n]` image markers, and shipping a parser for the whole of markdown to
 * handle seven constructs would cost more than it returns. Anything
 * unrecognised falls through as text, so an unexpected construct degrades to
 * readable rather than to broken markup.
 *
 * `[img:n]` names a citation, never a URL. A model asked for an image address
 * will invent a plausible one; asked to point at a source it already cited, it
 * cannot, because the address is looked up server-side from the row that
 * citation resolves to.
 */

export type InlineSegment =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'code'; text: string }
  | { type: 'citation'; n: number };

export type AnswerBlock =
  | { type: 'paragraph'; segments: InlineSegment[] }
  | { type: 'bullets'; items: InlineSegment[][] }
  | { type: 'numbers'; items: InlineSegment[][] }
  | { type: 'table'; header: InlineSegment[][]; rows: InlineSegment[][][] }
  | { type: 'image'; n: number };

/** `| a | b |` — a row of a markdown table. */
const TABLE_ROW = /^\|(.+)\|\s*$/;
/** `| --- | :---: |` — the rule under a header, which is what makes it a table. */
const TABLE_RULE = /^\|[\s:|-]+\|\s*$/;
/** `[img:3]` alone on a line. */
const IMAGE_LINE = /^\[img:(\d+)\]$/;

/** Splits `| a | b |` into its cells, tolerating missing outer pipes. */
function tableCells(line: string): string[] {
  const inner = TABLE_ROW.exec(line.trim())?.[1] ?? line.trim();
  return inner.split('|').map((cell) => cell.trim());
}

/** Splits an answer into paragraphs and lists. */
export function parseAnswer(text: string): AnswerBlock[] {
  const lines = text.split('\n');
  const blocks: AnswerBlock[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];
  let numbers: string[] = [];

  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', segments: parseInline(paragraph.join(' ').trim()) });
      paragraph = [];
    }
    if (bullets.length > 0) {
      blocks.push({ type: 'bullets', items: bullets.map(parseInline) });
      bullets = [];
    }
    if (numbers.length > 0) {
      blocks.push({ type: 'numbers', items: numbers.map(parseInline) });
      numbers = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed === '') {
      flush();
      continue;
    }

    const image = IMAGE_LINE.exec(trimmed);
    if (image) {
      flush();
      blocks.push({ type: 'image', n: Number(image[1]) });
      continue;
    }

    /*
     * A row of pipes is only a table if the next line is the rule. Without
     * that check a sentence containing a pipe becomes a one-column table.
     */
    if (TABLE_ROW.test(trimmed) && TABLE_RULE.test((lines[i + 1] ?? '').trim())) {
      flush();
      const header = tableCells(trimmed).map(parseInline);
      const rows: InlineSegment[][][] = [];

      i += 2;
      while (i < lines.length && TABLE_ROW.test((lines[i] ?? '').trim())) {
        rows.push(tableCells(lines[i] ?? '').map(parseInline));
        i += 1;
      }
      i -= 1;

      blocks.push({ type: 'table', header, rows });
      continue;
    }

    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      if (paragraph.length > 0 || numbers.length > 0) flush();
      bullets.push(bullet[1] ?? '');
      continue;
    }

    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) {
      if (paragraph.length > 0 || bullets.length > 0) flush();
      numbers.push(numbered[1] ?? '');
      continue;
    }

    if (bullets.length > 0 || numbers.length > 0) flush();
    paragraph.push(trimmed);
  }
  flush();

  return blocks;
}

const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|\[\d+\])/g;

/** Splits one line into text, bold, code and citation segments. */
export function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];

  for (const part of text.split(INLINE_PATTERN)) {
    if (part === '') continue;

    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      segments.push({ type: 'bold', text: part.slice(2, -2) });
      continue;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      segments.push({ type: 'code', text: part.slice(1, -1) });
      continue;
    }
    const marker = /^\[(\d+)\]$/.exec(part);
    if (marker) {
      segments.push({ type: 'citation', n: Number(marker[1]) });
      continue;
    }
    segments.push({ type: 'text', text: part });
  }

  return segments;
}
