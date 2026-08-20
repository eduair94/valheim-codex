import { sql } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { toVectorLiteral } from '@/lib/rag/embed';
import { fakeEmbed } from './fake-embed';

export type SeedChunk = {
  id: string;
  title: string;
  content: string;
  sectionPath?: string;
  kind?: 'prose' | 'infobox' | 'table';
  source?: string;
  sourceRank?: number;
  /** Omit to derive one from the content with the fake embedder. */
  embedding?: number[];
};

/** Inserts chunks (and the pages they need) into a test database. */
export async function seedChunks(db: Db, chunks: SeedChunk[]): Promise<void> {
  const sources = new Map<string, Set<string>>();
  for (const c of chunks) {
    const source = c.source ?? 'fandom';
    if (!sources.has(source)) sources.set(source, new Set());
    sources.get(source)!.add(c.title);
  }

  let pageId = 1;
  const pageKeys = new Map<string, string>();
  for (const [source, titles] of sources) {
    for (const title of titles) {
      const key = `${source}:${pageId}`;
      pageKeys.set(`${source}::${title}`, key);
      await db.execute(sql`
        INSERT INTO pages (key, source, page_id, title, url, revid)
        VALUES (${key}, ${source}, ${pageId}, ${title},
                ${`https://example.test/wiki/${encodeURIComponent(title)}`}, 1)
        ON CONFLICT (key) DO NOTHING
      `);
      pageId += 1;
    }
  }

  for (const c of chunks) {
    const source = c.source ?? 'fandom';
    const pageKey = pageKeys.get(`${source}::${c.title}`)!;
    const vector = toVectorLiteral(c.embedding ?? fakeEmbed(c.content));
    await db.execute(sql`
      INSERT INTO chunks (id, page_key, source, source_rank, title, url, section_path, kind,
                          content, token_count, content_hash, embedding)
      VALUES (${c.id}, ${pageKey}, ${source}, ${c.sourceRank ?? 0}, ${c.title},
              ${`https://example.test/wiki/${encodeURIComponent(c.title)}`},
              ${c.sectionPath ?? ''}, ${c.kind ?? 'prose'}, ${c.content},
              ${Math.ceil(c.content.length / 4)}, ${`h-${c.id}`}, ${vector}::vector)
    `);
  }
}
