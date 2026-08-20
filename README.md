# Valheim Codex

A private Valheim wiki you can actually use on a phone, plus an assistant that
answers from it. Ask a question in Spanish or English and get an answer built
only from wiki text; or search, browse and compare the 1,027 articles directly.
Installable, and articles you have opened stay readable offline.

- **Next.js 16** (App Router) + React 19, deployed to Vercel
- **Gemini Flash** for answers; embeddings from Gemini or a local CPU model
- **Postgres + pgvector** — Neon in production, embedded PGlite for local dev and tests
- **Hybrid retrieval**: dense vectors + Postgres full-text, fused with Reciprocal Rank Fusion
- One shared password, per-person profiles for separate history
- **Mobile reader**: instant local search, data-first article pages, category
  and biome browsing, sortable comparison tables, installable with offline
  reading

---

## Quick start

```bash
pnpm install

# Generate credentials; paste the output into .env.local
pnpm auth:hash "your-password"

# Fill in .env.local (see .env.example for the full list)
#   GEMINI_API_KEY=...        from https://aistudio.google.com/apikey
#   APP_PASSWORD_HASH=...     from the command above
#   SESSION_SECRET=...        from the command above
#   WIKI_CONTACT=you@example.com
#   EMBEDDING_PROVIDER=local  see "Embeddings" below

pnpm ingest          # downloads and indexes the wiki (~20 min the first time)
pnpm dev             # http://localhost:3000
```

With no `DATABASE_URL`, the app runs against an embedded PGlite database under
`.data/pglite`. Nothing else to install, no Docker, no database service.

---

## How it works

### Ingest

```
MediaWiki API ──▶ rendered HTML ──▶ sections + infobox ──▶ chunks ──▶ embeddings ──▶ Postgres
```

1. `list=allpages` enumerates every article (about 1,000 in namespace 0).
2. `prop=revisions` reports current revision ids, 50 per request. Only pages
   whose revision changed are re-parsed — an ordinary re-index after a patch
   touches a handful of pages, not the whole wiki.
3. `action=parse` returns **rendered HTML**, not wikitext. The Valheim wiki
   leans on templates (`{{item link|…}}`, `{{cols|…}}`) that only the server
   expands correctly.
4. The page is split into three kinds of chunk:
   - **infobox** — one per upgrade level, each repeating the shared fields so a
     question about level 3 retrieves a chunk that answers on its own;
   - **table** — split on row boundaries only, never mid-row;
   - **prose** — paragraph-split with one paragraph of overlap.
5. Chunks whose content hash is unchanged keep their existing embedding, so a
   one-line wiki edit does not pay to re-embed the article.

The awkward part is the infobox. Read as plain text it produces
`Weight Durability 0.8 200` — every number separated from its label. The
extractor walks the `portable-infobox` tree instead, zipping header cells to
value cells and carrying the upgrade-level tab down as a breadcrumb, so a chunk
reads:

```
Iron Sword › Level 1
Level 1 › Properties: Weight: 0.8; Durability: 200; Crafting Materials: Wood x2; Iron x20; Leather scraps x3
```

### Embeddings

Two providers, both producing 768 dimensions so they share one schema:

| `EMBEDDING_PROVIDER` | Model | Cost | Notes |
| --- | --- | --- | --- |
| `gemini` (default) | `gemini-embedding-001` @ 768 dims | Free tier: **1,000 requests per day** | Indexing this wiki needs several thousand, so a full ingest needs billing enabled |
| `local` | `Xenova/multilingual-e5-base` on CPU | Free, no quota | ~280 MB downloaded once; ~5 ms per chunk, so the whole wiki embeds in under a minute |

The free Gemini embedding quota is the reason `local` exists. It is not a
downgrade for this use: e5-base is retrieval-tuned and genuinely multilingual,
which is what a Spanish question searching English text needs. It uses the
`query:` / `passage:` prefixes it was trained with, mirroring Gemini's
asymmetric task types.

**Vectors from different models are not comparable.** The provider that built
the index is recorded in the `settings` table, and changing it makes the next
ingest discard every stored vector and recompute — an index half-built with
each would retrieve nonsense without ever raising an error.

### The wiki reader

The same index, read rather than searched. The ingest produces two things from
one parse: `chunks` for retrieval, and `articles` — ordered blocks, a structured
infobox, images and facets — for reading.

**Article pages put the data first.** The complaint about Fandom on a phone is
that the infobox buries the page and the numbers sit below the fold. Here the
identity strip and the stat rows come first, upgrade levels are a segmented
control rather than four stacked tables, and wide tables scroll inside their own
box with a pinned first column so the page never scrolls sideways.

**Search is split by what each half is good at.** The title index — 1,027
entries, about 40 KB gzipped — is sent to the browser and filtered as you type:
no request, no spinner, and it works offline. Full-text search over article
bodies stays on the server, reusing the same weighted `tsvector` the chat
retrieval already maintains.

**Browsing uses three axes** because they answer different questions:
categories ("what kind of thing"), biomes ("what will I meet out there") and
crafting stations ("what can I make at this bench"). Biome and station are
lifted out of the infoboxes during ingest.

**Comparison is generic.** Within a filter, columns are whatever infobox labels
the articles share — no per-item-type schema. Columns are ranked by how
*comparable* they are, not how common: numeric fields rank the rows, repeated
categorical values group them, and a distinct string per row is identity, which
the row header already provides. Ranking by frequency alone put "Internal ID"
in the first column.

**Citations link inward.** An answer's sources open the in-app article, with the
original wiki still one tap away.

### Retrieval

1. **Rewrite** — Gemini turns the question plus recent turns into one to three
   English keyword queries. This is what makes both bilingual support and
   follow-ups work: the index is English, and "¿y cuánto daño hace?" carries no
   searchable content until the previous turn is folded in.
2. **Search** — per query, top-20 by cosine distance (HNSW) and top-20 by
   `ts_rank_cd`.
3. **Fuse** — Reciprocal Rank Fusion, `1 / (60 + rank)`, summed across lists.
   Chosen over score normalisation because cosine and `ts_rank_cd` are not on
   comparable scales.
4. **Answer** — the top chunks go to Gemini under a prompt that forbids using
   anything outside them and requires a `[n]` citation on every claim. Empty
   retrieval short-circuits to "not in the wiki" without a model call.

**The rewrite is an enhancement, not a dependency.** Before every search, known
Spanish terms are translated by a small built-in glossary
(`src/lib/rag/glossary.ts`) and the translated form is searched alongside the
original. That matters more than it sounds: measured on the golden set, the
system scores **96.7% recall@5 with the rewrite switched off entirely**. When
the LLM call fails — quota, outage, a model id that stopped working — quality
dips instead of collapsing.

Two details in the full-text half carry a lot of the quality:

- **`simple`, not `english`.** An English stemmer turns *Surtlings* into *surtl*
  and breaks exact-name recall, and queries arrive in Spanish too. The cost is
  that Postgres strips no stop words, so `buildTsQuery` filters them itself —
  including `valheim`, which appears in nearly every document of a corpus about
  Valheim and therefore discriminates nothing.
- **Weighted and length-normalised ranking.** The title is weight `A` and the
  body weight `D`, so a title match counts ten body matches, and `ts_rank_cd`
  divides by document length. Without either, "iron sword crafting materials"
  returned the *Iron* article — whose crafting list mentions iron dozens of
  times — above *Iron Sword*.

### Models

`gemini-2.5-flash` returns `404: no longer available to new users` on keys
created recently. The defaults are therefore:

| Role | Default | Override |
| --- | --- | --- |
| Answer | `gemini-2.5-flash-lite` | `GEMINI_ANSWER_MODEL` |
| Query rewrite | `gemini-2.5-flash-lite` | `GEMINI_REWRITE_MODEL` |

Measured on one short prompt each: `gemini-2.5-flash-lite` 0.5 s,
`gemini-3-flash-preview` 1.5 s, `gemini-3.6-flash` 43 s (heavy default
reasoning). One answer costs a rewrite call plus a generation call, so latency
compounds and the lite model is the right default.

Free-tier limits are tight: **20 generate_content requests per minute** plus a
daily cap. That is workable for a few people chatting and not workable for a
benchmark loop, which is why `pnpm eval` paces itself and CI runs it with
`--no-rewrite`.

**Quota is counted per model.** When one model is exhausted the others still
answer, so `GEMINI_ANSWER_MODEL=gemini-3-flash-preview` is a working escape
hatch — useful to know before concluding the key is dead.

### Auth

**The reader is public; the chat is not.** The reader shows an index built from
a public wiki, so there is nothing behind a gate worth the cost of one. The
chat is different: every question spends model tokens on the operator's
account, and conversations are private to the profile that wrote them.

| Public | Behind the password |
| --- | --- |
| `/wiki/**` — search, browse, articles, compare | `/` — the chat |
| `/api/wiki/**` — title index, content search | `/api/chat`, `/api/conversations/**` |
| `/login`, `/api/auth/**`, `/api/health` | `/api/ingest` |

`src/lib/auth/access.ts` is the single list, read by both the proxy and the
handlers, so a path cannot be public in the routing layer while its handler
still refuses — or, far worse, the other way round. Prefixes match at a path
boundary, so a route added later whose name merely begins with `/wiki` does
not inherit its openness. `tests/unit/access-policy.test.ts` pins both halves.

A signed-out visitor to `/` lands on the reader rather than a password prompt.
The chat tab shows a lock and leads to the login form, so the password is
announced rather than sprung after the click.

One shared password, hashed with scrypt (N=2^16) from `node:crypto` — no native
module to build on Windows or ship to Vercel. A successful login mints a
30-day HS256 JWT in an httpOnly cookie. The profile name in that token is a
label, not a credential; it only scopes conversation history.

The proxy (`src/proxy.ts`, the Next.js 16 name for middleware) redirects
unauthenticated browsers, but **every gated page and route handler verifies the
session itself**. Next.js middleware has been bypassable through a forged
internal header ([CVE-2025-29927](https://nvd.nist.gov/vuln/detail/CVE-2025-29927)),
so it is a routing convenience, never the only gate.

### Database privileges

The app connects as `valheim_app`, which can read the index and write chat
history, and nothing else — no DDL, and no write to `pages`, `chunks`,
`articles` or `settings`. Those belong to the ingest, which runs from a trusted
machine under the owner credential.

The split means a compromise of the internet-facing container costs you the
conversations, not the index. `pnpm db:app-role` creates or rotates the role and
writes its connection string to a file without printing it.

Login is rate limited to 10 attempts per IP per 15 minutes, counted in
Postgres — an in-process counter would reset on every serverless cold start.

---

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Development server |
| `pnpm build` / `pnpm start` | Production build and server |
| `pnpm ingest` | Incremental re-index |
| `pnpm ingest --full` | Re-parse every page |
| `pnpm ingest --limit 20` | Index 20 pages, skipping pruning — a smoke test |
| `pnpm ingest --reembed` | Discard stored vectors and recompute them all |
| `pnpm eval` | Retrieval quality: recall@5 over `tests/eval/golden.jsonl` |
| `pnpm test` | Unit and integration suite |
| `pnpm test:e2e` | Playwright end-to-end suite |
| `pnpm check` | typecheck + lint + test |
| `pnpm auth:hash "<pw>"` | Generate `APP_PASSWORD_HASH` and `SESSION_SECRET` |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:backup` | Copy the embedded database aside |
| `pnpm db:restore` | Restore it (`--dir .data/serve` for a disposable copy) |

---

## Testing

The unit and integration suites need **no API key and no database service**.
PGlite runs Postgres and pgvector in memory, and embeddings are replaced by a
deterministic bag-of-words fake, so retrieval tests assert real ranking
behaviour without a network call or a flaky model dependency.

`pnpm eval` is the one that catches quality regressions. Recall@5 measures
whether the right *article* was retrieved; which chunk of it answered is an
implementation detail. Change chunking, the ranking weights or the fusion
constants and this is the number that tells you whether it helped. It fails
below 80%.

Run it with `--no-rewrite` for a hermetic measurement: no API calls, no quota,
about three seconds, and it measures the deterministic path the app falls back
to. That is what CI runs.

```
$ pnpm eval --no-rewrite
index: 5856 chunks | cases: 30 | k=5 | rewrite off

recall@5   96.7%  (29/30)
MRR         0.798
elapsed     2.7s
```

The single miss is "core wood" versus the article named *Corewood*: a compound
split that lexical search cannot bridge and that the LLM rewrite does handle.

---

## Deploying

1. **Database** — create a Neon project, then run migrations against it:
   ```bash
   DATABASE_URL='postgresql://…' pnpm db:migrate
   ```
2. **Vercel** — import the repo and set:
   `GOOGLE_GENERATIVE_AI_API_KEY`, `DATABASE_URL`, `APP_PASSWORD_HASH`,
   `SESSION_SECRET`, `WIKI_CONTACT`.
3. **Ingest** — run `pnpm ingest` locally against `DATABASE_URL`, or add the
   same secrets to the repo and use the `Ingest wiki` GitHub Actions workflow.
   It runs weekly and can be triggered by hand.
4. **In-app re-index button** — set `GITHUB_TOKEN` (with `actions: write`) and
   `GITHUB_REPO` (`owner/repo`) in Vercel. Without them the button explains
   that it is not configured rather than failing silently.

The ingest deliberately does not run inside a Vercel function: a full pass takes
minutes and serverless caps out at 60–300 seconds.

---

## Two traps worth knowing about

**`.env` files expand `$NAME`.** The password hash is dot-separated
(`scrypt.65536.8.1.<salt>.<digest>`) rather than using the conventional `$`
because Next.js expands `$` references when it loads `.env`: a hash written
`scrypt$65536$8$1$…` arrives at the server as the single word `scrypt`, and
every login fails as "wrong password" with nothing in the logs. `pnpm auth:hash`
prints values that are safe to paste, and the login route now reports an
unparsable hash as a configuration fault instead of a bad password.

**PGlite does not survive a force-kill.** Its WASM filesystem is not crash safe:
killing the process mid-write leaves a data directory that aborts on the next
open, with no repair path. The app closes the database on SIGINT and SIGTERM,
so stopping `pnpm dev` with Ctrl+C is safe, and it refuses a second connection
to a directory already open. None of this applies to Neon in production, which
holds no local state.

Two habits make it a non-issue locally:

```bash
pnpm ingest          # only this writes the canonical .data/pglite
pnpm db:backup       # snapshot it, every time the ingest finishes

# Serve from a disposable copy, so a hard kill costs nothing:
pnpm start:copy      # restore .data/serve from the snapshot
PGLITE_DATA_DIR=.data/serve pnpm start
```

The snapshot goes stale the moment a migration or an ingest changes the schema —
`pnpm db:backup` after every ingest is what keeps `pnpm db:restore` from
quietly rolling the index back.

## Verified state

Measured on this machine against the live wiki:

| | |
| --- | --- |
| Index | 1,027 articles, 5,856 chunks, 1,027 reading documents, 0 ingest errors |
| Retrieval | recall@5 **96.7%** (29/30), MRR 0.798, no LLM calls, 3.3 s |
| Unit + integration | 252 tests, 22 files |
| End-to-end | 38 tests: chat, wiki reader, access control, offline reading |
| Typecheck / lint / build | clean |

Three end-to-end tests need Gemini quota to run and skip with a reason when it
is exhausted; all three have been verified green.

## Notes and limits

**Only Fandom is indexed.** `valheim.wiki.gg` answers every request with
`401 www-authenticate: Basic realm="Unreleased site"` — that wiki was never
published. Fandom is the wiki the developers point players to. The schema keeps
`source` and `source_rank` columns and the fusion applies a source penalty, so
adding a second wiki means editing `src/lib/wiki/sources.ts` and nothing else.
Cross-source deduplication (cosine > 0.95 on same-titled chunks) is implemented
and runs on every ingest; with one source it is a no-op.

**Answers are only as good as the wiki.** The prompt forbids the model from
filling gaps with its own Valheim knowledge, because a player cannot tell an
invented number from a cited one, and patch-specific values are exactly where a
model's memory is least reliable. When retrieval finds nothing, the app says so.

**Token counts are estimated** at four characters per token. Gemini's vocabulary
is not public, and chunk sizing only needs to be in the right ballpark.

**Toolchain versions.** The app stack is current (Next 16, React 19, AI SDK 7,
Drizzle, Zod 4). TypeScript is pinned to 5.9 and ESLint to 9 rather than the
just-released TypeScript 7 (native port) and ESLint 10; both are worth revisiting
once the surrounding tooling catches up.

`packageManager` pins pnpm to the version that produced the lockfile. Without
it, `corepack enable` on a build host installs whatever pnpm is newest — which
is how a container build first failed here: pnpm 11 enforces a
`minimumReleaseAge` policy that rejects packages published in the last day, and
several dependencies had been released hours earlier. That policy is a real
supply-chain protection and worth adopting deliberately, by upgrading pnpm and
regenerating the lockfile, rather than inheriting silently from whatever the
build host happens to download.
