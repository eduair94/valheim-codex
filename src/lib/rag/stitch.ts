import { sql, type SQL } from 'drizzle-orm';
import { rawQuery, type Db } from '@/lib/db/create-db';
import { describeError, logWarn } from '@/lib/log';
import type { IntentKind } from './intent';
import type { RetrievedChunk, ScoredChunk } from './retrieve';

/**
 * Whole sections instead of fragments.
 *
 * The chunker splits a section at its subheadings, so a Usage section reaches
 * retrieval as one tiny chunk per kind of use: "Tin › Usage › Building" is
 * "Cauldron, Mead ketill" (11 tokens), "Tin › Usage › Crafting" is "Bronze,
 * Butcher knife". 175 of the 220 articles with a Usage section split it, and
 * 204 of those 267 subsection chunks are under 40 tokens. Each competes for a
 * place on its own and the one whose label matches the query wins: asked what
 * tin is for, the context held the Crafting half, and the Building half sat at
 * fused rank 11.
 *
 * So once ranking has chosen, a chunk that is part of a small section brings
 * the rest of the section with it — its siblings on the same page, read in one
 * query — as one excerpt in document order. Merging the chunks at ingest was
 * measured as well and lost: it put 47 of the lab's 54 target chunks in the
 * context against stitching's 49, and took the golden set's MRR from 0.797 to
 * 0.764, where stitching after ranking leaves the ranking exactly as it was.
 */

/**
 * Largest section folded into one excerpt, in stored tokens. Of the 75 Usage
 * sections split into two chunks or more, only Wood's (538) and Honey's (532)
 * are larger. A section that size is a catalogue, and pulling all of it in for
 * one line of it would crowd out the other excerpts.
 */
export const FAMILY_MAX_TOKENS = 450;

/**
 * Most that stitching may add to one context. Measured: about 40 tokens on
 * average for a uses question and 75 (7%) on the golden set, never more than
 * about 250, so this only bounds a pathological question.
 */
export const STITCH_EXTRA_TOKENS = 1200;

/** The `kind` of an excerpt made of several chunks. */
export const STITCHED_KIND = 'stitched';

/** What a text costs in the context, counted the way the retrieval budget counts it. */
export function contextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** One chunk of a section, as the section queries read it. */
export type SectionMember = Pick<RetrievedChunk, 'id' | 'sectionPath' | 'kind' | 'content'> & {
  /** As stored: the chunker's estimate, which the section limit is measured in. */
  tokenCount: number;
};

/** A pinned article's chunk: one of the rows of the section its question asks for. */
export type PinnedRow = RetrievedChunk & { tokenCount: number };

/**
 * The sections a chunk may be completed into, widest first: its top-level
 * section, and, for a chunk three levels down or more, its direct parent too
 * for when the whole is too large. A lead has none: it is part of no section.
 */
export function anchorsFor(sectionPath: string): string[] {
  if (!sectionPath) return [];
  const parts = sectionPath.split(' > ');
  return parts.length >= 3 ? [parts[0]!, parts.slice(0, -1).join(' > ')] : [parts[0]!];
}

/** The key `fetchFamilies` files a page's section under. */
export function familyKey(pageKey: string, anchor: string): string {
  return `${pageKey}\n${anchor}`;
}

/**
 * A Postgres `text[]` literal: one bound parameter however long the list.
 * The same encoding as `wiki-repo.ts`, where a list of slugs is read this way.
 */
export function textArray(values: readonly string[]): SQL {
  const literal = `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
  return sql`${literal}::text[]`;
}

type FamilyRow = {
  page_key: string;
  anchor: string;
  id: string;
  section_path: string;
  kind: string;
  content: string;
  token_count: number;
};

/**
 * Every chunk under each (page, section) pair, in document order, in one
 * round trip.
 *
 * Whole headings only: "Usage" and "Usage > Building", never "Usage tips" or
 * "Usages". The `page_key = ANY` guard is the same condition the join already
 * makes, said where the planner can use the page index with it: without it the
 * query scanned every chunk (33 ms on PGlite against 1.5 ms) for the same
 * rows. The ordinal is the number at the end of the chunk id, compared as a
 * number, so a page's tenth chunk follows its ninth.
 */
export async function fetchFamilies(
  db: Db,
  keys: readonly { pageKey: string; anchor: string }[],
): Promise<Map<string, SectionMember[]>> {
  const families = new Map<string, SectionMember[]>();
  if (keys.length === 0) return families;
  const pageKeys = keys.map((key) => key.pageKey);
  const rows = await rawQuery<FamilyRow>(
    db,
    sql`
      SELECT c.page_key, f.anchor, c.id, c.section_path, c.kind, c.content, c.token_count
      FROM chunks c
      JOIN unnest(${textArray(pageKeys)}, ${textArray(keys.map((key) => key.anchor))}) AS f(page_key, anchor)
        ON f.page_key = c.page_key
       AND (c.section_path = f.anchor OR starts_with(c.section_path, f.anchor || ' > '))
      WHERE c.page_key = ANY(${textArray(pageKeys)})
        AND c.kind <> 'infobox'
      ORDER BY c.page_key, f.anchor, split_part(c.id, ':', 4)::int
    `,
  );
  for (const row of rows) {
    const key = familyKey(row.page_key, row.anchor);
    const members = families.get(key) ?? [];
    members.push({
      id: row.id,
      sectionPath: row.section_path,
      kind: row.kind,
      content: row.content,
      tokenCount: Number(row.token_count),
    });
    families.set(key, members);
  }
  return families;
}

/** A chunk's text without its breadcrumb line, which the excerpt's own heading replaces. */
function bodyOf(content: string): string {
  const newline = content.indexOf('\n');
  return newline === -1 ? '' : content.slice(newline + 1).trim();
}

/**
 * A pure list of names on one line: "Building: Cauldron, Mead ketill".
 *
 * Pure means short lines, none of them ending or containing a sentence. On
 * lines of their own under a label, the names of a short list read as
 * headings: below "Tin › Usage › Crafting", "Bronze" above "Butcher knife"
 * looks like a Bronze section holding a knife, and an answer put the knife
 * under bronze. Two things keep a list on its lines, though. A blank line
 * separates groups whose first line is a heading (Deer Hide's uses come by
 * biome, "Meadows" and then what it makes there), and one line would make
 * those headings into items. A name with a comma of its own ("Blue, red and
 * white banner") would run into its neighbours.
 */
function oneLine(text: string): string {
  if (/\n\s*\n/.test(text)) return text;
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const pure = lines.every(
    (line) => line.length <= 48 && !line.includes(',') && !/[.;:!?]$/.test(line) && !/[.!?]\s/.test(line),
  );
  return pure ? lines.join(', ') : text;
}

/** A member's place under the excerpt's heading: "Building", "Crafting › Tools", or nothing for the section itself. */
function labelBelow(anchor: string, sectionPath: string): string {
  if (sectionPath === anchor) return '';
  const below = anchor && sectionPath.startsWith(`${anchor} > `) ? sectionPath.slice(anchor.length + 3) : sectionPath;
  return below.split(' > ').join(' › ');
}

/**
 * A section as one excerpt: the breadcrumb a chunk would have, then each
 * member in document order, labelled with its path below the section.
 */
export function renderSection(title: string, anchor: string, members: readonly SectionMember[]): string {
  const parts: string[] = [];
  for (const member of members) {
    const body = bodyOf(member.content);
    if (!body) continue;
    const label = labelBelow(anchor, member.sectionPath);
    const text = oneLine(body);
    parts.push(!label ? text : text.includes('\n') ? `${label}:\n${text}` : `${label}: ${text}`);
  }
  const crumb = [title, ...(anchor ? anchor.split(' > ') : [])].join(' › ');
  // Labelled one-liners read as one list of lists; a part over several lines
  // needs a blank line before the next label, or the label reads as its last item.
  const separator = parts.some((part) => part.includes('\n')) ? '\n\n' : '\n';
  return `${crumb}\n${parts.join(separator)}`;
}

/** Without its stored token count, which the context does not carry. */
function asScored(row: PinnedRow, ranks: Record<string, number>): ScoredChunk {
  const { tokenCount: _tokenCount, ...chunk } = row;
  return { ...chunk, score: 0, ranks };
}

/**
 * A pinned article's section as excerpts: the whole of it as one when it is
 * small enough, otherwise its first two chunks, so a catalogue such as Wood's
 * Usage does not take the context over. A uses section is headed by its own
 * heading ("Tin › Usage"); a where answer spans the lead and Availability, so
 * it is headed by the title alone and each part by its section.
 *
 * Pinned excerpts are not ranked: `score` is 0 and `ranks` says which pin
 * this was, first named first.
 */
export function pinnedExcerpts(rows: readonly PinnedRow[], kind: IntentKind, pin: number): ScoredChunk[] {
  const ranks = { pinned: pin };
  const total = rows.reduce((sum, row) => sum + row.tokenCount, 0);
  if (rows.length === 1 || total > FAMILY_MAX_TOKENS) return rows.slice(0, 2).map((row) => asScored(row, ranks));

  const first = rows[0]!;
  const anchor = kind === 'uses' ? first.sectionPath.split(' > ')[0]! : '';
  return [
    {
      ...asScored(first, ranks),
      ids: rows.map((row) => row.id),
      sectionPath: anchor,
      kind: STITCHED_KIND,
      content: renderSection(first.title, anchor, rows),
    },
  ];
}

export type StitchLimits = {
  /** The context's ceiling: stitching never takes the context past it. */
  maxContextTokens: number;
  familyMaxTokens?: number;
  extraTokens?: number;
  /**
   * Chunks already final, the pinned ones: left as they are, and never pulled
   * into another excerpt, which would show them twice.
   */
  keep?: ReadonlySet<string>;
};

function stitchable(chunk: ScoredChunk, keep: ReadonlySet<string>): chunk is ScoredChunk & { pageKey: string } {
  return Boolean(chunk.pageKey) && chunk.kind !== 'infobox' && !chunk.ids && !keep.has(chunk.id) && chunk.sectionPath !== '';
}

type Section = { anchor: string; members: SectionMember[]; content: string };

/**
 * Completes each selected chunk's section, given the sections' chunks
 * (`fetchFamilies`).
 *
 * In rank order, each chunk tries its section and then, three levels down,
 * its parent's. A section is taken when it has another member, fits
 * `familyMaxTokens`, and its cost — the excerpt, less the members the context
 * already holds — fits both the stitching allowance and the context's
 * ceiling. Otherwise the chunk stays as it was.
 *
 * The excerpt goes where its best-ranked member was, with that member's score
 * and ranks; `id` is the section's first chunk and `ids` all of them. Other
 * selected members are not repeated: their places are freed, not refilled,
 * so the context only ever gets shorter in excerpts.
 */
export function stitch(
  selected: readonly ScoredChunk[],
  families: ReadonlyMap<string, readonly SectionMember[]>,
  limits: StitchLimits,
): ScoredChunk[] {
  const { maxContextTokens, familyMaxTokens = FAMILY_MAX_TOKENS, extraTokens = STITCH_EXTRA_TOKENS } = limits;
  const keep = limits.keep ?? new Set<string>();
  const inContext = new Map(selected.map((chunk) => [chunk.id, chunk]));
  const sectionOf = new Map<string, Section>();
  let used = selected.reduce((sum, chunk) => sum + contextTokens(chunk.content), 0);
  let extra = 0;

  for (const chunk of selected) {
    if (!stitchable(chunk, keep) || sectionOf.has(chunk.id)) continue;
    for (const anchor of anchorsFor(chunk.sectionPath)) {
      const members = (families.get(familyKey(chunk.pageKey, anchor)) ?? []).filter((member) => !keep.has(member.id));
      if (members.length < 2) continue;
      // A chunk belongs to one excerpt at most.
      if (members.some((member) => sectionOf.has(member.id))) continue;
      if (members.reduce((sum, member) => sum + member.tokenCount, 0) > familyMaxTokens) continue;

      const content = renderSection(chunk.title, anchor, members);
      const replaced = members.reduce((sum, member) => {
        const held = inContext.get(member.id);
        return held ? sum + contextTokens(held.content) : sum;
      }, 0);
      const cost = contextTokens(content) - replaced;
      if (extra + cost > extraTokens || used + cost > maxContextTokens) continue;

      extra += cost;
      used += cost;
      const section: Section = { anchor, members: [...members], content };
      for (const member of members) sectionOf.set(member.id, section);
      break;
    }
  }
  if (sectionOf.size === 0) return [...selected];

  const out: ScoredChunk[] = [];
  const placed = new Set<Section>();
  for (const chunk of selected) {
    const section = sectionOf.get(chunk.id);
    if (!section) {
      out.push(chunk);
      continue;
    }
    if (placed.has(section)) continue;
    placed.add(section);
    out.push({
      ...chunk,
      id: section.members[0]!.id,
      ids: section.members.map((member) => member.id),
      sectionPath: section.anchor,
      kind: STITCHED_KIND,
      content: section.content,
    });
  }
  return out;
}

/**
 * `stitch` with the sections read from the database: one more round trip
 * after ranking, and none when no selected chunk is part of a section.
 *
 * Completing a section makes a good context better; it is never what makes
 * one possible. A failed read leaves the chunks as ranked and says so.
 */
export async function stitchSections(db: Db, selected: ScoredChunk[], limits: StitchLimits): Promise<ScoredChunk[]> {
  const keep = limits.keep ?? new Set<string>();
  const keys = new Map<string, { pageKey: string; anchor: string }>();
  for (const chunk of selected) {
    if (!stitchable(chunk, keep)) continue;
    for (const anchor of anchorsFor(chunk.sectionPath)) {
      keys.set(familyKey(chunk.pageKey, anchor), { pageKey: chunk.pageKey, anchor });
    }
  }
  if (keys.size === 0) return selected;

  let families: Map<string, SectionMember[]>;
  try {
    families = await fetchFamilies(db, [...keys.values()]);
  } catch (error) {
    logWarn('retrieve', 'could not read the sections of the selected chunks: answering with the chunks as ranked', {
      error: describeError(error).message,
    });
    return selected;
  }
  return stitch(selected, families, limits);
}
