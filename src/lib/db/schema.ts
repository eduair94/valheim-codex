import { sql } from 'drizzle-orm';
import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core';

/** Dimensionality of the stored embeddings. Must match `EMBEDDING_DIMENSIONS` in src/lib/rag/embed.ts. */
export const EMBEDDING_DIMENSIONS = 768;

/**
 * `tsvector` has no first-class Drizzle type. It is only ever read through raw
 * SQL in the retrieval query, so a passthrough custom type is enough to make
 * the column visible to the schema.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

/** A wiki article, stored once per source, with the revision it was fetched at. */
export const pages = pgTable(
  'pages',
  {
    /** `${source}:${pageId}` — stable across renames. */
    key: text('key').primaryKey(),
    source: text('source').notNull(),
    pageId: integer('page_id').notNull(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    /** MediaWiki revision id; drives incremental re-indexing. */
    revid: integer('revid').notNull(),
    categories: jsonb('categories').$type<string[]>().notNull().default([]),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('pages_source_title_idx').on(t.source, t.title)],
);

/** A retrievable unit of text: one prose section, or one flattened table/infobox. */
export const chunks = pgTable(
  'chunks',
  {
    id: text('id').primaryKey(),
    pageKey: text('page_key')
      .notNull()
      .references(() => pages.key, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    /** 0 = preferred source, higher = penalised during fusion. */
    sourceRank: integer('source_rank').notNull().default(0),
    title: text('title').notNull(),
    url: text('url').notNull(),
    /** e.g. `Usage > Crafting`. Empty string for the lead section. */
    sectionPath: text('section_path').notNull().default(''),
    kind: text('kind').$type<'prose' | 'infobox' | 'table'>().notNull(),
    /** Text as embedded and as shown in citations, including its context prefix. */
    content: text('content').notNull(),
    tokenCount: integer('token_count').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    fts: tsvector('fts'),
    /** Cheap change-detection so unchanged chunks keep their embedding. */
    contentHash: text('content_hash').notNull(),
  },
  (t) => [
    index('chunks_page_key_idx').on(t.pageKey),
    index('chunks_content_hash_idx').on(t.contentHash),
  ],
);

/** One chat thread, scoped to a profile name chosen at login. */
export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    profile: text('profile').notNull(),
    title: text('title').notNull().default('Nueva conversación'),
    lang: text('lang').$type<'es' | 'en'>().notNull().default('es'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('conversations_profile_updated_idx').on(t.profile, t.updatedAt)],
);

export type Citation = {
  n: number;
  title: string;
  url: string;
  sectionPath: string;
  source: string;
  score: number;
  /**
   * In-app article slug. Null when the page has no reading document, in which
   * case the citation falls back to the original wiki URL.
   */
  slug?: string | null;
  /**
   * Lead image of the cited article, resolved server-side so an `[img:n]`
   * marker in an answer can never point at a URL the model invented.
   */
  image?: { url: string; alt: string } | null;
};

/** A single message. `parts` mirrors the AI SDK UIMessage part array. */
export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    parts: jsonb('parts').$type<unknown[]>().notNull(),
    citations: jsonb('citations').$type<Citation[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId, t.createdAt)],
);

/** Audit trail for ingest runs; also powers the in-app re-index panel. */
export const ingestRuns = pgTable('ingest_runs', {
  id: text('id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: text('status').$type<'running' | 'ok' | 'failed'>().notNull().default('running'),
  trigger: text('trigger').notNull().default('cli'),
  pagesSeen: integer('pages_seen').notNull().default(0),
  pagesChanged: integer('pages_changed').notNull().default(0),
  chunksWritten: integer('chunks_written').notNull().default(0),
  embeddingsComputed: integer('embeddings_computed').notNull().default(0),
  durationMs: real('duration_ms'),
  errors: jsonb('errors').$type<{ title: string; message: string }[]>().notNull().default([]),
});

/** Fixed-window brute-force protection for the shared password. */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    ip: text('ip').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.ip, t.windowStart] })],
);

/** Advisory lock rows: prevents two ingests running against one database. */
export const locks = pgTable('locks', {
  name: text('name').primaryKey(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  holder: text('holder').notNull(),
});

/**
 * A wiki page as something to read.
 *
 * `chunks` serves retrieval and this serves reading; both are built from one
 * parse during ingest. Keeping them apart means the reader can gain images and
 * structure without perturbing the index the chat searches.
 */
export const articles = pgTable(
  'articles',
  {
    pageKey: text('page_key')
      .primaryKey()
      .references(() => pages.key, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    url: text('url').notNull(),
    categories: jsonb('categories').$type<string[]>().notNull().default([]),
    lead: text('lead').notNull().default(''),
    blocks: jsonb('blocks').$type<unknown[]>().notNull().default([]),
    infobox: jsonb('infobox').$type<unknown>(),
    images: jsonb('images').$type<unknown[]>().notNull().default([]),
    facets: jsonb('facets').$type<Record<string, string>>().notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('articles_slug_idx').on(t.slug)],
);

/**
 * Index-level settings.
 *
 * Vectors produced by different embedding models are not comparable, so the
 * provider that built the index is recorded here and the ingest refuses to add
 * vectors from a different one.
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const schema = {
  pages,
  chunks,
  conversations,
  messages,
  ingestRuns,
  loginAttempts,
  locks,
  settings,
  articles,
};

/** Kept so `sql` stays imported for downstream raw-SQL helpers in this module. */
export const nowSql = sql`now()`;
