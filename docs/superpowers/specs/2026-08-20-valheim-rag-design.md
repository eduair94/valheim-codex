# Valheim Codex — design

**Date:** 2026-08-20
**Status:** implemented

A private, password-protected browser app that answers Valheim questions from
the wiki, in Spanish or English, citing the article every claim came from.

---

## 1. Decisions

| Axis | Decision | Why |
| --- | --- | --- |
| Deployment | Next.js 16 on Vercel, Neon Postgres | One repo for UI, API and streaming; `git push` deploys |
| Model | `gemini-2.5-flash-lite` for answers (see §1 correction), 768-dim embeddings | The requested `gemini-2.5-flash` is unavailable to new keys; lite is the available member of the family and the fastest option |
| Retrieval | Hybrid dense + full-text, fused with RRF | Neither alone is sufficient — see §4 |
| Chunking | Structural: sections, flattened tables, per-level infoboxes | Recipes are the most-asked question and live in tables |
| Auth | One shared password + per-person profile | No registration, no user table, separate history |
| Languages | Bilingual with a toggle | Content is English; questions arrive in Spanish |
| Local dev / tests | Embedded PGlite + pgvector | No Docker, no service, tests need no API key |

### Source correction

The brief called for both `valheim.wiki.gg` and `valheim.fandom.com`, preferring
wiki.gg. **wiki.gg does not exist publicly**: every request returns
`401 www-authenticate: Basic realm="Unreleased site"`. Fandom is the wiki the
developers point players to, and is the only source indexed.

The multi-source design is kept intact — `source` and `source_rank` columns,
a source penalty in fusion, and cosine-based cross-source deduplication — so
adding a second wiki is a change to `src/lib/wiki/sources.ts` alone.

### Model correction

`gemini-2.5-flash` answers `404: no longer available to new users` on keys
created recently. `gemini-2.5-flash-lite` is the member of the 2.5 Flash family
new keys can use, and is also the fastest available option (0.5 s versus 1.5 s
for `gemini-3-flash-preview` and 43 s for `gemini-3.6-flash`, which reasons
heavily by default). Both roles are overridable by environment variable, and
free-tier quota is counted per model, so exhausting one leaves the others
usable.

### Format correction

The brief assumed wikitext. The Valheim wiki leans on templates
(`{{item link|…}}`, `{{cols|…}}`) that only MediaWiki can expand, so ingest uses
`action=parse` and works from **rendered HTML**, which also yields `revid`,
`sections` and `categories` in the same request.

---

## 2. Shape

```
src/lib/
  wiki/      mediawiki client · html → sections · infobox extractor · chunker
  rag/       embeddings · tsquery builder · hybrid retrieval · RRF · rewrite · prompts
  db/        schema · driver factory · dir lock · migrations · repository
  auth/      scrypt password · JWT session · rate limit
  ingest/    orchestration
```

`wiki/` and `rag/` import nothing from Next. They are plain Node modules, which
is what lets the ingest script, the eval harness and the test suite use them
without a server.

---

## 3. Ingest

Incremental by revision id, then incremental by content hash:

1. `list=allpages` → ~1,000 article titles.
2. `prop=revisions` → current revision ids, 50 per request.
3. Pages whose revid is unchanged are skipped entirely.
4. Changed pages are parsed and re-chunked; chunks whose content hash is
   unchanged **keep their existing embedding**.

A patch that edits 40 pages therefore costs ~20 API requests and embeds only
the paragraphs that actually changed.

### Chunking

Three kinds, kept apart because they fail differently:

- **infobox** — one chunk per upgrade level, each repeating the shared fields.
  A question about level 3 retrieves a chunk that answers on its own.
- **table** — split on row boundaries only. A crafting row is never halved.
- **prose** — one chunk per section; paragraph-split with one paragraph of
  overlap past ~400 tokens.

Every chunk is prefixed with `Article › Section › Subsection` before embedding.
The cheapest available form of contextual retrieval, and it makes a chunk
self-describing once pulled out of the index.

### The infobox problem

Read as text, a Fandom `portable-infobox` yields `Weight Durability 0.8 200` —
every number detached from its label. The extractor walks the DOM instead,
zipping `<th>` to `<td>` in horizontal groups and carrying the upgrade tab down
as a breadcrumb:

```
Iron Sword › Level 1
Level 1 › Properties: Weight: 0.8; Durability: 200; Crafting Materials: Wood x2; Iron x20; Leather scraps x3
```

Tab labels are only prefixed with "Level" when numeric — creature infoboxes tab
by `0★` and `Trophy`, where "Level Trophy" would be nonsense.

### A bug worth recording

MediaWiki does not wrap a lead paragraph in `<p>`. It emits **bare text nodes**
interleaved with `<b>` and `<a>` directly under `.mw-parser-output`. Walking
element children only — the obvious implementation — silently drops every word
that is not inside a link, reducing the summary sentence of every article to a
list of link labels. Caught by a test asserting the lead text of `Iron`.

---

## 4. Retrieval

```
question → rewrite (Gemini) → 1-3 English queries
             ↓
    per query: top-20 cosine (HNSW) + top-20 ts_rank_cd
             ↓
          RRF fusion, 1/(60 + rank), source penalty
             ↓
       top-8 within a 6,000-token budget → Gemini Flash
```

**Why hybrid.** Vector search generalises across language and paraphrase, which
is what lets a Spanish question find English wiki text. It also blurs rare
proper nouns, which is most of what Valheim questions contain. Full-text nails
`Yagluth` and `Surtling core` exactly and is useless for paraphrase.

**Why RRF over score normalisation.** Cosine similarity and `ts_rank_cd` are not
on comparable scales, and mapping them onto one is a tuning exercise that drifts
whenever either retriever changes. RRF reads only positions.

**Why the `simple` text-search configuration.** An English stemmer turns
*Surtlings* into *surtl* and breaks exact-name recall, and queries arrive in
Spanish too. The cost is that Postgres strips no stop words, so `buildTsQuery`
filters an ES+EN stop list itself before joining terms with `OR`.

**Why rewrite at all.** It solves two problems with one cheap call: the index is
English while questions are not, and "¿y cuánto daño hace?" carries nothing
searchable until the previous turn is folded in. A failure falls back to
searching the question verbatim rather than failing the request.

**Grounding.** The system prompt forbids using the model's own Valheim
knowledge, requires a `[n]` citation per claim, and requires saying so when the
excerpts do not contain the answer. Empty retrieval short-circuits to a fixed
reply with no model call — asking a model to answer with no context is asking
it to invent.

---

## 5. Auth

- scrypt (N=2^16, r=8) from `node:crypto`. No native module to build on Windows
  or ship to Vercel.
- HS256 JWT in an httpOnly, SameSite=Lax cookie, 30 days, via `jose`.
- The profile in the token is a **label, not a credential**. It scopes history
  and nothing else; the login copy says so.
- Login rate limited to 10 attempts per IP per 15 minutes, counted in Postgres —
  an in-process counter resets on every serverless cold start and is not shared
  between instances.

**Middleware is not the security boundary.** It redirects unauthenticated
browsers, but every page and route handler verifies the session itself. Next.js
middleware has been bypassable through a forged internal header
(CVE-2025-29927); treating it as the only gate would put the app one header
away from public.

Conversation ownership is enforced **in the query**, not after loading, so a
guessed id never reads another profile's history even briefly.

---

## 6. Re-indexing from the UI

The button dispatches a GitHub Actions `workflow_dispatch`; the ingest runs
there. A full pass takes minutes and a Vercel function caps out at 60–300
seconds. Actions also leaves a log and costs nothing for this workload. Without
`GITHUB_TOKEN`/`GITHUB_REPO` the button explains it is not configured rather
than failing silently.

---

## 7. Local database: a hazard, and the guard

PGlite is **single-process**. Two connections to one data directory do not fail
loudly — they corrupt the directory, and the corruption only surfaces on the
next start as an unrecoverable WASM abort. This happened once during
development and cost a full re-ingest.

`acquireDirLock` now takes an exclusive pid lockfile in the data directory
before PGlite opens it, refuses a directory held by a live process (including
this one), and takes over locks whose owner is gone. `PGLITE_DATA_DIR` lets a
build, a test run and an ingest use separate directories.

---

## 8. Testing

- **Unit** — infobox extraction, HTML sectioning, table flattening, chunking,
  the MediaWiki client (mocked fetch), RRF, tsquery building, auth.
- **Integration** — migrations, hybrid retrieval and the whole ingest pipeline
  against a real in-memory Postgres, with a deterministic bag-of-words
  embedder in place of Gemini. No API key, no service, no flake from model
  updates.
- **Eval** — `pnpm eval` measures recall@5 over a hand-written golden set of 30
  bilingual questions. It measures whether the right *article* was retrieved;
  which chunk answered is an implementation detail. Fails below 80%.
- **E2E** — Playwright against a production build: access control, a forged
  cookie, streaming, citations linking to Fandom, history round-trip, the
  language toggle, and mobile layout.

---

## 9. What the build actually taught

Six findings that changed the design, each caught by something rather than
guessed at:

1. **`valheim.wiki.gg` does not exist.** `401 Basic realm="Unreleased site"`.
   Found by probing before writing a client for it.
2. **MediaWiki does not wrap lead paragraphs in `<p>`.** Walking element
   children silently dropped every word not inside a link. Caught by a test
   asserting the lead text of *Iron*.
3. **`gemini-2.5-flash` is unavailable to new keys** (`404`). It broke the
   rewrite *and* would have broken answering. It hid behind a `catch` that
   swallowed the error, so the only symptom was mediocre retrieval. Errors on
   a degradation path must be logged.
4. **The eval was the whole quality story.** It reported 63.3% recall and each
   fix moved a real number: the model id, weighted `tsvector` (title `A`, body
   `D`), length normalisation, corpus stop words, the glossary, and per-
   retriever fusion weights took it to 96.7%.
5. **Retrieval must not depend on an LLM call.** The rewrite is one network
   request per question, and when quota ran out the system did not degrade — it
   collapsed. A deterministic glossary now carries the Spanish path, and the
   measured floor is 96.7% with the rewrite off entirely.
6. **`.env` expands `$`, and PGlite dies on force-kill.** Both cost hours and
   both are now guarded: a dot-separated hash with a config-error path, and a
   directory lock plus graceful shutdown plus backup/restore.

A seventh only an end-to-end test could find: `toUIMessageStream` defaults to
`sendStart: true`, which opened a second assistant message and rendered every
answer twice with duplicated sources.

## 10. Deliberately not built

Tool calling, file upload, multimodal input, a reranking pass, an i18n
framework, and real user accounts. The reranker has a named seam between fusion
and selection; the rest would be speculative.
