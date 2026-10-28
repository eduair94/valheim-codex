-- Recipes as the ingest reads them from each page, and the recipe graph it
-- assembles from all of them.
--
-- An article is stored as a document to read, and that document has already
-- let go of what a crafting planner needs: the links that say which item a
-- material is, the "Crafts 20" a batch of nails yields, and every infobox
-- after a page's first, where the mead bases, the cooked meats and the armor
-- pieces are described. So the ingest reads recipes from the same HTML it
-- parses the article from, with an extractor of its own
-- (src/lib/wiki/recipes.ts), and keeps what it read here, one row per page.
--
-- `recipes_version` is the RECIPES_VERSION of the extractor that read the
-- page, and `revid` the revision it read. Comparing them with the extractor
-- and the wiki lets a run read again exactly the pages whose recipes are
-- missing, read by an older extractor or from an older revision, without
-- re-deriving their articles: a re-derived article marks its Spanish
-- translation stale, and translating again is paid for. A page with no recipe
-- gets a row too, so that it is not fetched again on every run to find that
-- out once more.
--
-- `updated_at` is when the page's recipes last changed, not when they were
-- last written: most edits to a page leave its recipes alone.
CREATE TABLE IF NOT EXISTS page_recipes (
  page_key        text        PRIMARY KEY REFERENCES pages(key) ON DELETE CASCADE,
  recipes_version integer     NOT NULL,
  revid           integer     NOT NULL,
  data            jsonb       NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

--> statement-breakpoint
-- The recipe graph: every craftable thing, the cost of each of its levels and
-- what it is used in, assembled from all of page_recipes at the end of a run
-- (src/lib/craft/assemble.ts), with the report of what the assembly could not
-- resolve or found the wiki contradicting itself about.
--
-- `version` is a hash of the graph's content, so assembling the same recipes
-- twice stores one row. The newest row by `built_at`, of the shape a server
-- reads, is the one it serves, and the two before it are kept: a run that
-- stops before its graph is written leaves readers on the previous one, and
-- a graph that turns out wrong can be set aside by deleting its row. A row is
-- written by one statement, whole or not at all, because Neon's HTTP driver
-- has no transactions.
--
-- `shape` is the graph's `v`. A server reads only the shape it knows, and a
-- newer ingest can store graphs of a newer shape before the server that
-- reads them is deployed, so the three kept are counted per shape: a write
-- makes room only among graphs of its own shape, and the older server goes
-- on serving the newest graph it understands. A shape no server reads any
-- more keeps its last three until they are deleted by hand. It has a column
-- of its own so that choosing a graph never decompresses one to look inside.
--
-- `basis` is a fingerprint of page_recipes as the assembly found it: every
-- page's recipes and the revision they were read from (`getRecipeBasis`,
-- src/lib/db/recipe-repo.ts). A run that stored new recipes and stopped
-- before assembling them, or whose assembly failed, leaves a graph whose
-- basis page_recipes no longer matches; the next run compares the two and
-- assembles a new graph, even when it finds nothing new on the wiki.
--
-- A whole graph is a few hundred kilobytes of JSON; Postgres compresses a
-- jsonb value that size out of line on its own (TOAST).
CREATE TABLE IF NOT EXISTS recipe_graph (
  version         text        PRIMARY KEY,
  built_at        timestamptz NOT NULL DEFAULT now(),
  recipes_version integer     NOT NULL,
  shape           integer     NOT NULL,
  basis           text        NOT NULL,
  graph           jsonb       NOT NULL,
  report          jsonb       NOT NULL
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS recipe_graph_built_idx ON recipe_graph (built_at DESC);

--> statement-breakpoint
-- The app's least-privilege role (scripts/create-app-role.ts) reads the graph
-- to serve item pages and the planner; only the ingest writes it, with the
-- owner credential. page_recipes is the ingest's own working copy, which the
-- app never reads, so it gets nothing.
--
-- A role that already exists, as production's does, is granted the graph
-- here: the alternative, re-running `pnpm db:app-role`, also rotates the
-- role's password, which then has to reach the deployment. A database set up
-- from scratch runs this before that script creates the role, so there the
-- role gets the table only if the script's READ_ONLY list names recipe_graph
-- too. A database without the role (PGlite, a deployment that connects as the
-- owner) skips this.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'valheim_app') THEN
    GRANT SELECT ON TABLE recipe_graph TO valheim_app;
  END IF;
END
$$;
