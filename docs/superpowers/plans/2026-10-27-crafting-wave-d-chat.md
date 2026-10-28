# Crafting wave D: the chat answers from the graph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Crafting and progression questions get exact answers: the server adds an exact "X › Recipe and uses" excerpt, built from the recipe graph, for each craftable thing a question names (and, after wave C, a "Progression › Stage" excerpt), as one pinned stage with the existing intent pins; recipe citations offer "Agregar al taller"; and the chat-quality judge's open findings are fixed.

**Architecture:** No tool calling. A bilingual name spotter (no model) picks at most three items from the question, the previous question and the rewrite's queries; a pure renderer turns each into a short English excerpt with verbatim names, integers and precomputed totals; `retrieve` puts these excerpts and the intent pins at the head of the context under one budget, on all three paths (password, own key, Puter). The prompt gains one precedence rule. Citations carry an optional `kind: 'recipe'`, which the source list uses to offer the planner.

**Tech Stack:** TypeScript, Next.js 16.4.3 route handlers, AI SDK, Drizzle on PGlite (local) / Neon (production), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-27-crafting-and-progression-design.md` §10 (and §15.7-8). Evidence: chat recon (`craft/recon/merged/chat.md` in the session scratchpad: §4 excerpt format and costs, §7 recommended shape, §8 tests, §9 risks); the chat-quality fix's verification and judge (`rag/fix/workflow-result.json`: `verify.regressions`, `judge.remaining`, `judge.recommendations`) and their tools (`rag/fix/verify/lab/answer-lab.mts`, `rag/fix/judge/dump.mjs`, `rag/fix/verify/label-scan.txt`).

## Global Constraints

- Production database: never connect to it. Every measurement runs on a local PGlite copy refreshed from the live wiki (`pglite-full`, then the copy wave A's recipes pass completes). Never `--neon`.
- Real-model checks are paced and budgeted: Groq `openai/gpt-oss-120b` (~8K tokens/minute), Gemini `gemini-2.5-flash-lite` at most 20 requests/day (resets 07:00 UTC); xAI, Cerebras and OpenRouter keys hidden from every run. Each task states its request budget.
- English in-game names stay in answers, copied letter for letter, with an optional Spanish gloss in parentheses (spec §15.8). Spanish answers in rioplatense voseo.
- Excerpts are data: names and integers verbatim from the graph, totals precomputed (the prompt forbids the model to compute), and a raw breakdown only when every yield on the path is known.
- The numbering contract of `buildContext` and the citation records stay as they are; new citation fields are optional (stored messages, history reloads and Puter's signed grant all carry citations as JSON).
- No commits. Read `node_modules/next/dist/docs/` before route code. Code reads like the surrounding code.

## Review Focus

1. **A name the spotter reads two ways** ("Drakkar": the Longship's Spanish name and its own article; "horno": kiln or smelter; "hierro": Iron, Iron ore, Scrap iron): both readings within the cap of three, never a third unrelated item. Pinned in Task 1.
2. **Questions in other languages and compound words** ("Zinn", "ferro", "Eisenschwert", on the Puter path with no rewrite): the spotter finds what the title index can name; otherwise nothing is pinned and ranking answers as today. Pinned in Tasks 1 and 3.
3. **Materials used in everything** (Wood 75 uses, Finewood 58, Iron 51): the excerpt caps the list at 24 and says how many more are on the page; the budget never pushes the question's own article out. Pinned in Tasks 2 and 3.
4. **The graph missing or old** (no `recipe_graph` row, a graph built before a wiki edit, an item whose yield is unknown): no excerpt, or an excerpt that says what it does not know; the answer still comes from retrieval; nothing throws. Pinned in Tasks 2 and 3.
5. **Old clients and stored conversations** (a conversation saved before `kind` existed; a Puter grant near its 16,384-character limit): they render and verify as before. Pinned in Task 5.

---

## Owners, files and order

| Owner | Tasks | Files |
|---|---|---|
| **parser** | 0 | `src/lib/wiki/article.ts` and the section and list extraction it calls, `src/lib/wiki/chunker.ts`, `src/lib/ingest/version.ts`, their tests |
| **craft-chat** | 1-2 | `src/lib/craft/spot.ts`, `src/lib/craft/excerpt.ts`, `src/lib/chat-server/craft.ts` (all new), tests |
| **retrieval** | 3, 6 | `src/lib/rag/{retrieve,stitch,intent,plan}.ts`, `src/lib/chat-server/answer.ts`, `src/app/api/chat/prepare/route.ts`, `scripts/eval.ts`, `tests/eval/*`, tests |
| **prompts** | 4 | `src/lib/rag/{prompt,rewrite}.ts`, tests |
| **ui** | 5 | `src/lib/db/schema.ts` (the `Citation` type only), `src/components/sources.tsx`, `src/lib/i18n/copy/chat.ts`, tests |

Order: Task 0 first (it changes the corpus every later measurement reads; then `pnpm ingest --pglite <copy> --reparse` locally). Tasks 1-2 and 4-5 in parallel; Task 3 after 1-2; Task 6 after the rest. Wave D2 (progression excerpts) follows wave C.

---

### Task 0: Group labels and banners at the source

**Files:** the parser modules that build article sections and lists, `src/lib/wiki/chunker.ts`, `src/lib/ingest/version.ts`; tests beside them.

The judge's top finding: 17 of 219 Usage sections hold group labels (biome names, "Seasonal", "DLC"; Resin's "Crafting", "Refueling", "Upgrading") as plain lines, which the stitcher joins into item lists ("Crafting: Black Forest, Finewood bow, …"). And page banners ("This article is marked to be outdated", "candidate for deletion": Stagger, Roadmap) reach contexts as chunks.

- [ ] **Step 1:** Measure both on the refreshed corpus (`pglite-full` after its run): rerun the verifier's label scan (`rag/fix/verify/label-scan.txt` describes its method) and count banner chunks. If parser v2 already fixed either, record it and skip that half.
- [ ] **Step 2: Write the failing tests** with fixtures (Finewood, Stone, Black Metal, Sap, Resin, Stagger): a label line followed by items becomes `Black Forest: Adze, Archery target, …` in the section's text (and in the reading document); a banner block (`notice`) produces no chunk.
- [ ] **Step 3:** Implement, bump the parser version as `version.ts` requires (fingerprint, history line), run the parser and chunker tests.
- [ ] **Step 4:** Re-derive the local copy (`pnpm ingest --pglite <copy> --reparse`), rerun the scan: 0 label lines joined into lists, 0 banner chunks.

### Task 1: The spotter

**Files:** `src/lib/craft/spot.ts`; `tests/unit/craft-spot.test.ts`; the recon's crafting question set copied to `tests/fixtures/craft-questions.json` (`craft/recon/chat/` holds the 45 questions and their 50 targets).

**Interfaces:**
```ts
export type SpotIndex; // opaque
export function buildSpotIndex(items: readonly GraphItem[], titles?: readonly TitleIndexEntry[]): SpotIndex; // items with a recipe or a use
export function spotItems(index: SpotIndex, text: string, limit?: number): ItemId[]; // limit 3
```
Names: English, Spanish (`es`, aliases) and the title index's Spanish names for the item's article; folded (accents, case, punctuation); plural variants (es `-s`/`-es`; en `-s`/`-es`/`-ies`); multiword names matched longest first, non-overlapping, returned in the order the text names them; a name shared by several items returns each (Drakkar).

- [ ] **Step 1: Write the failing tests:** the recon's set finds at least 43 of 50 targets with at most 2 unwanted; "¿Qué puedo hacer con el estaño y el bronce?" → Tin, Bronze; "espadas de hierro" → SwordIron; "Drakkar" → both items; a question naming none → [].
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** Implement. **Step 4:** Run; expect PASS.

### Task 2: The excerpt and its loader

**Files:** `src/lib/craft/excerpt.ts`, `src/lib/chat-server/craft.ts`; `tests/unit/craft-excerpt.test.ts`, `tests/integration/craft-excerpts.test.ts`.

**Interfaces:**
```ts
// excerpt.ts (pure)
export type CraftExcerpt = { id: ItemId; title: string; slug: string | null; text: string; tokens: number; maxQuality: number };
export function renderCraftExcerpt(index: GraphIndex, id: ItemId, options?: { lang?: Lang; maxUses?: number }): CraftExcerpt | null; // maxUses 24
// chat-server/craft.ts (server; memo 10 minutes like link-index.ts; never throws)
export async function craftExcerpts(db: Db, input: { question: string; previousQuestion?: string; queries: string[]; lang: Lang }): Promise<ScoredChunk[]>;
```
Format (English, verbatim names and integers; one line each):
```
Iron Sword › Recipe and uses
Made at Forge. One craft makes 1.
Quality 1 (Forge level 2): Wood 2, Iron 20, Leather scraps 3.
Quality 2 (Forge level 3): Wood 1, Iron 10, Leather scraps 2. From new to quality 2: Wood 3, Iron 30, Leather scraps 5.
…
Raw materials, new to quality 4: Wood 8, Scrap iron 80, Leather scraps 15 (smelting fuel: Coal 80).
Used in: Forge: Bronze sword (Bronze 8), …; Workbench: …; and 12 more on its page.
Spanish names: Espada de hierro; Madera; Hierro; Retazos de cuero.
```
Stations add "Upgrades: Forge cooler (+1 level): Fine wood 25, Copper 10; …" and "Made here, by level: 1: …; 2: …" (capped). The Spanish names line appears only for `lang: 'es'` and only for names the graph has. Excerpt chunks: `id: graph:<ItemId>`, `kind: 'recipe'`, `source: 'graph'`, `sectionPath: 'Recipe and uses'`, `url` of the article (or the wiki page), `pageKey` unset.

Selection in `craftExcerpts`: spot the question; if it names nothing, the previous question; add the rewrite queries' spots; keep items with graph data; at most 3, question order first.

- [ ] **Step 1: Write the failing tests:** the Iron Sword excerpt from the fixture graph holds "Quality 1 (Forge level 2): Wood 2, Iron 20, Leather scraps 3." and the 1→4 total; Tin's lists Bronze, Butcher knife, Cauldron, Mead ketill; an item with an unknown yield on its path has no raw line; Wood's use list stops at 24 with "and N more on its page"; the p99 excerpt is at most 230 tokens on the real graph (integration, measured on the refreshed copy); no graph stored → [] and one warning.
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** Implement. **Step 4:** Run; expect PASS.

### Task 3: One pinned stage

**Files:** `src/lib/rag/retrieve.ts`, `src/lib/rag/stitch.ts`, `src/lib/rag/intent.ts`, `src/lib/rag/plan.ts`, `src/lib/chat-server/answer.ts`, `src/app/api/chat/prepare/route.ts`; `tests/integration/retrieve.test.ts`, `tests/integration/chat-route.test.ts`, `tests/integration/chat-puter.test.ts`.

**Interfaces:** `RetrieveOptions` gains `craft?: () => Promise<ScoredChunk[]>` (the caller binds `craftExcerpts`); retrieve returns `[...craft, ...intentPins, ...ranked]` with the pinned part capped by `PINNED_MAX_TOKENS` (choose from measurement; start at 2,400) and at most 4 slots, the rest filled by ranking up to `topK` and the 6,000-token budget; an article already present as a recipe excerpt is not pinned a second time through its Usage section unless the question is a uses question.

Judge fixes owned here (`judge.recommendations` 4-7):
- Where-questions: no Usage section is stitched into a where context; slots that stitching frees are refilled from the ranking; `planQueries` rewrites where-questions in `auto` mode (measured better: es-where kept Tin Deposit › Availability).
- Uses-questions: when a pin exists, other articles' Usage sections stay single chunks (no whole-section stitching), so another item's list never sits beside the asked one looking as authoritative.
- Rewrite names snapped to the title index before searching (Fine wood → Finewood, Core wood → Corewood, Blackmetal → Black metal): a query span that folds equal to a title without spaces or punctuation is replaced.
- Off-topic: when nothing in the context shares a term with the queries and the best vector similarity is under a floor measured on the golden set and 10 off-topic probes, skip the answer call and send the existing no-context reply.

Wiring: `answer.ts` and the Puter prepare route pass `craft` (Puter with `deterministicQueries`); the empty check becomes "no chunks and no excerpts".

- [ ] **Step 1: Write the failing tests:** with a mocked model, the prompt for "¿Cuánto hierro necesito para una espada de hierro nivel 4?" starts `[1] Iron Sword › Recipe and uses` and its citation 1 has `kind: 'recipe'`; the Puter prepare route returns the same excerpt and a grant whose citations verify; a where-question's context has no stitched Usage section; an off-topic probe makes no answer call; the pinned part never exceeds its cap.
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** Implement. **Step 4:** Run the three integration files and the evals (`pnpm eval -- --pglite <copy> --rewrite off`, `--sections`): golden recall not below 97.6% and sections not below 52/54 on the refreshed copy's own baseline.

### Task 4: Prompt rules

**Files:** `src/lib/rag/prompt.ts`, `src/lib/rag/rewrite.ts`; `tests/unit/prompt.test.ts`, `tests/unit/model-rewrite.test.ts`.

- One precedence rule (about 64 tokens, both languages): for an item's amounts, stations and uses, prefer its "Recipe and uses" excerpt and copy its totals instead of adding numbers; where a list page disagrees, follow the item's excerpt (do not cite both).
- The names rule as an instruction to copy (judge rec. 2): copy every item, structure, creature, biome and place name exactly as the excerpt writes it, in English, letter for letter, because that is how the wiki names it; a Spanish translation, if added, goes after it in parentheses, never instead. Examples must not be names any eval or lab question asks about.
- Answer first, lists included (judge rec. 3): even when the answer is a list, the first sentence names the main items for each thing asked; never a bold label or an empty sentence first; when the question names several things, each gets its own bold line.
- Rewrite (judge rec. 6): boss intents map to "X summoning" and "X drops"; the instructions keep "never usage or crafting".
- [ ] **Step 1:** Tests: each rule present in both languages, the size budgets updated (Spanish ≤ 3,900 characters, English ≤ 3,500), no example name collides with `tests/eval/*.jsonl` or the lab's questions, the voseo checks still pass. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.

### Task 5: Recipe citations in the answer

**Files:** `src/lib/db/schema.ts` (`Citation` gains `kind?: 'recipe'` and `craft?: { id: ItemId; maxQuality: number }`), `src/lib/rag/prompt.ts` is not touched here (buildContext copies the fields from the chunk: coordinate with the prompts owner, who owns that file; the change is two lines), `src/components/sources.tsx`, `src/lib/i18n/copy/chat.ts`; tests: `tests/unit/sources.test.tsx` or the chat component tests, `tests/integration/chat-history.test.ts` (an old stored citation without `kind` still loads).

The source row stays one link; a recipe row gets a sibling button "Agregar al taller" / "Add to Craft" (wave B `plannerStore`, `addItem` level 1, one craft) that becomes "En tu taller · Ver" linking to `/wiki/craft`; 44 px on coarse pointers; no change for other rows.

- [ ] **Step 1-4:** test first (old citations render; a recipe citation shows the button; the grant size of a three-excerpt answer stays far below 16,384 characters), implement, PASS.

### Task 6: Evals and the answer lab

**Files:** `scripts/eval.ts` (`--craft`: the spotter on the crafting set, no model), `tests/eval/golden.jsonl` (crafting cases whose target is the item's article), lab copies under the scratchpad.

- [ ] **Step 1:** `pnpm eval --craft` reports targets found and unwanted items; the floor is 43/50.
- [ ] **Step 2:** The answer lab (`rag/fix/verify/lab/answer-lab.mts`, copied) on its 14 questions plus 6 crafting ones (Iron Sword level 4, Karve raw, Poison resistance mead batch, Tin uses, Finewood uses, Forge upgrades), 3 samples each on Groq, and on Gemini once its quota allows (≤ 18 Gemini requests). Automatic flags: English names present in the context but missing from the answer, misspellings of names in the context (Mead ketill), biome labels listed as items, a bold label as the first line, numbers not present in the context. Budget: 150 provider requests in total.
- [ ] **Step 3:** An independent judge compares with the AFTER answers of the chat-quality fix (`rag/fix/verify/lab/out-after/`).

---

## Wave D2: progression excerpts (after wave C)

- A progression intent (frames: "qué hago después de", "qué necesito para (ir|cruzar|entrar) a", "antes de pelear con", "what next after", "what do I need for <biome>", "how do I get to") plus the spotter over boss and biome names selects at most two stages.
- `renderProgressionExcerpt(stage)` from `snapshot.json` and `milestones.ts`: the boss (summon items and counts, altar, Vegvisir, drops and what each unlocks, power), the stage's entry gates (key, tool, resistance, transport), the critical milestones in order, and the station levels reachable; English names verbatim; about 200 tokens.
- It joins the pinned stage (Task 3) under the same cap.
- Golden questions (recon `domain.md` §7): "¿Qué necesito para cruzar a las Ashlands?" → Drakkar, Ceramic plate, Majestic carapace; "¿Cómo despejo la niebla de las Mistlands?" → Wisplight, Wisp fountain, Torn spirit; "¿Qué hago después de matar a Bonemass?" → Wishbone, Silver, Iron pickaxe, Frost resistance mead; "What forge level do I need for the Frostner?" → 3.
