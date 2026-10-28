# Crafting wave B: crafting surfaces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the recipe graph in front of players: a craft card that follows the article's level, "Usado en" on materials, the upgrade path on stations, and the "Taller" planner at `/wiki/craft` (list, shopping list, what I can craft, share links, offline), reached from a fifth tab.

**Architecture:** Server components render everything that is reading (Usado en, the station path) and pass the article's slice (`getCraftView`, wave A) to one client island, the card. The planner is one client tree under a thin server route; it downloads the whole graph once (`/api/wiki/recipes?v=1`, kept by the service worker) and computes with the wave A maths. Plans live on the device through one shared store with cross-tab sync, and travel by share link.

**Tech Stack:** Next.js 16.4.3 (App Router, server components, `useSyncExternalStore`), React 19, Tailwind 4 with per-route stylesheets, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-27-crafting-and-progression-design.md` (§6 item pages, §7 planner, §8 shell, §11 storage, §12 design). Design context: `PRODUCT.md`, `DESIGN.md`, `.impeccable/design.json` (read both before any UI work). UI recon with measurements: session scratchpad `craft/recon/merged/ui.md`. Wave A interfaces: `docs/superpowers/plans/2026-10-27-crafting-wave-a-data.md` Tasks 4, 5, 9 and the code in `src/lib/craft/`.

## Global Constraints

- Production database: never connect to it (`.env.local`). Tests use PGlite; the dev server on port 3100 uses the scratchpad copy named in `.env.development.local`.
- No commits: the owner commits when they ask. Wherever a step would commit, run the task's tests instead.
- Read the relevant guide in `node_modules/next/dist/docs/` before writing route, metadata or client navigation code (AGENTS.md).
- Client components read copy through `useStrings()` only; never import `strings.ts` or `copy/*` from a `'use client'` module (`tests/unit/client-copy-guard.test.ts`). Server components use `strings(lang)`.
- Spanish is rioplatense voseo ("Agregá", "Podés"); no tuteo, no English strings in the Spanish interface. English item names appear beside Spanish ones where the interface names an item (spec §15.8).
- Design: extend the incumbent system (DESIGN.md). No new colours; forge is the only accent; quantities in forge monospace; section labels with `.label`; 44 px targets on coarse pointers; text fields 16 px on coarse pointers (selects included); icons with `object-fit: scale-down` (never enlarged); nothing that holds values clips (`overflow: hidden` only where nothing can overflow); floating shadows in bog, never pure black.
- Styles: new classes go in `src/app/styles/craft.css` (card, Usado en, station path; owner: article) and `src/app/styles/planner.css` (planner; owner: planner), each starting with `@reference '../globals.css';`, classes in `@layer components`, imported by every route that uses them (`tests/unit/route-css.test.ts` enforces both ways). The home (`/wiki`) stays utilities-only. `tables.css` is edited only by the drift owner (Task 16).
- Storage: every access wrapped; blocked storage never breaks a page; the UI says what is saved on the device.
- Never write a number the maths could not compute: unknown yields, cycles and missing steps are named, not guessed (spec anti-goal 1).
- Budgets: article route client JS grows at most 8 KB gzip (the card and the maths it imports); the card's props at most 3 KB per article; the planner route's own JS at most 25 KB gzip plus the graph (at most 30 KB gzip); no sideways scroll at 360 px.
- UI owners load the impeccable skill's context once (`node C:/Users/airau/.claude/skills/impeccable/scripts/context.mjs --target <main file>`), read `reference/craft-floor.md` before editing UI, follow `reference/new-work.md` for the new surfaces (mode: Operate), and run `node C:/Users/airau/.claude/skills/impeccable/scripts/detect.mjs --json <changed UI files>` before reporting.
- Code reads like the surrounding code: full-sentence comments that say why, above each non-obvious decision; the same naming and idiom.

## Review Focus

1. **A plan saved by a newer or older build** (unknown item ids, a level above an item's new maximum, a malformed `wv-craft-v1`, storage blocked, two tabs writing at once): nothing is lost or overwritten; unknown ids stay in the list and are named; malformed entries drop alone; the other tab's write shows up. Pinned in Tasks 1, 2 and 13.
2. **A share link someone edited or truncated** (`?l=` with garbage parts, 500 items, ids with `:` `#` `.` `~` or percent signs, a level of 99): decoding keeps the valid parts, caps the count, never throws, and opening it never replaces the reader's list without asking. Pinned in Tasks 2 and 15.
3. **The level switcher and the card disagreeing** (a `#level-4` fragment on load, Back/Forward between fragments, an item whose tabs are stars or variants, a single-level item, an article without a card): the card always shows the selected level's recipe, the switcher still works where there is no card, and nothing scrolls on load. Pinned in Tasks 7 and 8.
4. **Yields and fuel at the edges** (one Karve; 30 nails when a craft makes 20; a mead batch of 6; an upgrade from level 2 to 4 of three swords; a target whose yield is unknown): the card and the planner agree to the unit with the wave A maths, leftovers are shown, unknown yields stop the breakdown with a named reason. Pinned in Tasks 3, 8 and 13.
5. **Narrow and translated screens** (360 px, Spanish labels, a 9-input recipe, "Usado en" for Wood's 75 uses, a long station name like "Mesa de preparación de comida"): no sideways scroll, no clipped value, groups collapse past 8. Pinned in Tasks 8, 10, 13 and 17.

---

## Owners, files and order

| Owner | Tasks | Files (only these) |
|---|---|---|
| **foundation** | 1-4 | `src/lib/browser-storage.ts` (new), `src/lib/chat/storage.ts`, `src/lib/local-store.ts`, `src/lib/craft/planner-store.ts`, `src/lib/craft/share.ts`, `src/lib/craft/plan.ts`, `src/lib/craft/graph-client.ts`, `src/lib/craft/item-search.ts`, `src/lib/i18n/copy/craft.ts`, `src/lib/i18n/strings.ts` (merge only), `src/lib/routes.ts`, their tests |
| **shell** | 5-6 | `src/components/shell/nav-model.ts`, `src/components/wiki/tab-bar.tsx`, `src/components/lang-toggle.tsx`, `src/lib/i18n/copy/shell.ts`, `src/app/manifest.ts`, `src/app/sitemap.ts`, `public/sw.js`, their tests |
| **article** | 7-10 | `src/components/wiki/article/level-context.tsx` (new), `level-tabs.tsx`, `infobox.tsx`, `infobox-model.ts`, `stat-group.tsx`, `src/components/wiki/article-view.tsx`, `src/app/wiki/a/[slug]/page.tsx`, `src/components/wiki/craft/*` (new), `src/app/styles/craft.css` (new), their tests |
| **planner** | 11-15 | `src/app/wiki/craft/page.tsx` (new), `src/components/wiki/planner/*` (new), `src/app/styles/planner.css` (new), their tests |
| **drift** | 16 | the files named in Task 16, `DESIGN.md`, `.impeccable/design.json` |

Order: foundation first (Tasks 1-4). Then shell, article, planner in parallel; drift can start at once (it shares no file with anyone). Article and planner need wave A's `getCraftView` and the recipes route (wave A Task 9) and, for real-data checks, the refreshed local corpus (wave A Task 11). Task 17 runs last.

---

### Task 1: Browser storage and the shared local store

**Files:**
- Create: `src/lib/browser-storage.ts` (move `StorageLike`, `browserStorage`, `readStored`, `readStoredStrict`, `writeStored`, `removeStored` here, comments included)
- Modify: `src/lib/chat/storage.ts` (keep `PROFILE_KEY`, `PUTER_MODEL_KEY`; re-export the helpers from `../browser-storage` so no chat import changes)
- Create: `src/lib/local-store.ts`
- Test: `tests/unit/local-store.test.ts`; existing chat storage tests keep passing unchanged

**Interfaces:**
- Produces:

```ts
// src/lib/local-store.ts — browser-safe, no React import at module top other than the hook's
export type LocalCodec<T> = { parse(raw: string | null): T; serialize(value: T): string };
export type LocalStore<T> = {
  readonly key: string;
  /** The parsed value; the same reference until the stored string changes. parse(null) where storage is missing or blocked. */
  read(): T;
  /** Saves; false when it could not be saved. Notifies this tab's listeners at once; other tabs hear the `storage` event. */
  write(next: T): boolean;
  /** read() → change → write(); returns write's result. */
  update(change: (current: T) => T): boolean;
  subscribe(listener: () => void): () => void;
  /** Whether storage can be written here (false in a blocked browser), for the "not saved" note. */
  writable(): boolean;
};
export function createLocalStore<T>(key: string, codec: LocalCodec<T>): LocalStore<T>;
/** null on the server and while hydrating (both renders agree), then the stored value; re-renders on writes in this tab and others. */
export function useLocalStore<T>(store: LocalStore<T>): T | null;
```

- [ ] **Step 1: Write the failing tests** (fake `Storage` and a dispatched `StorageEvent`): `read()` twice returns the same object while the raw string is unchanged; `write` then `read` round-trips through the codec; a listener fires once per `write` in this tab; a `storage` event for the key from another tab notifies listeners and `read()` returns the new value; a `storage` event for another key does not; a storage whose `getItem` throws reads as `parse(null)` and `writable()` is false; `setItem` throwing (quota) makes `write` return false and leaves `read()` unchanged.
- [ ] **Step 2:** Run `pnpm exec vitest run tests/unit/local-store.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement. Cache the last raw string and its parsed value per store. Subscribe to `window` `storage` events lazily (first listener) and remove the handler with the last one.
- [ ] **Step 4:** Run the new test and `pnpm exec vitest run tests/unit` (chat storage tests included); expect PASS.

### Task 2: Planner state and share links

**Files:**
- Create: `src/lib/craft/planner-store.ts`, `src/lib/craft/share.ts`
- Test: `tests/unit/planner-store.test.ts`, `tests/unit/craft-share.test.ts`

**Interfaces:**
- Consumes: Task 1; `ItemId` from `src/lib/craft/types.ts`.
- Produces:

```ts
// planner-store.ts
export const PLANNER_KEY = 'wv-craft-v1';
export const MAX_PLAN_ITEMS = 100;
export const MAX_ITEM_QTY = 9999;   // items, not crafts: 99 crafts × 20 nails fits
export const MAX_HAVE = 99999;
export type PlanItem = { id: ItemId; level: number; from: number; qty: number };
export type PlannerState = { v: 1; items: PlanItem[]; have: Record<ItemId, number>; at: string | null };
export const EMPTY_PLANNER: PlannerState;
export function parsePlanner(raw: string | null): PlannerState;
export function serializePlanner(state: PlannerState): string;
export function addItem(state: PlannerState, item: PlanItem, now: string): { state: PlannerState; added: boolean };
export function updateItem(state: PlannerState, index: number, patch: Partial<Omit<PlanItem, 'id'>>, now: string): PlannerState;
export function removeItem(state: PlannerState, index: number, now: string): PlannerState;
export function mergeItems(state: PlannerState, items: PlanItem[], now: string): PlannerState;   // "Sumar a mi lista"
export function replaceItems(state: PlannerState, items: PlanItem[], now: string): PlannerState; // "Reemplazar mi lista"; keeps `have`
export function setHave(state: PlannerState, id: ItemId, count: number, now: string): PlannerState; // ≤ 0 deletes the entry
export function clearPlan(state: PlannerState, now: string): PlannerState; // empties items, keeps have
export const plannerStore: LocalStore<PlannerState>;
// share.ts
export const SHARE_PARAM = 'l';
export const MAX_SHARE_ITEMS = 40;
export const MAX_SHARE_LENGTH = 4000;
export function encodeShare(items: PlanItem[]): string;          // "SwordIron.4.0.1~BronzeNails.1.0.20"
export function decodeShare(param: string | null | undefined): PlanItem[];
```

Rules: an item is valid when `id` is a non-empty string of at most 120 characters, and `level`, `from`, `qty` are integers; clamp `level` to 1..20, `from` to 0..level-1, `qty` to 1..`MAX_ITEM_QTY`; drop anything else alone. Unknown ids are kept (a newer graph may know them). `addItem` sums `qty` into an entry with the same `id`, `level` and `from`, else appends; at `MAX_PLAN_ITEMS` it returns `added: false` and the same state. In `encodeShare`, each id is `encodeURIComponent(id)` with `.` and `~` also escaped (`%2E`, `%7E`); only the first 40 items are written.

- [ ] **Step 1: Write the failing tests:**

```ts
it('drops what is malformed and keeps the rest', () => {
  const raw = JSON.stringify({ v: 1, items: [{ id: 'SwordIron', level: 4, from: 0, qty: 1 }, { id: '', level: 1 }, 'x', { id: 'Karve', level: 9, from: 12, qty: -3 }], have: { Wood: 12, Iron: 'x', Tin: -1 }, at: 'z' });
  expect(parsePlanner(raw)).toEqual({ v: 1, items: [{ id: 'SwordIron', level: 4, from: 0, qty: 1 }, { id: 'Karve', level: 9, from: 8, qty: 1 }], have: { Wood: 12 }, at: 'z' });
});
it('reads garbage as an empty plan', () => { for (const raw of [null, '', '{', '[]', '{"v":2}', 'null']) expect(parsePlanner(raw)).toEqual(EMPTY_PLANNER); });
it('keeps ids the graph does not know', () => { expect(parsePlanner(JSON.stringify({ v: 1, items: [{ id: 'FutureThing', level: 1, from: 0, qty: 2 }], have: {}, at: null })).items).toHaveLength(1); });
it('caps the list', () => { /* 150 valid items → 100 */ });
it('adds into the same target', () => { /* SwordIron 4/0 qty 1 twice → one entry qty 2 */ });
it('round-trips a share link with awkward ids', () => {
  const items = [{ id: 'SwordIron', level: 4, from: 2, qty: 1 }, { id: 'page:wood-structures#wood-wall.2~x', level: 1, from: 0, qty: 30 }];
  expect(decodeShare(encodeShare(items))).toEqual(items);
});
it('keeps the valid parts of an edited link', () => { expect(decodeShare('SwordIron.4.0.1~~garbage~BronzeNails.1.0.20.7~Karve.a.b.c')).toEqual([{ id: 'SwordIron', level: 4, from: 0, qty: 1 }]); });
it('caps a long link', () => { /* 500 parts → 40 items; a 5000-character param → [] */ });
```

(`BronzeNails.1.0.20.7` has five parts and is dropped; decide in the test which exact parts a five-part entry yields: none.)

- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.

### Task 3: Plan maths, the graph loader and item search

**Files:**
- Create: `src/lib/craft/plan.ts`, `src/lib/craft/graph-client.ts`, `src/lib/craft/item-search.ts`
- Test: `tests/unit/craft-plan.test.ts`, `tests/unit/craft-item-search.test.ts`

**Interfaces:**
- Consumes: wave A `indexGraph`, `stepCost`, `totalCost`, `missingSteps`, `expandRaw`, `stationsNeeded`, `craftable`, `decodeGraph` (`src/lib/craft/math.ts`, `codec.ts`); the route's payload as wave A Task 9 shipped it (read `src/app/api/wiki/recipes/route.ts`); `prepareTitleIndex`, `searchTitles` (`src/lib/wiki/title-search.ts`); Task 2's `PlanItem`.
- Produces:

```ts
// plan.ts (pure, isomorphic)
export type PlanNeeds = {
  direct: Map<ItemId, number>;        // what the targets' own steps consume
  raw: Map<ItemId, number>;           // expandRaw(direct) with the reader's intermediates subtracted
  fuel: Map<ItemId, number>;          // smelter and kiln fuel, the targets' own steps included
  crafts: CraftStep[];                // intermediate crafts, in the order to make them
  stations: Map<ItemId, number>;      // highest level per station, the targets' own steps included
  unexpanded: Unexpanded[];           // cycle / unknown-yield, from expandRaw
  missing: { id: ItemId; steps: number[] }[]; // targets whose steps the graph lacks
  unknown: ItemId[];                  // targets the graph does not know (kept in the list)
  made: { id: ItemId; crafts: number; made: number; leftover: number }[]; // targets with a yield above 1
};
export function planNeeds(index: GraphIndex, items: PlanItem[], have?: ReadonlyMap<ItemId, number>): PlanNeeds;
// graph-client.ts (browser)
export const GRAPH_URL = '/api/wiki/recipes?v=1';
export type LoadedGraph = { graph: RecipeGraph; index: GraphIndex; version: string };
export function loadGraph(): Promise<LoadedGraph>;   // one download per page life; a failure lets the next call retry
export function loadedGraph(): LoadedGraph | null;
// item-search.ts
export type ItemSearch = { prepared: PreparedTitleIndex; byId: ReadonlyMap<ItemId, GraphItem> };
export function prepareItemSearch(graph: RecipeGraph, filter: 'products' | 'all'): ItemSearch;
export function searchItems(search: ItemSearch, query: string, limit?: number): GraphItem[]; // limit 8
```

Rules for `planNeeds`, per target:
- Not in the graph → `unknown`.
- `level === 1 && from === 0`: the quality-1 recipe; `crafts = ceil(qty / yield)`; `direct += inputs × crafts`; `fuel += fuel × crafts`; when `yield > 1` push `made` with `leftover = crafts × yield − qty`; an unknown yield goes to `unexpanded` with reason `unknown-yield` and adds nothing.
- Otherwise: steps `from+1..level` (`totalCost` × `qty`); `missingSteps` → `missing`.
- Station levels of the targets' own steps go into `stationsNeeded(..., also)`.
- `raw` = `expandRaw(index, direct, { have: <have restricted to items that have a recipe> })`: what the reader already holds of an intermediate (4 Bronze) is not broken down; their raw counts are shown beside the need instead, never subtracted twice.

Item search: entries `{ s: id, t: en, c: [], i: icon, e: es, a: aliases }`; `products` keeps items with at least one recipe, `all` keeps every item (the "Lo que tengo" field).

- [ ] **Step 1: Write the failing tests** on the fixture graph from `tests/unit/craft-math.test.ts` (import or copy its builder):

```ts
it('needs a Karve's materials and expands its nails', () => {
  const n = planNeeds(ix, [{ id: 'Karve', level: 1, from: 0, qty: 1 }]);
  expect(n.direct.get('BronzeNails')).toBe(80);
  expect(n.raw.get('CopperOre')).toBe(8);
  expect(n.raw.get('TinOre')).toBe(4);
});
it('rounds a target's crafts up and reports the leftover', () => {
  expect(planNeeds(ix, [{ id: 'BronzeNails', level: 1, from: 0, qty: 30 }]).made).toEqual([{ id: 'BronzeNails', crafts: 2, made: 40, leftover: 10 }]);
});
it('upgrades three swords from level 2 to 4', () => {
  const n = planNeeds(ix, [{ id: 'SwordIron', level: 4, from: 2, qty: 3 }]);
  expect(Object.fromEntries(n.direct)).toEqual({ Wood: 15, Iron: 150, LeatherScraps: 30 });
  expect(n.stations.get('Forge')).toBe(5);
});
it('does not break down what the reader holds', () => {
  expect(planNeeds(ix, [{ id: 'Karve', level: 1, from: 0, qty: 1 }], new Map([['Bronze', 4]])).raw.get('CopperOre') ?? 0).toBe(0);
});
it('names unknown targets and missing steps', () => { /* 'Nope' → unknown; an item with steps 1-2 asked to 4 → missing [3, 4] */ });
it('finds items by their Spanish name', () => { /* 'espada de hierro' → SwordIron first, with es on the fixture item */ });
```

- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. `graph-client.ts` follows `loadIndex()` in `src/components/wiki/search-view.tsx:84-104` (module promise, retry after failure).
- [ ] **Step 4:** Run; expect PASS.

### Task 4: Copy and routes

**Files:**
- Create: `src/lib/i18n/copy/craft.ts` (`CRAFT_COPY = { es: {...}, en: {...} } as const`)
- Modify: `src/lib/i18n/strings.ts` (import and spread `CRAFT_COPY` in both languages, after `GUIDE_COPY`), `src/lib/routes.ts`
- Test: `tests/unit/strings.test.ts` (add `craft: CRAFT_COPY` to AREAS), `tests/unit/routes.test.ts` (or the file that tests `routes.ts`)

**Interfaces:**
- Produces: the keys below (both languages, voseo); `craftHref(share?: string): Route` (`/wiki/craft`, or with `?l=`), `articleLevelHref(slug: string, level: number): Route` (`/wiki/a/<slug>#level-<n>`; level 1 has no fragment).

| Key | es | en |
|---|---|---|
| craftMethodCraft / Build / Smelt / Cook / Bake / Brew / Ferment / Refine / Mill / Spin / Kiln / Prepare | Fabricar / Construir / Fundir / Cocinar / Hornear / Elaborar / Fermentar / Refinar / Moler / Hilar / Quemar / Preparar | Craft / Build / Smelt / Cook / Bake / Brew / Ferment / Refine / Mill / Spin / Burn / Prepare |
| craftStationLevel | {station} · nivel {n} | {station} · level {n} |
| craftByHand | A mano | By hand |
| craftNear | Cerca de {station} · nivel {n} | Near {station} · level {n} |
| craftModes | Qué mostrar | Show |
| craftModeStep | Este nivel | This level |
| craftModeTotal | Del 1 al {n} | Levels 1–{n} |
| craftModeRaw | Materias primas | Raw materials |
| craftQuantity | Cantidad | Quantity |
| craftFewer / craftMore | Uno menos / Uno más | One fewer / One more |
| craftYield | Rinde ×{n} | Makes ×{n} |
| craftMakes | {n} en total | {n} in total |
| craftTotalsStep | Para subir al nivel {n}: | To reach level {n}: |
| craftTotalsAll | Del nivel 1 al {n}: | Levels 1 to {n}: |
| craftTotalsRaw | Todo, en materias primas: | Everything, as raw materials: |
| craftFuel | Combustible | Fuel |
| craftSteps | Pasos intermedios | Steps in between |
| craftTimes | {n} veces | {n} times |
| craftUnknownYield | La wiki no dice cuántos rinde {name}; no lo desglosamos para no inventar un número. | The wiki does not say how many {name} a craft makes, so it is not broken down rather than guessed. |
| craftCycle | {name} se hace con sí mismo en otra receta; queda sin desglosar. | {name} is made from itself in another recipe, so it is left as is. |
| craftAdd | Agregar al taller | Add to Craft |
| craftInList | En tu taller | In your list |
| craftOpen | Ver | View |
| craftAdded | Agregado al taller. | Added to your list. |
| craftListFull | Tu taller está lleno (100 objetos). Quitá algo para sumar más. | Your list is full (100 items). Remove something to add more. |
| craftUsedIn | Usado en | Used in |
| craftUsedInMore | Ver {n} más | Show {n} more |
| craftUsedInLevel | nivel {n} | level {n} |
| craftStationPath | Mejoras de la estación | Station upgrades |
| craftStationBase | La estación sola llega al nivel 1; cada mejora construida cerca suma uno, en cualquier orden. | The station alone is level 1; each upgrade built nearby adds one, in any order. |
| craftStationMax | Nivel máximo: {n} | Highest level: {n} |
| craftStationMakes | Qué se fabrica acá | What is made here |
| craftPageTitle | Taller | Craft |
| craftPageLede | Armá tu lista, mirá cuánto te falta juntar y qué podés fabricar con lo que tenés. | Build your list, see what is left to gather and what you can make with what you have. |
| craftSaved | Se guarda en este dispositivo. | Saved on this device. |
| craftNotSaved | Este navegador no deja guardar: tu lista se pierde al cerrar la página. Compartila para no perderla. | This browser does not allow saving: your list is lost when the page closes. Share it to keep it. |
| craftNoScript | El taller necesita JavaScript. Cada artículo sigue mostrando su receta sin él. | The planner needs JavaScript. Every article still shows its recipe without it. |
| craftViewList / craftViewHave | Mi lista / Lo que tengo | My list / What I have |
| craftAddLabel | Agregar al taller | Add to your list |
| craftAddPlaceholder | Espada de hierro, karve, hidromiel… | Iron sword, karve, mead… |
| craftNoMatch | No hay nada que se fabrique con ese nombre. | Nothing craftable goes by that name. |
| craftEmpty | Tu lista está vacía. Buscá algo arriba o tocá «Agregar al taller» en cualquier artículo. | Your list is empty. Search above, or tap "Add to Craft" on any article. |
| craftLevel | Nivel | Level |
| craftFrom | Ya tengo | I have |
| craftFromNone | Nada | Nothing |
| craftRemove | Quitar {name} | Remove {name} |
| craftClear / craftClearConfirm | Vaciar lista / Sí, vaciar | Clear list / Yes, clear it |
| craftGather | Para juntar | To gather |
| craftDirect | Directo | Direct |
| craftGot | Lo tengo | Got it |
| craftHaveCount | Cuántos tenés de {name} | How many {name} you have |
| craftLeft | Te faltan {n} de {total} | {n} of {total} still to gather |
| craftDone | Tenés todo. ¡A fabricar! | You have everything. Go craft! |
| craftObtainMine / Chop / Gather / Drop / Loot / Farm / Fish / Buy / Other / Made | Se mina / Se tala / Se recolecta / Lo sueltan criaturas / Se encuentra / Se cultiva / Se pesca / Se compra / Otros / Se fabrica | Mined / Chopped / Gathered / Dropped / Found / Farmed / Fished / Bought / Other / Crafted |
| craftStationsNeeded | Estaciones que necesitás | Stations you need |
| craftUnknownTargets | {n} de tu lista ya no está en las recetas; lo guardamos por si vuelve. | {n} in your list is no longer in the recipes; it is kept in case it returns. |
| craftMissingSteps | La wiki no tiene la receta del nivel {levels} de {name}. | The wiki has no recipe for level {levels} of {name}. |
| craftLeftover | sobran {n} | {n} left over |
| craftHaveIntro | Anotá lo que tenés en el cofre y te decimos qué podés fabricar. | Note what is in your chests and see what you can make. |
| craftHaveAdd | Agregar material | Add a material |
| craftCanNow | Podés fabricar ya | You can make now |
| craftAlmost | Te falta poco | Almost there |
| craftMissing | falta {list} | missing {list} |
| craftShare | Compartir lista | Share list |
| craftShareCopied | Enlace copiado. | Link copied. |
| craftShared | Te pasaron una lista con {n} objetos. | Someone shared a list of {n} items. |
| craftReplace / craftMerge / craftCancel | Reemplazar mi lista / Sumar a mi lista / Cancelar | Replace my list / Add to my list / Cancel |
| craftLoading | Cargando recetas… | Loading recipes… |
| craftUnavailable | Las recetas no cargaron. | The recipes did not load. |
| craftRetry | Probá de nuevo | Try again |

- [ ] **Step 1:** Add `craft: CRAFT_COPY` to `tests/unit/strings.test.ts` AREAS and a routes test: `craftHref()` is `/wiki/craft`; `craftHref(encodeShare([...]))` starts `/wiki/craft?l=`; `articleLevelHref('iron-sword', 4)` is `/wiki/a/iron-sword#level-4`; level 1 has no fragment.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. Placeholders are `{name}`-style, replaced with `.replace` as elsewhere.
- [ ] **Step 4:** Run `pnpm exec vitest run tests/unit/strings.test.ts tests/unit/client-copy-guard.test.ts` and the routes test; expect PASS.

---

### Task 5: The fifth tab and the compact language button

**Files:**
- Modify: `src/components/shell/nav-model.ts`, `src/components/wiki/tab-bar.tsx`, `src/components/lang-toggle.tsx`, `src/lib/i18n/copy/shell.ts`, `src/app/manifest.ts`, `src/app/sitemap.ts`
- Test: `tests/unit/shell-nav.test.ts`, `tests/unit/sitemap.test.ts`, `tests/unit/access-policy.test.ts`, the manifest's test if one exists

**Interfaces:**
- Consumes: `plannerStore`, `useLocalStore` (Tasks 1-2).
- Produces: `TabKey` gains `'craft'`; `CRAFT_HREF = '/wiki/craft'`; `LangToggle` gains `compact?: boolean`; copy keys `shellCraft` (Taller / Craft), `shellShortcutCraft` (Tu lista de fabricación y lo que te falta juntar / Your crafting list and what is left to gather), `shellCraftCount` ({n} en tu taller / {n} in your list).

Decisions:
- Tabs, in order: Buscar ⌕ · Explorar ☰ · **Taller ᚳ** · Guía ᛦ · Chat ✦. The Taller rune is **ᚳ** (Anglo-Saxon *cēn*, the torch, the same meaning as kenaz): ᚲ is already `rune(6)`, the Mistlands ordinal and the sixth source (DESIGN.md, OPEN item), and ᚳ is in none of the ordinal runes.
- `currentTab('/wiki/craft')` is `{ key: 'craft', current: 'page' }`; `/wiki/crafts`, `/wiki/craftsman` and `/wiki/craft/x` are `null`.
- Below 640 px the toggle is one 44 px button showing the other language's code (`EN` while reading Spanish), `lang` set to that language, accessible name its endonym (`shellLanguageEn` / `shellLanguageEs`), same cookie and refresh behaviour. From 640 px the segmented pair as today. Both are rendered and switched by CSS (`sm:hidden` / `max-sm:hidden`), so the server and the first client render agree. The chat's toggle is unchanged (`compact` unset).
- The nav search shows from 768 px (`md:block`); between 640 and 767 px the Search tab is one tap away.
- Badge: the number of targets in `wv-craft-v1`, rendered only after hydration (`useLocalStore` is null before), on the rune on phones and after the label from 640 px, `aria-hidden`, with `shellCraftCount` as screen-reader text inside the link; nothing when the list is empty.
- Manifest: a shortcut `{ name: t.shellCraft, url: '/wiki/craft', description: t.shellShortcutCraft }` after Search. Sitemap: `/wiki/craft` beside the other sections. Access: `/wiki/craft` and `/api/wiki/recipes` are public (already true by prefix; pin it in the test).

- [ ] **Step 1: Write the failing tests:** the `currentTab` cases above; the sitemap lists `/wiki/craft`; the access policy treats `/wiki/craft` and `/api/wiki/recipes?v=1` as public.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. Measure in a browser at 360, 390, 640, 768 and 1280 px, Spanish and English: five tabs with no truncated label at 360 (each about 60.8 px), the compact button 44 px, nothing overflowing the bar.
- [ ] **Step 4:** Run the tests and `pnpm exec vitest run tests/unit`; expect PASS.

### Task 6: The service worker

**Files:**
- Modify: `public/sw.js`
- Test: `tests/unit/sw-routing.test.ts`

**Interfaces:**
- Consumes: `GRAPH_URL` (Task 3).

Behaviour: `/api/wiki/recipes` is handled like the title index (stale-while-revalidate in the shell cache); `GRAPH_URL` is fetched at install beside the title index; every other `/api/` path is still left to the network. A page load of `/wiki/craft?l=…` is **not kept** (like `/wiki?q=`): its HTML embeds the shared list and the address, so a copy saved under `/wiki/craft` would offer the shared list again every time the planner opens offline. The planner cleans the address after the reader decides, and the page's `shown` message then names `/wiki/craft`, whose copy is taken as usual; `copyKey` folds any `l` away for the same reason. One slot for the planner, however many share links are opened. No `VERSION` bump unless the stored shapes change. Build on the current worker (the `shown`-message copies landed on 2026-10-27; read its header comment first).

- [ ] **Step 1: Write the failing tests:** rename "leaves every API alone except the title index" to "…except the title index and the recipe graph" and add the recipes path; a twin of "saves the title index the search page reads" that reads `GRAPH_URL` from `src/lib/craft/graph-client.ts` and checks the install list holds it; a page load of `/wiki/craft?l=SwordIron.4.0.1` is answered from the network and nothing is stored for it; `copyKey('/wiki/craft?l=SwordIron.4.0.1')` equals `copyKey('/wiki/craft')`; a `shown` message for `/wiki/craft` stores one copy.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement, keeping the file's comment voice.
- [ ] **Step 4:** Run; expect PASS.

---

### Task 7: One selected level per article

**Files:**
- Create: `src/components/wiki/article/level-context.tsx` (`'use client'`)
- Modify: `src/components/wiki/article/level-tabs.tsx`, `src/components/wiki/article/infobox.tsx` (mount the provider)
- Test: `tests/unit/level-context.test.tsx` (React Testing Library if the repo has it; otherwise test the pure helpers and cover the rest in Task 17's e2e)

**Interfaces:**
- Produces:

```ts
export const LEVEL_FRAGMENT = /^#level-(\d{1,2})$/;
export function levelFromHash(hash: string, qualities: readonly number[]): number | null; // index into qualities, or null
export function LevelProvider(props: { qualities: number[]; children: React.ReactNode }): React.JSX.Element;
export function useLevel(): { qualities: readonly number[]; index: number; select(index: number): void } | null;
```

Behaviour: the provider is mounted by `Infobox` around the tabbed groups when `tabSetKind(...) === 'levels'` (qualities = the tab labels as numbers). It starts at index 0 (server and first render agree), then on mount reads `location.hash` and listens to `hashchange` and `popstate`. `select` updates state and writes the fragment with `history.replaceState(history.state, '', ...)` (`#level-N`, none for the first level): no new history entry, Next's state kept, no scroll. `LevelTabs` uses the context when present, local state otherwise (stars and variants unchanged), and gains a `before?: React.ReactNode` slot rendered after the switcher and its hint, before the panels' flow, spanning the full width when spread.

- [ ] **Step 1: Write the failing tests:** `levelFromHash('#level-4', [1,2,3,4])` is 3; `'#level-9'`, `'#level-x'`, `''` are null; a two-tab star set ignores the hash.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS. In a browser: `/wiki/a/iron-sword#level-4` opens on level 4 without scrolling; switching levels rewrites the fragment; Back leaves the article rather than stepping through levels.

### Task 8: The craft card

**Files:**
- Create: `src/components/wiki/craft/craft-card.tsx` (`'use client'`), `src/app/styles/craft.css`
- Test: `tests/unit/craft-card-model.test.ts` (pure helpers the card uses, in `src/components/wiki/craft/card-model.ts`)

**Interfaces:**
- Consumes: `CraftView` from `src/lib/craft/data.ts` (wave A Task 9; use the type only, never import the server module into the client: re-export the type from `src/lib/craft/types.ts` or a `view-types.ts` if `data.ts` is server-only), wave A maths, Tasks 1-4, `useLevel()`.
- Produces: `export type CraftCardData = Pick<CraftView, 'item' | 'recipes' | 'closure'>;` `export function CraftCard(props: { data: CraftCardData; lang: Lang; uiLang?: Lang }): React.JSX.Element;` and in `card-model.ts`: `cardTotals(index, data, quality, mode: 'step' | 'total' | 'raw', crafts: number): { rows: { id; qty }[]; fuel: { id; qty }[]; steps: CraftStep[]; unexpanded: Unexpanded[]; made: number }` and `planItemFor(data, quality, mode, crafts): PlanItem`.

What it shows, top to bottom (spec §6): a `.label` heading from the method (`craftMethod*`); the station chip ("Forja · nivel 2", linking to the station's article; "A mano" with no station; "Cerca de Banco de trabajo · nivel 1" for pieces); the mode switch (Este nivel / Del 1 al N / Materias primas; "Del 1 al N" hidden at level 1 or on single-level items, where it equals the step; a segmented control like `SegmentedLinks`, buttons with `aria-pressed`, 44 px on coarse pointers); the material tiles (reuse the look of `.recipe-tile` from `tables.css` through new `craft-*` classes in `craft.css`; icon with `thumbnailImageUrl` + `FANDOM_IMG_PROPS`, `object-fit: scale-down`; name in the reader's language with the English name beside it where different; quantity in forge monospace; linked to its article when it has one); in raw mode, fuel as its own row and the intermediate steps listed ("Bronce ×4 · Forja"); the unexpanded names with `craftUnknownYield` / `craftCycle`; the quantity stepper (crafts 1-99, `inputMode="numeric"`, buttons named `craftFewer` / `craftMore`); the yield line when above 1 (`Rinde ×20 · 40 en total`); the main action.

Semantics: "Este nivel" is the step to the selected quality; "Del 1 al N" is `totalCost(id, 0, N)`; "Materias primas" is `expandRaw` of the 0→N total. The add action adds exactly what is shown: `{ id, level: N, from: mode === 'step' ? N − 1 : 0, qty: crafts × yield }`. After adding, the button becomes "En tu taller · Ver" (linking to `/wiki/craft`) for that target, from the store. The totals sentence sits in an `aria-live="polite"` region and changes with level, mode and quantity.

Server render: the card renders on the server with level 1 (or the provider's first quality), mode "Este nivel", quantity 1, so a reader without JavaScript still sees the recipe.

- [ ] **Step 1: Write the failing tests** (`card-model`): Iron Sword level 3, step → Wood 1, Iron 10, Leather scraps 2 (fixture numbers), total → Wood 5, Iron 50, Leather scraps 9; Bronze Nails, raw, 2 crafts → 40 made, Copper ore and Tin ore from 2 Bronze; an unknown-yield intermediate → listed in `unexpanded` and absent from rows; `planItemFor` for step mode at level 3 is `{ from: 2, level: 3 }`, for total and raw `{ from: 0 }`, quantity × yield.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement the model, then the component, then `craft.css`. Follow the impeccable steps in Global Constraints.
- [ ] **Step 4:** Run; expect PASS.

### Task 9: The card in the infobox, and the page

**Files:**
- Modify: `src/components/wiki/article/infobox.tsx`, `infobox-model.ts`, `stat-group.tsx`, `src/components/wiki/article-view.tsx`, `src/app/wiki/a/[slug]/page.tsx`
- Test: `tests/unit/infobox-model.test.ts` (extend), `tests/integration/article-craft.test.ts` (new; renders the page's data path on PGlite seeded through wave A's `buildRecipeGraph`)

**Interfaces:**
- Consumes: `getCraftView(slug, lang)`, Task 7-8.
- Produces: `Infobox` prop `craft?: CraftCardData | null`; `StatGroup` prop `hideRecipe?: boolean` (a group left with no rows renders nothing); `infoboxUnits(infobox, craftInputs?: number)` and `articleLayout(doc, infobox, craftInputs?: number)`: with a card, recipe rows count nothing and the card counts `4 + ceil(craftInputs / 2) × 1.6` units, where `craftInputs` is the most inputs any of its recipes has.

Placement (spec §6, recon §3.2): with level tabs, the card is `LevelTabs`' `before` slot (directly under the switcher, above the rows it changes; spanning the three columns when spread); without them, the first block of the infobox. Recipe rows are hidden wherever the card shows. The page awaits `getCraftView` beside `getArticlePage` (`Promise.all`); a failure of the craft view never takes the article down (catch → `null`, log once). `ArticleView` takes `craft: CraftView | null` and passes the card's three fields down; it also renders Task 10's sections. Items with no graph data keep today's recipe row. The route imports `@/app/styles/craft.css`.

- [ ] **Step 1: Write the failing tests:** layout units with a 9-input card equal the formula; a group whose only row is the recipe disappears with `hideRecipe`; on seeded PGlite, Iron Sword's page data carries a craft view with 4 recipes and its infobox renders no recipe row; an article whose slug the graph lacks renders the recipe row as before.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests and `pnpm exec vitest run tests/unit/route-css.test.ts`; expect PASS.

### Task 10: "Usado en" and the station's upgrade path

**Files:**
- Create: `src/components/wiki/craft/used-in.tsx`, `src/components/wiki/craft/station-path.tsx` (server components, no `'use client'`)
- Modify: `src/app/styles/craft.css`, `src/components/wiki/article-view.tsx` (render them first in the body column)
- Test: `tests/unit/used-in-model.test.ts` (grouping and collapse helpers in `src/components/wiki/craft/used-in-model.ts`)

**Interfaces:**
- Consumes: `CraftView['usedIn']`, `CraftView['station']`, `categoryHref(ALL_CATEGORIES, { station })`.
- Produces: `UsedIn({ usedIn, lang, uiLang })`, `StationPath({ item, station, lang, uiLang })`, `groupUses(usedIn, visible = 8): { station; shown; hidden }[]`.

"Usado en": an `h2` with `craftUsedIn`, groups by station in the order the view gives (by hand last), each group's first 8 tiles visible and the rest inside `<details>` with `craftUsedInMore`; a tile names the product, its quantity of this material, and the level when the use is an upgrade step (`craftUsedInLevel`). No client JavaScript.

Station path: an `h2` with `craftStationPath`; `craftStationBase`; `craftStationMax`; each extension with its materials (tiles) and "+1"; then `craftStationMakes` linking to `/wiki/c/all?station=<the station's English name>`.

- [ ] **Step 1: Write the failing tests:** 75 uses in one group → 8 shown, 67 hidden; several groups keep the given order; an empty `usedIn` renders nothing.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS. In a browser on the refreshed corpus: Bronze, Wood (75 uses), Forge (its extensions), Tin, at 360 and 1280 px.

---

### Task 11: The planner route

**Files:**
- Create: `src/app/wiki/craft/page.tsx`, `src/components/wiki/planner/planner.tsx` (`'use client'`), `src/app/styles/planner.css`
- Test: `tests/unit/route-css.test.ts` (automatic), `tests/integration/craft-route.test.ts` (the page answers 200 for a signed-out reader, in both languages)

**Interfaces:**
- Consumes: Tasks 1-4; `LANG_COOKIE`/`parseLang` like the article route.
- Produces: `export default async function CraftPage({ searchParams })`; `Planner({ lang, shared }: { lang: Lang; shared: string | null })`.

The server renders the `h1` (`craftPageTitle`), the lede, a `<noscript>` note (`craftNoScript`) and `<Planner lang shared={searchParams.l ?? null} />`; `dynamic = 'force-dynamic'`; metadata: title "Taller — Valheim Codex" / "Craft — Valheim Codex", a description from the lede, canonical `/wiki/craft`. The planner loads the graph on mount (`loadGraph`), shows `craftLoading` in a box of fixed height (no layout shift), and `craftUnavailable` with `craftRetry` on failure. It states `craftSaved`, or `craftNotSaved` when `plannerStore.writable()` is false. Two views, "Mi lista" and "Lo que tengo", switched by a segmented control in local state.

- [ ] **Step 1:** Write the route test; run; expect FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run; expect PASS.

### Task 12: My list

**Files:**
- Create: `src/components/wiki/planner/add-item.tsx`, `target-list.tsx`
- Test: `tests/unit/planner-list-model.test.ts` (helpers in `src/components/wiki/planner/list-model.ts`)

Adding: a combobox over `prepareItemSearch(graph, 'products')` (input 16 px on coarse pointers, `role="combobox"`, a listbox of up to 8 options with icon, the reader's name and the English one, arrow keys and Enter, Escape clears); choosing adds `{ id, level: 1, from: 0, qty: yield }` and announces `craftAdded`; at the cap, `craftListFull`.

Each target row: icon; name linking to `articleLevelHref(slug, level)` (no link when the item has no article); a level select (1..maxQuality, only when above 1); "Ya tengo" select (Nada, Nivel 1..level-1; only when level is above 1); a quantity stepper in items (step = yield for yield items); the station line for its steps; remove (`craftRemove`). A level above the item's maximum (an older or newer graph) is shown as stored with a note, never silently changed. Targets the graph does not know are listed with `craftUnknownTargets`. "Vaciar lista" asks once inline (`craftClearConfirm`).

- [ ] **Step 1: Write the failing tests** for the list model: the station line for Iron Sword 2→4 is "Forja · nivel 5"; the quantity step of Bronze Nails is 20; an unknown id is flagged.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.

### Task 13: The shopping list

**Files:**
- Create: `src/components/wiki/planner/shopping-list.tsx`, `src/components/wiki/planner/shopping-model.ts`
- Test: `tests/unit/planner-shopping.test.ts`

**Interfaces:**
- Consumes: `planNeeds` (Task 3), `setHave` (Task 2).
- Produces: `shoppingRows(index, needs, mode: 'direct' | 'raw', have): { group: ObtainGroup; rows: { id; need; have; done }[] }[]` with `ObtainGroup = 'made' | 'mine' | 'chop' | 'gather' | 'drop' | 'loot' | 'farm' | 'fish' | 'buy' | 'other'`.

"Para juntar" with a Directo / Materias primas switch. Direct mode: the `direct` map, intermediates first (group `made`), then raw by how they are had. Raw mode: `raw` plus `fuel` grouped by the first `obtain.how` of each item (`other` when the graph says nothing), then "Pasos intermedios" (the crafts in order, with station and times) and leftovers (`craftLeftover`). Each row: icon, name (linked), need in forge monospace, a "Lo tengo" checkbox (sets `have` to the need) and a count field (`craftHaveCount`, 16 px on coarse pointers); a done row dims but keeps 4.5:1 contrast. A summary line above (`craftLeft` / `craftDone`) in an `aria-live="polite"` region. Then "Estaciones que necesitás" (chips linking to the stations), the unexpanded names with their reasons, and missing steps (`craftMissingSteps`). On a phone nothing sticks to the bottom except what clears the tab bar (`bottom: calc(var(--tabbar-h) + …)`).

- [ ] **Step 1: Write the failing tests:** a Karve in raw mode has Copper ore 8 and Tin ore 4 under `mine`; Bronze in direct mode is in `made`; ticking Copper ore with need 8 sets have 8 and the row is done; the summary counts rows not done.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.

### Task 14: What I have

**Files:**
- Create: `src/components/wiki/planner/have-view.tsx`, `src/components/wiki/planner/have-model.ts`
- Test: `tests/unit/planner-have.test.ts`

The reader's counts (the same `have` map the shopping list writes), editable, with an add field over `prepareItemSearch(graph, 'all')`. Results from `craftable(index, have)`: "Podés fabricar ya" (product and how many times) and "Te falta poco" (product and `craftMissing` with the missing quantities), items before building pieces, each list capped at 24 with the rest behind `<details>`; every result has "Agregar al taller" (adds level 1, quantity one craft's yield).

- [ ] **Step 1: Write the failing tests** for the model: 4 Copper and 2 Tin → Bronze ×2 in "now"; ordering puts items before pieces; the cap hides the rest.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.

### Task 15: Sharing

**Files:**
- Create: `src/components/wiki/planner/share.tsx`
- Test: `tests/unit/planner-share-flow.test.ts` (the decision helper in `src/components/wiki/planner/share-model.ts`)

"Compartir lista" builds `location.origin + craftHref(encodeShare(items))`; `navigator.share` where it exists, else the clipboard with `craftShareCopied`, else a read-only field holding the link. Opening `/wiki/craft?l=…`: an empty list loads it at once; a non-empty one asks (`craftShared`, Reemplazar / Sumar / Cancelar) in an inline panel at the top (no modal trap), focus moved to it; any choice then `router.replace('/wiki/craft', { scroll: false })` to clean the address. An undecodable `l` is dropped with no question.

- [ ] **Step 1: Write the failing tests** for `shareDecision(current, shared)`: empty current → `load`; non-empty → `ask`; nothing valid in the link → `ignore`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run; expect PASS.

---

### Task 16: Design drift fixes

**Files:** `src/components/wiki/lists/compare-view.tsx`, `src/components/composer.tsx`, `src/components/connect/gemini-panel.tsx`, `src/components/wiki/article/identity.tsx`, `src/app/styles/chat.css`, `src/components/sidebar.tsx`, `src/components/wiki/ask-button.tsx`, `src/components/wiki/gallery-lightbox.tsx`, `src/components/wiki/guide/guide-ui.tsx`, `src/components/wiki/guide/guide-data.tsx` (callout tone only), `src/app/styles/guide.css`, `src/app/styles/tables.css`, `src/components/connect/method-picker.tsx`, `src/components/wiki/lists/segmented-links.tsx` (comment), `DESIGN.md`, `.impeccable/design.json` (regenerate with the scratchpad's `build-sidecar.mjs`). Locate each by the line the DESIGN.md Drift entry cites; paths above are where the review found them.

Fix each, then delete its Drift entry from DESIGN.md:
1. Compare sort select: 16 px on coarse pointers, a hover and focus edge.
2. Composer, Gemini key field, model select: 16 px whenever `pointer: coarse` (the nav-search pattern), smaller only on fine pointers.
3. Article picture: `object-scale-down` (never enlarged; chat.css precedent).
4. Citation chip: `font-size: max(0.7em, 0.75rem)`; lit state forge/15 (5.27:1 on bog, 4.64:1 on peat).
5. New-question hover and the ask button's hover: an opaque `color-mix(in srgb, var(--color-forge) 15%, var(--color-peat))` base.
6. Lightbox counter: ash text, no black drop shadow.
7. Biome callouts: the warn (blood) tone only for what costs a death; tips such as the Mistlands smelting note take the neutral tone.
8. `.g-stats` and `.stack-table tr`: no `overflow: hidden`; round the first and last rows instead, like `.stat-list`.
9. Method picker: 2 px inner corners in the 4 px-padded track; the `segmented-links.tsx` comment says what the code does.

- [ ] **Step 1:** For each, measure the before state in a browser (size, contrast, clipping) and record it.
- [ ] **Step 2:** Fix; measure again; run `pnpm exec vitest run tests/unit` and `pnpm lint`.
- [ ] **Step 3:** Update DESIGN.md, rebuild the sidecar, run the impeccable doctor (`node C:/Users/airau/.claude/skills/impeccable/scripts/doctor.mjs --json`): 0 problems.

### Task 17: Whole-wave checks

**Files:** `tests/e2e/craft.spec.ts` (new), `tests/e2e/wiki.spec.ts` (extend the tab-bar test with Taller).

- [ ] **Step 1:** `pnpm exec tsc --noEmit -p .`, `pnpm lint`, `pnpm test` (unit and integration): PASS.
- [ ] **Step 2:** Write the e2e specs (phone 390 and desktop 1280, Spanish and English): the Taller tab is current on `/wiki/craft`; Iron Sword's card follows the level and `#level-4` opens level 4; "Agregar al taller" then the planner shows it and the tab badge says 1; a share link offers Reemplazar / Sumar and cleans the address; the planner opens offline after one visit; no sideways scroll at 360 on the planner and on Iron Sword; with JavaScript off, Iron Sword shows its level-1 recipe in the card and the planner shows its `<noscript>` note.
- [ ] **Step 3:** Run them against the dev server on the refreshed corpus (`E2E_BASE_URL=http://localhost:3100 pnpm exec playwright test tests/e2e/craft.spec.ts tests/e2e/wiki.spec.ts`): PASS.
- [ ] **Step 4:** Budgets: compare the article route's and the planner route's client JS (gzip) against the previous build's (`pnpm build` output or `.next` analysis); measure `/api/wiki/recipes?v=1` gzip. Record the numbers.
- [ ] **Step 5:** Screenshots of Iron Sword, Bronze, Forge, Wood and the planner (list, raw list, what I have, share prompt) at 360, 390, 768 and 1280 px in both languages; review them against DESIGN.md; run the impeccable detector on every changed UI file.
