-- Weight the full-text vector by field.
--
-- Previously the title, the section path and the body were concatenated into
-- one unweighted tsvector, which made an article's own name worth exactly as
-- much as a passing mention. The effect was severe: "iron sword crafting
-- materials" retrieved the *Iron* article — whose "Usage > Crafting" section
-- lists dozens of iron items, so it matches "iron" many times — above the
-- *Iron Sword* article that actually answers the question.
--
-- Postgres' default ts_rank weights are {D, C, B, A} = {0.1, 0.2, 0.4, 1.0},
-- so labelling the title 'A' and the body 'D' makes a title hit worth ten body
-- hits. That is the right ratio here: on a wiki, the title states what the
-- article is about, and a question usually names it.

ALTER TABLE chunks DROP COLUMN IF EXISTS fts;

--> statement-breakpoint
ALTER TABLE chunks ADD COLUMN fts tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(section_path, '')), 'B') ||
  setweight(to_tsvector('simple', coalesce(content, '')), 'D')
) STORED;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chunks_fts_idx ON chunks USING GIN (fts);
