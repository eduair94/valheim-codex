-- Machine translations of articles, cached permanently.
--
-- There is no Spanish Valheim wiki to point at: valheim.fandom.com/es,
-- valheim-es.fandom.com and es.valheim.fandom.com all answer 404, and
-- valheim.wiki.gg is still unreleased. So a Spanish reader gets a translation
-- or gets English, and the only question is who pays for it and how often.
--
-- Once per article, not once per reader. Translating the whole corpus up front
-- is millions of tokens and the free tiers this runs on allow tens of
-- thousands a day; translating on every view would spend that in an afternoon
-- and be slow every time. Translating on first view and keeping the result
-- means the cost is bounded by what people actually read, and the second
-- reader of an article waits for nothing.
--
-- `source_updated_at` is the article's `updated_at` at the moment of
-- translation. A re-index that changes the article makes the stored
-- translation stale, and comparing the two is how that is noticed rather than
-- silently serving a translation of text that no longer exists.
CREATE TABLE IF NOT EXISTS article_translations (
  page_key          text        NOT NULL REFERENCES pages(key) ON DELETE CASCADE,
  lang              text        NOT NULL,
  title             text        NOT NULL,
  lead              text        NOT NULL DEFAULT '',
  blocks            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  infobox           jsonb,
  model             text        NOT NULL,
  source_updated_at timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_key, lang)
);

--> statement-breakpoint
-- The reader looks translations up by slug, which lives on `articles`.
CREATE INDEX IF NOT EXISTS article_translations_lang_idx
  ON article_translations (lang);
