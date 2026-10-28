# Crafting wave A: the recipe graph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract every recipe from the wiki's page HTML at ingest, assemble one versioned recipe graph per run, serve it to pages and the browser, and provide the pure crafting maths every later surface uses.

**Architecture:** A pure extractor (`extractRecipes(html)`) runs on each fetched page and its output is stored per page (`page_recipes`). At the end of an ingest run a pure assembler resolves links through the wiki's redirects, applies a visible overrides module, validates, and writes one `recipe_graph` row. Server loaders decorate it with the reader's names; a compact, versioned API serves it to the planner; an isomorphic maths library computes steps, totals, raw breakdowns, stations, used-in and craftable sets.

**Tech Stack:** TypeScript, Next.js 16.4.3 route handlers, Drizzle (PGlite locally, Neon HTTP in production), cheerio (already used by the parser), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-27-crafting-and-progression-design.md` (§5 is this wave). Evidence for every number below: the data recon in the session scratchpad (`craft/recon/merged/data.md`), its prototype scripts (`craft/recon/data/11-v2.mts`, `13-hrefonly.mjs`, `14-graph.mts`, `15-demo.mjs`), its live HTML cache (`craft/recon/data/html/<pageid>.json.gz`, 1,027 `action=parse` responses) and `redirects.json`.

## Global Constraints

- Production database: `.env.local` holds its `DATABASE_URL`. Never connect to it. Scripts and tests use PGlite (in-memory in tests; a copy under the scratchpad otherwise, opened with `--pglite <dir>` or `openScriptDatabase({ pglite })`). Never `--neon`.
- Neon's HTTP driver has no transactions: every write that must be atomic is one statement (`INSERT … ON CONFLICT … DO UPDATE`).
- Migrations are plain SQL files `drizzle/NNNN_name.sql`, idempotent (`IF NOT EXISTS`), applied in order by `src/lib/db/migrate.ts`; mirror every table in `src/lib/db/schema.ts`.
- Item identity is the game's internal ID (`SwordIron`, `MeadBasePoisonResist`); otherwise `page:<slug>` or `page:<slug>#<anchor>` (anchor = slugified tab or section).
- A recipe's `quality` is the step TO that quality; its inputs are that step's cost only (Iron Sword: Wood 2/1/2/3, Iron 20/10/20/30, Leather scraps 3/2/4/6; Forge level 2/3/4/5).
- Yield is 1 unless the wiki states "Crafts N"; stated yields seen live: 20 (arrows, bolts, missiles, Bronze Nails), 10 (Iron Nails, Smoke Bomb), 6 (meads; Berserkir 3), 5, 4, 3, 2.
- Wiki contradictions are reported, never silently clamped (Black forge recipes at levels 6-7 against a stated maximum of 5; Galdr table 5 against 4).
- No commits: the owner commits when they ask. Replace every "commit" with running the task's tests.
- Code reads like the surrounding code: full-sentence comments explaining why above each non-obvious decision; the same naming and idiom. Read `node_modules/next/dist/docs/` before writing the route handler (AGENTS.md).
- Concurrent workflows own `src/lib/rag/*`, `src/lib/wiki/chunker.ts`, `src/lib/ingest/version.ts`, `src/lib/chat-server/answer.ts`, `src/app/api/chat/**`, `scripts/eval.ts`, `public/sw.js`, `src/components/shell/*`: do not edit them in this wave.

## Review Focus

1. **Cells the parser has never seen** (quantity first, "x 5" with a space, `<br>` runs, "Pot shard x3, x4,", "nil", "n/a", a "Crafts N" line, notes like "(Requires Stonecutter)"): no throw, no invented entry; the unparsed text lands in `notes` and in the report. Pinned in Task 2 and Task 3.
2. **A secondary infobox with the same title as its page** (Anti-Sting Concoction, Lightfoot Mead, Bear Meat, Volture Meat, Frosted Sweetbread, Mysterious Rock): its own identity (`page:<slug>#<anchor>` or its internal ID), never merged into the page's item, never a self-loop. Pinned in Task 6.
3. **Cycles and alternatives** (scrap and ore both make a metal; a recipe that consumes its own product through an alternative): `expandRaw` terminates, uses the preferred recipe, and reports the cycle. Pinned in Task 5.
4. **An ingest that stops partway** (recipes stored for some pages, no new graph): the next run assembles a complete graph; a graph row is written whole or not at all; readers keep the previous graph meanwhile. Pinned in Task 8.
5. **Names with punctuation and encoding** (`Smith's anvil` linked as `Smith%27s_anvil`, `Mead base: Poison resistance`, fragments like `Deer_Meat#Cooked`, underscores): resolution decodes them and matches the wiki's own titles. Pinned in Task 3 and Task 6.

---

## Task groups and owners

The tasks split into three owners with disjoint files, so they can run in parallel where the arrows allow:

- **extract** (Tasks 1-3): fixtures, recipe-cell parsing, `extractRecipes`. Starts immediately.
- **graph** (Tasks 4-6, 9-10): types, codec, maths, assembly, serving. Tasks 4-5 start immediately; Task 6 needs Task 3's output type (defined below, so it can start against fixtures as soon as Task 3's extractor exists).
- **store** (Tasks 7-8): migration, repository, client redirects, ingest wiring and CLI. Needs Tasks 3 and 6.
- **Task 11** (local corpus refresh and real-data checks) runs last, after all of the above are reviewed.

---

### Task 1: Recipe fixtures

**Files:**
- Create: `tests/fixtures/recipes/<Title>.json` for: `Bronze_Nails`, `Iron_Nails`, `Poison_Resistance_Mead` (mead and its "Mead base" secondary infobox), `Deer_Meat` (raw and "Cooked" infoboxes), `Bread` (dough and bread), `Cauldron` (station: Max Level, Improvements), `Forge_Cooler` (extension: "Upgrades Forge"), `Karve`, `Tin`, `Bronze`, `Troll_Set` (armor set: tabs per piece, quantity-first rows), `Wood_Structures` (structure list table), `Food` (food table with station and multiplier), `Yuleklapp` (malformed cell), `Anti-Sting_Concoction` (secondary infobox with the page's title), `Root_Set` (the "Root" link to the creature page).
- Keep: the existing `tests/fixtures/*.json` (Iron_Sword, Iron, Forge, Bronze_Armor, Frosted_Sweetbread, …) unchanged; tests may read them.
- Create: `tests/fixtures/recipes/README.md`: where they came from (live `action=parse` responses, 2026-10-27), how to refresh one.

**Interfaces:**
- Produces: raw `action=parse` JSON (`{ parse: { title, pageid, revid, text, categories } }`), the same shape as `tests/fixtures/Iron_Sword.json`.

- [ ] **Step 1:** Copy each page from the recon's live cache (`craft/recon/data/html/<pageid>.json.gz`, gunzipped; find page ids in `craft/recon/data/titles.json`) or, if a title is absent, fetch it once with `action=parse&pageid=…&prop=text|revid|categories&format=json&formatversion=2` with the project's user agent (`WIKI_CONTACT`). Save as pretty-printed JSON is not required; keep the response as returned.
- [ ] **Step 2:** Run `pnpm test -- tests/unit/strings.test.ts` (any quick suite) to make sure nothing reads fixtures by directory listing and breaks.

### Task 2: Recipe cells (quantities, yields, both orders)

**Files:**
- Modify: `src/lib/wiki/recipe.ts` (keep `parseRecipe` and `isRecipeLabel` working for the article page)
- Test: `tests/unit/recipe.test.ts` (extend; create if absent)

**Interfaces:**
- Produces: `export type RecipeCell = { entries: RecipeEntry[]; yield: number | null; notes: string[] }` and `export function parseRecipeCell(value: string): RecipeCell` in `src/lib/wiki/recipe.ts`; `parseRecipe(value)` returns `parseRecipeCell(value).entries` (unchanged signature, so the article page now reads quantity-first armor rows too).

- [ ] **Step 1: Write the failing tests**

```ts
describe('parseRecipeCell', () => {
  it('reads name-first entries', () => {
    expect(parseRecipeCell('Wood x2; Iron x20; Leather scraps x3').entries).toEqual([
      { name: 'Wood', qty: 2 }, { name: 'Iron', qty: 20 }, { name: 'Leather scraps', qty: 3 },
    ]);
  });
  it('reads quantity-first entries, one per line', () => {
    expect(parseRecipeCell('5 Bronze\n2 Deer hide').entries).toEqual([{ name: 'Bronze', qty: 5 }, { name: 'Deer hide', qty: 2 }]);
  });
  it('reads "x N" with a space', () => {
    expect(parseRecipeCell('Deer hide x 5').entries).toEqual([{ name: 'Deer hide', qty: 5 }]);
  });
  it('takes the yield from a Crafts line and never makes it an entry', () => {
    expect(parseRecipeCell('Crafts 20\nBronze x1')).toEqual({ entries: [{ name: 'Bronze', qty: 1 }], yield: 20, notes: [] });
  });
  it('splits a yield glued to the first entry by the old parser', () => {
    expect(parseRecipeCell('Crafts 5Black marble x5')).toMatchObject({ entries: [{ name: 'Black marble', qty: 5 }], yield: 5 });
  });
  it('keeps what it cannot read as notes, inventing nothing', () => {
    expect(parseRecipeCell('Pot shard x3, x4,')).toMatchObject({ entries: [], notes: ['Pot shard x3, x4,'] });
    expect(parseRecipeCell('nil').entries).toEqual([]);
    expect(parseRecipeCell('n/a').entries).toEqual([]);
  });
});
```

(`RecipeEntry` is the existing `{ name, qty }` type in recipe.ts; keep its name.)

- [ ] **Step 2:** Run `pnpm exec vitest run tests/unit/recipe.test.ts`; expect the new cases to FAIL.
- [ ] **Step 3:** Implement `parseRecipeCell`; make `parseRecipe` delegate to it. A cell is split on newlines and `;`; a line matching `^Crafts\s*(\d+)` sets the yield (and the rest of a glued line is parsed again); an entry is `^(.*?)\s*[x×]\s*(\d+)$` or `^(\d+)\s+(.+)$`; anything else non-empty and not in `{nil, n/a, -, none}` goes to `notes`.
- [ ] **Step 4:** Run the file and `pnpm exec vitest run tests/unit` filtered to recipe/infobox/article tests; expect PASS, and no change in existing article tests.

### Task 3: `extractRecipes(html)`

**Files:**
- Create: `src/lib/wiki/recipes.ts`, `src/lib/wiki/recipes-version.ts`
- Test: `tests/unit/recipes-extract.test.ts`

**Interfaces:**
- Consumes: `parseRecipeCell` (Task 2).
- Produces (exported from `src/lib/wiki/recipes.ts`):

```ts
export type RawLink = { title: string; fragment: string | null; text: string }; // title decoded: "Smith's anvil", "Deer Meat"; fragment "Cooked"
export type RawEntry = { text: string; qty: number; link: RawLink | null };
export type RawLevel = { quality: number; stationLevel: number | null; yield: number | null; entries: RawEntry[] };
export type RawInfobox = {
  title: string;                 // the infobox's own title
  tab: string | null;            // null for the page's main item; else the label that names this infobox on the page
  internalId: string | null;
  source: { text: string; links: RawLink[] } | null;
  levels: RawLevel[];            // quality tabs "1".."N", or one level when untabbed
  maxLevel: number | null;       // stations
  improvements: RawLink[];       // stations
  upgrades: RawLink | null;      // extensions ("Upgrades Forge")
  notes: string[];               // cells it could not read
};
export type RawListRow = { name: string; entries: RawEntry[]; anchor: string | null }; // structure list tables
export type RawFoodRow = { item: RawLink; station: string | null; stationLevel: number | null; multiplier: number | null };
export type PageRecipes = { infoboxes: RawInfobox[]; listRows: RawListRow[]; foodRows: RawFoodRow[] };
export function extractRecipes(html: string): PageRecipes;
```

- `src/lib/wiki/recipes-version.ts`: `export const RECIPES_VERSION = 1;` and `export const RECIPES_OUTPUT_HASH = '<sha256 of the fixtures' output>';` with a comment stating the same rule as `PARSER_VERSION` (bump with any output change; record the new hash).

- [ ] **Step 1: Write the failing tests** (each reads a fixture's `parse.text`):

```ts
it('reads Iron Sword per quality: step costs and forge levels', () => {
  const { infoboxes } = extractRecipes(html('Iron_Sword'));
  expect(infoboxes[0]).toMatchObject({ tab: null, internalId: 'SwordIron', source: { text: 'Forge' } });
  expect(infoboxes[0]!.levels.map((l) => [l.quality, l.stationLevel, l.entries.map((e) => `${e.link?.title ?? e.text}:${e.qty}`)])).toEqual([
    [1, 2, ['Wood:2', 'Iron:20', 'Leather scraps:3']],
    [2, 3, ['Wood:1', 'Iron:10', 'Leather scraps:2']],
    [3, 4, ['Wood:2', 'Iron:20', 'Leather scraps:4']],
    [4, 5, ['Wood:3', 'Iron:30', 'Leather scraps:6']],
  ]);
});
it('keeps the yield of Bronze Nails', () => {
  expect(extractRecipes(html('recipes/Bronze_Nails')).infoboxes[0]!.levels[0]).toMatchObject({ yield: 20, entries: [{ qty: 1, link: { title: 'Bronze' } }] });
});
it('reads every infobox on a page, each with its own tab', () => {
  const boxes = extractRecipes(html('recipes/Poison_Resistance_Mead')).infoboxes;
  expect(boxes.map((b) => b.tab)).toEqual([null, 'Mead base']); // labels as the page shows them
  expect(boxes[1]!.levels[0]!.entries.map((e) => e.link?.title)).toEqual(['Honey', 'Thistle', 'Neck tail', 'Coal']);
});
it('gives a secondary infobox titled like its page a tab of its own', () => {
  const boxes = extractRecipes(html('recipes/Anti-Sting_Concoction')).infoboxes;
  expect(new Set(boxes.map((b) => b.tab)).size).toBe(boxes.length);
});
it('reads quantity-first armor rows per piece', () => {
  const boxes = extractRecipes(html('recipes/Troll_Set')).infoboxes;
  expect(boxes.every((b) => b.levels.every((l) => l.entries.length > 0))).toBe(true);
});
it('reads a station and an extension', () => {
  expect(extractRecipes(html('recipes/Cauldron')).infoboxes[0]).toMatchObject({ maxLevel: 6 });
  expect(extractRecipes(html('recipes/Cauldron')).infoboxes[0]!.improvements.map((l) => l.title)).toHaveLength(5);
  expect(extractRecipes(html('recipes/Forge_Cooler')).infoboxes[0]!.upgrades?.title).toBe('Forge');
});
it('decodes link titles and fragments', () => {
  // from Deer_Meat or Bread: an entry or redirect-style link with a fragment, and an apostrophe title from Forge's improvements
  const forge = extractRecipes(html('Forge')).infoboxes[0]!;
  expect(forge.improvements.map((l) => l.title)).toContain("Smith's anvil"); // as the wiki's link title reads; adjust case to the fixture
});
it('reads structure list rows and food rows', () => {
  expect(extractRecipes(html('recipes/Wood_Structures')).listRows.length).toBeGreaterThan(10);
  const food = extractRecipes(html('recipes/Food')).foodRows;
  expect(food.find((r) => r.item.title === "Queen's jam" || r.item.text === "Queen's jam")).toBeTruthy();
});
it('keeps unreadable cells as notes and never throws', () => {
  expect(() => extractRecipes(html('recipes/Yuleklapp'))).not.toThrow();
});
it('matches the recorded output fingerprint', () => {
  expect(fingerprint(allFixtures().map(extractRecipes))).toBe(RECIPES_OUTPUT_HASH);
});
```

(Adjust only literal names to what the fixtures actually contain, never the structure; `html(name)` reads `tests/fixtures/<name>.json`'s `parse.text`.)

- [ ] **Step 2:** Run `pnpm exec vitest run tests/unit/recipes-extract.test.ts`; expect FAIL (module missing).
- [ ] **Step 3:** Implement with cheerio, following the prototype in `craft/recon/data/11-v2.mts`, `13-hrefonly.mjs` and `14-graph.mts` for where Fandom puts each piece (`aside.portable-infobox`, `.pi-item[data-source]`, tab panels, `<b>Crafts N</b>` before the list, `<a href>` on every entry; tabbers that hold several infoboxes). Link titles come from the `href` (`/wiki/Title#Fragment`, URL-decoded, underscores to spaces), not the link text. Reuse `src/lib/wiki/tabber.ts` helpers where they fit. Then compute and paste `RECIPES_OUTPUT_HASH`.
- [ ] **Step 4:** Run the test file; expect PASS. Then run the extractor over all 1,027 cached pages in a scratch script (not in the repo) and record: pages with any recipe, levels parsed, entries with and without a link, notes count. Expect at least 474 products with recipes and at least 99% of entries with a link (the recon measured 99.6%).

### Task 4: Graph types and the wire codec

**Files:**
- Create: `src/lib/craft/types.ts`, `src/lib/craft/codec.ts`
- Test: `tests/unit/craft-codec.test.ts`

**Interfaces:**
- Produces: the spec §5.3 types, with these additions: `GraphRecipe.fuel?: [ItemId, number]` (fuel per craft, e.g. smelter coal), `GraphRecipe.method` also allows `'prepare'` (food preparation table); `RecipeGraph.v` is `1`. `export function encodeGraph(graph: RecipeGraph): WireGraph` and `export function decodeGraph(wire: unknown): RecipeGraph` (throws `GraphShapeError` on a wrong `v` or shape). `WireGraph` is compact arrays: items as tuples, recipes as tuples with item indexes, inputs flattened `[index, qty, index, qty, …]`; strings never repeated except names.

- [ ] **Step 1: Write the failing tests:** a round trip of a small hand-made graph (an upgradeable sword, bronze from copper and tin with a smelter fuel line, nails with yield 20, an alternative recipe, an item with aliases and an anchor) equals the input deeply; `decodeGraph({ v: 2 })` throws `GraphShapeError`; the encoded JSON of the hand-made graph is smaller than `JSON.stringify(graph)`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. `types.ts` imports nothing from the server (it ships to the browser).
- [ ] **Step 4:** Run; expect PASS.

### Task 5: The maths library

**Files:**
- Create: `src/lib/craft/math.ts`
- Test: `tests/unit/craft-math.test.ts`

**Interfaces:**
- Consumes: Task 4 types.
- Produces:

```ts
export type GraphIndex; // opaque: items by id, recipes by product and quality, preferred recipe per product, used-in by material
export function indexGraph(graph: RecipeGraph): GraphIndex;
export function stepCost(index: GraphIndex, id: ItemId, quality: number): GraphRecipe | null;
export function totalCost(index: GraphIndex, id: ItemId, from: number, to: number): Map<ItemId, number>; // sum of steps from+1..to
export type CraftStep = { recipe: GraphRecipe; crafts: number; produced: number };
export type Unexpanded = { id: ItemId; need: number; reason: 'raw' | 'cycle' | 'unknown-yield' };
export function expandRaw(
  index: GraphIndex,
  demand: Map<ItemId, number>,
  options?: { have?: Map<ItemId, number>; stopAt?: ReadonlySet<ItemId> },
): { raw: Map<ItemId, number>; fuel: Map<ItemId, number>; crafts: CraftStep[]; leftovers: Map<ItemId, number>; unexpanded: Unexpanded[] };
export function stationsNeeded(crafts: CraftStep[], also?: { station: ItemId; level: number }[]): Map<ItemId, number>;
export function usedIn(index: GraphIndex, id: ItemId): { product: ItemId; quality: number; qty: number; station: ItemId | null; stationLevel: number }[];
export function craftable(index: GraphIndex, inventory: Map<ItemId, number>, almostRatio?: number): {
  now: { product: ItemId; crafts: number }[];
  almost: { product: ItemId; missing: Map<ItemId, number> }[];
};
```

`raw` holds materials with no recipe (reason `raw` items are not listed in `unexpanded`; `unexpanded` lists only `cycle` and `unknown-yield`, which the UI must name). Only quality-1 recipes are used to make intermediates.

- [ ] **Step 1: Write the failing tests** against a fixture graph built in the test (ids as the game's):

```ts
it('totals Iron Sword from new to quality 4', () => {
  expect(Object.fromEntries(totalCost(ix, 'SwordIron', 0, 4))).toEqual({ Wood: 8, Iron: 80, LeatherScraps: 15 });
});
it('upgrades only the missing steps', () => {
  expect(Object.fromEntries(totalCost(ix, 'SwordIron', 2, 4))).toEqual({ Wood: 5, Iron: 50, LeatherScraps: 10 });
});
it('expands a Karve through the nails yield', () => {
  const r = expandRaw(ix, new Map([['Karve', 1]]));
  expect(r.raw.get('CopperOre')).toBe(8);
  expect(r.raw.get('TinOre')).toBe(4);
  expect(r.crafts.find((s) => s.recipe.product === 'BronzeNails')).toMatchObject({ crafts: 4, produced: 80 });
});
it('aggregates demand before rounding crafts', () => {
  // two items needing 50 and 40 nails: 5 crafts (100 nails), not 3 + 2 rounded separately to 6
  const r = expandRaw(ix, new Map([['ItemA', 1], ['ItemB', 1]]));
  expect(r.crafts.find((s) => s.recipe.product === 'BronzeNails')!.crafts).toBe(5);
  expect(r.leftovers.get('BronzeNails')).toBe(10);
});
it('counts smelter fuel separately', () => {
  expect(expandRaw(ix, new Map([['Bronze', 4]])).fuel.get('Coal')).toBe(/* 2 per bar, 8 bars of copper and 4 of tin */ 24);
});
it('stops at what the reader has', () => {
  expect(expandRaw(ix, new Map([['Karve', 1]]), { have: new Map([['Bronze', 4]]) }).raw.get('CopperOre') ?? 0).toBe(0);
});
it('reports a cycle and terminates', () => {
  expect(expandRaw(cyclic, new Map([['A', 1]])).unexpanded).toContainEqual(expect.objectContaining({ id: 'A', reason: 'cycle' }));
});
it('reports an unknown yield instead of assuming one', () => {
  expect(expandRaw(ix, new Map([['MysteryStew', 1]])).unexpanded).toContainEqual(expect.objectContaining({ reason: 'unknown-yield' }));
});
it('needs the highest station level along the tree', () => {
  const r = expandRaw(ix, new Map([['SwordIron', 1]]));
  expect(stationsNeeded(r.crafts, [{ station: 'Forge', level: 5 }]).get('Forge')).toBe(5);
});
it('lists uses and craftable sets', () => {
  expect(usedIn(ix, 'Tin').map((u) => u.product).sort()).toEqual(['Bronze', 'Cauldron', 'MeadKetill' /* … as in the fixture graph */].sort());
  const c = craftable(ix, new Map([['Copper', 4], ['Tin', 2]]));
  expect(c.now).toContainEqual({ product: 'Bronze', crafts: 2 });
});
```

(Fill the fixture graph so these numbers hold; the Bronze fuel line and ratio come from the override in Task 6, stated in the fixture here.)

- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. Expansion order: topological over the demand's closure (Kahn on the preferred quality-1 recipe edges); a back edge marks `cycle` and stops that branch; `crafts = ceil(need / yield)`; leftovers = `crafts × yield − need`.
- [ ] **Step 4:** Run; expect PASS.

### Task 6: Assembly, overrides and the report

**Files:**
- Create: `src/lib/craft/assemble.ts`, `src/lib/craft/recipe-overrides.ts`
- Test: `tests/unit/craft-assemble.test.ts`

**Interfaces:**
- Consumes: `PageRecipes` (Task 3), Task 4 types.
- Produces:

```ts
export type AssemblyPage = { slug: string; title: string; categories: string[]; recipes: PageRecipes };
export type Redirects = ReadonlyMap<string, { title: string; fragment: string | null }>; // keyed by normalized title
export type GraphReport = {
  items: number; recipes: number; products: number; raw: number;
  unresolved: { text: string; from: string; count: number }[];
  cycles: ItemId[][];
  levelConflicts: { station: ItemId; stated: number; required: number; from: string }[];
  duplicates: { product: ItemId; quality: number; kept: string; dropped: string }[];
  yieldSuspects: { product: ItemId; from: string }[];
};
export function assembleGraph(pages: AssemblyPage[], redirects: Redirects, builtAt: string): { graph: RecipeGraph; report: GraphReport };
```

- `recipe-overrides.ts` exports one typed `OVERRIDES` object: `linkFixes` (`'Root': 'Root (item)'` when the product is not a creature), `alternatives` (charcoal kiln: Wood → Coal ×1; smelter recipes' fuel `Coal ×2` per bar; blast furnace likewise), `stationMaxLevel` (only where the report proves a contradiction; each with a reason), `yields`, `spanishNames` (curated names for intermediates without a translation: mead bases, cooked meats, doughs, armor pieces), `ignore` (Cheat Sword, Cheat Sledge, CAPE TEST, and console-only pages). Every entry carries a one-line `reason`.

- [ ] **Step 1: Write the failing tests** with fixtures through `extractRecipes`:
  - Iron Sword's item is `SwordIron` with 4 recipes at Forge levels 2-5 and the step costs above.
  - Bronze Nails yield 20; Karve's input `BronzeNails ×80` resolves by link.
  - `Mead base: Poison resistance` resolves through a redirect to `Poison Resistance Mead#Mead base` and becomes its own item (its internal ID), made at the Mead ketill.
  - A secondary infobox titled like its page (Anti-Sting Concoction) yields two distinct items and no recipe whose input is its own product.
  - `Root` in Root Set resolves to Root (item), with the override's reason in the report's applied list.
  - Duplicated (product, quality) keeps the item's own page and lists the other in `duplicates`.
  - A station level above the station's stated maximum appears in `levelConflicts` and the recipe keeps the stated level.
  - Unknown names are counted in `unresolved`, never dropped silently.
  - Structure list rows become `kind: 'piece'` items with `anchor` set and `method: 'build'`.
  - Food rows set the Cauldron level of a food whose infobox says plain "Cauldron".
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. Identity: internal ID, else `page:<slug>` / `page:<slug>#<anchor>`. Resolution order: link → redirect → page or page#anchor → case-folded title → override. Station from `source.links`: a link to a station item (an infobox with `maxLevel`, or a page in a crafting-station category) is the station; "Player crafting menu" is null; anything else (creature, deposit, tree, trader, biome) becomes the material's `obtain`. Method from the station (Forge, Workbench, Black forge, Galdr table, Artisan table: `craft`, or `build` for pieces; Smelter and Blast furnace: `smelt`; Cooking stations and Cauldron: `cook`; Stone oven: `bake`; Mead ketill: `brew`; Fermenter: `ferment`; Eitr refinery: `refine`; Windmill: `mill`; Spinning wheel: `spin`; Charcoal kiln: `kiln`; Food preparation table: `prepare`). `version` is the SHA-256 of the canonical JSON of `items` and `recipes`.
- [ ] **Step 4:** Run; expect PASS. Then, in a scratch script, assemble all 1,027 cached pages with the recon's `redirects.json` and compare with the prototype (`proto-graph.json`): items and recipes within 5%, and the four checks in Task 11 hold.

### Task 7: Storage and the redirect client

**Files:**
- Create: `drizzle/0010_recipes.sql`
- Modify: `src/lib/db/schema.ts` (two tables), `src/lib/db/repo.ts` or a new `src/lib/db/recipe-repo.ts` (preferred: new file), `src/lib/wiki/mediawiki.ts` (one method)
- Test: `tests/integration/recipe-repo.test.ts`, `tests/unit/mediawiki-redirects.test.ts`, `tests/integration/migrations.test.ts` (extend)

**Interfaces:**
- Produces:

```sql
CREATE TABLE IF NOT EXISTS page_recipes (
  page_key text PRIMARY KEY REFERENCES pages(key) ON DELETE CASCADE,
  recipes_version integer NOT NULL,
  revid integer NOT NULL,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS recipe_graph (
  version text PRIMARY KEY,
  built_at timestamptz NOT NULL DEFAULT now(),
  recipes_version integer NOT NULL,
  graph jsonb NOT NULL,
  report jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS recipe_graph_built_idx ON recipe_graph (built_at DESC);
```

```ts
// src/lib/db/recipe-repo.ts
export function writePageRecipes(db: Db, row: { pageKey: string; recipesVersion: number; revid: number; data: PageRecipes }): Promise<void>; // one upsert
export function getRecipeStates(db: Db, source: string): Promise<Map<number /*pageId*/, { recipesVersion: number; revid: number }>>;
export function getAssemblyPages(db: Db): Promise<AssemblyPage[]>; // page_recipes joined with pages (title, categories) and articles (slug)
export function writeRecipeGraph(db: Db, graph: RecipeGraph, report: GraphReport, recipesVersion: number): Promise<void>; // one INSERT … ON CONFLICT (version) DO NOTHING, then delete all but the newest 3
export function getLatestRecipeGraph(db: Db): Promise<{ graph: RecipeGraph; report: GraphReport } | null>;
// src/lib/wiki/mediawiki.ts
fetchRedirects(source: WikiSource, titles: string[]): Promise<Map<string, { title: string; fragment: string | null }>>; // action=query&titles=…&redirects=1, 50 titles per request
```

- [ ] **Step 1: Write the failing tests:** the migration applies twice without error and creates both tables; `writePageRecipes` twice for the same page keeps one row with the second's data; deleting the page deletes its recipes (cascade); `writeRecipeGraph` of the same version twice keeps one row, and after four versions only the newest three remain; `getLatestRecipeGraph` returns the newest by `built_at`; `fetchRedirects` against a fake fetch returns `{ 'Mead base: Poison resistance': { title: 'Poison Resistance Mead', fragment: 'Mead base' } }` from a `redirects: [{ from, to, tofragment }]` body and batches 120 titles into 3 requests.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement, mirroring the tables in `schema.ts` with comments in the file's voice.
- [ ] **Step 4:** Run; expect PASS.

### Task 8: Ingest wiring and the `--recipes` mode

**Files:**
- Create: `src/lib/craft/build.ts`
- Modify: `src/lib/ingest/run.ts`, `scripts/ingest.ts`
- Test: `tests/integration/ingest.test.ts` (extend), `tests/integration/recipe-build.test.ts`

**Interfaces:**
- Consumes: `extractRecipes`, `RECIPES_VERSION` (Task 3), `assembleGraph` (Task 6), Task 7's repository and `fetchRedirects`.
- Produces:

```ts
// src/lib/craft/build.ts
export async function buildRecipeGraph(db: Db, client: MediaWikiClient, source: WikiSource, builtAt?: string): Promise<GraphReport>;
// src/lib/ingest/run.ts
export type IngestOptions = { …; recipesOnly?: boolean; recipesVersion?: number /* tests */ };
export type IngestResult = { …; recipesExtracted: number; graph: { version: string; report: GraphReport } | null };
```

Behaviour:
- `ingestOnePage` writes `page_recipes` (one upsert, after the chunks and before `writeArticle`, so the page stays `UNFINISHED` until both are stored).
- After the page loop, every listed page whose recipes are missing, older than `RECIPES_VERSION`, or from another revision than the live one gets a **recipes-only** pass: one `fetchPage`, `extractRecipes`, `writePageRecipes`; no chunks, no article, no translation staleness.
- `recipesOnly: true` skips the article re-derivation and the vector work entirely: list, compare recipe states with live revisions, recipes-only pass, assemble.
- The graph is assembled (`buildRecipeGraph`) when any page's recipes were written, a page was deleted, or no graph exists; a failure here is reported in `errors` and does not fail an otherwise good run.
- `scripts/ingest.ts`: `--recipes` sets `recipesOnly`; the help text explains it ("fetches every page whose recipes are missing or outdated and rebuilds the recipe graph, without touching articles or their translations"); the summary prints recipes extracted, the graph's item and recipe counts, and the report's unresolved, cycles, level conflicts and duplicates counts with the five worst unresolved names.

- [ ] **Step 1: Write the failing tests** with the fixture-backed fake wiki in `tests/integration/ingest.test.ts`: a first run writes `page_recipes` for every page and one graph; a second run with nothing changed writes no recipes and no graph; bumping `recipesVersion` re-extracts every page without changing any article's `updated_at`; `recipesOnly` on a fresh index writes recipes and a graph but no articles or chunks; a run whose `buildRecipeGraph` throws still ends `ok` with the error recorded; a run stopped after half the pages (throwing fetch) leaves the old graph readable and the next run writes a complete one.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm exec vitest run tests/integration/ingest.test.ts tests/integration/recipe-build.test.ts`; expect PASS, and the existing ingest tests unchanged.

### Task 9: Serving: loaders and the API

**Files:**
- Create: `src/lib/craft/data.ts` (server only), `src/app/api/wiki/recipes/route.ts`
- Test: `tests/integration/recipes-route.test.ts`, `tests/integration/craft-view.test.ts`

**Interfaces:**
- Consumes: `getLatestRecipeGraph` (Task 7), `getSearchIndex` (`src/lib/db/wiki-repo.ts`, Spanish names `e` and aliases), `spanishTitle`, `termLabel`, Task 4-5.
- Produces:

```ts
export const getRecipeGraphData: () => Promise<RecipeGraph | null>; // unstable_cache, tags ['corpus'], revalidate 3600, wrapped in React cache(); names decorated: es and aliases from the search index for items with a slug, curated names otherwise
export type CraftView = {
  item: { id: ItemId; name: string; en: string; slug: string | null; kind: GraphItem['kind']; maxQuality: number };
  recipes: { quality: number; alt: number; station: { id: ItemId; name: string; slug: string | null } | null; stationLevel: number; yield: number; inputs: { id: ItemId; name: string; slug: string | null; icon: string | null; qty: number }[] }[];
  closure: RecipeGraph;            // only the items and recipes needed to expand this item to raw, names in the reader's language
  usedIn: { station: { id: ItemId; name: string; slug: string | null } | null; items: { id: ItemId; name: string; slug: string | null; icon: string | null; quality: number; qty: number }[] }[];
  station?: { maxLevel: number; extensions: { id: ItemId; name: string; slug: string | null; inputs: { id: ItemId; name: string; qty: number }[] }[] };
};
export function getCraftView(slug: string, lang: Lang): Promise<CraftView | null>; // React cache(); null when the graph has nothing for the slug
// GET /api/wiki/recipes?v=1 → { v: 1, version, graph: WireGraph }; without v=1 → 400 { error: 'version_required' }
```

- [ ] **Step 1: Write the failing tests** on in-memory PGlite seeded through `buildRecipeGraph` with the fixture wiki: the route answers 200 with `Cache-Control: public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800` and a payload `decodeGraph` accepts; no graph stored → 503 `{ error: 'recipes_unavailable' }` with `no-store`; `getCraftView('iron-sword', 'es')` has 4 recipes, Forge levels 2-5, inputs named in Spanish where the translation exists, and a closure that expands to raw without the full graph; `getCraftView('tin', 'en')` lists Bronze, Cauldron, Mead ketill and Butcher knife in `usedIn`; `getCraftView('cauldron', 'es')` has `station.maxLevel` 6 and five extensions; an unknown slug gives `null`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement, following `src/app/api/wiki/index/route.ts` and the house cache rule in `src/lib/wiki/data.ts` (no cached function calls another: load the graph row and the search index rows inside the one cached function).
- [ ] **Step 4:** Run; expect PASS. Measure the API payload of the full fixture-free graph later in Task 11 (target at most 30 KB gzip).

### Task 10: Whole-wave checks

**Files:** none new.

- [ ] **Step 1:** `pnpm exec tsc --noEmit -p .` — PASS (failures only in files owned by concurrent workflows are reported, not fixed here).
- [ ] **Step 2:** `pnpm lint` — PASS.
- [ ] **Step 3:** `pnpm test` (unit) and the integration files above — PASS.

### Task 11: Local corpus refresh and real-data checks

**Files:** none in the repo; a new PGlite copy under the scratchpad (`pglite-live`).

- [ ] **Step 1:** Copy `pglite-mirror-migrated` to `pglite-live`, apply migrations (`pnpm db:migrate` with `--pglite`), then `pnpm ingest --pglite <pglite-live> --full` (read-only against Fandom, concurrency 3; the local e5 model embeds changed chunks). Record the run's summary.
- [ ] **Step 2:** From the stored graph, check: Iron Sword 0→4 = Wood 8, Iron 80, Leather scraps 15 at Forge 2-5; Karve raw = 8 Copper ore, 4 Tin ore (plus the rest of its recipe); Bronze plate cuirass 0→4 = 23 Bronze + 2 Deer hide → 46 Copper ore + 23 Tin ore; Poison resistance mead (one batch of 6) = Honey 10, Thistle 5, Neck tail 1, Coal 10; Tin used in Bronze, Butcher knife, Cauldron, Mead ketill.
- [ ] **Step 3:** Record the report (unresolved, cycles, level conflicts, duplicates, yield suspects) and add overrides for real errors it shows; rerun the assembly only (`pnpm ingest --pglite <pglite-live> --recipes`) until the unresolved list holds only names with no wiki page.
- [ ] **Step 4:** Measure `GET /api/wiki/recipes?v=1` against a server on `pglite-live` (gzip size; target ≤ 30 KB) and record the eval baselines on the new corpus (`pnpm eval -- --pglite <pglite-live> --rewrite off` and `--sections`), since chunk boundaries changed.
