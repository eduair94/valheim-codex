import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PARSER_OUTPUT_HASH, PARSER_VERSION } from '@/lib/ingest/version';
import { extractArticle } from '@/lib/wiki/article';
import { chunkPage } from '@/lib/wiki/chunker';
import { extractSections } from '@/lib/wiki/html';
import { extractInfobox } from '@/lib/wiki/infobox';

/**
 * Everything the ingest derives from each saved page — the reading document,
 * the retrieval sections, the infobox and the chunks — hashed together.
 *
 * Stored articles record the parser version that built them, and only a new
 * version gets them rebuilt. A parser edit that changes the output without a
 * bump therefore never reaches the pages nobody edits afterwards, which is
 * how the August 2026 maths fix missed the 14 articles it was written for.
 */
async function parserOutputHash(): Promise<string> {
  const hash = createHash('sha256');
  const files = (await readdir('tests/fixtures')).filter((name) => name.endsWith('.json')).sort();
  for (const file of files) {
    const raw = JSON.parse(await readFile(`tests/fixtures/${file}`, 'utf8')) as { parse: { text: string } };
    const html = raw.parse.text;
    const page = { source: 'fandom', pageId: 1, title: file, url: 'https://example.test/x', revid: 1, categories: [], html };
    const infobox = extractInfobox(html);
    const sections = await extractSections(html);
    const chunks = chunkPage({ page, infobox, sections }, { sourceRank: 0 });
    hash.update(JSON.stringify({ file, article: await extractArticle(html), sections, infobox, chunks }));
  }
  return hash.digest('hex').slice(0, 16);
}

describe('PARSER_VERSION', () => {
  it('moves with what the parser builds', async () => {
    const actual = await parserOutputHash();
    expect(
      actual,
      `The parser's output over tests/fixtures changed. If the parser changed, bump PARSER_VERSION ` +
        `(now ${PARSER_VERSION}) in src/lib/ingest/version.ts, so the next \`pnpm ingest --reparse\` ` +
        `rebuilds what the old one stored. Then set PARSER_OUTPUT_HASH there to '${actual}' (alone, ` +
        `if only a fixture changed).`,
    ).toBe(PARSER_OUTPUT_HASH);
  });
});
