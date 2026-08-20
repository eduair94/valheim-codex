/**
 * Parsing for answer text, kept apart from rendering so it can be tested as
 * plain functions.
 *
 * A full markdown parser is not warranted: the model is instructed to produce
 * short prose, bullets, bold, inline code and `[n]` citation markers, and
 * shipping a parser to handle five constructs would cost more than it returns.
 * Anything unrecognised falls through as text, so an unexpected construct
 * degrades to readable rather than to broken markup.
 */

export type InlineSegment =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'code'; text: string }
  | { type: 'citation'; n: number };

export type AnswerBlock =
  | { type: 'paragraph'; segments: InlineSegment[] }
  | { type: 'bullets'; items: InlineSegment[][] }
  | { type: 'numbers'; items: InlineSegment[][] };

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

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      flush();
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
