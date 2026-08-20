-- Key/value settings that the index itself depends on.
--
-- The immediate need is the embedding provider: vectors from two different
-- models are not comparable, so an index built with one and queried with
-- another degrades silently rather than failing. Recording it lets the ingest
-- refuse the mix.

CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
