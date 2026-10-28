/**
 * Text hygiene for what the chat stores, titles and replays to a model.
 *
 * Three hazards, the first two seen in production:
 *
 * - **Lone surrogates.** JavaScript strings are UTF-16, so `slice` can cut an
 *   emoji in half, and a JSON body can carry a `\ud83d` escape on its own.
 *   Neon's HTTP driver sends parameters as JSON and Neon refuses to parse a
 *   lone surrogate, so a conversation titled with half an emoji failed with a
 *   500 on every retry. PGlite quietly stores U+FFFD instead, which is why no
 *   test noticed. User text is made well-formed on the way in, and every cut
 *   lands on a boundary.
 * - **Stale citations.** An earlier answer's `[3]` named that turn's third
 *   excerpt. Replayed into a new prompt it collides with the new `[3]`, under a
 *   system prompt that says to cite only the numbered excerpts.
 * - **Control characters.** Postgres refuses U+0000 outright, in `text`
 *   (22021) and in `jsonb` (22P05), on PGlite and Neon alike: a question with
 *   one failed with a 500 on every retry, and an answer a model ended up
 *   writing one into was lost whole. See `storableText`.
 */

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Replaces each unpaired UTF-16 surrogate with U+FFFD. */
export function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, '�');
}

/** C0 controls other than tab, line feed and carriage return. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

/**
 * Text the database will take, and that reads back as what was written:
 * well-formed, and without C0 control characters other than tab, line feed
 * and carriage return.
 *
 * NUL is the one Postgres refuses. The others are stored, but nobody types
 * them and no model means them, and JSON escapes each one in six bytes, so
 * 10,000 of them — an answer the 64 KB body cap still admits — read back as
 * 60 KB every time the conversation is opened. They are dropped rather than
 * replaced: unlike half an emoji, they carry no content.
 *
 * Applied to every text a chat route stores — questions, answers, titles —
 * before any check of its length or emptiness, so a text made only of them
 * counts as empty.
 */
export function storableText(text: string): string {
  return wellFormed(text).replace(CONTROL, '');
}

/** Length in Unicode code points, which is what a reader would call characters. */
export function codePointLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

/**
 * At most `max` UTF-16 code units, never ending on half a surrogate pair.
 * For long texts where a cut is a cap, not something a reader sees.
 */
export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * At most `max` user-perceived characters. Cut on grapheme boundaries rather
 * than merely code points, so a flag, a skin-toned emoji or a letter with a
 * combining accent is kept whole or left out, never split.
 */
export function truncateGraphemes(text: string, max: number): string {
  let out = '';
  let count = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (count === max) break;
    out += segment;
    count += 1;
  }
  return out;
}

/** The sidebar title for a conversation, from its opening question. */
export function conversationTitle(question: string, max = 60): string {
  return truncateGraphemes(storableText(question).replace(/\s+/g, ' ').trim(), max);
}

/*
 * Both patterns below start with a run of blanks, and both start it with
 * `(?<![ \t])`: a match may begin only where a run of blanks begins.
 *
 * Without it the engine retried the run from each of its blanks in turn, and
 * each retry scanned the rest of the run, so a long run with no marker or
 * line break after it cost the square of its length: 12,000 spaces took each
 * pattern about 80 ms, and replaying eight such answers into a question's
 * history blocked the server's only thread for over a second — every page,
 * every reader. A Puter reader writes their own stored answers, so anyone
 * could.
 *
 * The output is unchanged. The greedy run from a run's first blank reaches
 * every marker or line break a later blank could, so the leftmost match
 * always started there anyway; and no match ends on a blank (one ends on a
 * bracket, the other on a line break), so the next match can never be one
 * that begins in the middle of a run.
 */

/**
 * Citation and image markers in every shape the models write them: `[2]`,
 * `[2][3]`, `[1, 2]`, `[1–3]`, `[img:2]`, and the lenticular and full-width
 * brackets gpt-oss reaches for. The leading whitespace goes with the marker so
 * "hierro [1]." becomes "hierro.".
 */
const MARKER = /(?<![ \t])[ \t]*[[【［]\s*(?:img\s*:\s*)?\d+(?:\s*[,，、–—-]\s*\d+)*\s*[\]】］]/gi;

/** Blanks at the end of a line. */
const TRAILING_BLANKS = /(?<![ \t])[ \t]+\n/g;

/** An earlier answer as plain prose, without markers that only meant something in its own turn. */
export function stripCitationMarkers(text: string): string {
  return text
    .replace(MARKER, '')
    .replace(TRAILING_BLANKS, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
