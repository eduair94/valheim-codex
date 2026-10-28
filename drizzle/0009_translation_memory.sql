-- What every string of an article has been translated to, keyed by its
-- English text: the article's translation memory.
--
-- `article_translations` holds the page a reader is shown, and anything stored
-- there is shown. Translation work also has to be kept when it is not ready to
-- show: a long article is translated over several calls, and a call where one
-- batch of forty strings failed used to throw away every batch that worked and
-- pay for all of them again on the next view. So progress lives here, and the
-- reader's copy is written only once at least half of the article is in the
-- target language.
--
-- Keyed by English text rather than by position, so the memory survives a
-- re-index: an article that changed pays only for the strings that changed,
-- and one rewritten without changing (a full re-ingest bumps every
-- `updated_at`) costs no model call at all to refresh.
--
-- `pending` is how many distinct strings are still in English. More than zero
-- with a translation present means a partial translation, which the bulk
-- script and the reader's endpoint pick up and complete.
--
-- `failures` counts, per English string, the attempts that came back
-- unusable. A string no model will translate would otherwise be paid for on
-- every call that tries to finish its article; the endpoint stops sending it
-- after a few attempts and leaves it to the bulk script.
--
-- `lease_holder` / `lease_until`: whoever is translating the article right now
-- (the reader's endpoint or a script, on any machine). One writer per article
-- at a time, so two of them never pay for the same strings or save over each
-- other's progress. A lease that is not renewed expires on its own.
--
-- The app creates this table on first use if its role may (same DDL), since
-- deploys do not run migrations; this file makes it explicit.
CREATE TABLE IF NOT EXISTS article_translation_memory (
  page_key     text        NOT NULL REFERENCES pages(key) ON DELETE CASCADE,
  lang         text        NOT NULL,
  entries      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  failures     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  pending      integer     NOT NULL DEFAULT 0,
  lease_holder text,
  lease_until  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_key, lang)
);

--> statement-breakpoint
-- A table made by an earlier draft of this file lacks the last three columns.
ALTER TABLE article_translation_memory ADD COLUMN IF NOT EXISTS failures jsonb NOT NULL DEFAULT '{}'::jsonb;

--> statement-breakpoint
ALTER TABLE article_translation_memory ADD COLUMN IF NOT EXISTS lease_holder text;

--> statement-breakpoint
ALTER TABLE article_translation_memory ADD COLUMN IF NOT EXISTS lease_until timestamptz;

--> statement-breakpoint
-- The app's least-privilege role (scripts/create-app-role.ts) gets the table
-- here, because the alternative — re-running `pnpm db:app-role` — also
-- rotates that role's password, which then has to reach the deployment. A
-- database without the role (PGlite, a deployment that uses the owner) skips
-- this.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'valheim_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE article_translation_memory TO valheim_app;
  END IF;
END
$$;

--> statement-breakpoint
-- A translation's image captions, keyed by image URL.
--
-- Since parser version 1 a figure's caption travels with its image instead of
-- being repeated as a paragraph, and the reader shows the English article's
-- images, so a Spanish page would show every caption in English. NULL when the
-- translation has none, which is also how every translation stored before this
-- column reads.
ALTER TABLE article_translations ADD COLUMN IF NOT EXISTS captions jsonb;
