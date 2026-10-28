# Product

<!-- impeccable:product-schema 1 -->

> **Provenance.** Written on 2026-10-27 by `/impeccable init` with no interview. The owner skipped the questions and
> delegated every decision ("do as you recommend"), as both specs record: the crafting spec's header (lines 3-6) and
> the overhaul spec's status line (lines 3-4). Every fact below is therefore **inferred from the repository** and
> names its source in brackets. Anything no source settles is marked **OPEN**.
> Source keys: **[crafting]** = `docs/superpowers/specs/2026-10-27-crafting-and-progression-design.md`;
> **[overhaul]** = `docs/superpowers/specs/2026-10-26-wiki-overhaul-and-chat-auth-design.md`;
> **[rag]** = `docs/superpowers/specs/2026-08-20-valheim-rag-design.md`; **[browser]** =
> `docs/superpowers/specs/2026-08-20-wiki-browser-design.md`; **[README]** = `README.md`. Other sources are code paths.
> The visual system is recorded separately, in `DESIGN.md`.

## Platform

web

## Users

- **Primary: Spanish-speaking Valheim players in the middle of a play session.** They open the Codex "usually on a phone
  next to the keyboard" [crafting §1] and use it one-handed: "the whole point of this reader is that it is usable
  one-handed mid-game" (`src/components/wiki/tab-bar.tsx`). The copy is rioplatense Spanish with voseo
  (`src/lib/i18n/copy/*`), Spanish is the default language for anyone without a cookie, including crawlers
  (`src/app/manifest.ts`, `src/app/layout.tsx`), and link previews are tagged `es_UY` (`src/lib/site.ts`).
- **Their jobs, as the crafting spec frames them in four questions** [crafting §1]. The framing is the spec
  author's; no user research is recorded (see Evidence on Hand).
  1. "What do I need to make this?" Exact materials for the level they want, totals, the station and its level, and
     what the materials break down into.
  2. "I have this; what can I do with it?" Everything a material is used in, and what they can craft now.
  3. "What should I do next?" Where they are in the game, and the next step that matters.
  4. "Can you just tell me?" The chat, with the same exact numbers, in Spanish or English.
- **The owner's crew ("el grupo").** People who share the server's chat password. Each picks a profile name that keeps
  their history apart; it is a label, not a credential, and the server pays for their answers
  (`src/lib/i18n/copy/auth.ts` `connectPasswordIntro`; [README] Profiles).
- **Chat guests.** Readers who bring their own Gemini API key or their Puter account and pay for their own answers
  [overhaul §2; README Auth].
- **Public readers**, including people sent by a search engine or a shared link. Reading (search, browse, articles,
  compare, guide) needs no account [README Auth]; the site publishes a sitemap, robots rules and per-article preview
  cards (`src/app/sitemap.ts`, `src/app/robots.ts`, `src/app/wiki/a/[slug]/opengraph-image.tsx`).
- **English-speaking players** get every string in English too (`tests/unit/strings.test.ts`), as the second language.
- **OPEN:** how many readers there are, and whether growing the public audience is a goal. The repository holds no
  analytics or usage data.

## Product Purpose

Valheim Codex turns the Valheim wiki (Fandom, 1,027 articles) into answers a player can use mid-game. Today it is a
data-first reader that works on a phone and offline, a search that finds articles by their Spanish names, a bilingual
"100%" completion guide, and a chat that answers only from wiki text and cites the article behind every claim
[README].

The owner's current goal: "I need the valheim app to be the ultimate tool to help valheim players to craft items and
progress ingame" [crafting, header]. The crafting and progression companion being built adds a recipe graph derived
from the wiki, a craft card on every item page, a planner called "Taller" (`/wiki/craft`), the guide as a progress
tracker with a "your next step" card, and chat answers that quote exact recipe rows [crafting §2]. Work runs in waves
A to E; wave A (the recipe graph) is in progress (`docs/superpowers/plans/2026-10-27-crafting-wave-a-data.md`).

**Success:** "a player who stops opening three wiki tabs and a calculator" [crafting §1]. Retrieval quality is measured
by `pnpm eval` (see Evidence on Hand). **OPEN:** no product metric for that success is defined or collected.

## Positioning

- **The data is the page.** On Fandom, on a phone, the infobox buries the page and the numbers sit below the fold. Here
  identity and stats come first, upgrade levels are one switch instead of four stacked tables, and prose follows:
  "Nobody opens 'Iron Sword' to read prose" [browser §3; `src/components/wiki/article-view.tsx`].
- **Spanish-first over an English wiki.** Search folds accents and case and reads Spanish through a glossary, so
  *hierro*, *espada de hierro* and *banco de trabajo* rank the right article first [README]. Articles are translated
  by a model and labeled as such. Names stay matchable to what the game shows: the guide's name chips and the chat's
  answers use the English in-game name (the chat may add a Spanish gloss), and interface labels and the planner show
  the canonical Spanish name with the English beside it (`src/components/wiki/guide/guide-ui.tsx` `Item`;
  [crafting §15.8]).
- **Grounded answers.** The chat may not fill gaps from the model's own Valheim knowledge, cites every claim, and says
  so when the wiki has no answer: "a player cannot tell an invented number from a cited one" [rag §4; README].
- **Exact numbers, computed.** Totals across upgrade levels, yields per craft and raw-material breakdowns. When a yield
  or a recipe is unknown, the UI says so and does not compute past it [crafting §2].
- **Works offline after one visit, and installs to a home screen** [browser §5; `public/sw.js`; `src/app/manifest.ts`].
- **No account to read.** Only the chat costs money, so only the chat asks how its answers will be paid for: the crew
  password, the reader's own key, or their Puter account [README Auth].

## Operating Context

- **Where and how.** Mid-session, on a phone held next to the PC running the game, often one-handed; also on desktops
  beside the game, tablets, and phones turned sideways for wide tables (`src/app/manifest.ts` keeps orientation
  `any`). Design checks run at 360, 390, 768, 1024 and 1440 px [overhaul §6].
- **Over weeks.** The guide is "a reading page… that a reader checks off over weeks of play"
  (`src/app/styles/guide.css`); ticks live on the device (`localStorage`, key `wv-guide-checks-v1`).
- **Unreliable network.** Visited pages and the title index are kept by the service worker; a saved copy answers when
  the network fails or stays silent for 3 s; a banner says when the server cannot be reached
  (`public/sw.js`, `src/components/wiki/offline-banner.tsx`).
- **Installed, without browser chrome.** The app runs standalone (short name "Codex"), so every page must offer its own
  way back: the 404 and error pages keep the reader inside the app (`src/components/shell/not-found-view.tsx`).
- **Content freshness.** The stored corpus was ingested on 2026-08-20 at game patch 0.221.12. The game's 1.0 release
  (2026-09-09) has passed and 220 of 1,027 pages have changed on the wiki since. The guide is hand-written, dated
  21 Aug 2026, and 17 of its statements contradict the corpus [crafting §3].
- **Surfaces and the moments they serve.**

| Surface | Route | Moment it serves |
|---|---|---|
| Search (the home) | `/wiki` | "I know its name": one tap to the article; titles filter on the device, offline too |
| Article | `/wiki/a/[slug]` | "What are its numbers, what does it take": identity, stats per level, recipe, then prose |
| Browse | `/wiki/browse` | "I don't know its name": biomes, categories, crafting stations |
| Category list | `/wiki/c/[category]` | an index of one kind of thing |
| Compare | `/wiki/c/[category]?view=compare` | "Which of these is better": one stat sorted across rows |
| Guide | `/wiki/guide` | the 100% run, chapter by chapter, ticked over weeks |
| Chat | `/` | "Can you just tell me?": a cited answer, follow-ups, history |
| Connect | `/login` | choosing how answers are paid for |
| 404, error, offline notices | any | getting back on track without browser chrome |
| Craft card (planned) | inside the article | this level's cost, levels 1 to N, raw materials, add to the list [crafting §6] |
| Taller planner (planned) | `/wiki/craft` | the shopping list for what to make; what can be crafted now [crafting §7] |
| Next-step card (planned) | home and guide | "What should I do next?" [crafting §9.3] |

No surface is a marketing page: the home is the search itself (`src/app/wiki/page.tsx`).

## Capabilities and Constraints

**Capabilities, as built** [README unless noted]:

- Reader pages are rendered on the server and readable without JavaScript; client code is limited to small islands
  (level switch, gallery viewer, ask button, translation request, sticky infobox, scroll boxes)
  (`src/components/wiki/article-view.tsx`).
- Title search runs in the browser over a downloaded index (about 29 KB brotli); full-text search runs on the server;
  `/` focuses search from any page (`src/components/wiki/tab-bar.tsx`).
- Spanish translations are made by a model when an article is viewed, labeled "Traducción automática", under a small
  daily public cap (30 by default) [overhaul §2].
- The guide has 54 checkboxes saved on the device [crafting §3].
- The chat runs hybrid retrieval, falls through five model providers, links citations to in-app articles, and offers
  three sign-in methods with per-identity quotas (password: 40 questions per 10 minutes per address and 2,000 a day;
  guests: 6 a minute and 150 a day).
- Installable PWA; visited pages, their images and the title index work offline (`public/sw.js`, up to 60 saved pages).

**Constraints future work must keep:**

- **Phone-first, one-handed.** Every surface works on a phone held in one hand mid-game: navigation sits "where a
  thumb rests" (`src/components/wiki/tab-bar.tsx`), touch targets are at least 44 × 44 px on coarse pointers, and
  nothing scrolls the page sideways at 360 px [overhaul §4.1; crafting §12]. How that is drawn is recorded in
  `DESIGN.md`.
- **Offline.** The worker never answers a page from cache while the network works, and keys saved copies so a page is
  not stored once per query string. A new API works offline only once the worker routes it (`public/sw.js`).
- **Saved on the device.** Every storage access is wrapped, and blocked storage never takes a page down
  [crafting §11]. Saved state that must survive a change of shape lives under a versioned key: the guide's ticks are
  `wv-guide-checks-v1` (`src/components/wiki/guide/guide-progress.tsx`), and the crafting spec names `wv-craft-v1`
  for the planner and `wv-progress-v1` for progress, which also reads the legacy key [crafting §11]. No naming rule is
  written down. Recommended for new keys: the `wv-<area>-v<n>` shape of those three. Existing keys without a version:
  `wv-install-dismissed` (`src/components/shell/install-capture.ts`), `wv.profile` and `wv.puter-model`
  (`src/lib/chat/storage.ts`).
- **Language.** Every visible or accessible string exists in both languages, in per-area copy modules; client
  components read copy through `useStrings()` and never import the copy table (`tests/unit/client-copy-guard.test.ts`).
  The language lives in a cookie. **OPEN:** moving it into the URL is the recommended next step, not decided
  [overhaul §8].
- **Performance budgets.** Only Tailwind and the shell's base layer block every first paint; only Spectral and Cinzel are
  preloaded (`src/app/layout.tsx`). Links prefetch on intent, never on sight (`src/components/wiki/linked-text.tsx`).
  The whole recipe graph never enters a page payload; the article's craft card is one client island with 1–3 KB of
  props and no measurable LCP regression; the planner route ships at most about 25 KB gzip of its own JavaScript plus
  the graph (at most 30 KB gzip) [crafting §12].
- **Privacy and spending.** A reader's Gemini key lives only in an encrypted httpOnly cookie, never in `localStorage` or
  the database; the operator's model budget is spent only for password sessions; images load from Fandom with no
  referrer [overhaul §2; README].
- **Data.** Fandom is the only source (wiki.gg is unpublished) [rag §1]. Item identity is the game's internal ID, so
  lists, progress and share links survive wiki renames [crafting §4].
- **Deployment.** Self-hosted Docker behind a Cloudflare tunnel, Postgres on Neon; reader pages render per request
  because the language comes from a cookie [README].
- **OPEN:** accounts or cross-device sync (a non-goal today: plans and progress stay on the device and travel by share
  link [crafting §2]); the language in the URL; product metrics.

**Must never** [crafting §2 anti-goals, plus invariants stated in the code]:

- Show a wrong number. A total that ignores a yield, or a stale list page's cost, is worse than no total.
- Lose a reader's progress or list (an overwriting save, a reused id).
- Make article pages heavier or slower.
- Put English-only strings in the Spanish interface, or use tuteo.
- Let the chat answer from the model's own memory, or show a model's raw reasoning [README].
- Spend the operator's model budget on a guest [overhaul §2].
- Answer with a stale or wrong-language page while the network works (`public/sw.js`).
- Nag: a dismissed install offer stays dismissed (`src/components/wiki/install-prompt.tsx`).
- Require JavaScript to read content, or disable pinch-zoom (`src/app/layout.tsx`).

## Brand Commitments

- **Name.** "Valheim Codex"; the installed app's short name is "Codex". The brand is the same in both languages: "The
  brand is 'Valheim Codex' everywhere else, including the installed app's own name" (`src/lib/i18n/copy/shell.ts`).
  Known exceptions still in the code: the guide's Spanish kicker and its preview card say "Codex de Valheim"
  (`src/lib/i18n/copy/guide.ts`, `src/app/wiki/guide/opengraph-image.tsx`).
- **Mark.** The Fehu rune (ᚠ), "the first rune, and the marker this app uses for its first source"
  (`public/icon.svg`). Runes are the app's ordinals because "Valheim delivers its lore on runestones, and the sources
  are this app's lore" (`src/lib/i18n/format.ts`).
- **Voice, Spanish.** Rioplatense voseo: "Buscá", "Preguntá", "Probá de nuevo", "Instalá". The community's gaming words
  where players use them: "crafteo", "farmear", "drops", "stats", "gear". Actions are named for what they do and keep
  the same word through a flow; errors say what happened and what to do next, and do not apologise
  (`src/lib/i18n/strings.ts`). Limits are stated plainly: "Traducción automática", "Se guarda en este dispositivo"
  [crafting §7].
- **Voice, English.** Plain and direct, the same structure as the Spanish (`src/lib/i18n/copy/*`).
- **Names in two languages.** Where the player must match the game, the in-game name stays in English inside Spanish
  text: the guide's name chips show the English name alone, marked `lang="en"` (`src/components/wiki/guide/guide-ui.tsx`
  `Item`), and chat answers keep it, "with an optional Spanish gloss". Interface labels and the planner show "the
  canonical Spanish name with the English name beside it" [crafting §15.8].
- **Identity is binding.** "Refinement, not a redesign" [overhaul §1]; a redesign is a non-goal and "new surfaces
  extend the incumbent firelit-camp identity" [crafting §2]. That identity is recorded in `DESIGN.md`.

## Evidence on Hand

- **Corpus:** 1,027 Fandom articles, 5,856 retrieval chunks and 1,027 reading documents with infoboxes and images
  (images hotlinked from Fandom's CDN) [README Verified state].
- **Recipe graph prototype** from the live wiki: 1,144 items, 954 recipes, 474 products, 182 raw materials, 168
  upgradeable items, 58 recipes that yield more than one; 94.8 KB raw, 26.6 KB gzip [crafting §5.3].
- **Retrieval eval:** `tests/eval/golden.jsonl`. recall@5 96.7% (29/30) and MRR 0.798 were measured on the original
  30 questions in Spanish and English, with the hermetic `pnpm eval --no-rewrite` [README]. The set has since grown to
  41 questions (22 Spanish, 17 English, 1 German, 1 Portuguese; uncommitted in the working tree). **OPEN:** no
  measurement of the 41-question set is recorded, so the 96.7% describes the old set only.
- **The guide:** `src/components/wiki/guide/guide-data.tsx`, hand-written in both languages, patch 0.221.12.
- **Brand assets:** `public/icon.svg`, `public/icon-maskable.svg`, the PNG icons in `public/`, the preview cards in
  `src/app/opengraph-image.tsx`, `src/app/wiki/guide/opengraph-image.tsx` and `src/app/wiki/a/[slug]/opengraph-image.tsx`,
  and the fonts they ship (`public/fonts/Cinzel-SemiBold.ttf`, `public/fonts/Spectral-Regular.ttf`).
- **Screenshots:** `screenshots/` (from August 2026).
- **Absent, never to be fabricated:** usage analytics, reader counts, testimonials, user research, an accessibility
  audit, field performance data, and pricing (the reader and the crew chat are free; guests pay their own model
  provider).

## Product Principles

1. **Data before prose, computed before quoted.** The numbers a player came for come first, exact, and say when they
   are unknown.
2. **One hand, mid-game.** Every decision assumes a phone held next to the keyboard and a reader who is back in the game
   within seconds.
3. **Spanish first, both complete.** Voseo throughout, English never missing, game names always matchable.
4. **Works when the network does not.** What was read stays readable, and what is saved says it is saved on this device.
5. **Grounded and honest.** Answers come from the wiki, translations are labeled, unknowns are named, nothing is
   invented.

## Accessibility & Inclusion

- **Standard: OPEN.** The repository names no conformance target. The rules it does write down are: text contrast of
  at least 4.5:1 [overhaul §6]; keyboard focus and in-page anchors never land under the bars, per WCAG 2.4.11
  (`src/app/styles/base.css`); a visible focus ring everywhere; targets of at least 44 × 44 px on coarse pointers; no
  functional text under 12 px [overhaul §4.1]. Inferred, not decided: the contrast and focus rules are WCAG 2.2
  level AA criteria (1.4.3, 2.4.7 and 2.4.11, the last new in 2.2), and the 44 px targets exceed AA's 24 px (2.5.8),
  so WCAG 2.2 AA is the working assumption until the owner sets a target. No formal audit or test with
  assistive-technology users is recorded.
- **Keyboard and screen readers complete** [crafting §12]: real tab lists and radio groups, polite live regions for
  progress and totals (`src/components/wiki/translate-on-view.tsx`; [crafting §6]).
- **Two languages for assistive technology.** `<html lang>` follows the reader's language (`src/app/layout.tsx`), and
  English text inside the Spanish interface carries `lang="en"`, so a screen reader voices it in English
  (`src/components/wiki/article-view.tsx`).
- **Motion and display preferences.** Reduced motion is respected (`src/app/styles/base.css`); forced colors keep the
  page-load bar visible (`src/components/shell/nav-progress.tsx`); pinch-zoom is never disabled (`src/app/layout.tsx`).
- **Low capability.** Content reads without JavaScript, and printing drops the navigation
  (`src/components/wiki/ask-button.tsx`, `src/app/styles/guide.css`).
