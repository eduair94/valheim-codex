-- The reading representation of a wiki page.
--
-- Separate from `chunks` on purpose. Chunks exist to be retrieved: self-
-- contained text with an embedding. Articles exist to be read: ordered blocks,
-- a structured infobox, images, and facets. Serving both from one shape gave
-- chunks that read badly and a page that searched badly.

CREATE TABLE IF NOT EXISTS articles (
  page_key   text PRIMARY KEY REFERENCES pages(key) ON DELETE CASCADE,
  source     text NOT NULL,
  title      text NOT NULL,
  slug       text NOT NULL,
  url        text NOT NULL,
  categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  lead       text NOT NULL DEFAULT '',
  blocks     jsonb NOT NULL DEFAULT '[]'::jsonb,
  infobox    jsonb,
  images     jsonb NOT NULL DEFAULT '[]'::jsonb,
  facets     jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS articles_slug_idx ON articles (slug);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS articles_title_idx ON articles (lower(title));
--> statement-breakpoint
-- Browsing is "every article in this category" and "every article from this
-- biome"; both are containment tests, which is what jsonb_path_ops indexes.
CREATE INDEX IF NOT EXISTS articles_categories_idx ON articles USING GIN (categories jsonb_path_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS articles_facets_idx ON articles USING GIN (facets jsonb_path_ops);
