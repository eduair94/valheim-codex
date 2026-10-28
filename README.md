# Valheim Codex

A private Valheim wiki you can actually use on a phone, plus an assistant that
answers from it. Ask a question in Spanish or English and get an answer built
only from wiki text; or search, browse and compare the 1,027 articles directly.
Installable, and articles you have opened stay readable offline.

- **Next.js 16** (App Router) + React 19, self-hosted with Docker behind a Cloudflare tunnel
- **Gemini Flash** for answers; embeddings from Gemini or a local CPU model
- **Postgres + pgvector** — Neon in production, embedded PGlite for local dev and tests
- **Hybrid retrieval**: dense vectors + Postgres full-text, fused with Reciprocal Rank Fusion
- Chat sign-in three ways: a shared password (operator-paid), your own Gemini
  API key, or your Puter account; each keeps its own conversation history
- **Mobile reader**, Spanish or English: instant local search that understands
  Spanish names, data-first article pages, category and biome browsing,
  sortable comparison tables, a bilingual 100% guide, installable with offline
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
the index is recorded in the `settings` table, and an ingest whose
`EMBEDDING_PROVIDER` differs refuses to run (the index is left untouched) — an
index half-built with each would retrieve nonsense without ever raising an
error. Switching is explicit: `EMBEDDING_PROVIDER=<id> pnpm ingest
--switch-provider=<id>`, and the app's `EMBEDDING_PROVIDER` must follow it.
`--reembed` rebuilds every vector with the provider that built the index; the
rebuild works from the stored chunk text, and missing vectors are filled again
at the start of every run, so a failed rebuild never leaves the index empty.

### The wiki reader

The same index, read rather than searched. The ingest produces two things from
one parse: `chunks` for retrieval, and `articles` — ordered blocks, a structured
infobox, images and facets — for reading.

**Article pages put the data first.** The complaint about Fandom on a phone is
that the infobox buries the page and the numbers sit below the fold. Here the
identity strip and the stat rows come first, upgrade levels are a segmented
control rather than four stacked tables, and wide tables scroll inside their own
box with a pinned first column so the page never scrolls sideways.

**Articles link to each other at render time.** The ingest keeps text, not
markup, so the wiki's own cross-links do not survive it. Instead, every article
title — and its Spanish title, once translated — is a term, and any term that
appears whole in a page's prose, lists, tables or stat rows becomes a link. On
a translated page each list item and cell is also paired by position with the
English it came from, so `Especiero` links to Spice rack even when the
translation dropped the gloss. The server resolves the mentions against the
whole title list; the page carries only the handful it uses.

**Search is split by what each half is good at.** The title index — 1,027
entries with their Spanish names, about 29 KB brotli — is sent to the browser
and filtered as you type: no request, no spinner, and it works offline. It
folds accents and case, reads Spanish through the glossary and the display
vocabulary (`src/lib/i18n/terms.ts`), so *hierro*, *espada de hierro*,
*jabali* and *banco de trabajo* all rank the right article first. Full-text
search over article bodies stays on the server, reusing the same weighted
`tsvector` the chat retrieval maintains, plus the stored Spanish titles and
leads (so *cardo* finds Thistle); the query is in the URL (`/wiki?q=`), so Back
returns to the results.

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

Five providers, tried in order, because the failure this app actually hits is
not a bug — it is a provider being out of budget. Each is optional; one with no
key configured is left out of the chain rather than tried and failed.

| Order | Provider | Default model | Free tier, measured |
| --- | --- | --- | --- |
| 1 | xAI | `grok-4.20-non-reasoning` | none — needs credit on the team |
| 2 | Google | `gemini-2.5-flash-lite` | 20 requests/minute + a daily cap |
| 3 | Groq | `openai/gpt-oss-120b` | 200,000 tokens/day, ~50 questions |
| 4 | Cerebras | `gpt-oss-120b` | none on the account tested |
| 5 | OpenRouter | `x-ai/grok-4.3` | unusable, see below |

Every id is overridable: `GROK_ANSWER_MODEL`, `GEMINI_ANSWER_MODEL`,
`GROQ_ANSWER_MODEL`, `CEREBRAS_ANSWER_MODEL`, `OPENROUTER_ANSWER_MODEL`, and
the matching `*_REWRITE_MODEL`.

Gemini and Groq are worth having together because their limits have different
shapes: Gemini refuses in bursts and recovers within the minute, Groq is steady
until the day's budget is gone.

**OpenRouter's free models were measured and rejected.** `openrouter/free`
routes by availability rather than capability and answered once from a coding
model and once from a content-safety classifier, which replied `User Safety:
safe`. The one free model that produced clean Spanish leaked its chain of
thought as soon as the prompt looked like RAG. A wrong answer is recoverable;
raw reasoning rendered as the answer is not something to ship. Put credit on
the key and it becomes the best tier instead of the worst.

**Falling through is fast.** A provider that will refuse does so before the
first token, and `streamWithFallback` waits for that token before committing to
a stream, so the reader never sees a switch. Only the last provider in the
chain gets retries — the SDK's default of three attempts with backoff had a
rate-limited Gemini spending six seconds failing while four other providers sat
idle. Falling through to a working provider went from 8452 ms to 839 ms.

A provider that fails with 401, 402 or 403 is demoted for ten minutes, because
an unfunded key answers the same way for weeks and would otherwise tax every
question with a failed round trip. A 429 does not demote anything: waiting
fixes it, and skipping the provider would give up quota it is about to get
back.

Latency, one short prompt each: `gemini-2.5-flash-lite` 0.5 s,
`gpt-oss-120b` on Groq 0.9 s, `gemini-3-flash-preview` 1.5 s,
`gemini-3.6-flash` 43 s (heavy default reasoning). One answer costs a rewrite
call plus a generation call, so latency compounds.

**Gemini quota is counted per model.** When one is exhausted the others still
answer, so `GEMINI_ANSWER_MODEL=gemini-3-flash-preview` is a working escape
hatch — useful to know before concluding a key is dead.

### Auth

**The reader is public; the chat is not.** The reader shows an index built from
a public wiki, so there is nothing behind a gate worth the cost of one. The
chat is different: every question spends model tokens on somebody's account,
and every conversation belongs to the profile that started it. Under the
shared password a profile is a name, not an account (see **Profiles** below).

| Public | Any signed-in reader | Password only |
| --- | --- | --- |
| `/wiki/**` — search, browse, articles, compare | `/` — the chat | `/api/ingest` (only the `ADMIN_PROFILES` names, if set: a convenience, not a lock) |
| `/api/wiki/**` — title index, search, translations | `/api/chat`, `/api/chat/prepare`, `/api/chat/complete` | |
| `/login`, `/api/auth/**`, `/api/health`, `/robots.txt`, `/sitemap.xml` | `/api/conversations/**` | |

`src/lib/auth/access.ts` is the single list, read by both the proxy and the
handlers, so a path cannot be public in the routing layer while its handler
still refuses — or, far worse, the other way round. Prefixes match at a path
boundary, so a route added later whose name merely begins with `/wiki` does
not inherit its openness. `tests/unit/access-policy.test.ts` pins both halves.

**Three ways in**, chosen on `/login`. Each is its own cookie with its own key
and audience, so one can never be mistaken for another:

| | Who pays for answers | What the server keeps |
| --- | --- | --- |
| **Shared password** | the operator's provider chain | a 30-day HS256 session (`wv_session`) naming a profile, which is a label, not a credential |
| **Own Gemini key** | the reader's Google account | the key, encrypted (JWE, A256GCM) in an httpOnly cookie (`wv_byok`, 30 days); never in the database, never logged |
| **Puter** | the reader's Puter account; the model runs from their browser | a 1-day session (`wv_puter`) after the server verifies their Puter token |

- **Own key.** `POST /api/auth/byok` checks the key against Google (a
  `models.get` and a one-token generation, the key only ever in the
  `x-goog-api-key` header) before sealing it, so a typo fails at sign-in rather
  than on the first question. Answers then use only that key and the model the
  reader picked; the operator's keys and its circuit breaker are never touched.
- **Puter.** The browser signs in with `puter.auth.signIn()` and hands the token
  to `POST /api/auth/puter`, which asks Puter who it belongs to and refuses a
  token issued to another site or to a temporary account. Retrieval stays on the
  server (`/api/chat/prepare` returns the grounded prompt and a 15-minute signed
  grant); the browser streams the answer from Puter and `/api/chat/complete`
  stores it against the grant.
- `GUEST_CHAT_MODES` (default `byok,puter`) turns either off — `none` makes the
  chat password-only — and is read on every request, so it also stops cookies
  already issued.

**Profiles.** History is kept per profile, and what keeps others out of it
depends on how its reader signed in:

- A Gemini-key reader's history belongs to an id minted in their browser
  (`byok:<uuid>`). A second cookie, `wv_byok_owner`, outlives sign-out: for the
  last four keys used in that browser it remembers which id each one signed in
  as, by a server-keyed tag of the key, never the key. So the same key in the
  same browser finds its history again after signing out, "Forget key" or a
  switch to another method; another key starts a history of its own and cannot
  reach the previous one; another browser always starts fresh. Changing the key
  while signed in keeps the history. Clearing the site's data, 180 days without
  signing in, or rotating `BYOK_SECRET` (`SESSION_SECRET` while `BYOK_SECRET`
  is unset) cuts a browser off from those histories; their rows stay in the
  database, since nothing purges them yet.
- A Puter reader's history belongs to their Puter account (`puter:<uuid>`),
  from any device they sign in on. Neither kind of id can be typed at sign-in.
- Under the shared password, the profile is only the name typed at sign-in.
  Anyone with the password who types the same name (case counts, extra spaces
  do not) sees that profile's conversations and can continue, rename and
  delete them. Give the password only to people you would show your history
  to: privacy between them would need a credential per person, which this
  app does not have.
- `ADMIN_PROFILES` limits re-indexing to some of those names. Anyone with the
  password can type one, so it keeps the button from friends who should not
  press it, not from someone determined.

Sessions are verified **in every gated page and route handler**, not only in the
proxy (`src/proxy.ts`, the Next.js 16 name for middleware): middleware has been
bypassable through a forged internal header
([CVE-2025-29927](https://nvd.nist.gov/vuln/detail/CVE-2025-29927)), so it is a
routing convenience, never the only gate. In production every auth cookie is
`__Host-`-prefixed (Secure, host-only, path `/`), so deploying this version
signs everyone out once.

**The password** is hashed with scrypt (N=2^16) from `node:crypto` and must be
at least 12 characters. Guessing is bounded in Postgres per address (10 per 15
minutes), per network (an IPv4 /24 or IPv6 /48, 30), and by a budget of failed
sign-ins from everyone (50 per window). Past that budget only browsers that
have signed in before (a signed `wv_device` cookie, tied to the current hash)
may try. Verification runs at most two at a time per process, so a guess flood
cannot starve the server. The address is Cloudflare's `CF-Connecting-IP`
(the origin listens on loopback behind the tunnel, so it cannot be forged),
else the nearest proxy hop — never the client-written first
`X-Forwarded-For` entry, which let every guess buy a fresh window.

**Every mutating API request** must come from this site (`Sec-Fetch-Site` or
`Origin`), carry JSON, and stay under 64 KB; the proxy checks all three before
any handler runs. One exception: `/api/csp-report` also takes the
`Origin: null` report with no `Sec-Fetch-Site` that Safari before 16.4 sends.
It stores nothing and rate-limits its own logging.

**Quotas** (`src/lib/auth/limits.ts`, all overridable, see `.env.example`):
password sessions share 40 questions per 10 minutes per address and 2,000 a
day overall; guest readers spend their own budget but the server still
retrieves for them, so they get 6 a minute and 150 a day each. Counted in
Postgres in one statement per request; a guest is refused if the counter is
unavailable. Opening a saved conversation returns its newest 200 messages
(about 1 MB at most) and is capped at 60 a minute per reader and per address,
in memory.

**Headers.** `Referrer-Policy: no-referrer` (Fandom's CDN refuses images that
carry a referrer), `X-Frame-Options: DENY`, HSTS, `nosniff`, a
`Permissions-Policy`, and a Content-Security-Policy. Production sends the full
CSP **report-only** until `CSP_ENFORCE=1` (violations are logged as `[csp]`
lines by `/api/csp-report`); framing, `<base>`, plugins and form targets are
blocked from day one.

### Database privileges

The app connects as `valheim_app`, which can read the index and the recipe
graph and write chat history, and nothing else — no DDL, and no write to `pages`, `chunks`,
`articles` or `settings`. Those belong to the ingest, which runs from a trusted
machine under the owner credential.

The split means a compromise of the internet-facing container costs you the
conversations, not the index. `pnpm db:app-role` creates or rotates the role and
writes its connection string to a file without printing it.

Login attempts, quotas and translation progress are counted in Postgres, not
in the process, so they hold across restarts and across every process serving
the app.

---

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Development server |
| `pnpm build` / `pnpm start` | Production build and server |
| `pnpm ingest` | Incremental re-index |
| `pnpm ingest --full` | Re-parse every page (implies `--reparse`) |
| `pnpm ingest --reparse` | Rebuild pages an older parser built (each run reports how many) |
| `pnpm ingest --limit 20` | Index 20 pages, skipping pruning — a smoke test |
| `pnpm ingest --reembed` | Recompute every vector with the index's own provider |
| `pnpm ingest --switch-provider=<id>` | Move the index to another embedding provider (with `EMBEDDING_PROVIDER=<id>`) |
| `pnpm ingest --recipes` | Read the recipes of pages that lack current ones and rebuild the recipe graph; no article, translation or vector is touched |
| `pnpm translate:es --priority` | Translate 30 key pages (biomes, bosses, stations, hubs) into Spanish (`--dry-run`, `--slugs`, `--max-strings`, `--tpm` …) |
| `pnpm translate:es --rebuild` | Re-derive stored translations from their memory; no model calls |
| `pnpm db:app-role` | Create or rotate the least-privilege `valheim_app` role |
| `pnpm eval` | Retrieval quality: recall@5 over `tests/eval/golden.jsonl` |
| `pnpm test` | Unit and integration suite |
| `pnpm test:e2e` | Playwright end-to-end suite |
| `pnpm check` | typecheck + lint + test |
| `pnpm auth:hash "<pw>"` | Generate `APP_PASSWORD_HASH` and `SESSION_SECRET` |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:backup` | Copy the embedded database aside |
| `pnpm db:restore` | Restore it (`--dir .data/serve` for a disposable copy) |

**Which database a script works on** (`scripts/_db.ts`; `ingest`,
`translate:*`, `db:migrate` and `eval`). Scripts read `.env.local`, then
`.env`, never `.env.development.local`. `--pglite <dir>` picks that local copy
whatever else is set, and `--neon` picks `DATABASE_URL`. A `DATABASE_URL` from
one of those files is read freely but written only with `--neon`; one given in
the environment (`DATABASE_URL='…' pnpm db:migrate`, the ingest workflow's
secret) works as it always did. `DATABASE_URL` and `PGLITE_DATA_DIR` both set,
with neither flag, stops the run. In PowerShell `$env:DATABASE_URL = ''`
deletes the variable, and the file fills it in again.

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

`pnpm test:e2e` builds and starts the production server on
`http://127.0.0.1:3100`, or reuses whatever already answers on that port; the
global setup signs in with `E2E_PASSWORD` (default `valheim-dev-2026`), so the
server's `APP_PASSWORD_HASH` must match it. Against `next dev`, run it with
`E2E_BASE_URL=http://localhost:3100`: the dev server refuses its hot-reload
socket to any other host, and no page hydrates without it. `app.spec.ts` asks
the real model providers and skips with a reason when their quota is gone;
every other spec answers translation and key requests in the browser.

---

## Deploying

Production is one Docker container (`docker-compose.yml`) on a host that also
runs the Cloudflare tunnel in front of it; the container listens on loopback
only. The database is Neon. Nothing deploys on merge.

**First time**

1. **Database** — create a Neon project (with the `vector` extension), then,
   with the owner credential:
   ```bash
   DATABASE_URL='postgresql://owner…' pnpm db:migrate
   DATABASE_URL='postgresql://owner…' pnpm db:app-role   # writes the app's URL to .app-role-url
   ```
2. **Host** — clone the repo, write `.env` from `.env.example`: the app-role
   `DATABASE_URL`, at least one model key, `APP_PASSWORD_HASH` and
   `SESSION_SECRET` (`pnpm server:password "<password>"` writes both),
   `WIKI_CONTACT`, `EMBEDDING_PROVIDER=local`. Then build with the CPU cap below.
3. **Ingest** — `pnpm ingest` from a trusted machine with the owner
   credential (it runs migrations itself), or the `Ingest wiki` GitHub Actions
   workflow. The ingest deliberately does not run inside the web container.
4. **In-app re-index button** — optional: `GITHUB_TOKEN` (`actions: write`)
   and `GITHUB_REPO` (`owner/repo`). Without them the button explains that it
   is not configured.

**Every update**

```bash
# 1. Migrations first, with the owner credential. They are additive, so the
#    version still running keeps working against the new schema.
DATABASE_URL='postgresql://owner…' pnpm db:migrate

# 2. Build and swap the container.
ssh <host>
cd /opt/valheim-codex && git pull --ff-only origin main
sudo systemctl set-property --runtime docker CPUQuota=1600%
docker compose up -d --build
sudo systemctl set-property --runtime docker CPUQuota=
```

Migrations are not optional: the app role has no DDL rights, so a table or
column the code expects cannot appear on first use.

The image checks itself before it replaces the running container; a failed
check fails the build and the old container keeps serving. Both checks catch
failures nothing else would notice: the embedding model must load from the
image (`verify-image:` in the build log), and `next start` must load the
`next.config.ts` the build used (`verify-next-config:`). `next start` reads
that file again when it boots; without it the server falls back to Next's
defaults — `X-Powered-By`, a public image optimizer, 10 MB request bodies —
and still passes its health check.

**Upgrading to the chat sign-in release** (migrations 0005–0009):

- Everyone signs in again once: the auth cookies became `__Host-` cookies.
- `SESSION_SECRET` must be 32 characters or more, or password sign-in stays
  off (the boot log says so). New optional settings: `GUEST_CHAT_MODES`,
  `BYOK_SECRET`, `APP_ORIGIN`, `PUTER_APP_UIDS`, `ADMIN_PROFILES`,
  `CSP_ENFORCE` and the quota knobs, all in `.env.example`.
- The CSP starts report-only. Watch `docker logs valheim-codex | grep csp`
  for a few days of real traffic, then add `CSP_ENFORCE=1` and
  `docker compose up -d`.
- Content, from a trusted machine with the owner credential, in this order
  (`--neon` confirms a `DATABASE_URL` that comes from `.env.local`; it is not
  needed when the URL is given in the environment, nor for `--dry-run`):
  1. `pnpm translate:es --rebuild --dry-run`, then `--rebuild --neon` —
     repairs the translations' doubled headings and seeds their translation
     memory; no model calls.
  2. `pnpm ingest --reparse --neon` — rebuilds every article with the new
     parser, version 2: line breaks in tables and stat rows, real table
     headers, status banners; leads that were tab labels run together
     ("RawCooked", "MeadMead base", "HeadChestLegs"); armor sets' "Armor
     pieces" split per quality with their tables; armor pieces' per-level
     stats (armor, durability, weight, recipe), which the Armor comparison
     then shows; the 16 armor-set pages left out of that comparison, since
     their infobox is their first piece's; and the traders Hildir and Haldor,
     "n/a" and "Console" no longer taken for crafting stations. About 1,027
     page fetches; it re-embeds about a third of the chunks and marks most
     translations stale, which then only pay for the strings that changed.
     Until step 3 refreshes them, those articles keep their stale Spanish
     leads and infoboxes (for example "CrudaCocida").
  3. `pnpm translate:es --priority --neon`, then plain `pnpm translate:es
     --neon` on later days. It saves as it goes and stops when the free tier
     runs out, when no provider answers for two articles in a row, or after
     three articles that yield nothing usable, so the next run resumes where
     this one stopped.
- Cloudflare: keep Rocket Loader off (it rewrites scripts and breaks
  hydration and the CSP), and consider a rate-limiting rule on `/api/auth/*`
  as a first line in front of the app's own limits.

**Upgrading to the crafting release** (migration 0010, recipes version 2):

- The app role reads one more table: `GRANT SELECT ON recipe_graph TO
  valheim_app` with the owner credential (`pnpm db:app-role` grants it to a
  new role).
- `pnpm ingest --recipes --neon`, from a trusted machine: it reads every
  page's recipes once (about 1,058 fetches, a few minutes), assembles the
  graph and stores it, and touches no article, translation or vector. Run it
  again after editing `src/lib/craft/recipe-overrides.ts`. Item pages show
  the craft card and the "Usado en" sections within the hour, or at once in a
  container built after the run.
- The translator paces itself by tokens: `--tpm` defaults to 4,000, half of
  Groq's 8,000 a minute, so the chat keeps room, and `--rpm` has no default.
  A run still spends Groq's day, so run `--priority` while the chat is quiet.
  It can now stop as rate-limited, apart from "no provider answered".

### `restart` does not reload `.env`

`docker compose restart` restarts the container with the environment it was
created with. `env_file` is read at create time, so a changed secret is only
picked up by a recreate:

```bash
node scripts/set-password.mjs "the password you chose"
docker compose up -d      # NOT `restart`
```

This fails quietly and confusingly: the file on disk is right, the container is
healthy, and every login is rejected. `docker exec valheim-codex printenv
APP_PASSWORD_HASH` against the value in `.env` is what tells them apart.

### Rebuilding without taking the site down

The image is built on the same machine that serves it, and an unconstrained
build saturates that machine: on a 32-core host the load average reached 24,
the Cloudflare connector was starved until it dropped its QUIC streams, and the
tunnel answered 502 while the container itself was healthy and answering on
`127.0.0.1:3210`. The container was never the problem — the CPU was.

Cap the builder and the site stays up:

```bash
sudo systemctl set-property --runtime docker CPUQuota=1600%   # half the box
docker compose up -d --build
sudo systemctl set-property --runtime docker CPUQuota=         # restore
```

Verified: `/wiki` answered 200 throughout a capped build. The real fix is to
build the image in CI and have the server pull it, which this repo does not do
yet.

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
DATABASE_URL= PGLITE_DATA_DIR=.data/serve pnpm start
```

The app uses `DATABASE_URL` whenever it is set, and `next start` fills it in
from `.env.local`; the empty `DATABASE_URL=` is what keeps a machine whose
`.env.local` holds the production URL off production. In PowerShell, which
cannot pass an empty variable, put both lines in `.env.production.local`
instead: Next reads that file before `.env.local`, and scripts never read it.

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
