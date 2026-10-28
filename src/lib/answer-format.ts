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
 * What the models actually write is wider than what they are asked for, and
 * the cheap variants are handled rather than shown as punctuation: `###`
 * headings, a citation inside bold, `[1, 2]` and `[1–3]` lists, lenticular and
 * full-width brackets, and an image marker in the middle of a sentence.
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
  /**
   * A markdown heading (`#` to `######`). Rendered as its own line, never run
   * into the next paragraph; a renderer that does not style it can treat it
   * as a paragraph.
   */
  | { type: 'heading'; level: number; segments: InlineSegment[] }
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
/** `[img:3]` anywhere in a line. */
const INLINE_IMAGE = /\[img:(\d+)\]/g;
/** `### Materiales`, with any closing hashes. */
const HEADING = /^(#{1,6})\s+(.+?)(?:\s+#+)?$/;

/*
 * A citation marker's body: one number, a list (`1, 2`) or a range (`1–3`).
 * The separators include the full-width comma and the ideographic one, and
 * the range accepts a hyphen, an en dash or an em dash.
 */
const CITATION_BODY = String.raw`\d+(?:\s*[,，、–—-]\s*\d+)*`;
const CITATION = new RegExp(String.raw`^\[(${CITATION_BODY})\]$`);
/** A range wider than this is not a citation run; it stays text. */
const MAX_RANGE = 12;

/** Splits `| a | b |` into its cells, tolerating missing outer pipes. */
function tableCells(line: string): string[] {
  const inner = TABLE_ROW.exec(line.trim())?.[1] ?? line.trim();
  return inner.split('|').map((cell) => cell.trim());
}

/*
 * Citation brackets, as models actually write them.
 *
 * The prompt asks for `[1]` and `gpt-oss` answers with `【1】` — the CJK
 * lenticular brackets — often enough that treating it as the model
 * misbehaving would mean shipping answers whose citations render as literal
 * punctuation instead of chips. Normalising costs one pass over the string
 * and makes the parser indifferent to which bracket the model reached for.
 * Image markers get the same treatment, and lose any stray spaces or capitals
 * (`[IMG: 2]`).
 */
const BRACKET_VARIANTS: [RegExp, string][] = [
  [new RegExp(String.raw`[【［]\s*((?:img\s*:\s*)?${CITATION_BODY})\s*[】］]`, 'gi'), '[$1]'],
  [/\[\s*img\s*:\s*(\d+)\s*\]/gi, '[img:$1]'],
];

function normaliseBrackets(text: string): string {
  return BRACKET_VARIANTS.reduce(
    (out, [pattern, replacement]) => out.replace(pattern, replacement),
    text,
  );
}

/**
 * The citation numbers in a marker body, or null when it is not one a model
 * would write (a reversed or implausibly wide range).
 */
function citationNumbers(body: string): number[] | null {
  const out: number[] = [];
  for (const piece of body.split(/\s*[,，、]\s*/)) {
    const range = /^(\d+)\s*[–—-]\s*(\d+)$/.exec(piece);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to < from || to - from > MAX_RANGE) return null;
      for (let n = from; n <= to; n += 1) out.push(n);
    } else {
      out.push(Number(piece));
    }
  }
  // `[2, 2]` is one source cited twice; one chip says it.
  return out.filter((n, i) => out.indexOf(n) === i);
}

/** Splits an answer into paragraphs, headings, lists, tables and figures. */
export function parseAnswer(text: string): AnswerBlock[] {
  const lines = normaliseBrackets(text).split('\n');
  const blocks: AnswerBlock[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];
  let numbers: string[] = [];
  /*
   * Image markers found inside a line. A figure in the middle of a sentence
   * reads as a hole in it, so the marker is lifted out and the figure placed
   * after the block it came from.
   */
  let figures: number[] = [];

  const liftImages = (line: string): string => {
    let lifted = false;
    const rest = line.replace(INLINE_IMAGE, (_marker, n: string) => {
      lifted = true;
      if (!figures.includes(Number(n))) figures.push(Number(n));
      return '';
    });
    if (!lifted) return line;
    return rest.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([.,;:!?)])/g, '$1').trim();
  };

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
    for (const n of figures) blocks.push({ type: 'image', n });
    figures = [];
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
     * A heading is a line of its own. Left to the paragraph rules it ran
     * into the next line as "### Materiales Necesitás hierro".
     */
    const heading = HEADING.exec(trimmed);
    if (heading) {
      flush();
      const content = liftImages(heading[2] ?? '');
      if (content) blocks.push({ type: 'heading', level: heading[1]!.length, segments: parseInline(content) });
      flush();
      continue;
    }

    /*
     * A row of pipes is only a table if the next line is the rule. Without
     * that check a sentence containing a pipe becomes a one-column table.
     */
    if (TABLE_ROW.test(trimmed) && TABLE_RULE.test((lines[i + 1] ?? '').trim())) {
      flush();
      const header = tableCells(liftImages(trimmed)).map(parseInline);
      const rows: InlineSegment[][][] = [];

      i += 2;
      while (i < lines.length && TABLE_ROW.test((lines[i] ?? '').trim())) {
        rows.push(tableCells(liftImages(lines[i] ?? '')).map(parseInline));
        i += 1;
      }
      i -= 1;

      blocks.push({ type: 'table', header, rows });
      flush();
      continue;
    }

    const line = liftImages(trimmed);
    if (line === '') continue;

    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      if (paragraph.length > 0 || numbers.length > 0) flush();
      bullets.push(bullet[1] ?? '');
      continue;
    }

    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      if (paragraph.length > 0 || bullets.length > 0) flush();
      numbers.push(numbered[1] ?? '');
      continue;
    }

    if (bullets.length > 0 || numbers.length > 0) flush();
    paragraph.push(line);
  }
  flush();

  return blocks;
}

const INLINE_PATTERN = new RegExp(String.raw`(\*\*[^*]+\*\*|` + '`[^`]+`' + String.raw`|\[${CITATION_BODY}\])`, 'g');
const MARKER_SPLIT = new RegExp(String.raw`(\[${CITATION_BODY}\])`, 'g');

/** Pushes the citations in a marker, or nothing (and false) when it is not one. */
function pushCitations(segments: InlineSegment[], part: string): boolean {
  const body = CITATION.exec(part)?.[1];
  const numbers = body === undefined ? null : citationNumbers(body);
  if (!numbers) return false;
  for (const n of numbers) segments.push({ type: 'citation', n });
  return true;
}

/**
 * Bold text, with any citation inside it pulled out as a chip: models write
 * `**Espada de hierro [1]**` as often as `**Espada de hierro** [1]`.
 */
function pushBold(segments: InlineSegment[], inner: string): void {
  for (const piece of inner.split(MARKER_SPLIT)) {
    if (piece === '') continue;
    if (pushCitations(segments, piece)) continue;
    if (piece.trim() !== '') segments.push({ type: 'bold', text: piece });
    else segments.push({ type: 'text', text: piece });
  }
}

/** Splits one line into text, bold, code and citation segments. */
export function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];

  for (const part of normaliseBrackets(text).split(INLINE_PATTERN)) {
    if (part === '') continue;

    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      pushBold(segments, part.slice(2, -2));
      continue;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      segments.push({ type: 'code', text: part.slice(1, -1) });
      continue;
    }
    if (pushCitations(segments, part)) continue;
    segments.push({ type: 'text', text: part });
  }

  return segments;
}
