-- Wiki Valheim RAG — initial schema.
-- Hand-written rather than generated: it needs an extension, a generated
-- tsvector column and an HNSW index, none of which drizzle-kit emits cleanly.

CREATE EXTENSION IF NOT EXISTS vector;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS pages (
  key         text PRIMARY KEY,
  source      text NOT NULL,
  page_id     integer NOT NULL,
  title       text NOT NULL,
  url         text NOT NULL,
  revid       integer NOT NULL,
  categories  jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  indexed_at  timestamptz
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS pages_source_title_idx ON pages (source, title);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS chunks (
  id            text PRIMARY KEY,
  page_key      text NOT NULL REFERENCES pages(key) ON DELETE CASCADE,
  source        text NOT NULL,
  source_rank   integer NOT NULL DEFAULT 0,
  title         text NOT NULL,
  url           text NOT NULL,
  section_path  text NOT NULL DEFAULT '',
  kind          text NOT NULL,
  content       text NOT NULL,
  token_count   integer NOT NULL,
  embedding     vector(768),
  content_hash  text NOT NULL,
  -- 'simple' rather than 'english': Valheim proper nouns must not be stemmed
  -- (Surtlings -> surtl would break exact-name recall), and queries arrive in
  -- Spanish as well as English.
  fts tsvector GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(title, '') || ' ' || coalesce(section_path, '') || ' ' || coalesce(content, ''))
  ) STORED
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chunks_page_key_idx ON chunks (page_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chunks_content_hash_idx ON chunks (content_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chunks_fts_idx ON chunks USING GIN (fts);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS conversations (
  id         text PRIMARY KEY,
  profile    text NOT NULL,
  title      text NOT NULL DEFAULT 'Nueva conversación',
  lang       text NOT NULL DEFAULT 'es',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversations_profile_updated_idx
  ON conversations (profile, updated_at DESC);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS messages (
  id              text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL,
  parts           jsonb NOT NULL,
  citations       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, created_at);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ingest_runs (
  id                  text PRIMARY KEY,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  status              text NOT NULL DEFAULT 'running',
  trigger             text NOT NULL DEFAULT 'cli',
  pages_seen          integer NOT NULL DEFAULT 0,
  pages_changed       integer NOT NULL DEFAULT 0,
  chunks_written      integer NOT NULL DEFAULT 0,
  embeddings_computed integer NOT NULL DEFAULT 0,
  duration_ms         real,
  errors              jsonb NOT NULL DEFAULT '[]'::jsonb
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS login_attempts (
  ip           text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, window_start)
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS locks (
  name        text PRIMARY KEY,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  holder      text NOT NULL
);
