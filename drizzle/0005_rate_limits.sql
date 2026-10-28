-- Fixed-window counters for everything that is not the login form.
--
-- Signing in with your own Gemini key or with Puter means the model is paid
-- for by the reader, but retrieval is not: every question still runs local
-- embeddings and several queries on this server. Without a ceiling, the
-- retrieval endpoint would be a free search API for anyone. These counters are
-- that ceiling — per signed-in identity, per client address and globally per
-- day — and they also cap the operator-paid paths (password chat, public
-- translation warm-ups).
--
-- `key` names the bucket and its window length (`chat:ip:203.0.113.7|60000`),
-- so a minute bucket and a day bucket for the same subject never share a row
-- even when both windows start at the same instant.
CREATE TABLE IF NOT EXISTS rate_limits (
  key          text        NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

--> statement-breakpoint
-- Pruning deletes by age across all keys.
CREATE INDEX IF NOT EXISTS rate_limits_window_idx
  ON rate_limits (window_start);

--> statement-breakpoint
-- The app's least-privilege role (scripts/create-app-role.ts) counts in this
-- table on every chat question, guest sign-in and translation request, and has
-- no right to create it, so the grant belongs with the table. Re-running
-- `pnpm db:app-role` would also do it, but it rotates the role's password,
-- which then has to reach the deployment. A database without the role
-- (PGlite, a deployment that connects as the owner) skips this.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'valheim_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE rate_limits TO valheim_app;
  END IF;
END
$$;
