# Crafting wave C: progression — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the guide into the player's progress tracker: facts derived from the corpus into a committed snapshot, about 80 curated milestones whose every fact is checked against that snapshot, a deterministic "your next step", tickable bosses and milestones that never lose a tick, the guide's 17 wrong statements corrected and its gaps filled, and a next-step card on the home page.

**Architecture:** A read-only script derives a `snapshot.json` from a local corpus copy and the recipe graph (bosses, stages, stations, tool gates, tiers, and the text found at every evidence pointer the milestones cite). Curated modules hold what needs a human (which milestones matter, bilingual sentences, tier seeds, conflict picks). A pure engine computes the next step from the ticked set. One shared device store (`wv-progress-v1`, wave B's `local-store`) serves the guide, the home card and the planner, and every save merges.

**Tech Stack:** TypeScript, Next.js 16.4.3 server components, React 19 (`useSyncExternalStore`), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-27-crafting-and-progression-design.md` §9 (and §11 storage, §12 design). Evidence: the domain recon in the session scratchpad (`craft/recon/merged/domain.md`: §2 measurements, §3 stages with sources, §4 guide audit, §6 model, §7 next step) and its prototypes (`craft/recon/domain/derive.mjs`, `tiers3.mjs`, `progression-derived.json`, `tiers-derived.json`). UI context: `craft/recon/merged/ui.md` §3.4-3.5, `PRODUCT.md`, `DESIGN.md`.

## Global Constraints

- The snapshot is built from the **refreshed local corpus** (`pglite-live`, wave A Task 11: parser v2, fetched after the game's 1.0 date) opened read-only through `openScriptDatabase({ pglite }, { writes: false })`. Never the production database.
- The live wiki now describes the game after 1.0. Wherever the recon describes the pre-1.0 corpus (the Deep North as a placeholder, "1.0 arrives September 9"), the refreshed corpus decides. If it documents the Deep North as playable (no `Unfinished` category, a boss with a world key in `[global-keys]`), it is stage 8 with its own boss and milestones; otherwise one "announced" card.
- Milestone ids are `p-` prefixed, unique, and **never reused or reassigned**; a removed milestone's id is retired in a frozen list in the test. Existing guide checkbox ids (`c-*`, `m-*`, `bf-*`, `sw-*`, `mt-*`, `pl-*`, `ml-*`, `as-*`, `h-barber`, `t-*`) keep their meaning.
- Spanish is rioplatense voseo; the voseo lint rejects "puedes", "tienes", "debes", "quieres", "eres", "haz ", "ve a", "construye", "craftea" (imperative tú forms). In-game item names stay English in guide chips (the guide's convention, PRODUCT.md); interface labels follow `copy/guide.ts`.
- Client components read copy through `useStrings()` only; the guide's `Item` chips are server-only (`guideRequest()`), so anything a client component renders uses plain names.
- Storage: `wv-progress-v1` is read as the union with the legacy `wv-guide-checks-v1`; every save merges (adds what was ticked here, removes what was unticked here). Every access wrapped.
- Design: DESIGN.md (no new colours; forge for the current place and counts; blood only for what costs a death; 44 px targets on coarse pointers; nothing that holds values clips). New guide classes go in `src/app/styles/guide.css`; the home stays utilities-only.
- No commits; run the task's tests instead. Read `node_modules/next/dist/docs/` before route or client navigation code.
- Concurrent workflows may own `src/lib/rag/*`, `src/app/api/chat/**`, `scripts/eval.ts`: do not edit them in this wave.

## Review Focus

1. **A tick made outside the guide** (home card, planner, an old offline build of the guide that only knows the 54 legacy ids): it survives every guide save, and a legacy-only build writing `wv-guide-checks-v1` does not erase new ids from `wv-progress-v1`. Pinned in Task 5.
2. **Bosses beaten out of order** (Moder before Bonemass; only the Queen ticked): two cursors, the skipped boss offered as catch-up, never "you are in the Meadows". Pinned in Task 4.
3. **A wiki fact that changes under a milestone** (a re-ingest turns "Dragon tear x2" into "x3"): the evidence test fails in CI until a person reviews the milestone. Pinned in Task 3.
4. **Inferred prerequisites** (ticking "Lo derroté" on Bonemass marks the Swamp key and the Elder as done, shown as inferred and untickable without unticking the cause): never a silently ticked box the reader cannot explain. Pinned in Tasks 4 and 6.
5. **Readers who never tick anything** (no storage, blocked storage, a crawler): the guide reads exactly as a guide, the home shows the guide card, no layout shift when hydration finds progress. Pinned in Tasks 6 and 8.

---

## Owners, files and order

| Owner | Tasks | Files |
|---|---|---|
| **data** | 1-4 | `src/lib/progression/{types,seeds,tiers,milestones,next-step,snapshot-build}.ts`, `src/lib/progression/snapshot.json`, `scripts/progression-snapshot.ts`, `tests/unit/progression*.test.ts` |
| **tracker** | 5-6 | `src/lib/progression/progress-store.ts`, `src/components/wiki/guide/guide-progress.tsx`, `guide-ui.tsx`, the guide's table of contents component, new `src/components/wiki/guide/{boss-check,milestone-list,chapter-progress,progress-strip,gear-tiles}.tsx`, `src/app/styles/guide.css`, `src/lib/i18n/copy/guide.ts`, tests |
| **content** | 7 | `src/components/wiki/guide/guide-data.tsx`, `guide-content.tsx`, `src/app/wiki/guide/page.tsx` |
| **home** | 8 | `src/app/wiki/page.tsx`, `src/components/wiki/next-step-slot.tsx` (new), `src/components/wiki/next-step-card.tsx` (new) |

Order: Task 1 needs wave A's refreshed corpus and graph. Tasks 1→2→3→4 in sequence (data). Task 5 starts at once (needs wave B's `local-store`). Task 6 after 3-5. Task 7 after 3 (it cites the same facts). Task 8 after 4-5. Task 9 last.

---

### Task 1: Types and the snapshot

**Files:**
- Create: `src/lib/progression/types.ts` (the recon's §6 model, adapted below), `src/lib/progression/snapshot-build.ts` (pure: corpus rows + graph → snapshot), `scripts/progression-snapshot.ts` (CLI: opens the corpus read-only, loads the latest recipe graph, writes the JSON), `src/lib/progression/snapshot.json` (committed output)
- Modify: `package.json` (`"progression:snapshot": "tsx scripts/progression-snapshot.ts"`)
- Test: `tests/unit/progression-snapshot.test.ts`

**Interfaces:**
- Consumes: `openScriptDatabase` (`scripts/_db.ts`), articles (`doc` v2: infobox tabs, sections, tables), `getLatestRecipeGraph` (wave A), `RecipeGraph`.
- Produces: the recon's `ProgressionSnapshot`, `BossFacts`, `StageFacts`, `StationFacts` with these changes: stations and items are keyed by the graph's `ItemId` where one exists (slug kept beside it); `StationFacts.levelCap` is computed from extension tiers (Task 2); `meta = { builtAt, corpusFetchedAt, gamePatch, parserVersions, graphVersion }`; a new `evidence: Record<string, string>` maps `evidenceKey(e)` (`${slug}|${JSON.stringify(where)}`) to the normalized text found at that pointer, for every pointer `milestones.ts` cites (the script imports the milestones to know which). `export function buildSnapshot(input: SnapshotInput): ProgressionSnapshot` and `export function evidenceKey(e: Evidence): string`.

Derivations (recon §2, §5; prototype `derive.mjs`): boss order from the lead ("is the Nth boss"), world keys from `[global-keys § Boss Keys]`, altar, summon and Vegvisir from `[forsaken-altars § Altars]` (fix the Queen's shifted row by matching on the boss name), HP, power and weaknesses from `[creatures § Bosses]`, drops from each boss's `§ Aftermath > Drops` table, unlocks from each drop's `§ Usage`, power text from `[forsaken-power]`, raids from `[events § World-based]`, trader unlocks from trader tables' `Availability`; stages from each biome's infobox groups; tool gates from `[pickaxes § List of pickaxes]` and `[tools § Logging (Axes)]`; no-teleport items from infoboxes; stations, extensions and recipes from the graph. Filter `hive` / `the-hive` (category `Unfinished`). Conflict picks come from `seeds.ts` (Task 2).

- [ ] **Step 1: Write the failing tests** with fixture rows (extend `tests/fixtures` with the needed pages' `action=parse` JSON, parsed by the repo's parser): seven bosses in order with keys `defeated_eikthyr` … `defeated_fader`; Eikthyr's summon is Deer trophy ×2; Yagluth's drops include Torn spirit ×3; the Artisan table's recipe is Dragon tear ×2 and Wood ×10; the Galdr table's maximum level is 4; the Iron pickaxe mines Silver; the Bronze axe chops Finewood's trees; `evidence` holds the text at each requested pointer and nothing else.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement the builder, then the CLI (`--pglite <dir>` required; refuses `--neon` and any `DATABASE_URL`; refuses unless every article is at the current `PARSER_VERSION`; prints a summary and the list of facts it could not derive).
- [ ] **Step 4:** Run the tests; then run the CLI against `pglite-live` and commit nothing; check the JSON by eye against the recon's §3 for each stage.

### Task 2: Seeds and tiers

**Files:**
- Create: `src/lib/progression/seeds.ts`, `src/lib/progression/tiers.ts`
- Test: `tests/unit/progression-tiers.test.ts`

**Interfaces:**
- Produces: `TIER_SEEDS: Record<ItemId, StageId>` (about 70; earliest legitimate source; each with a one-line reason), `ALIASES: Record<string, ItemId>` (Raw meat → Boar meat, plurals), `CONFLICT_PICKS` (Moder's power from `[forsaken-power]`; Fader's Vegvisir from `[fader § Summoning]`; each with the two sources and the reason); `deriveTiers(graph: RecipeGraph, seeds: Record<ItemId, StageId>, stages: StageFacts[]): Record<ItemId, StageId>` (rules from recon §2.6: a recipe beats a seed; only Unique and Food lists seed; dungeon loot by location; boss drops count from the next stage; `tier = max(tier(material), tier(station))`).

- [ ] **Step 1: Write the failing tests** on the committed snapshot's graph: Bronze sword = black-forest, Frostner = mountain, Krom = mistlands, Black metal pickaxe = mistlands, Drakkar = ashlands, Smelter = black-forest, Stonecutter = swamp; every item whose article states a tier agrees (recorded in the snapshot as `statedTiers`); coverage of recipe products at least 84%.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement; the snapshot script stores `tiers` and the stations' `levelCap` per stage.
- [ ] **Step 4:** Run; expect PASS. Regenerate `snapshot.json`.

### Task 3: Curated milestones with evidence

**Files:**
- Create: `src/lib/progression/milestones.ts`
- Test: `tests/unit/progression-milestones.test.ts`

**Interfaces:**
- Produces: `MILESTONES: readonly Milestone[]` (recon §6 shape; `target` uses `ItemId` with `level` and `qty` so it maps to a planner `PlanItem`); `RETIRED_IDS: readonly string[]` (empty now); `milestoneText(m, lang): string` (tokens `{ItemId}` / `{ItemId|3}` rendered as plain names, for client use).

Content: 10-13 per stage, every stage the refreshed corpus makes playable, covering for each: entry gates (key, tool, resistance, transport), the stations and the levels the stage's gear needs (with extensions), the gear sets worth making, the food and mead line, the boss summon, the boss, and what its drop unlocks. Use the recon's §3 stage lists and §7 critical paths (Swamp: Swamp key + Poison resistance; Mountain: Frost resistance + Iron pickaxe; Plains: Artisan table; Mistlands: Wisplight + Black metal axe; Ashlands: Drakkar + Portal stone). Kinds: `boss` (one per stage, id `p-boss-<stage>`), `unlock`, `build`, `upgrade`, `craft`, `cook`, `prepare`, `gather`, `locate`, `summon`. Each milestone has at least one evidence pointer with an `expect` literal, and the snapshot's `evidence` must contain that literal.

- [ ] **Step 1: Write the failing tests:** ids unique, `p-` prefixed, none in `RETIRED_IDS`, frozen against a committed list (a removed id fails until it is moved to `RETIRED_IDS`); every `after` resolves and the graph is acyclic; exactly one `boss` milestone per playable stage; every `{ItemId}` token and every `target` id exists in the recipe graph or the snapshot; both languages non-empty; the voseo lint (Global Constraints); every evidence pointer's `expect` occurs in `snapshot.evidence[evidenceKey(e)]`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Write the milestones; rerun the snapshot script (it records the cited pointers); iterate until green.
- [ ] **Step 4:** Run; expect PASS.

### Task 4: The next step

**Files:**
- Create: `src/lib/progression/next-step.ts`
- Test: `tests/unit/progression-next-step.test.ts`

**Interfaces:**
- Consumes: `MILESTONES`, the snapshot, the recipe graph (for derived prerequisites and "how").
- Produces:

```ts
export type Progress = ReadonlySet<string>; // ticked ids, milestones and legacy guide ids alike
export type DoneState = { done: ReadonlySet<string>; inferred: ReadonlySet<string> };
export function doneState(ticked: Progress, milestones?: readonly Milestone[]): DoneState; // ticked ∪ transitive prerequisites; legacy ids map through LEGACY_IMPLIES
export const LEGACY_IMPLIES: Record<string, `p-${string}`[]>; // e.g. sw-crypt ⇒ the Swamp key milestone; mt-silver ⇒ Wishbone and Iron pickaxe
export function cursors(done: DoneState): { cleared: StageId | null; reached: StageId | null; current: StageId };
export type NextStep = { milestone: Milestone; reason: 'critical' | 'catch-up' | 'unblocks' | 'prep'; unblocks: string[]; how: { station?: { id: ItemId; level: number }; targets: PlanItem[] } };
export function nextSteps(ticked: Progress, count?: number): NextStep[]; // default 3: the top step and two alternatives
export function stageProgress(done: DoneState): Record<StageId, { done: number; total: number }>;
```

Ranking (recon §7): critical path to the current boss or the next stage's entry gate; then earlier-stage leftovers (`catch-up`); then how much each unblocks; optional last; ties by the milestones' order in the file.

- [ ] **Step 1: Write the failing golden tests:** nothing ticked → the Workbench milestone; Eikthyr → Antler pickaxe; the Elder → the Swamp key (and Iron next); Bonemass → Iron pickaxe and Frost resistance mead among the three; Yagluth → Wisp fountain, then Wisplight; the Queen → Artisan press, Ceramic plates, Drakkar; Fader → the Deep North (playable stage's first milestone, or the announced card); only Moder ticked → Moder's stage is `reached`, Bonemass offered as `catch-up`; ticking Bonemass infers the Elder and the Swamp key (`inferred`, not `ticked`).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.

---

### Task 5: Progress storage that merges

**Files:**
- Create: `src/lib/progression/progress-store.ts`
- Modify: `src/components/wiki/guide/guide-progress.tsx`
- Test: `tests/unit/guide-progress.test.ts` (extend), `tests/unit/progress-store.test.ts`

**Interfaces:**
- Consumes: wave B `createLocalStore`, `useLocalStore`.
- Produces: `PROGRESS_KEY = 'wv-progress-v1'`, `LEGACY_PROGRESS_KEY = 'wv-guide-checks-v1'`, `progressStore: LocalStore<ReadonlySet<string>>` (reads the union of both keys; writes the new key only; ids validated as `^[a-z][a-z0-9-]{0,63}$`, at most 2,000), `applyPageTicks(stored, pageIds, checkedOnPage): ReadonlySet<string>` (stored − (pageIds − checked) ∪ checked: removes only what this page shows unticked).

`GuideProgress` restores ticks from `progressStore` and on every change saves `applyPageTicks(...)` through the store; it re-applies ticks when another tab or another component writes (`useLocalStore`).

- [ ] **Step 1: Write the failing tests:** an id that is not on the page survives a save; unticking on the page removes only that id; the legacy key's ids are read; writing never touches the legacy key; a legacy build writing `wv-guide-checks-v1` later does not remove ids from the new key; malformed values read as empty.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.

### Task 6: The guide as tracker

**Files:**
- Create: `src/components/wiki/guide/{boss-check,milestone-list,chapter-progress,progress-strip,gear-tiles}.tsx`
- Modify: `src/components/wiki/guide/guide-ui.tsx` (boss card heading, chapter head, chapter body), the guide's table of contents component, `src/app/styles/guide.css`, `src/lib/i18n/copy/guide.ts`
- Test: `tests/unit/guide-tracker-model.test.ts`, `tests/unit/strings.test.ts` (keys added to the guide area)

What it adds (spec §9.2, recon UI §3.4):
- A "Lo derroté" / "Defeated" checkbox in each boss card's heading (id `p-boss-<stage>`); the master boss table shows the same state read-only.
- A per-chapter "Hitos" / "Milestones" checklist from `MILESTONES` (server-rendered labels with `<Item>` chips; inferred items shown checked-and-dimmed with "por {cause}" / "from {cause}" and an explanation on focus).
- Gear tiles from each stage's milestones' targets with "Agregar todo al taller" / "Add all to Craft" (wave B planner store, `mergeItems`), announcing the result.
- Per-chapter progress "4 de 11" / "4 of 11" with a thin bar in `.g-chapter-head`; a mark per biome in the table of contents; a strip at the top of the guide with the seven boss runes lit as each falls and the next step (`nextSteps(…, 1)`), linking to its chapter.
- Copy keys: `guideDefeated`, `guideMilestones`, `guideChapterProgress` ("{done} de {total}"), `guideInferredFrom`, `guideAddAllToCraft`, `guideAddedToCraft`, `guideNextStep` ("Tu próximo paso"), `guideNextStepWhy`, `guideAllDone`.
- Everything that depends on storage renders after hydration (`useLocalStore` is null on the server), so the server HTML is the plain guide.

- [ ] **Step 1: Write the failing tests** for the model helpers (which milestones a chapter lists, how inferred ones are labelled, the strip's rune states).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement, following the impeccable steps (context, craft floor, detector).
- [ ] **Step 4:** Run; expect PASS. In a browser at 390 and 1280 px: tick Bonemass, the strip lights three runes, the Swamp chapter shows inferred items, the next step names the Iron pickaxe or Frost resistance mead.

### Task 7: The guide's facts

**Files:**
- Modify: `src/components/wiki/guide/guide-data.tsx`, `guide-content.tsx`, `src/app/wiki/guide/page.tsx`
- Test: `tests/unit/guide-data.test.ts` (new: the corrected facts as literals)

Correct the 17 statements of recon §4.1 (each against the refreshed corpus, which wins where it differs from the recon), fill the gaps of §4.2 in priority order (§8: Wisp → Wisplight and Torn spirit ×3; tool gates; the Drakkar and Shield core chain and the Portal stone; station extensions and the levels gear needs; the food and mead line with Poison, Frost and Fire resistance; the missing armor sets and per-stage raids; Bog Witch exact unlocks; Iron Pit in `PORTAL_BLOCKED`; Raw Meat, Fuling Archer, Fenris coat, Elaking), generate the boss cards' drops, summons and powers from the snapshot, and replace the hand-written "current as of" line with the snapshot's `meta` ("Datos de la wiki del {date}, parche {patch}"). Rewrite the Deep North section from the refreshed corpus. Every new passage in both languages, voseo, item chips as today.

- [ ] **Step 1: Write the failing tests:** the Artisan table passage says 2 Dragon tears; Yagluth's drops include Torn spirit; the Galdr table's maximum is 4; `PORTAL_BLOCKED` includes Iron Pit; no "Fuling Archer", "Elakingar" or "Raw Meat" chip remains; the date line comes from `snapshot.meta`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS. Read both language versions of every changed chapter in a browser.

### Task 8: The next step on the home page

**Files:**
- Create: `src/components/wiki/next-step-slot.tsx` (`'use client'`), `src/components/wiki/next-step-card.tsx`
- Modify: `src/app/wiki/page.tsx`
- Test: `tests/unit/next-step-slot.test.ts` (the decision helper)

The server passes the ordered milestones in the reader's language (`{ id, text, stage, chapterHref }`, about 5 KB) and wraps the guide card: `<NextStepSlot milestones={…}><FeaturedGuideCard lang={lang} /></NextStepSlot>`. On the server and while hydrating it renders its children; after hydration, when the reader has progress or a planner list, it shows the next-step card in the same box at the same minimum height (71 px desktop, 91 px phone): the stage's rune, "Tu próximo paso · {stage}", the step, "Ver en la guía" (chapter anchor) and, with a planner list, "Tu taller: {n} objetos · faltan {m} materiales" linking to `/wiki/craft` (counts from the store; the material count only once the graph is loaded, never guessed). Tailwind utilities only.

- [ ] **Step 1: Write the failing tests:** no progress and no list → children; progress → the card; a list only → the card with the taller line; storage blocked → children.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS. In a browser: no layout shift when the card replaces the guide card (CLS 0 in a performance trace).

### Task 9: Whole-wave checks

- [ ] **Step 1:** `pnpm exec tsc --noEmit -p .`, `pnpm lint`, `pnpm test`: PASS.
- [ ] **Step 2:** E2E (`tests/e2e/guide.spec.ts` extended; phone and desktop, both languages): ticking Bonemass changes the home's next step; a tick made on the home card survives a tick in the guide; the guide without JavaScript reads as before; no sideways scroll at 360 px.
- [ ] **Step 3:** Run against the dev server on the refreshed corpus: PASS. Screenshots of the guide's strip, a chapter with progress and inferred items, the boss card checkbox, the gear tiles, and the home card, at 390 and 1280 px in both languages; the impeccable detector on every changed UI file.
