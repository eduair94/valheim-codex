# Crafting and progression companion

Date: 2026-10-27. Status: approved for implementation. The owner set the goal
("I need the valheim app to be the ultimate tool to help valheim players to
craft items and progress ingame"), skipped the questions and delegated every
decision ("do as you recommend"). Every decision below is the builder's call
and is listed in §15 so it can be checked.

This document is the shared contract for the work: what gets built, why, the
interfaces between the pieces, and the order. It rests on four read-only
reconnaissance reports (data, UI, chat, game progression) kept outside the repo
in the session scratchpad; the numbers quoted here come from them.

## 1. Intent

A Valheim player opens the Codex in the middle of a session, usually on a phone
next to the keyboard, with one of four questions:

1. **"What do I need to make this?"** Exact materials for the level they want,
   how many in total, which station and station level, and what those
   materials break down into (bronze is copper and tin; a Karve's 80 nails are
   4 bronze, not 80).
2. **"I have this; what can I do with it?"** Everything a material is used in,
   and what they can craft right now from what is in their chests.
3. **"What should I do next?"** Where they are in the game (bosses beaten,
   stations upgraded, gear made), the next step that matters, and why.
4. **"Can you just tell me?"** The chat, answering the same questions with the
   same exact numbers, in Spanish (voseo) or English.

The wiki already holds almost all of these facts, but as prose and per-page
infoboxes. The app's job is to turn them into answers: computed, exact, in the
reader's language, and usable offline. Success is a player who stops opening
three wiki tabs and a calculator.

## 2. Goals, non-goals, anti-goals

**Goals**

1. A **recipe graph** derived from the wiki: every craftable item, building
   piece, processed material and food, with station, station level per upgrade
   level, materials per level, yield per craft, and the reverse index (used in).
2. On every **item page**: a craft card with this level's cost, the total from
   level 1 to N, the breakdown to raw materials, the stations needed, a
   quantity stepper and "Agregar al taller". On materials, a "Usado en"
   section; on stations, their upgrade path.
3. A **planner** ("Taller", `/wiki/craft`): a list of things to make, one
   aggregated shopping list (direct or raw), the stations needed, ticks for
   what has been gathered, "what can I craft with what I have", saved on the
   device and shareable by link.
4. The **guide becomes the progress tracker**: tickable bosses and milestones,
   progress per biome, gear sets that go to the planner in one tap, a "your
   next step" card on the guide and the home page, and the guide's 17 wrong or
   stale statements corrected.
5. The **chat** answers crafting and progression questions from the graph's
   exact rows, cites them, and offers "Agregar al taller".
6. All of it Spanish-first (rioplatense voseo) and English, phone-first, fast,
   accessible, and working offline after one visit.

**Non-goals**

- Accounts, cloud sync or server-side storage of plans and progress. They live
  on the device; share links are the backup and the way to move them.
- Reading game save files, mods, or a live connection to the game.
- Tool calling in the chat (measured: about 2.1× the input tokens and one more
  request per answer, on free tiers that are already exhausted).
- A redesign. New surfaces extend the incumbent firelit-camp identity.

**Anti-goals (failure even if it "works")**

- **A wrong number.** A total that ignores a yield (80 bronze for a Karve) or a
  stale list page's cost is worse than no total. When a yield or a recipe is
  unknown, the UI says so and does not compute past it.
- Losing a reader's progress or list (storage overwrites, id reuse).
- Making article pages heavier or slower: the whole graph never goes into a
  page payload.
- English-only strings in the Spanish interface, or tuteo.

## 3. What exists today, and why the stored data is not enough

- Articles store an infobox tree per page (`articles.infobox`), with the
  recipe as a `Crafting Materials` row per upgrade tab, the station as a free
  text `Source` row and the station level as `Crafting Level` per tab. Each
  tab is the cost of that step only (Iron Sword 1→4 totals 8 Wood, 80 Iron,
  15 Leather scraps, matching the wiki's own Total).
- **Every stored article is parser version 0** (ingested 2026-08-20, game patch
  0.221.12). Parser versions 1 and 2 exist in the working tree but were never
  run against the stored corpus. 220 of 1,027 pages have changed on the wiki
  since, and the game's 1.0 date (2026-09-09) has passed.
- What the stored data has lost, and a planner needs:
  - **Yields.** "Crafts 20" (nails, arrows), 10, 6 (meads), 5, 4 were dropped.
  - **Links.** Material names are plain text; matching by name reaches 95.3%,
    while the wiki's own links plus its redirect list resolve 99.9%,
    intermediates included (mead bases, cooked meats, doughs, trophies).
  - **Secondary infoboxes.** Only the first infobox per page is read; 82 more
    hold recipes (all 18 mead bases, cooked meats, unbaked dishes, armor
    pieces).
  - **Armor recipes** (none in v0; v2 writes them quantity first, "5 Bronze",
    which `parseRecipe` does not read).
- The guide (`src/components/wiki/guide/guide-data.tsx`) is hand-written,
  bilingual, dated "21 Aug 2026, patch 0.221.12", with 54 checkboxes (no
  bosses, stations or gear) and 17 statements the corpus contradicts
  (Artisan table needs 2 Dragon tears, not 10; Yagluth also drops 3 Torn
  spirit; the Galdr table's maximum is 4; ...).
- The chat answers crafting questions from retrieved prose, which is
  incomplete (5 of 58 Finewood uses) and sometimes stale (5 leather scraps for
  the Iron Sword, from a list page; the item's own page says 3).

## 4. Key decisions

| Decision | Why |
|---|---|
| Recipes are **extracted from each page's HTML at ingest**, into their own table, and **assembled into one versioned graph per run**. | The stored reading document has already discarded links, yields and secondary infoboxes. Re-deriving them would mean making every article payload heavier. |
| Recipe extraction has **its own version** and its own ingest mode (`pnpm ingest --recipes`), independent of the article parser. | The graph can ship without re-parsing articles. A v2 article re-parse marks about 850 Spanish translations stale, and re-translating is quota-bound; that stays a separate, deliberate step. |
| Item identity is the **game's internal ID** (`SwordIron`, `MeadBasePoisonResist`); a slug-derived id only where the wiki gives none. | 539 of 543 article items and 87 of 88 secondary infoboxes have one, unique. They survive wiki renames (Odin → Oden) and are language-free, so saved lists, progress and share links stay valid. |
| Wiki data errors are corrected in a **visible overrides file**, and conflicts are **reported, not silently fixed**. | The wiki contradicts itself (Black forge recipes at level 6-7 against a stated maximum of 5; Cauldron food levels). A silent clamp would hide a wrong number. |
| The graph reaches the browser through **two channels**: a 1-3 KB server-computed slice for each article, and one cached, versioned `GET /api/wiki/recipes?v=1` (about 27 KB gzip) for the planner. | Article pages stay light and work offline from the saved HTML; the planner gets everything in one download the service worker keeps. |
| All crafting maths lives in **one pure, isomorphic library** (`src/lib/craft/math.ts`). | The card, the planner, the guide's gear tiles and the chat excerpts must agree to the unit. |
| Plans and progress are **stored on the device** (`wv-craft-v1`, `wv-progress-v1`) through one shared store with cross-tab sync, and travel by **share link**. | No accounts exist for readers; the wiki is public. Device storage is enough for a companion, and share links cover moving a list. |
| **One new tab**, "Taller", in the centre of the bar; the guide becomes the tracker in place. | The phone bar fits five tabs only with a compact language button (60.8 px each at 360 px); six would be about 50 px. The guide already owns progression and its URL, shortcut and offline copies. |
| Progression facts come from a **committed snapshot derived from the corpus**, plus a **small curated milestone file** whose every fact points at the corpus and is checked by a test. | The corpus holds boss summons, drops, unlocks, station extensions and tool gates; only "which milestones matter" and the bilingual sentences need a human. The evidence test makes a changed wiki fact fail CI instead of drifting. |
| The chat gets **exact "Receta y usos" excerpts** built from the graph for the items a question names (at most 3), as one pinned stage with the retrieval fixes' pins. No tool calling. | Measured: a name spotter finds 43 of 50 targets with no model; an excerpt costs 36 tokens at the median and 216 at most; it works on the Puter path, where the server signs the citations. |

## 5. The recipe graph

### 5.1 Extraction (per page, at ingest)

`src/lib/wiki/recipes.ts` exports a pure `extractRecipes(html, page)` that runs
in `ingestOnePage` on the same fetch as `extractArticle`. It reads:

- **Every infobox on the page**, each identified by page plus tab (a secondary
  infobox becomes `Poison Resistance Mead#Mead base`), with its title and
  `Internal ID`.
- `Source`, with its links (the station or stations; "Forge; Smelter",
  "Cauldron, Workbench", or a non-station: a creature, a deposit, a trader,
  "Player crafting menu").
- Per quality tab: `Crafting Level`, the "Crafts N" yield, and the entries as
  `{ text, qty, href }`, in both "Name xN" (also "x N") and "N Name" forms, in
  `<li>` lists or `<br>` runs; "n/a", "nil" and "-" mean nothing.
- On stations: `Max Level` and `Improvements`; on extensions: `Usage:
  Upgrades X`.
- The structure list tables (about 185 building pieces with no article of
  their own, 212 of 214 rows parse) and the Food page's station-level and
  multiplier columns.

The result is stored per page in a new table, `page_recipes(page_key primary
key references pages on delete cascade, recipes_version, revid, data jsonb,
updated_at)`, written by one upsert before the article (Neon's HTTP driver
has no transactions; the page stays marked unfinished until its article is
written, so an interrupted page is redone). Its version constant,
`RECIPES_VERSION`, lives in its own module, with the same "bump with any
output change, record the fixture fingerprint" rule as `PARSER_VERSION`.

### 5.2 Assembly (once per ingest run)

A pure `assembleGraph(pages, redirects, overrides, names)` in
`src/lib/craft/assemble.ts`, called at the end of `runIngest` whenever any
page's recipes changed (or with `--recipes`):

1. **Resolve** every entry by its link, through the wiki's redirect map
   (fetched once per run: about 3 requests for the titles recipes use, or 32
   for all 1,433 redirects), to a page, or to page#tab for intermediates
   (`Cooked deer meat → Deer Meat#Cooked`, `Deer trophy → Trophies#Meadows`).
   Text matching is the fallback, case-folded.
2. **Apply overrides** from `src/lib/craft/recipe-overrides.ts`: processing
   alternatives and fuel (smelter coal, the charcoal kiln, scrap versus ore),
   trophies as creature drops, `Root → Root (item)`, Yuleklapp sizes, station
   maximum levels where the wiki contradicts itself, and anything else the
   report shows is wrong. Each override carries a one-line reason.
3. **Deduplicate** (19 recipes are stated on two pages; prefer the item's own
   page), and **validate**: cycles, unresolved names, station levels above a
   station's maximum, missing yields where the wiki states one elsewhere.
4. **Name**: one canonical Spanish name per item (the stored translation's
   title without its English gloss, then the hand-written names, then the
   fixed vocabulary in `terms.ts`), with the variants the translations use as
   aliases ("Retazos de cuero", "Restos de cuero" for Leather scraps). The
   about 40 intermediates with no source (mostly armor pieces) get curated
   Spanish names in the overrides module.
5. **Write** one row, `recipe_graph(version = content hash, built_at,
   recipes_version, graph jsonb, report jsonb)`, keeping the last few. The
   ingest CLI prints the report's counts and its worst problems.

### 5.3 Shape

```ts
export type ItemId = string; // "SwordIron"; else "page:<slug>" or "page:<slug>#<tab>"

export type GraphItem = {
  id: ItemId;
  en: string;
  es?: string;
  aliases?: string[];          // Spanish and English variants, for search and the chat
  slug?: string;               // the article that describes it
  anchor?: string;             // the tab or section on that page, for intermediates and pieces
  icon?: string;               // short icon path, as the title index stores it
  kind: 'item' | 'piece' | 'station' | 'extension' | 'virtual';
  maxQuality: number;          // 1 for single-level items
  station?: { maxLevel: number; extensions: ItemId[] };
  extends?: ItemId;            // an extension: the station it raises by one level
  obtain?: Obtain[];           // how a raw material is had
};

export type Obtain =
  | { how: 'drop'; from: string[] }
  | { how: 'mine' | 'chop' | 'gather' | 'fish' | 'loot' | 'farm'; from: string[]; tool?: ItemId }
  | { how: 'buy'; from: string; coins: number };

export type GraphRecipe = {
  product: ItemId;
  quality: number;             // the step TO this quality; its cost alone
  station: ItemId | null;      // null: by hand
  stationLevel: number;
  yield: number;               // items per craft; 1 unless the wiki says "Crafts N"
  yieldKnown: boolean;         // false where the wiki is silent and no override settles it
  inputs: [ItemId, number][];
  method: 'craft' | 'build' | 'smelt' | 'cook' | 'bake' | 'brew' | 'ferment' | 'refine' | 'mill' | 'spin' | 'kiln';
  alt?: number;                // 0 = preferred; alternatives for the same product and quality
  from: string;                // provenance: "Bronze Armor#Chest", "Wood Structures"
};

export type RecipeGraph = { v: 1; version: string; builtAt: string; items: GraphItem[]; recipes: GraphRecipe[] };
```

The prototype built from the live wiki: 1,144 items, 954 recipes, 474
products, 182 raw materials, 168 upgradeable, 58 with a yield above 1; 94.8 KB
raw, 26.6 KB gzip as compact arrays.

### 5.4 Serving

- `getRecipeGraphData()` (server only, `src/lib/craft/data.ts`):
  `unstable_cache` tagged `corpus`, revalidated hourly like the search index
  (the house pattern, `data.ts:97-105`; the CLI ingest runs elsewhere and
  cannot invalidate the server's tags), with Spanish names and aliases
  attached at serve time from the search index, so a translation made after
  the graph was built still names its item.
- `getCraftView(slug, lang)`: React `cache()` over that memo; the item's slice
  (its recipes, the closure needed for its raw breakdown, its used-in list,
  names and station labels already in the reader's language): 1-3 KB of props.
- `GET /api/wiki/recipes?v=1`: public, compact arrays, the same headers as
  `/api/wiki/index?v=2` (`public, max-age=3600, s-maxage=86400,
  stale-while-revalidate=604800`); the payload carries `v`. A shape change
  becomes `?v=2` while `v=1` keeps answering for one release.
- The service worker treats it like the title index (stale-while-revalidate,
  fetched at install).

### 5.5 Maths (`src/lib/craft/math.ts`, pure, isomorphic)

- **Step and totals.** `stepCost(id, q)`; `totalCost(id, from, to)` sums steps
  `from+1..to` (from 0 = craft new).
- **Raw breakdown.** Aggregate the whole demand first, then expand each
  intermediate in topological order with `ceil(need / yield)` crafts, using the
  preferred recipe, guarding cycles, stopping at raw materials and at items the
  reader says they have. Returns the raw totals, the craft steps (with station
  and level), the leftovers yields create, and **the items it could not expand
  safely** (unknown yield or recipe), which the UI names instead of guessing.
- **Stations needed.** The highest level required per station along the tree.
  A station's level is 1 + the number of its extensions built, in any order.
- **Used in.** By material, grouped by station.
- **What can I craft.** For each recipe, the number of crafts the inventory
  allows; "now" (all inputs) and "almost" (one input short, or within 20% of
  the quantities).

Checked on the prototype: Karve → 80 nails → 4 crafts → 4 Bronze → 8 Copper
ore + 4 Tin ore; Bronze plate cuirass 1→4 → 23 Bronze + 2 Deer hide → 46
Copper ore + 23 Tin ore; Poison resistance mead (6 per batch) → Honey 10,
Thistle 5, Neck tail 1, Coal 10.

## 6. Item pages

- **The craft card** replaces the recipe row and sits directly under the level
  switcher (the house rule: the switcher sits above the rows it changes). On
  single-level items it is the infobox's first block. It follows the selected
  level through a small `LevelProvider` context shared with `LevelTabs` (which
  gains a `before` slot beside its `after` slot); a `#level-N` fragment selects
  a level on load, so no query parameter multiplies renders or saved copies.
- It shows: a station chip ("Forja · nivel 2", linking to the station); a
  three-way switch, **Este nivel / Del 1 al N / Materias primas**; the existing
  recipe tiles with forge-coloured monospace quantities; a quantity stepper
  (crafts, 1-99) and the yield ("Rinde ×20"); **Agregar al taller**, which
  becomes "En tu taller · Ver"; totals in an `aria-live="polite"` line.
- **Usado en**, on materials: a server component, no client JavaScript, the
  first block of the body, grouped by station, each group collapsed past 8
  entries with `<details>`; the heaviest (Wood 75, Iron 60, Finewood 58) get
  a "Ver las N" link to a filtered list.
- **Stations** add their upgrade path (each extension, its materials, the
  level it gives) and "Qué se fabrica acá", linking to the station list grouped
  by required level.
- `articleLayout()` counts the card's height instead of the recipe row's, and
  `StatGroup` skips recipe rows when the card is present. Items with no graph
  data keep today's recipe row.

## 7. The planner: "Taller" (`/wiki/craft`)

- **Mi lista**: targets `{ id, level, from, qty }` (from = the level already
  owned, 0 for a new item), each with a level selector, quantity and remove.
  Items are added through the same title index the search downloads (shared
  loader), filtered to things with a recipe; from an article's card; from the
  guide's gear tiles; from the chat.
- **The shopping list** under it: Directo or Materias primas; grouped by where
  the material comes from (biome tier when known, then how it is had: mined,
  dropped, gathered, bought); the stations and levels needed; each row ticks
  ("lo tengo") or takes a count ("tengo 12 de 20"), sharing one `have` map;
  items the maths could not expand are listed with the reason.
- **Lo que tengo**: the reader enters counts; results split into "Podés
  fabricar ya" and "Te falta poco", each addable to the list.
- **Storage**: `wv-craft-v1 = { v: 1, items, have, at }`, validated on read
  (malformed entries dropped, about 100 items at most, unknown ids kept for a
  newer graph), every access wrapped, through the shared store (§11).
- **Share**: `/wiki/craft?l=SwordIron.4.0.1~BronzeNails.1.0.20` (id, level,
  from, quantity; capped length). Opening one asks **Reemplazar mi lista** or
  **Sumar a mi lista**, never overwriting silently, then cleans the URL. The
  service worker drops `l` from its saved-copy keys.
- **Offline**: after one visit, the page copy, the graph and the storage all
  work with no network. The page says what is saved where ("Se guarda en este
  dispositivo").
- No-JavaScript readers get a `<noscript>` note; content pages keep working
  without JavaScript as today.

## 8. Navigation and shell

- Tabs: **Buscar · Explorar · Taller · Guía · Chat**; Taller in the centre,
  rune ᚲ (kenaz), labels "Taller" / "Craft".
- Below 640 px the ES|EN switch becomes one 44 px button naming the other
  language (accessible name "English" / "Español"; same cookie and refresh).
- From 640 to 767 px the nav search is hidden (the Search tab is one tap away).
- `TabKey` gains `craft` (`/wiki/craft` only; `/wiki/crafts` stays unmatched);
  manifest shortcut and sitemap entry; `/wiki` and `/api/wiki` are already
  public.
- An optional count badge on the tab, rendered only after hydration.

## 9. Progression

### 9.1 Data

- `scripts/progression-snapshot.ts` reads a local corpus copy (read-only, never
  production) and writes a committed `src/lib/progression/snapshot.json`:
  bosses (order, world key, summon items and counts, altar, Vegvisir, drops,
  what each drop unlocks, power, weaknesses, raids enabled, trader unlocks),
  stages (creatures, resources, places, foods, meads, armor sets), stations
  (recipe, maximum level, extensions, the level reachable per stage), tool
  gates (which pickaxe mines what, which axe chops what), item tiers (derived
  through the recipes from about 70 curated seed materials: 84% coverage, 48 of
  48 agree with stated tiers), things that cannot go through a portal, and
  meta (game patch, corpus date).
- `src/lib/progression/milestones.ts`, curated: about 80 milestones (10-13 per
  stage) with stable `p-` ids (never reused), kind (boss, unlock, build,
  upgrade, craft, cook, prepare), bilingual text in voseo and English with
  item tokens, an optional planner target, prerequisites (mostly derived from
  the graph, drops and tool gates), and at least one evidence pointer
  (`{ slug, where, expect }`) that a test checks against the snapshot.
- `src/lib/progression/seeds.ts`: tier seeds, aliases (Raw meat → Boar meat,
  plurals), and the conflict choices (Moder's power, Fader's Vegvisir).

### 9.2 The guide as tracker

- Fix the storage first: progress moves to `wv-progress-v1`, read as the union
  with the legacy `wv-guide-checks-v1`, and every save **merges** (adds what
  was ticked here, removes what was unticked here) instead of replacing the
  saved list with the boxes on the page.
- A "Lo derroté" checkbox on each boss card; a per-chapter "Hitos" checklist;
  gear tiles built from the data with **Agregar todo al taller**; per-chapter
  progress ("4 de 11") and a mark per biome in the table of contents; a strip
  at the top with the seven boss runes lit as they fall and the next step.
- Correct the 17 contradicted or stale statements and fill the gaps the domain
  recon lists (Wisp fountain → Wisplight, the tool gates, the Drakkar chain,
  station extensions and levels, the food and mead line, the missing armor
  sets); the "current as of" line comes from the snapshot's meta.

### 9.3 Your next step

- Done = ticked ∪ the prerequisites of ticked milestones (shown as inferred).
- Two cursors, because bosses can be fought in any order: the last boss
  cleared in order, and the furthest stage reached.
- Frontier = open milestones whose prerequisites are done, ranked: on the
  critical path to the current boss or the next stage's entry gate; then
  earlier-stage leftovers; then how much each unblocks; optional last.
- The top step plus two alternatives, each with why, how (station and level,
  raw materials and where they come from) and "Agregar al taller".
- Golden scenarios: nothing ticked → Workbench; Eikthyr → Antler pickaxe;
  Bonemass → Iron pickaxe and Frost resistance mead; Yagluth → Wisp fountain
  and Wisplight; the Queen → Artisan press, Ceramic plates, Drakkar.
- On the home page the next-step card takes the guide card's slot after
  hydration, at the same height, once the reader has progress or a list.

## 10. Chat

- `src/lib/craft/spot.ts`: a bilingual name spotter over the title index
  (longest match, plurals, compound names); `craftExcerpts(question, history,
  queries)` returns at most 3 "X › Receta y usos" excerpts built from the graph
  (verbatim English names and integers; one line per quality with its station
  level and the precomputed running total; raw materials only when every
  yield is known; used-in lists capped at 24 with "and N more on its page").
- They join the retrieval fixes' pinned stage as one stage with one budget, on
  every path (operator, own key, Puter).
- One prompt rule: for an item's amounts, stations and uses, prefer its
  "Receta y usos" excerpt and quote its totals rather than adding numbers.
- Citations gain an optional `kind: 'recipe'`; the source list shows an
  "Agregar al taller" button beside such a row.
- `pnpm eval --craft` measures the spotter with no model calls; the golden set
  gains multi-hop progression questions.

## 11. Storage and offline

- `src/lib/browser-storage.ts` (the existing safe helpers, moved up from
  `src/lib/chat/storage.ts`) and `src/lib/local-store.ts`: one
  `useSyncExternalStore` store per key, `null` on the server, the `storage`
  event for other tabs, in-memory listeners for this tab.
- Keys: `wv-craft-v1` (planner), `wv-progress-v1` (progress; reads the legacy
  key too). Every access wrapped; blocked storage never breaks a page; the UI
  says what is saved on the device.
- Service worker: `/api/wiki/recipes` like the title index; `l` dropped from
  `/wiki/craft` copy keys.

## 12. Design, language, accessibility, performance

- **Design.** Write `PRODUCT.md` and `DESIGN.md` from the existing spec and CSS
  before building new surfaces (the impeccable context requires them); then
  extend the incumbent system: no new colours, forge amber the only accent,
  quantities in forge monospace, section labels in `.label`, 44 px touch
  targets on touch screens, the 4 px rhythm. New classes go in a per-route
  `src/app/styles/craft.css` (with `@reference '../globals.css'`), imported by
  every route that uses them; the home stays utilities-only.
- **Language.** A `copy/craft.ts` area (and guide additions) in both
  languages, voseo, short tab labels; client components read copy through
  `useStrings()` only (the client copy guard).
- **Accessibility.** Keyboard and screen-reader complete; totals announced
  politely; visible focus; reduced motion respected.
- **Budgets.** The article craft card: one client island, 1-3 KB of props,
  no measurable LCP regression. The planner route's own JavaScript at most
  about 25 KB gzip, plus the graph (at most 30 KB gzip). No sideways scroll at
  360 px.

## 13. Verification

- Unit: extractor fixtures (an item with levels, nails with a yield, a mead
  and its base, an armor set, a meat, Bread, a station, an extension, a
  structure list), assembly (resolution, overrides, dedupe, validation),
  maths (steps, totals, raw with yields, cycles, unknowns, stations needed,
  craftable), storage parsing, share links, next step, milestones' evidence,
  spotter and excerpts, copy areas, navigation, service-worker routing.
- Integration (PGlite): the ingest writes `page_recipes` and the graph; the
  API's shape and headers; `getCraftView` for a weapon, a material and a
  station; the chat routes carrying the excerpt and its citation.
- End to end (phone and desktop, Spanish and English): the Taller tab, the
  card following the level, add to the planner, a share link, the planner
  offline, a guide tick changing the next step, a tick elsewhere surviving a
  guide save, no sideways scroll at 360 px, articles without JavaScript.
- Real data: a fresh local ingest of the live wiki with the new code, and the
  numbers above (Karve, cuirass, mead, Iron Sword) checked against it.
- Then the production build, performance against the previous release,
  accessibility, the impeccable detector, and a cross-cutting review.

## 14. Rollout

**Local (this work).** After the extractor lands, refresh a local corpus copy
from the live wiki with the new code (`pnpm ingest --pglite <copy> --full`,
read-only against Fandom, polite concurrency): it becomes the development
corpus, the source of the progression snapshot and the eval baseline. The
dev server keeps running on its own copy until it is switched gracefully.

**Production (the operator, each step confirmed first).**
1. Apply the pending migrations (0005 onwards, now including the recipe
   tables) with the owner credential.
2. `pnpm ingest --recipes --neon`: fetches every page once and builds the
   graph without touching articles or translations.
3. Deploy.
4. Optional, separately: `pnpm ingest --full --neon` to re-parse articles with
   parser v2 and bring in pages added since August (Spanish translations of
   changed articles are then shown with the "may be outdated" note until they
   are re-translated, which is quota-bound).

## 15. Calls made by the builder

1. Ingest-time extraction with its own version and mode, not read-time
   derivation from stored articles.
2. Game internal IDs as the identity for items, lists, progress and links.
3. Overrides in a visible module, conflicts reported.
4. One tab ("Taller"); the guide is the tracker; compact language button on
   phones.
5. Device storage plus share links; no accounts.
6. A committed progression snapshot plus curated, evidence-checked milestones.
7. Graph excerpts in the chat; no tool calling.
8. English in-game names inside chat answers stay the rule (with an optional
   Spanish gloss); interface labels and the planner show the canonical Spanish
   name with the English name beside it.
9. Raw breakdowns stop at unknown yields instead of assuming 1.
10. The production steps above are proposed, not run.

## 16. Work order

Waves, each implemented by owners with disjoint files, then reviewed
adversarially, fixed and verified before the next depends on it:

- **A. Data foundation**: extractor and fixtures; storage, migration and the
  `--recipes` ingest mode with redirects; assembly, overrides, names and the
  report; serving (`getRecipeGraph`, `getCraftView`, the API) and the maths
  library. Then the local corpus refresh.
- **B. Crafting surfaces**: `PRODUCT.md` and `DESIGN.md`; shell (Taller tab,
  compact language button, service worker, copy, routes); the article card,
  "Usado en" and the station view; the planner.
- **C. Progression**: snapshot, milestones and seeds with their tests; the
  guide as tracker with corrections; the next-step card on the home.
- **D. Chat**: spotter and excerpts in the pinned stage, the prompt rule,
  recipe citations with "Agregar al taller", the evals.
- **E. Release checks**: production build, performance, end-to-end,
  accessibility, design detector, cross-cutting review, README.
