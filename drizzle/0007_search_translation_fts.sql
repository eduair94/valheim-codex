-- A full-text index over the translations' titles and leads.
--
-- The wiki's search reads the stored Spanish titles and leads as well as the
-- English chunks, so a word only the Spanish says ("cardo" for Thistle) still
-- finds its article. Without an index that meant building the text-search
-- vector of every translation, about 850 of them, on every Spanish search:
-- 40 ms of PGlite per query on a public route, before the search had matched
-- anything.
--
-- An expression index rather than a stored column: nothing about the table
-- changes, no row is rewritten, and a database without it still answers the
-- same query, only more slowly. The expression must stay exactly the one the
-- search writes (TRANSLATION_DOC in src/lib/db/wiki-repo.ts), or the planner
-- will not use it. `simple`, like `chunks.fts`, so Valheim's proper nouns are
-- kept as they are spelled.
--
-- The app creates the same index on first use if its role may
-- (`ensureSearchIndexes`), since deploys do not run migrations.
CREATE INDEX IF NOT EXISTS article_translations_search_idx
  ON article_translations
  USING GIN ((setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', lead), 'B')));
