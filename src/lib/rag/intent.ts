import type { TitleIndexEntry } from '@/lib/db/wiki-repo';
import { describeError, logWarn } from '@/lib/log';
import { fold } from '@/lib/wiki/slug';
import { prepareTitleIndex, searchTitles, type PreparedTitleIndex } from '@/lib/wiki/title-search';

/**
 * What a question asks about a thing, read from the question itself.
 *
 * Two questions are common enough, and fail often enough, to be worth reading
 * without a model: what a thing is for ("¿qué puedo hacer con el estaño?")
 * and where it is ("¿dónde encuentro estaño?"). Their answer is one known
 * section of the thing's own article — Usage, or the lead and Availability —
 * and ranking alone kept missing it. Usage is split into tiny chunks, one per
 * subsection ("Tin › Usage › Building" is "Cauldron, Mead ketill", 11
 * tokens), each competing on its own; a rewrite that asked for "recipes"
 * instead of uses, or no rewrite at all on the Puter path, left the item's own
 * list out of the context while lists that merely mention it got in.
 *
 * So the question is matched against a few frames per language, the thing it
 * names is linked to its article through the title index the wiki search
 * already ships, and retrieval pins that article's section at the head of the
 * context (`retrieve`). Matching is deliberately narrow: a phrasing no frame
 * knows, or a name no article answers to exactly, changes nothing.
 */

export type IntentKind = 'uses' | 'where';

export type Intent = {
  kind: IntentKind;
  /**
   * What the question asks about, folded and without its article, as it is
   * written: "estano y bronce", "jack-o-turnip". Linked whole before it is
   * read as a list (`linkThings`).
   */
  object: string;
  /** The things it lists, each a candidate article name: ["estano", "bronce"]. One, when it lists one. */
  phrases: string[];
};

/**
 * Frames that ask what a thing is for, in es / en / de / pt / fr. Matched
 * against the folded question; the group is the object phrase.
 *
 * A phrase comes before the alternative that is its first word: an
 * alternation takes the first that fits, and "uso" ahead of "uso le doy" left
 * "le doy a la resina" as the object.
 */
const USES_FRAMES: readonly RegExp[] = [
  // Spanish
  /\b(?:que|en que)\s+(?:puedo|podes|puedes|se puede|podria|podemos|pueden)\s+(?:hacer|fabricar|construir|craftear|crear|cocinar|usar|forjar)\s+(?:con|usando)\s+(.+)/,
  /\bpara\s+que\s+(?:sirve|sirven|me sirve|me sirven|se usa|se usan|usar|uso|necesito)\s+(.+)/,
  /\b(?:que|en que)\s+(?:uso le doy|usos tiene|uso|hago|hacer|se hace|se usan|se usa)\s+(?:con\s+)?(.+)/,
  /\b(?:usos?|utilidad(?:es)?)\s+(?:de|del)\s+(.+)/,
  /\bdonde\s+(?:se usa|se usan|uso|usar)\s+(.+)/,
  // English
  /\bwhat\s+(?:can|could|should|do)\s+(?:i|you|we)\s+(?:make|craft|build|do|cook|create|use)\s+(?:with|from|using)\s+(.+)/,
  /\bwhat\s+(?:is|are|'s)\s+(.+?)\s+(?:used|good)\s+for\b/,
  /\bwhat\s+(?:uses|needs|requires)\s+(.+)/,
  /\b(?:uses?|usage)\s+(?:of|for)\s+(.+)/,
  /\bwhat\s+to\s+do\s+with\s+(.+)/,
  // German
  /\bwas\s+(?:kann|konnen|koennen)\s+(?:ich|man|wir)\s+(?:mit|aus)\s+(.+?)\s+(?:herstellen|machen|bauen|craften|anfangen|tun|fertigen)\b/,
  /\b(?:wofur|wozu|wofuer)\s+(?:ist|sind|braucht man|brauche ich|dient|dienen|verwende ich|nutze ich)\s+(.+)/,
  // Portuguese
  /\bo\s+que\s+(?:posso|pode|da para|da pra|consigo|podemos)\s+(?:fazer|criar|construir|fabricar)\s+com\s+(.+)/,
  /\bpara\s+que\s+(?:serve|servem)\s+(.+)/,
  // French
  /\bque\s+(?:puis-je|peut-on|puis je)\s+(?:faire|fabriquer|construire)\s+avec\s+(.+)/,
  /\ba\s+quoi\s+(?:sert|servent)\s+(.+)/,
];

/**
 * Frames that ask where a thing is: found, mined, farmed, living. Checked
 * after the uses frames, so "¿dónde se usa la resina?" stays a uses question.
 */
const WHERE_FRAMES: readonly RegExp[] = [
  /\b(?:donde|en que bioma|en que lugar|en que parte)\s+(?:encuentro|consigo|hay|esta|estan|se encuentra|se encuentran|puedo encontrar|puedo conseguir|se consigue|se consiguen|aparece|aparecen|vive|viven|sale|salen|mino|farmeo|busco)\s+(.+)/,
  /\bwhere\s+(?:do|can|could|would|should)\s+(?:i|you|we)\s+(?:find|get|farm|mine|obtain|locate|look for)\s+(.+)/,
  /\bwhere\s+(?:to)\s+(?:find|get|farm|mine)\s+(.+)/,
  /\bwhere\s+(?:is|are)\s+(.+?)(?:\s+(?:found|located))?$/,
  /\bwhere\s+(?:do|does)\s+(.+?)\s+(?:come from|spawn|live|grow)\b/,
  /\bwo\s+(?:finde|bekomme|kriege|gibt es)\s+(?:ich\s+|man\s+)?(.+)/,
  /\bonde\s+(?:encontro|acho|consigo|fica|ficam|tem|ha|encontrar)\s+(.+)/,
];

/**
 * Articles, possessives and contractions in front of a name, in the five
 * languages. Stripped up to twice ("a la", "de la").
 */
const LEADING_ARTICLES =
  /^(?:el|la|los|las|un|una|unos|unas|lo|al|the|a|an|my|der|die|das|den|dem|des|ein|eine|einen|o|os|as|um|uma|le|les|du|de|del|mi|mis)\s+/;

/**
 * "estaño y bronce", "Zinn und Bronze", "tin, copper or iron": one phrase per
 * thing. A conjunction is a word between spaces, never a letter between
 * hyphens: "jack-o-turnip" is one thing.
 */
const CONJUNCTIONS = /\s*,\s*|\s+(?:y|e|and|und|et|o|or|oder|ou)\s+/;

/** Lower-case, accents folded, question marks gone, spaces collapsed. */
function normalise(question: string): string {
  return fold(question)
    .replace(/[¿?¡!.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A phrase without what stands in front of its name: "a la resina" → "resina". */
function withoutArticles(phrase: string): string {
  return phrase.trim().replace(LEADING_ARTICLES, '').replace(LEADING_ARTICLES, '');
}

/** Whether the question asks what a thing is for or where it is, and about what. */
export function detectIntent(question: string): Intent | null {
  const text = normalise(question);
  if (!text) return null;
  for (const [kind, frames] of [
    ['uses', USES_FRAMES],
    ['where', WHERE_FRAMES],
  ] as const) {
    for (const frame of frames) {
      const match = frame.exec(text);
      if (!match) continue;
      const object = withoutArticles(match[1]!.trim().replace(/\s+(?:en|in|im|no|na|dans)\s+valheim$/, ''));
      const phrases = object
        .split(CONJUNCTIONS)
        .map(withoutArticles)
        .filter((part) => part.length >= 2);
      if (phrases.length > 0) return { kind, object, phrases };
    }
  }
  return null;
}

/**
 * The sections that answer each intent, as a pattern on `section_path`.
 *
 * Whole headings only: "Usage" and its subsections, never "Usage tips". The
 * empty alternative of `where` is the lead, which on most items is where the
 * biome is named; Availability and its synonyms hold the rest.
 */
export const INTENT_SECTIONS: Record<IntentKind, string> = {
  uses: '^(Usage|Uses|Used in)( > |$)',
  where: '^(|Availability|Location|Locations|Spawning|Biome|Biomes|Sources|Obtaining)( > |$)',
};

/**
 * Most articles one question pins. A question names one or two things; past
 * three, pinned lists would push everything ranking found out of the context.
 */
export const MAX_PINNED_PAGES = 3;

/* -------------------------------------------------------------------------- */
/* Linking a name to its article                                               */
/* -------------------------------------------------------------------------- */

export type LinkedTitle = { slug: string; title: string };

export type TitleLinker = {
  /**
   * The article a phrase names exactly, in English or Spanish: one of its
   * names with the spaces taken out ("madera fina" is Finewood, "core wood"
   * is Corewood), or else a name made of the phrase's words and nothing more,
   * plurals folded ("núcleos de surtling" is Surtling Core). Null otherwise.
   */
  link(phrase: string): LinkedTitle | null;
  /** The articles an English text names by title, longest name first ("fine wood" before "wood"). */
  titlesIn(text: string): LinkedTitle[];
};

/** Where a linker comes from: the title index, read once, on first use. */
export type LinkerSource = () => Promise<TitleLinker | null>;

/** A name with everything but letters and digits removed: "Madera fina" → "maderafina". */
function compact(text: string): string {
  return fold(text).replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Words that never decide which article a phrase names. */
const LINK_STOP_WORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'of', 'the', 'a', 'an']);

/** A name's words, singular and in order, for "the same words" comparisons. */
function wordSet(text: string): string {
  const words = fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word && !LINK_STOP_WORDS.has(word))
    .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word));
  return [...new Set(words)].sort().join(' ');
}

/**
 * A linker over the bilingual title index (`getSearchIndex`).
 *
 * Exact or nothing, on purpose. A pinned section bypasses ranking, so a wrong
 * link puts an unrelated list at the head of the context: "hueso" must not
 * become Withered Bone because its Spanish name starts with it, and a name
 * the index does not know ("Zinn") links to nothing and leaves retrieval as
 * it was.
 */
export function createTitleLinker(index: TitleIndexEntry[]): TitleLinker {
  // Folded for the title search only when a phrase is not a name as it
  // stands: preparing a thousand entries costs about 10 ms, the maps 2 ms.
  let prepared: PreparedTitleIndex | undefined;
  const byCompact = new Map<string, TitleIndexEntry>();
  const byTitle = new Map<string, TitleIndexEntry>();
  for (const entry of index) {
    for (const name of [entry.t, entry.e, ...(entry.a ?? [])]) {
      const key = name ? compact(name) : '';
      if (key && !byCompact.has(key)) byCompact.set(key, entry);
    }
    const title = fold(entry.t);
    if (!byTitle.has(title)) byTitle.set(title, entry);
  }
  const linked = (entry: TitleIndexEntry): LinkedTitle => ({ slug: entry.s, title: entry.t });

  return {
    link(phrase) {
      const key = compact(phrase);
      if (!key) return null;
      const direct = byCompact.get(key);
      if (direct) return linked(direct);

      const wanted = wordSet(phrase);
      if (!wanted) return null;
      prepared ??= prepareTitleIndex(index);
      for (const { entry } of searchTitles(prepared, phrase, 5)) {
        const names = [entry.t, entry.e, ...(entry.a ?? [])].filter((name): name is string => Boolean(name));
        if (names.some((name) => wordSet(name) === wanted)) return linked(entry);
      }
      return null;
    },

    titlesIn(text) {
      const words = fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      const out: LinkedTitle[] = [];
      for (let i = 0; i < words.length; ) {
        let found: TitleIndexEntry | undefined;
        let length = 0;
        for (let n = Math.min(4, words.length - i); n >= 1 && !found; n -= 1) {
          const gram = words.slice(i, i + n);
          // A name written as one word in the index ("fine wood" is
          // Finewood) is tried along with the spaced title, before the
          // shorter n-gram ("wood") can claim the words.
          found = byTitle.get(gram.join(' ')) ?? (n >= 2 ? byCompact.get(gram.join('')) : undefined);
          length = n;
        }
        if (found) {
          out.push(linked(found));
          i += length;
        } else {
          i += 1;
        }
      }
      return out;
    },
  };
}

/**
 * A linker built once from `load`, on first use, and shared by every caller
 * that holds this source: a chat turn plans its queries and retrieves with
 * one. The app passes the cached index the wiki search serves
 * (`getSearchIndexData`), scripts the database's (`getSearchIndex`).
 *
 * Never rejects. A failed load links nothing — the answer goes ahead as it
 * would have without — and is said once, rather than retried by every step
 * of the same turn.
 */
export function titleLinker(load: () => Promise<TitleIndexEntry[]>): LinkerSource {
  let linker: Promise<TitleLinker | null> | undefined;
  return () =>
    (linker ??= load()
      .then(createTitleLinker)
      .catch((error: unknown) => {
        logWarn('retrieve', 'the title index could not be read: names in the question are not linked', {
          error: describeError(error).message,
        });
        return null;
      }));
}

/**
 * Each thing an intent names, linked to its article or null, in the order the
 * question names them.
 *
 * The whole object is tried first, as one name. "Jack-o-turnip", "Pots and
 * Pans" and "estructuras de madera y hierro" are names with a conjunction in
 * them, and read as lists their parts name other articles — Turnip, Bread,
 * Iron — whose sections a pin would put at the head of the context. Only an
 * object no article answers to is a list.
 */
export function linkThings(intent: Intent, linker: TitleLinker): (LinkedTitle | null)[] {
  const whole = linker.link(intent.object);
  return whole ? [whole] : intent.phrases.map((phrase) => linker.link(phrase));
}

/** The articles an intent names, in the order the question names them, each once. */
export function linkIntent(intent: Intent, linker: TitleLinker): LinkedTitle[] {
  const out: LinkedTitle[] = [];
  for (const hit of linkThings(intent, linker)) {
    if (hit && !out.some((title) => title.slug === hit.slug)) out.push(hit);
  }
  return out;
}

/**
 * The articles whose section a question may pin, best first: the ones the
 * question names, then — for a uses question — titles named by the queries a
 * model rewrote it into. A German question names "Zinn", which nothing links,
 * while its rewrite says "Tin crafting recipes": the rewrite is wrong about
 * what is asked, but right about the thing.
 *
 * A model's queries only, which the caller passes as `rewrites`. Queries made
 * from the question itself (`deterministicQueries`) name nothing it does not,
 * except on a follow-up, where the previous question is folded in: what that
 * one named is not what is asked now, and pinned, its lists went to the head
 * of the context ("¿Y qué puedo hacer con el cobre?" after a question about
 * fine wood pinned Finewood's Usage second). A rewrite that fell back to the
 * question adds nothing either.
 *
 * More than `MAX_PINNED_PAGES` may come back: only articles that have the
 * section count, and only the database knows which do.
 */
export function pinCandidates(
  intent: Intent,
  question: string,
  rewrites: readonly string[],
  linker: TitleLinker,
): LinkedTitle[] {
  const out = linkIntent(intent, linker);
  if (intent.kind !== 'uses') return out;
  const asked = question.trim();
  for (const query of rewrites) {
    if (query.trim() === asked) continue;
    for (const title of linker.titlesIn(query)) {
      if (!out.some((t) => t.slug === title.slug)) out.push(title);
    }
  }
  return out;
}
