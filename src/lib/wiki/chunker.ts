import type { ParsedPage, WikiChunk } from './types';
import { infoboxTabs, renderInfobox } from './infobox';
import { estimateTokens, hashContent } from './text';

/** Upper bound for a chunk, in estimated tokens. */
export const MAX_CHUNK_TOKENS = 400;
/** Below this a chunk carries too little signal to be worth an embedding. */
export const MIN_PROSE_TOKENS = 9;
/** Paragraphs repeated from the previous chunk when splitting long prose. */
const OVERLAP_PARAGRAPHS = 1;

export type ChunkOptions = {
  sourceRank: number;
};

/**
 * Turns a parsed page into retrievable chunks.
 *
 * Three kinds, deliberately kept apart:
 *   - `infobox` — one per upgrade level, each repeating the shared fields so a
 *     question about level 3 retrieves a chunk that answers on its own;
 *   - `table`   — split on row boundaries only, never mid-row;
 *   - `prose`   — paragraph-split with overlap once a section is too long.
 */
export function chunkPage(parsed: ParsedPage, options: ChunkOptions): WikiChunk[] {
  const { page, infobox, sections } = parsed;
  const pageKey = `${page.source}:${page.pageId}`;
  const chunks: WikiChunk[] = [];

  const push = (kind: WikiChunk['kind'], sectionPath: string, body: string): void => {
    const content = withContext(page.title, sectionPath, body);
    const tokenCount = estimateTokens(content);
    if (kind === 'prose' && tokenCount < MIN_PROSE_TOKENS) return;
    const ordinal = chunks.length;
    chunks.push({
      id: `${page.source}:${page.pageId}:${kind}:${ordinal}`,
      pageKey,
      source: page.source,
      sourceRank: options.sourceRank,
      title: page.title,
      url: page.url,
      sectionPath,
      kind,
      content,
      tokenCount,
      contentHash: hashContent(content),
    });
  };

  if (infobox) {
    const tabs = infoboxTabs(infobox);
    if (tabs.length === 0) {
      push('infobox', '', stripTitleLine(renderInfobox(infobox), page.title));
    } else {
      for (const tab of tabs) {
        const rendered = stripTitleLine(renderInfobox(infobox, { tab }), page.title);
        const heading = /^\d+$/.test(tab) ? `Level ${tab}` : tab;
        push('infobox', heading, rendered);
      }
    }
  }

  for (const section of sections) {
    for (const body of splitProse(section.text)) {
      push('prose', section.path, body);
    }
    for (const table of section.tables) {
      for (const part of splitTable(table)) {
        push('table', section.path, part);
      }
    }
  }

  return chunks;
}

/**
 * Prefixes the breadcrumb onto the body.
 *
 * The prefix is embedded along with the text: it is the cheapest possible form
 * of contextual retrieval, and it means a chunk pulled out of the index still
 * says which article and section it came from.
 */
function withContext(title: string, sectionPath: string, body: string): string {
  const crumb = [title, ...sectionPath.split(' > ').filter(Boolean)].join(' › ');
  return `${crumb}\n${body}`.trim();
}

/** `renderInfobox` leads with the title; the context prefix already has it. */
function stripTitleLine(rendered: string, title: string): string {
  const [first, ...rest] = rendered.split('\n');
  if (first !== undefined && first.trim().toLowerCase() === title.trim().toLowerCase()) {
    return rest.join('\n').trim();
  }
  return rendered.trim();
}

/**
 * Splits a section into chunks on paragraph boundaries, repeating the last
 * paragraph of each chunk at the head of the next so a sentence pair split
 * across the boundary is still retrievable as a unit.
 */
function splitProse(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (estimateTokens(trimmed) <= MAX_CHUNK_TOKENS) return [trimmed];

  const paragraphs = trimmed.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const out: string[] = [];
  let current: string[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    out.push(current.join('\n\n'));
    current = current.slice(-OVERLAP_PARAGRAPHS);
  };

  for (const paragraph of paragraphs) {
    const candidate = [...current, paragraph].join('\n\n');
    if (current.length > 0 && estimateTokens(candidate) > MAX_CHUNK_TOKENS) {
      flush();
      current = [...current, paragraph];
    } else {
      current.push(paragraph);
    }
  }
  if (current.length > 0) out.push(current.join('\n\n'));

  // The overlap tail can make the final chunk a duplicate of the previous one.
  return out.filter((chunk, i) => i === 0 || chunk !== out[i - 1]);
}

/**
 * Splits a flattened table on row boundaries, repeating the caption line so
 * every part keeps its subject. A single row is never divided.
 */
function splitTable(table: string): string[] {
  const lines = table.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  if (estimateTokens(table) <= MAX_CHUNK_TOKENS) return [table];

  // Only treat the first line as a caption if it is not itself a data row.
  const caption = lines[0]!.includes(':') ? '' : lines[0]!;
  const rows = caption ? lines.slice(1) : lines;

  const out: string[] = [];
  let current: string[] = [];
  for (const row of rows) {
    const candidate = [caption, ...current, row].filter(Boolean).join('\n');
    if (current.length > 0 && estimateTokens(candidate) > MAX_CHUNK_TOKENS) {
      out.push([caption, ...current].filter(Boolean).join('\n'));
      current = [row];
    } else {
      current.push(row);
    }
  }
  if (current.length > 0) out.push([caption, ...current].filter(Boolean).join('\n'));
  return out;
}
