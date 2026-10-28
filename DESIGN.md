---
name: Valheim Codex
description: "A firelit-camp reference for Valheim players: data first, Spanish first, one-handed and offline."
colors:
  bog: "#14170f"
  peat: "#1d2216"
  moss: "#2a3120"
  lichen: "#3a4330"
  birch: "#e8e2d0"
  ash: "#9aa089"
  forge: "#d98a34"
  forge-dim: "#8a5720"
  blood: "#a33b2a"
typography:
  display:
    fontFamily: "Cinzel, Georgia, serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "0.14em"
  headline:
    fontFamily: "Cinzel, Georgia, serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.14em"
  title:
    fontFamily: "Spectral, Georgia, serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "Spectral, Georgia, serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.65
  body-small:
    fontFamily: "Spectral, Georgia, serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.375
  label:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.6875rem"
    fontWeight: 400
    letterSpacing: "0.16em"
  data:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.333
    fontFeature: '"tnum"'
  quantity:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.25
    fontFeature: '"tnum"'
  chip:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "max(0.85em, 0.75rem)"
    fontWeight: 400
  citation:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "max(0.7em, 0.75rem)"
    fontWeight: 600
    lineHeight: 1
rounded:
  xs: "2px"
  chip: "3px"
  sm: "4px"
  md: "6px"
  full: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
  gutter: "16px"
  gutter-sm: "24px"
  gutter-lg: "32px"
components:
  button-primary:
    backgroundColor: "{colors.forge}"
    textColor: "{colors.bog}"
    typography: "{typography.body-small}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "#d98a34e6"
  button-primary-disabled:
    backgroundColor: "{colors.moss}"
    textColor: "{colors.ash}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.birch}"
    typography: "{typography.body-small}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "44px"
  button-secondary-hover:
    backgroundColor: "{colors.peat}"
  button-ask:
    backgroundColor: "{colors.peat}"
    textColor: "{colors.forge}"
    typography: "{typography.body-small}"
    rounded: "{rounded.full}"
    padding: "0 20px"
    height: "44px"
  button-ask-hover:
    backgroundColor: "color-mix(in srgb, #d98a34 15%, #1d2216)"
  button-compact:
    backgroundColor: "transparent"
    textColor: "{colors.forge}"
    typography: "{typography.data}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-compact-hover:
    backgroundColor: "#d98a3426"
  segment:
    backgroundColor: "transparent"
    textColor: "{colors.ash}"
    typography: "{typography.body-small}"
    rounded: "{rounded.xs}"
    padding: "0 12px"
    height: "32px"
  segment-hover:
    backgroundColor: "{colors.moss}"
    textColor: "{colors.birch}"
  segment-selected:
    backgroundColor: "{colors.forge}"
    textColor: "{colors.bog}"
  input-search:
    backgroundColor: "{colors.peat}"
    textColor: "{colors.birch}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  input-field:
    backgroundColor: "{colors.bog}"
    textColor: "{colors.birch}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "44px"
  chip-item:
    backgroundColor: "#2a312080"
    textColor: "{colors.forge}"
    typography: "{typography.chip}"
    rounded: "{rounded.sm}"
    padding: "2px 4px"
  chip-item-hover:
    backgroundColor: "{colors.moss}"
  chip-category:
    backgroundColor: "#1d221699"
    textColor: "{colors.birch}"
    typography: "{typography.body-small}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  rune-chip:
    backgroundColor: "#d98a341f"
    textColor: "{colors.forge}"
    typography: "{typography.citation}"
    rounded: "{rounded.chip}"
    padding: "0 0.3em"
    height: "1.35em"
  rune-chip-active:
    backgroundColor: "#d98a341f"
  tile:
    backgroundColor: "{colors.peat}"
    textColor: "{colors.birch}"
    typography: "{typography.body-small}"
    rounded: "{rounded.md}"
    padding: "8px"
    height: "64px"
  tile-hover:
    backgroundColor: "#2a312066"
  recipe-tile:
    backgroundColor: "#1d221666"
    textColor: "{colors.birch}"
    typography: "{typography.quantity}"
    rounded: "{rounded.md}"
    padding: "8px"
  recipe-tile-hover:
    backgroundColor: "{colors.peat}"
  recipe-icon:
    backgroundColor: "#14170f99"
    rounded: "{rounded.xs}"
    size: "40px"
  stat-row:
    backgroundColor: "#1d221666"
    textColor: "{colors.ash}"
    typography: "{typography.body-small}"
    padding: "8px 12px"
  banner-alert:
    backgroundColor: "#d98a341a"
    textColor: "{colors.forge}"
    typography: "{typography.body-small}"
    padding: "8px 0"
  banner-note:
    backgroundColor: "{colors.peat}"
    textColor: "{colors.birch}"
    typography: "{typography.body-small}"
    padding: "8px 0"
  alert-error:
    backgroundColor: "#a33b2a1a"
    textColor: "{colors.birch}"
    typography: "{typography.body-small}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  tab-bar:
    backgroundColor: "#1d2216f2"
    textColor: "{colors.ash}"
    height: "56px"
  tab-current:
    textColor: "{colors.forge}"
---

# Design System: Valheim Codex

## Overview

**Creative North Star: "The Firelit Camp"**

The Codex is read at night beside a fire. The ground is peat-dark olive instead of a dark-mode black, the text is cream that reads as birch bark, and one amber accent reads as forge light (`src/app/globals.css:31-48`). Every neutral is warm-shifted on purpose, because "a neutral grey anywhere in this palette flattens the whole thing": in OKLCH the five olive neutrals (bog, peat, moss, lichen, ash) carry chroma between 0.016 and 0.034 at a hue of 119 to 129, and birch, the cream text, sits at a hue of about 92 with chroma 0.025. Forge light falls only where the eye should go: the tab the reader is on, a quantity to compare against the chest, the action to take, keyboard focus, and the citations, runes and in-game names that lead somewhere.

It is a field reference, not a showcase. The data is the page: identity, then stats, then prose (`src/components/wiki/article-view.tsx`). Numbers are set in JetBrains Mono with tabular figures so they line up; names and titles are carved Cinzel capitals; everything meant to be read is in Spectral, a serif drawn for screens (`src/app/layout.tsx:13-47`). Containers stay quiet: 1px moss hairlines, 6px corners, and tonal steps from bog to peat to moss instead of shadows. Runes are the app's ordinals and its mark, because Valheim delivers its lore on runestones and the Codex's sources are its lore (`src/lib/i18n/format.ts`).

It is built for one hand, mid-game. On phones the navigation is a bottom tab bar, every control is 44px on a touch screen, floating buttons sit above the bar and step aside while the reader scrolls down, and nothing scrolls the page sideways. Motion is nearly absent: an ember pulses while an answer is on its way, a message rises 6px as it arrives, a 2px forge line runs while a page loads. The code's own comments reject the dark-mode default, spreadsheet chrome on answer tables, spinners as the waiting state, the browser's grey tap flash, a cold black lightbox, tracked capitals on anything longer than a few words, and a third colour for links. This file records the system as implemented on 2026-10-27; new surfaces extend it and never redesign it.

**Key Characteristics:**
- Peat-dark, warm-shifted ground with one amber accent; blood only for failures and for warnings of harm.
- Three faces with one job each: Cinzel for names, Spectral for reading, JetBrains Mono for numbers and labels.
- Flat tonal layers and 1px moss hairlines; shadows only under the few controls that float.
- Data first: label-left, value-right rows, tabular figures, forge quantities.
- Phone-first and one-handed: bottom tab bar, 44px touch targets, no sideways scroll.
- Runes as ordinals and mark; text glyphs and thin line icons, never emoji.
- Near-still: an ember, a rise, a progress line, and all of it stops under reduced motion.

## Colors

Nine named tokens in one `@theme` block (`src/app/globals.css:38-48`), all warm: olive neutrals, cream text, a single amber light, and a rust red kept for harm. A state is the same token at an alpha, never a new hue.

### Primary
- **Forge Light** (forge, #d98a34): the only accent. As a solid fill: the selected segment of a switch, a form's one primary action, the skip link, the current tab's 2px mark (`src/components/wiki/tab-bar.tsx:136-141`), the page-load bar and the ember's dots. As text: the current tab and the contents entry being read; every quantity (the recipe tile's count, `src/app/styles/tables.css:552-557`) and the compare table's sorted value; search matches (`src/components/wiki/search-view.tsx:815`); kickers above titles (a forge label); ordinals and markers (the guide's runes at 80%, biome numerals, `src/components/wiki/category-grid.tsx:139`, list bullets and numbers, `src/app/styles/prose.css:48-68`, `guide.css:281-287`); citation chips and source plates (`src/app/styles/chat.css:21-53`, `src/components/sources.tsx:64-70`); the guide's in-game name chips and links (`guide.css:288-322`); `code` in answers; the ask action, the new-question button and banner actions (`src/components/wiki/ask-button.tsx:99`, `src/components/sidebar.tsx:131`, `src/components/wiki/install-prompt.tsx:100`); and the alert banner (`src/components/shell/banner.tsx:26`). As an edge or tint: the focus ring (`src/app/styles/base.css:237-240`), a focused field's edge, the hover edge of tiles, cards, chips and outlined controls (40 to 60%), and the underline of links in running text (50%, `.text-link`, `prose.css:87-99`).
- **Forge Dim** (forge-dim, #8a5720): text selection only (`::selection`, `src/app/styles/base.css:104-107`).

### Tertiary
- **Blood** (blood, #a33b2a): not an accent but a status colour, kept for harm: failures and warnings that cost the player something, at a 50% border over a 10% fill with birch text: sign-in and key errors (`src/components/login-form.tsx:117`, `src/components/connect/gemini-panel.tsx:166`, `src/components/connect/puter-panel.tsx:85`), the chat's failure notice (`src/components/chat/dock.tsx:143`), and the guide's warning callout, "what costs a death" (`src/components/wiki/guide/guide-ui.tsx:68`), at a 40% border (`src/app/styles/guide.css:414-418`). A biome chapter's callout takes the warning tone only where its data says so (`calloutTone`, `src/components/wiki/guide/guide-data.tsx:41`, `guide-ui.tsx:250`): the Ashlands one, a boiling sea and ash rain, is a warning; the Mistlands one, a smelting tip that costs nothing, is a plain callout. Offline and degraded notices are forge, not blood (`src/components/shell/banner.tsx:26`).

### Neutral
- **Bog** (bog, #14170f): the ground. The body background (`base.css:81`), the browser and install theme colour (`src/app/layout.tsx:107`, `src/app/manifest.ts:40-41`), text on forge fills, the opaque cells of pinned tables, fields that sit on peat panels, and the lightbox.
- **Peat** (peat, #1d2216): one step up. Tiles, cards, notes, sheets and panels; the tab bar at 95% under an 8px backdrop blur (`tab-bar.tsx:80`); fields on the bog page (search, composer); table header rows; row stripes at 35 to 70%.
- **Moss** (moss, #2a3120): the 1px border of every container and the hairlines between rows (full strength on containers, 50 to 70% between rows; answer tables rule theirs in lichen); the hover fill of segments and icon buttons; the selected conversation; item chips at 50%.
- **Lichen** (lichen, #3a4330): the stronger edge. Hover borders on outlined controls, the scrollbar thumb (`base.css:110-123`), the article's status notice, the dashed "what's next" frame (`guide.css:576-581`), the chat's jump pill, the answer figure's frame (`chat.css:121`), the rule closing an answer table and, at 60%, the hairlines between its rows (`tables.css:44-45,84-87`), and the diamond that stands in for a missing material.
- **Birch Bark** (birch, #e8e2d0): primary text; at 90 to 95% for long reading text and table cells; the inset focus ring on forge fills.
- **Ash** (ash, #9aa089): secondary text. Ledes, hints, meta lines, labels, inactive tabs and segments, counts, placeholders.
- **Drift:** bold text inside chat answers is `#f2ecda` (`prose.css:73`), a brighter birch that is not a token; two of the three floating shadows are pure black, the guide's contents pill and the chat's jump pill (see Elevation & Depth); and the palette is copied as literal hex into `layout.tsx:107`, `manifest.ts:40-41`, the three preview-card files and the page-load bar's fallback (all equal to the tokens today).

### Tints in use
Alpha steps the code applies to the tokens, through Tailwind's `/n` or `color-mix(in srgb, … n%, transparent)`: forge 8, 10, 12, 15, 20, 30, 34, 40, 50, 60, 80, 90; moss 40, 45, 50, 55, 60, 70; lichen 60; peat 20, 35, 40, 60, 70, 95; birch 80, 88, 90, 95; bog 60, 70, 88; blood 10, 20, 40, 50, 60; ash 60. Opaque stripes mix two tokens instead (`color-mix(in srgb, peat 35%, bog)`, `tables.css:160,210`; `compare.css:120,126`) so a pinned cell hides what scrolls beneath it, and so do the lit ask and new-question buttons (forge 15% into peat), so nothing shows through them.

### Measured contrast
Computed from the hex values with the WCAG 2.x formula. Text: birch on bog 13.99, on peat 12.55, on moss 10.41; birch at 90% on bog 11.50; ash on bog 6.70, on peat 6.01, on moss 4.98; forge on bog 6.59, on peat 5.91, on moss 4.90; bog on forge 6.59; forge on its own 10% tint 5.70; birch on the forge-dim selection 4.68. Forge text on a forge tint over bog: 5.70 at 10%, 5.53 at 12%, 5.27 at 15%, 4.81 at 20%, 4.26 at 26%; over peat: 5.09, 4.92, 4.64, 4.24 and 3.80. So a lit forge-text control stays at 4.5:1 up to forge/20 on bog and forge/15 on peat (composited in sRGB and rounded to 8 bits per channel, as browsers draw it). Lighter grounds leave less: on a phone card's title (moss/45 over peat/70), the lightest ground a citation chip sits on, forge text holds 4.62 at forge/12 and falls to 4.38 at forge/15. Ash under a forge tint drawn over it, the loading segment's: 4.83 at forge/20 on bog, 4.35 at forge/25. Non-text: a moss hairline on bog 1.34 and lichen on bog 1.75 (edges are decorative; a field is identified by its label, placeholder and position), the forge ring on bog 6.59, and the birch ring on a forge fill 2.12 (it is drawn inset, so its outer edge also meets the dark track, at 13.99).

### Named Rules
**The One Light Rule.** Forge is the only accent, and it marks where the reader is, what counts and what can be done. A solid forge fill means "selected" (a switch's segment, the current tab's mark), "do this" (a form's one primary action) or "working" (the page-load bar, the ember); forge text, edges and tints mark the current place, quantities and search matches, kickers and ordinals, citations, the guide's in-game name chips and links, outlined secondary actions ("ask about this", "new question", a banner's action), alerts, focus, and the hover edge of tiles, cards, chips and outlined controls. Links in running text, and the names that title rows, tiles and results, stay birch, lit only by a forge underline or hover. Everything else is birch or ash, ranked by weight and position.

**The Warm Ground Rule.** No neutral grey, no pure black and no pure white in any fill, text, border or shadow. Tailwind's default palette is still available, because the `@theme` block does not reset it (`--color-*: initial`), so a class such as `bg-gray-800` or `text-white` would bring one in; none is in the served CSS today, and none should be.

**The Tint, Not Hue Rule.** A state is a token at an alpha (a forge/10 fill under a forge/30 border; a moss/60 hairline; a peat/40 stripe), never a new colour.

**The Blood Costs Something Rule.** Blood marks failures and warnings that cost the player something, and nothing else; a tip or a note, however important, is not a warning.

## Typography

**Display Font:** Cinzel (with Georgia, serif), weights 500 and 600, preloaded
**Body Font:** Spectral (with Georgia, serif), weights 400, 500 and 600, preloaded
**Label/Mono Font:** JetBrains Mono (with ui-monospace, monospace), weights 400, 500 and 600, not preloaded

Each stack carries its own fallback so the root error page, rendered without the layout's font classes, falls back to Georgia (`src/app/globals.css:49-57`). Only what the first paint needs is preloaded: Spectral because body text is most of every page, Cinzel because an article's title is above the fold; JetBrains Mono waits for the stylesheet (`src/app/layout.tsx:19-31`).

**Character:** Roman inscriptional capitals cut in stone for names and titles, a warm screen serif that does not tire over long answers, and a monospace wherever digits must align.

### Hierarchy
- **Display** (Cinzel 600, uppercase, 0.14em tracking, line-height 1.25): `.display` (`src/app/styles/base.css:200-205`). Page titles are 1.5rem on phones and 1.875rem from 640px (browse, category, guide, error and 404 pages); the home's product name steps up to 2.25rem from 640px (`src/app/wiki/page.tsx:74`); the chat's header and the connect page use 0.875 to 1.25rem. Article titles are sized by length (`src/components/wiki/article/identity.tsx:20-24`, `article-meta.ts:55-60`): up to 20 characters, `display` at 1.25, 1.5 (640px) and 1.875rem (1024px); up to 34, 1.125, 1.25 and 1.5rem at 0.08em; longer, Cinzel 600 in its own small capitals with no uppercase transform, 0.02em, 1.125 to 1.5rem.
- **Headline** (Cinzel 600, uppercase, 0.14em): section titles. The guide's are 1.125rem, 1.25rem from 640px, line-height 1.3 (`guide.css:190-199`); the article's are 1rem, 1.125rem from 640px (`src/components/wiki/article/body.tsx:76`); a biome chapter's head is 1rem, 1.125rem from 640px (`guide.css:222-230`).
- **Title** (Spectral 600, 1.0625rem, line-height 1.35): sentence-case subheads of five or six words, too long for tracked capitals: the guide's `.g-h3` (`guide.css:203-209`) and headings a model writes into an answer (h3 1.0625rem, h4 1rem, `chat.css:79-92`). The article's third level is Cinzel 600 small capitals at 1rem and 0.04em; deeper levels are set as labels in JetBrains Mono 12px 500, 0.12em, ash (`body.tsx:75-79`).
- **Body** (Spectral 400, 16px, line-height 1.65): set on `<body>` (`base.css:80-86`). Reading text holds a 65 to 72ch measure: article paragraphs and lists 1rem at line-height 1.7, birch 90%, 68ch (`body.tsx:43,54`); the article's lead 1.0625rem at 1.7 (`article-view.tsx:129`); chat answers 0.975rem at 1.7, birch 95%, 68ch (`src/components/answer.tsx:51`, `prose.css:17-19`); guide prose 0.95rem at 1.65, 68ch (`guide.css:240-262`). Secondary interface text steps down to 14px (`text-sm`), notes and snippets to 13px.
- **Label** (JetBrains Mono 400, 11px, 0.16em, uppercase, ash): `.label` (`base.css:207-213`): section labels, column headings, kickers over titles (forge), form field labels. The only role allowed under 12px. Table heads use the same face at 0.12 to 0.14em (`tables.css:61-70,139-145,350-354`; `guide.css:518-528`).
- **Data** (JetBrains Mono 400, 12px, tabular figures where digits align): counts, dates, meta lines, facets, the English name under a Spanish title, compare cells; stat values at 13px (`tables.css:483-490`); quantities at 13px, weight 600, forge (`tables.css:552-557`).
- **Chip** (JetBrains Mono 400 at 85% of the surrounding text, never under 12px: `max(0.85em, 0.75rem)`): an in-game name set as a chip inside prose, a checklist or a table; about 13px in the guide's prose (`guide.css:310-324`, whose comment gives the floor's reason: "inside the smaller notes and tables 0.85em comes out at 11").
- **Citation** (JetBrains Mono 600 at 70% of the text, never under 12px: `max(0.7em, 0.75rem)`, line-height 1): the citation chip inside an answer (`chat.css:30`), 12px in an answer's 15.6px text and in an answer-table cell, where 70% alone was 10.9 and 9.5px.
- **Drift:** `base.css:181-187` says sizes come from Tailwind's scale, page titles are `text-2xl`/`sm:text-3xl` and section titles `text-lg`. In use, reading and table text also takes off-scale sizes (0.95, 0.975, 1.0625, 0.9375, 0.9, 0.85 and 0.8125rem), and the home title, article titles and section heads size as listed above.

### Named Rules
**The Carved Names Rule.** Cinzel only for the app's name, page and section titles and item names; capitals tire the eye after a line, so never running text.

**The Short Caps Rule.** Tracked capitals only for a few words ("nothing longer than a few words", `base.css:196-197`), such as the three of "Recursos para farmear". A table caption over 24 characters or a column heading over 20 is set in sentence case (`src/components/wiki/article/data-table.tsx:8-11`), and nothing functional is smaller than 12px except an 11px label.

**The Aligned Digits Rule.** A number compared across rows is JetBrains Mono with tabular figures; a count compared against the chest is also weight 600 and forge ("×20").

**The 16px Field Rule.** Every text field and every select is 16px whenever the pointer is coarse, or iOS zooms the page into it and does not zoom back out. Tie the size to the pointer, not the width: 12 to 14px on a fine pointer, 16px under `pointer: coarse`, as the nav search (`src/components/shell/nav-search.tsx:28-30,42`), the chat's model picker (`src/components/chat/account-panel.tsx:100-101`) and the compare page's sort select (`src/components/wiki/lists/compare-view.tsx:362`) do; a field that steps down from 640px takes the step on a fine pointer only (`sm:pointer-fine:`), as the composer does to 15.2px (`src/components/composer.tsx:137`) and the Gemini key field and the connect page's model select to 14px (`src/components/connect/gemini-panel.tsx:107,142`), so an iPad keeps 16px; or 16px everywhere, as the search page, the 404 search and the sign-in fields are.

## Layout

One centred column that every page shares, padded by a gutter that grows with the screen, inside a shell whose bars are declared as tokens so nothing pinned to an edge measures pixels. Pages set their own measure inside it: prose holds 65 to 72ch, grids take the full width.

### Shell and tokens
- **Container** (`.shell-container`, `src/app/styles/base.css:134-140`): full width, at most 72rem, centred, side padding `max(var(--gutter), env(safe-area-inset-left/right))`, so landscape notches never cut into it. The nav and `<main>` share it, so their edges line up.
- **`--gutter`:** 1rem below 640px, 1.5rem from 640px, 2rem from 1024px (`base.css:36-63`).
- **`--nav-h`:** what covers the top of the viewport. Below 640px only the safe-area inset (0px in a browser tab); from 640px `calc(3rem + env(safe-area-inset-top))`, and `calc(3.5rem + …)` on coarse pointers. It already includes the inset; never add it twice.
- **`--tabbar-h`:** `calc(3.5rem + env(safe-area-inset-bottom))` below 640px, 0px from 640px.
- **`--sticky-h`:** 0px unless a page sets it; the search page sets 4.5rem, and 0px when the screen is 480px tall or less (`src/components/wiki/search-view.tsx:527-528`). The example in `base.css:31-34` still says 4.25rem for the same selector; the code's 4.5rem is the live value.
- **Scroll padding:** `scroll-padding-top: calc(var(--nav-h) + var(--sticky-h, 0px) + 1rem)` and `scroll-padding-bottom: calc(var(--tabbar-h) + 1rem)`, so focus and anchors stop short of the bars (WCAG 2.4.11, `base.css:70-73`).
- **Frame** (`src/components/shell/wiki-frame.tsx:36-56`): skip link, nav, notices, then `<main>` with 20px of top padding (32px from 640px) and 32px at the bottom; the frame pads the page by `--tabbar-h`, and paints a bog strip under an installed app's status bar on phones.
- **Navigation:** below 640px a fixed bottom bar, 56px plus the home indicator; from 640px a sticky top bar, 48px (56px on touch). The nav is first in the document at every width (`tab-bar.tsx:29-41`).

### Breakpoints
Tailwind's defaults: 640px (sm), 768px (md), 1024px (lg), 1280px (xl) (`node_modules/tailwindcss/theme.css`; `docs/superpowers/specs/2026-10-26-wiki-overhaul-and-chat-auth-design.md` §4.1). Project-specific queries: below 336px (21rem) a guide table's item chips become boxes (`guide.css:332-338`); at 639px and below, tables become cards (`tables.css:243`); from 1152px (72rem) the compare table bleeds right to the gutter (`.compare-frame`, `compare.css:31-35`; the 2026-10-26 spec calls it `.compare-bleed`); at 480px tall or less the search field stops being sticky; at 512px (32rem) tall or less the chat sidebar and the connect page compact (`src/components/sidebar.tsx:104`, `src/components/connect/connect-view.tsx:83`). Pointer and hover queries change targets, not layouts: `pointer: coarse` for 44px targets, `hover: hover` for row highlights.

### Measures and columns
- Prose 68ch (answers, article text, guide prose, checklists, callouts); hints and captions 65ch; the chat's empty-state line 52ch; the connect subtitle 40ch.
- The search hero, the home header and the guide card: 42rem (`max-w-2xl`). The chat's thread, composer and notices: 48rem (`max-w-3xl`). Error and 404 pages: 36rem. The connect page: 28rem.
- **Article** (`src/components/wiki/article-view.tsx:219-224`): from 1024px the infobox is a 22rem column beside the text, 3rem apart, sticky at `top: calc(var(--nav-h) + 1.5rem)` only while all of it fits the window (`article/sticky-aside.tsx`); or, when the stats outweigh the text by 1.5 to 1, it spreads over three columns 2rem apart above the text (`article/infobox-model.ts:176-182`).
- **Guide** (`guide.css:27-56`): a 46rem column; from 1024px a 13rem table of contents on the left, 3rem apart.
- **Chat:** a 17rem sidebar, a drawer below 1024px (`src/components/chat.tsx:518`).

### Grids
- Browse tiles: 2 columns, 4 from 768px, gaps 8px then 12px (`src/components/wiki/category-grid.tsx:82`); the home shows 8 per axis and Browse 12 and 8, so every row is full at both counts.
- Category lists: 1 column, 2 from 768px, 3 from 1280px, 32px apart, rows divided by a moss/70 hairline (`src/components/wiki/lists/category-list.tsx:30-35`).
- Recipe tiles: 2 columns, 3 when their group is 28rem wide, 4 at 42rem; container queries on `.stat-group`, not the screen (`src/components/wiki/recipe.tsx:78`, `tables.css:466-469`).
- Gallery: 2 columns, 3 from 640px, 4 from 1024px when the text has the full width (`src/components/wiki/gallery.tsx:98`).
- Stat rows pair into two columns, 1.5rem apart, between 768 and 1023px (`tables.css:559-587`).

### Rhythm
Tailwind's 4px scale, tight within a group and generous between groups, with half steps only for hairline optical fixes (2026-10-26 spec §4.1). Half steps survive in three places (the composer's 14px side padding, the `/` hint's 6px, the language switch's 2px track) and the chat's answer tables pad cells 8px by 14.4px, with 8.8px above and below each head (`tables.css:56,68-69`). Measured examples: 32px between browse axes, 12px from an axis label to its tiles, 8px to a hint (`src/components/wiki/browse-axes.tsx:32-33`); article text 16px between blocks, 40px above an h2, 32px above an h3, 24px above deeper heads, 12px after any heading (`prose.css:107-124`); guide parts 40px apart (48px from 640px), 16px inside a section (`guide.css:58-92`); infobox groups 24px apart; chat messages 32px apart (`src/components/chat/thread.tsx:82`).

### Stacking
Table pins 1 to 3; the sticky search bar, the floating ask button and the guide's contents pill 20; the tab bar 30; the status-bar strip and the chat drawer's scrim 40; the chat drawer 50; the skip link 60; the page-load bar 70.

### Named Rules
**The Thumb Rule.** On phones the navigation is at the bottom; anything fixed sits at `bottom: calc(var(--tabbar-h) + <gap>)`, hides while the reader scrolls down past a 12px threshold, and is always shown in the top 80px (`src/components/wiki/ask-button.tsx`, `src/components/wiki/guide/guide-toc.tsx`).

**The No Sideways Scroll Rule.** The page never scrolls sideways: wide tables scroll inside their own box, long words break, and end-to-end tests check it at 390px on the wiki and the chat and at 360px on the guide (`tests/e2e/wiki.spec.ts:397`, `tests/e2e/app.spec.ts:262`, `tests/e2e/guide.spec.ts:79`).

**The Reading Order Rule.** Document order is visual order at every width: no reversed flex columns; nav first, then notices, then the page.

## Elevation & Depth

The system is flat. Depth is tonal: bog for the ground, peat one step up for tiles, cards and bars, moss for edges and for the hover fill of small controls, with 1px hairlines separating rows. Two surfaces are translucent: the tab bar (peat at 95% over an 8px backdrop blur) and scrims (bog at 70% behind the chat drawer, bog at 60% behind the guide's contents sheet, which "needs no shadow of its own", `guide.css:724-727`). Shadows appear only under controls that float over moving text, and as 1px inset lines on pinned table columns.

### Shadow Vocabulary
- **Floating lift** (`box-shadow: 0 4px 12px -4px color-mix(in srgb, var(--color-bog) 70%, transparent)`, that is `rgb(20 23 15 / 0.7)`): the value new floating controls take. It is the guide pill's geometry, the only one with a written reason, cast in bog as the ask button already casts its own, because the Warm Ground Rule admits no pure black. No control draws it yet.
- **Floating pill lift, guide** (`box-shadow: 0 4px 12px -4px rgb(0 0 0 / 0.7)`, `guide.css:685-686`): "a short, close shadow: enough to lift it off the line of text passing underneath". Drift: pure black.
- **Floating pill lift, chat** (`box-shadow: 0 4px 12px rgb(0 0 0 / 0.35)`, `src/components/chat.tsx:617`): the "jump to latest" pill. Drift: pure black, and a geometry of its own.
- **Floating pill lift, ask** (Tailwind `shadow-lg` in bog at 60%: `0 10px 15px -3px` and `0 4px 6px -4px`, `src/components/wiki/ask-button.tsx:94`): the floating "ask about this" button. In the palette, but longer than the guide's.
- **Pinned column edge** (`box-shadow: inset -1px 0 0 var(--color-moss)`, `tables.css:201`, `compare.css:108`): the hairline that travels with a pinned first column.
- **Pair hairline** (`box-shadow: 0 -1px 0 color-mix(in srgb, var(--color-moss) 60%, transparent)`, `tables.css:580-582`): row rules in the two-column stat layout.
- **Bleed band** (`0 0 0 100vmax var(--color-bog)` with a clip-path, `search-view.tsx:530`): not elevation; it paints the sticky search bar's background to the viewport's edges without widening the layout.

### Named Rules
**The Flat Camp Rule.** Surfaces are flat at rest; a resting card, tile, table or panel never casts a shadow.

**The Lift Only What Floats Rule.** A shadow is reserved for a control fixed over scrolling text: the ask button, the contents pill, the jump pill. The three differ today; new floating controls take the floating lift above, the guide pill's short, close geometry cast in bog at 70%.

## Shapes

Gentle, nested corners and thin edges. Containers (cards, tiles, fields, buttons, tables, banners' actions, notes) are 6px (`rounded-md`, `0.375rem`, 51 uses). Plates and small things are 4px (`rounded-sm`): icon and picture plates, item chips, rune plates, small panel actions, and the language switch's segments, which sit in a track padded by only 2px. Segments inside a 4px-padded track are 2px (`rounded-xs`): `SegmentedLinks`, the level tabs and the sign-in method picker (`src/components/connect/method-picker.tsx:45,74`); the recipe's icon plate is 2px too. The rune chip and the answer's picture frame are 3px (`chat.css:36,122`). Floating pills, the tab bar's current-tab mark, the scrollbar thumb and the ember are fully round (999px). The connect page's panel is the single 8px corner (`connect-view.tsx:130`). The chat's own message bubble is 6px with a 4px bottom-right corner, pointing at its sender (`thread.tsx:92`).

Edges are 1px solid moss, lichen on hover or for a stronger frame, forge at 30 to 60% for anything forge-tinted; the guide's "what's next" card is the one dashed edge (1px dashed lichen). Corners nest: a segment's radius is the track's radius less the track's padding, 6 − 4 = 2px in `SegmentedLinks`, the level tabs and the method picker, 6 − 2 = 4px in the language switch. The 1px border is left out of the sum, which rounds the inner curve up by a pixel, as the comment at `src/components/wiki/lists/segmented-links.tsx:21-27` says. Nothing is clipped to round a corner when clipping could cut content: the stat list rounds its first and last rows instead, at `calc(0.375rem - 1px)`, "so nothing in a row can ever be cut off" (`tables.css:425-458`); the boss card's fact list, whose values hold item chips that never wrap, does the same (`guide.css:440-469`), and so does every phone card, rounding its title cell, the one with a fill of its own, at the bottom too when nothing shows under it (`tables.css:259-281,297-308`).

Pictures sit on plates: a tile's plate is 56 × 44px (80 × 56px from 1024px) with a moss/70 edge over bog/60 (`category-grid.tsx:117-118`); a list row's is 40px square; a search result's 32px; the article's picture is 72px, 112px from 1024px, on peat with a moss edge (`identity.tsx:118`). Biome pictures fill 16:9 from 768px; gallery pictures sit in 4:3 boxes.

### Named Rules
**The Nested Corners Rule.** An inner corner is the outer corner less the padding between them: 2px segments in a 6px track with 4px of padding, 4px segments in one with 2px.

**The Nothing Clipped Rule.** Never clip a container just to round it; round its first and last rows, as the stat list, the boss card and the phone cards do, so no value can be cut off. New cards, the planner's included, do the same.

## Components

Components are carved and quiet: a 1px moss edge, 6px corners, a peat or transparent fill, and forge only where the One Light Rule puts it: on what is selected or current, counted, cited, or there to be acted on.

### Where component styles live
- **One global sheet.** `src/app/globals.css` imports Tailwind and `styles/base.css`, nothing else; it blocks every route's first paint, so it carries only the palette, layout tokens, type roles, focus, selection, scrollbars, the skip link and the ember and rise motions.
- **Route sheets.** Component classes live in `src/app/styles/`, each imported by the routes that draw it: `prose.css` (the chat, `src/app/page.tsx`, and articles, `src/app/wiki/a/[slug]/page.tsx`), `tables.css` (the chat, articles and the guide), `chat.css` (the chat), `compare.css` (category pages, `src/app/wiki/c/[category]/page.tsx`) and `guide.css` (the guide, `src/app/wiki/guide/page.tsx`). The home and browse pages import none and use utilities only.
- **`@reference '../globals.css'`** opens every route sheet. It emits nothing, but it compiles the sheet against the palette and gives every `color-mix()` of a palette variable a plain-colour fallback for browsers without `color-mix()` (Firefox 111 to 112, Safari before 16.2, Chrome before 111) (`globals.css:21-28`).
- **Layers.** Component rules sit in `@layer components`, so a utility on the same element wins (`label text-forge` is forge). Unlayered on purpose, each with its reason in a comment: the global focus ring and the reduced-motion override (`base.css`), the chat's answer tables and the phone cards that must override every table (`tables.css`), and two runtime `<style href precedence="medium">` blocks, the page-load bar (`src/components/shell/nav-progress.tsx`) and the search page's `--sticky-h`.
- **Short classes where markup repeats.** `g-*`, `stat-*`, `recipe-*` and `.text-link` exist because a class name is sent twice, in the HTML and in the payload React hydrates from, and these repeat hundreds of times on a page; one-off layout stays in utilities.
- **Third-party CSS** arrives only with its feature: the lightbox's three stylesheets load with its dynamically imported module (`src/components/wiki/article/gallery-lightbox.tsx:7-9`).
- **Tests.** `tests/unit/route-css.test.ts` walks each route's imports as the bundler does and fails when a route draws a class from a sheet it does not import, imports a sheet it does not draw, a sheet is imported nowhere, a sheet names a layer Tailwind does not declare or uses a Tailwind at-rule without `@reference`, or a sheet using `color-mix()` lacks `@reference '../globals.css'`; it also pins globals.css's imports to exactly Tailwind and base.css. `tests/e2e/route-css.spec.ts` checks, in a browser, computed values only a route's own sheet sets (`.stat-list` corner 6px, `.g-page` bottom padding 40px, `.compare-scroller` horizontal overflow, `.rune-chip` inline-flex), on a first load and after a client-side navigation.

### Buttons
- **Shape:** gently rounded (6px); floating pills fully round; small panel actions 4px.
- **Primary:** forge fill, bog text, Spectral 14px, 44px tall, 16px side padding; hover forge at 90% (`src/components/shell/error-view.tsx:54-59`, `src/components/shell/not-found-search.tsx:36-41`). Disabled, it turns moss with ash text (4.98:1), on the buttons that can be disabled: the composer's send and the three connect forms' submits (`composer.tsx:152`, `src/components/login-form.tsx:125`, `src/components/connect/gemini-panel.tsx:174`, `src/components/connect/puter-panel.tsx:112`). The composer's send button is weight 500 with 20px padding (`composer.tsx:149-153`); the connect page's submit buttons are weight 500 at the inherited 16px. One per form.
- **Secondary:** transparent with a 1px moss edge and birch text, 44px, 16px padding; hover lichen edge on a peat fill (`error-view.tsx:61-64`, `src/components/shell/not-found-view.tsx:38`).
- **Forge outline:** peat fill, forge text, a forge/40 edge; hover a full forge edge over a forge/15 fill. The "ask about this" action, docked at the foot of the infobox (6px, `src/components/wiki/article/infobox.tsx:82`) or floating (round, 20px padding, `ask-button.tsx:99`); the chat's "new question" is the same idea at forge/30 over forge/10, with a forge/60 edge on hover and a "+" before its label (`sidebar.tsx:131-135`). A secondary action that needs forge takes this outline; the solid fill stays with the primary action. A lit forge-text control keeps an opaque base and stops at forge/15 on peat, forge/20 on bog: the floating ask button and the new-question button light to an opaque `color-mix(in srgb, var(--color-forge) 15%, var(--color-peat))` (4.64:1), so nothing that scrolls beneath the floating one shows through it.
- **Compact action:** 32px tall (44px on touch), 6px, forge/50 edge, JetBrains Mono 12px forge; hover a forge/15 fill. Banner actions (`src/components/wiki/offline-banner.tsx:125`, `src/components/wiki/install-prompt.tsx:100`).
- **Small panel action:** 36px (44px on touch), 4px corners, a 1px edge, 12px text (`src/components/chat/dock.tsx:14-15`, `thread.tsx:163`, `connect-view.tsx:116`).
- **Icon button:** 32px square (44px on touch), 6px, an ash glyph; hover a moss fill and birch glyph (`install-prompt.tsx:109`).
- **Hover / Focus:** colours ease over 150ms; focus is the global 2px forge ring, 2px outside the control.

### Segmented controls
- **Reference: `SegmentedLinks`** (`src/components/wiki/lists/segmented-links.tsx:52-74`): a track with a 1px moss edge, 6px corners and 4px of padding and gap; segments 32px tall (44px on touch), 2px corners, 12px side padding (16px on touch), Spectral 14px; unselected ash with a moss hover fill; selected forge fill and bog text with a birch inset ring; while a tapped segment's view loads, a forge/20 tint covers it, drawn over its ash label, which keeps 4.83:1 (`segmented-links.tsx:78-96`). Views are links, so a level or a comparison can be shared. A track with more segments than fit scrolls sideways instead of wrapping.
- **Level tabs** (`src/components/wiki/article/level-tabs.tsx:99-121`): the same geometry on a peat track that wraps instead of scrolling, segments in JetBrains Mono 12px, no hover fill; real ARIA tabs, arrow keys move and select. The switcher always sits directly above the rows it changes.
- **Language switch** (`src/components/lang-toggle.tsx:157-184`): a tighter track (2px padding and gap), 4px segments 28 × 36px (44px on touch), JetBrains Mono 12px uppercase; pending dims the group to 70%. In the tab bar below 640px it is one button (`compact`), so four tabs, five once the planner ships, fit beside it at 360px: the language not in use, its code in the same face (EN, ES), a 44px square at every pointer with its own moss edge and 6px corners, named for a screen reader in its own language ("English", "Español") and marked with its `lang`. The same two buttons either way, one hidden by CSS, so the server's HTML and the first render agree at every width; choosing moves focus to the button that takes its place. The chat's and the connect page's switches stay the pair at every width.
- **Sign-in method picker** (`src/components/connect/method-picker.tsx:45-76`): a peat track, 2px segments 36px tall in 4px of padding, Spectral 14px, selected weight 500; a radio group.
- **Drift:** the four differ in track padding, corner, height and face, as listed above, and the same "Nivel 2" label is mono on an article and Spectral on a comparison. New switches follow `SegmentedLinks`, which says so (`segmented-links.tsx:21-25`).

### Chips
- **Item chip** (`.g-item`, `guide.css:315-352`): an in-game name, in English as the game shows it, inside the guide's prose, checklists and tables; JetBrains Mono at 85% of the text (never under 12px, the Chip role), forge on moss/50 (5.77:1 over bog), 4px corners, 2 × 4px padding, never broken across lines (below 336px, inside a guide table, it becomes a box that may wrap); hover a full moss fill; a chip leading to the original wiki ends with an ash "↗".
- **Category chip:** in the browse tail, 36px (44px on touch), 6px, a moss edge over peat/60, birch/90 text with an ash count, hover forge/40 edge (`category-grid.tsx:260`); in an article's footer, 32px with no fill and ash text (`article-view.tsx:175`).
- **Rune chip** (`.rune-chip`, `chat.css:21-53`): a citation marker inside an answer, JetBrains Mono 600 at 70% of the text and never under 12px (`max(0.7em, 0.75rem)`, the Citation role), 1.35em tall, 3px corners, forge on forge/12 under a forge/34 edge (5.53:1). It lights on hover and focus, and while its source row is pointed at or focused: the edge turns full forge over 120ms and the fill stays at forge/12, so a lit chip reads as well as a resting one on every ground it sits on, above the 4.5:1 floor of the 2026-10-26 spec (§6): 5.53:1 on bog, 4.92:1 on peat, 4.62:1 on a phone card's title (moss/45 over peat/70), where a fill deepened to forge/15 fell to 4.38:1 (`chat.css:41-53`). New citation chips, the recipe citations planned for the chat included, take this chip as it is.
- **Level badge** (`src/components/wiki/lists/compare-view.tsx:248`): "max level 3" beside a name, 4px corners, a moss edge, JetBrains Mono 12px ash.
- **Keyboard hint** (`nav-search.tsx:45-50`): the `/` key, 4px, a moss edge, mono 12px ash, shown only to fine pointers and only while the field is idle.

### Cards and containers
- **Tile** (`category-grid.tsx:114-118,163-191`): a picture plate, a two-line name (Spectral 14px birch, hyphenated) and a mono 12px count; peat, a moss edge, 6px, at least 64px tall (72px from 1024px); hover a forge/50 edge over moss/40. Biome ordinals are forge mono numerals.
- **Biome card:** from 768px a tile becomes a card with a 16:9 screenshot across the top, the name and count on one line below (`category-grid.tsx:207-229`).
- **Featured guide card** (`src/components/wiki/featured-guide-card.tsx:24-41`): a birch title over a teaser in 14px ash, two lines of their own (`featured-guide-card.tsx:35-36`), beside a 40px bog plate holding the forge rune ᛦ, and an ash arrow that turns forge on hover; peat, a moss edge, 6px, hover a forge/50 edge over moss/40; as wide as the search field.
- **Stat list** (`tables.css:434-502`, `src/components/wiki/article/stat-group.tsx`): a moss-edged 6px list; rows 8 × 12px, moss/60 hairlines, odd rows on peat/40; label left in Spectral 14px ash, value right in mono 13px birch, at most 60% wide; a phrase or list drops under its label as text; a recipe row spans the width.
- **Callout** (`.g-callout`, `guide.css:403-418`): 68ch, 12 × 16px, a moss edge, peat, 14px ash text; the warning tone, for harm only, is blood/40 over blood/10 with birch/90 text (the Ashlands chapter's; the Mistlands smelting tip is a plain callout; see Colors, Tertiary).
- **Status notice** (`body.tsx:110-117`): a wiki banner set apart from prose, a lichen edge over peat/60, a forge label, birch/90 14px text.
- **Boss card** (`.g-card`, `guide.css:422-482`): a forge "Jefe" label, a 15.2px birch title, then a moss-edged fact list, odd rows on peat/40: below 640px each label sits over its value, from 640px they are two left-aligned columns with 7rem labels, because the values are sentences (`guide-ui.tsx:77-85`). The list is not clipped: its first and last rows are rounded to its corners, as the stat list's are (`guide.css:440-469`).
- **Banner** (`src/components/shell/banner.tsx`): a full-width strip under the nav, its content in the shell container, at least 44px tall. The alert tone is forge text on forge/10 under a forge/30 rule; the note tone is birch on peat under a moss rule.
- **Chat notices** (`dock.tsx:143,153`): a failure on blood/10 under a blood/50 edge; a notice on peat under moss.
- **Chat message** (`thread.tsx:92`): the reader's question, right-aligned, at most 85% wide, peat under a moss edge, 15.2px birch; answers are plain prose with no bubble.

### Inputs / Fields
- **Style:** 1px moss edge, 6px corners, birch text, ash placeholder, 44px tall (the search page's field is the exception, below). A field takes the other neutral of its surface: peat on the bog page (the search page's field, `search-view.tsx:572`; the composer, `composer.tsx:137`; the 404 search, `src/components/shell/not-found-search.tsx:34`; the compare sort select, `compare-view.tsx:362`), bog on a peat panel or bar (the nav search, `nav-search.tsx:42`; sign-in fields, `login-form.tsx:13-14`; the Gemini key and model select, `gemini-panel.tsx:107,142`; the chat's model picker, `account-panel.tsx:101`).
- **Sizes:** the search page's field is 16px text on its inherited 26.4px line with 12 × 16px padding, so about 52px tall; the nav's is 36px tall and 14px with a fine pointer (44px and 16px on touch), at most 16rem wide; the composer grows from 44px to 190px, 16px text (15.2px from 640px with a fine pointer). Selects are 44px; the chat's model picker is 36px and 12px with a fine pointer (44px and 16px on touch).
- **Hover / Focus:** most fields hover a lichen edge (the nav and 404 searches, the sign-in fields, the Gemini key, both model selects and the compare sort select); the search page's field and the composer have no hover style. Focus turns the edge forge at 50% on the search page's field, the composer, the sign-in fields, the Gemini key and the compare sort select, at 60% on the nav and 404 searches; the model selects change no edge. The global ring draws outside every one: the search page's field, the composer, the sign-in fields and the Gemini key carry `focus:outline-none` and rely on the unlayered ring to win, and the rest never remove it. New fields take the lichen hover and the forge/50 edge.
- **Error / Disabled:** errors appear as a blood alert under the field group, not as a red field (`login-form.tsx:117`); disabled controls drop to 50 to 60% opacity.
- **Checkbox** (`.g-check`, `guide.css:362-399`): a native box tinted forge (`accent-color`), 16px (20px on touch), inside its label so the whole row is the target, at least 44px tall on touch.

### Navigation
- **Tab bar** (`tab-bar.tsx:77-173`): phones, a bottom bar of four tabs, Buscar, Explorar, Guía and Chat, each a glyph over a 12px label (⌕ ☰ ᛦ ✦) at least 44px tall, and the language switch as one 44px button at the end (see Segmented controls); from 640px a top bar with the brand ("Codex" from 640px, "Valheim Codex" from 768px, Cinzel 14px), the tabs in a row of 14px labels, a search field and the language switch. The search takes what the tabs leave, up to 16rem at every width it shows at (the cap has no breakpoint of its own, so it holds wherever the field starts): from 640px with four tabs (about 130px there), from 768px once the planner's tab makes five, which would leave it about 65px below that; on the search page it is not drawn. The planner's tab, Taller, stays out of the bar until the planner ships (`CRAFT_PLANNER_LIVE`, `src/lib/craft/feature.ts`), and the search's breakpoint moves with it. Inactive tabs are ash (hover birch); the current one is forge with a 2px round forge mark on the bar's edge facing the page, since forge and ash are too close in lightness to rely on colour (`tab-bar.tsx:131-141`). A signed-out reader's chat tab carries a padlock.
- **Breadcrumb** (`.crumb`, `prose.css:147-169`; `identity.tsx:79-97`): mono 12px ash links separated by an ash/60 "›", hover birch with an underline; on touch each grows to 44 × 44px with a negative margin, so the line stays where it was.
- **Back link** (`src/components/wiki/category-view.tsx:125-131`): "← Explorar", mono 12px ash, a 20px line padded to a 44px target.
- **Section head** (`browse-axes.tsx:136-154`, `src/components/sources.tsx:37-40`): a `.label`, a 1px moss rule filling the rest of the line, and an optional "Ver todo →" link in mono 12px ash that turns forge on hover.
- **Guide contents** (`guide.css:600-765`): from 1024px a sticky column with a hairline rail; the chapter being read is forge, with a forge mark on the rail, and its part birch. Below 1024px a round pill above the tab bar (44px, forge/40 edge, peat, forge text and rune) opens the same list as a sheet with 44px rows and a moss/60 fill on the current entry.
- **Page-load bar** (`nav-progress.tsx`): 2px forge along the top edge, shown only after 150ms, growing towards 90% over 20s, fading out over 250ms when the page lands.

### Tables
- **Answer tables** (`.answer-table`, `tables.css:36-103`): inside a chat answer, carved rather than boxed: a forge/40 rule above, a lichen rule below, lichen/60 hairlines between rows (`tables.css:84-87`), no outer frame and no stripes; heads as labels at 0.14em; values mono 13.6px at birch 88%; the table scrolls inside its box.
- **Article tables** (`.data-table`, `tables.css:116-220`; `data-table.tsx`): from 640px, in a moss-framed 6px scroll box; peat header row; moss/50 hairlines; opaque stripes on even rows; each column sized to its content (numbers on one line in tabular figures, sentences wrapped at no less than 10rem); a short first column pinned with its own hairline.
- **Phone cards** (`.stack-table`, `tables.css:243-423`): below 640px every row of an article, guide or answer table becomes a card (moss edge, 6px, peat/70) titled by its first cell on moss/45, each cell a line of label (mono 11px uppercase ash, 40% wide, 25% for short labels) and value (Spectral 14.4px with tabular figures). One semantic table, restyled; `data-label` on every cell carries its heading. No card is clipped: its first and last cells are rounded to its corners instead (`tables.css:259-281`), and a title with nothing under it, a heading the wiki wrote as a row of empty cells, closes the card with its own rounded bottom and no second rule (`tables.css:297-308`).
- **Compare table** (`compare.css`; `compare-view.tsx`): one table at every width, never taller than the screen between the bars; header row and name column pinned; stripes in solid mixes; the row under a mouse pointer on moss/60; sortable heads as label buttons with ↑ ↓ ↕; on phones a "sort by" picker with a 44px direction button, and the sorted value repeated under each name in forge mono.
- **Guide tables** (`.g-table`, `guide.css:486-561`): from 640px a moss-framed box, peat head, moss/50 hairlines and peat/35 stripes; below it, the shared phone cards.
- **Drift:** `tables.css:22-29` rejects an outer frame and zebra stripes as "table defaults that would import a spreadsheet into a firelit camp", but only the chat's answer tables follow it; article, guide and compare tables and the stat list are framed and striped, the article and compare stripes opaque so pinned cells hide what scrolls under them. Follow each family as described here.

### Recipe tile and quantities (signature)
The game's own crafting panel, borrowed (`src/components/wiki/recipe.tsx`; `tables.css:509-557`): each material is a tile with a 40px icon plate (bog/60, 2px corners, the material's own 32px picture), its name in Spectral 13px birch, balanced and never truncated (it wraps, usually to two lines, and nothing clamps a longer one, `tables.css:547-550`, `recipe.tsx:105-110`), and its count in JetBrains Mono 13px weight 600 forge, written "×20". Tiles share their row's height. A material with an article is a link tile (a moss edge over peat/40; hover a forge/60 edge on peat, 150ms); one without an article still gets a tile, with a lichen "◆" for a picture, because dropping it would make the recipe wrong. The guide's prose writes counts the other way round ("2× Deer Trophy", `guide-data.tsx:652`); in the interface the multiplier comes first.

### Runes and glyphs (signature)
- **Ordinals:** the twelve Elder Futhark runes ᚠ ᚢ ᚦ ᚨ ᚱ ᚲ ᚷ ᚹ ᚺ ᚾ ᛁ ᛃ from `rune(n)` (`src/lib/i18n/format.ts`) number the guide's biome chapters (forge at 80%, in the contents and each chapter head, `src/components/wiki/guide/guide-ui.tsx:228-234`), its boss table (`guide-content.tsx:222-224`), and a chat answer's sources (a 24px plate, forge/10 fill under a forge/30 edge, with the numeral beside it, `sources.tsx:64-70`). There are only twelve: `rune(n)` wraps after the twelfth (`FUTHARK[(n - 1) % 12]`, `format.ts:20-24`), so the thirteenth item repeats ᚠ. Runes number only short ordered sets that stay under thirteen (seven biomes, seven bosses, an answer's sources, of which retrieval keeps eight passages at most by default, `src/lib/rag/retrieve.ts:324`), never a list that grows with use, such as planner rows. ᚲ is rune(6): Mistlands in the guide's contents and chapter head, The Queen in its boss table, and the sixth source of an answer.
- **The planner's tab** wears ᚳ, the Anglo-Saxon cēn, "torch", which is what kenaz means (`tab-bar.tsx:66-71`). Not kenaz itself, ᚲ, which the 2026-10-27 crafting spec gave it (§8): ᚲ is rune(6), and already means Mistlands and the sixth source.
- **Mark:** Fehu (ᚠ), forge strokes on a peat plate framed in moss (`public/icon.svg`); on the connect page a 48px forge-tinted plate (`connect-view.tsx:93-96`). Drift: the site's preview card draws it on moss with a lichen frame while saying it copies `icon.svg` (`src/app/opengraph-image.tsx:25-37`), the article card on moss with no frame, and the maskable icon full-bleed peat with 30-unit strokes instead of 34.
- **Glyphs:** ᛦ the guide (tab and card), ⌕ search, ☰ browse, ✦ chat, ᚳ the planner (its tab, once it ships), ᛚ a missing picture, ◆ a material with no article, › a link inside the app and ↗ one that leaves it (always shown, since touch never hovers, `sources.tsx:75-82`), ← and → for back and onward, ↑ ↓ ↕ for sort order, + to start something new (the chat's "new question", `sidebar.tsx:133-135`), ✕ to dismiss (the guide's contents sheet alone uses ×, `guide-toc.tsx:213`), ↻ to re-index, "·" as the separator in meta lines and as the forge bullet of lists.
- **Line icons** (`src/components/wiki/article/glyphs.tsx`): a 12-unit grid, 1.25 stroke, round caps and joins, `currentColor`, 12 to 16px, always beside words: speech bubble (ask), padlock (sign-in needed), arrow leaving a box (opens another site).

### Imagery
- **Source:** pictures are hotlinked from Fandom's CDN, never proxied through `next/image`, with `FANDOM_IMG_PROPS` (no referrer, async decoding), asked for at the size they are drawn (`thumbnailImageUrl`, `src/lib/wiki/image-url.ts`) with a `srcset` where a slot changes size.
- **Placement:** every picture sits on a plate that keeps its row aligned; tiles and rows treat pictures as decoration (`alt=""`, since the name is beside them), and a picture that fails to load hides itself rather than show a broken-image glyph (`src/components/wiki/lists/wiki-image.tsx`).
- **Fit:** `object-contain` shrinks a picture to its box and also enlarges one smaller than the box; only `object-fit: scale-down`, a `max-width`/`max-height` cap, or a box no larger than the picture keeps a sprite at its natural size or below. The answer figure uses `scale-down`, because 64px sprites "stretched to fill the box … came out three times their size, and blurred" (a box at most 220px square, `chat.css:97-123`); gallery pictures are capped at their natural size inside 4:3 boxes and grow 3% on hover (`gallery.tsx:115-131`); the small plates (tiles, list rows, recipe icons, results) are smaller than the wiki's usual 64px sprite, so `object-contain` there only ever shrinks. The article's own picture is `scale-down` too: in its 112px plate from 1024px a 64px sprite stays at 64px, where `contain` drew it at 1.47× (`identity.tsx:118`). New icon slots, the craft card's and the planner's rows included, use `scale-down`. Biome screenshots are `object-cover` at 16:9.
- **Lightbox:** opaque bog with ash controls and an ash image counter, none of them under a drop shadow, its captions on bog/88 (`gallery-lightbox.tsx:92-109`; an inline `color-mix()`, so it gets none of the plain-colour fallbacks the route sheets get). The counter is not a button and reads its own variables, `--yarl__counter_color` and `--yarl__counter_filter`.
- **Loading:** the article's own picture and a first screen's first tile load eagerly, the likely largest paint with high priority; everything else lazily (`wiki-image.tsx:9-16`).
- **Preview cards** (`src/app/opengraph-image.tsx`, `src/app/wiki/a/[slug]/opengraph-image.tsx`, `src/app/wiki/guide/opengraph-image.tsx`): 1200 × 630, bog ground, the Fehu mark, Cinzel SemiBold titles and Spectral Regular text from the TTFs in `public/fonts/`; a long article title steps down from 88 to 72 to 58px.

### Motion and feedback
- **Ember** (`base.css:256-299`): 5px forge dots pulsing 1.4s ease-in-out forever (opacity 0.35 to 1, 2px up, scale 0.9 to 1.1), each 0.18s after the one before. Waiting for an answer: three dots for the chat's first token (`thread.tsx:174-177`) and for search results (`search-view.tsx:661-673`); one dot beside an article's translation status (`src/components/wiki/translate-on-view.tsx:171`).
- **Rise** (`base.css:274-303`): 260ms ease-out, from 6px below and transparent; each chat message and the empty state.
- **Page-load bar:** silent for 150ms, an 80ms fade in, growth over 20s on `cubic-bezier(0, .55, .45, 1)`, a 250ms fade out; under reduced motion a still full bar after the same pause.
- **State changes:** colours and borders ease over 150ms (CSS classes use `ease-out`, Tailwind's `transition-colors` its default curve); the rune chip over 120ms.
- **Floating controls:** the ask button and the contents pill slide 1rem down and fade over 200ms when hidden (the pill on CSS `ease-out`, `guide.css:690-692`; the ask button on Tailwind's default `cubic-bezier(0.4, 0, 0.2, 1)`, `ask-button.tsx:87`), and leave the tab order and the accessibility tree while hidden (`inert` on the ask button, `aria-hidden` and `tabindex="-1"` on the pill); the chat drawer slides over 200ms on Tailwind's `ease-out`, `cubic-bezier(0, 0, 0.2, 1)` (`src/components/chat.tsx:518`).
- **Reduced motion:** an unlayered `!important` rule cuts every animation and transition to 0.01ms and scrolling to instant (`base.css:306-319`).
- **Drift:** `base.css:256-261` calls the ember "the one ambient motion in the app", the alternative to a spinner, yet the chat sidebar's ↻ spins (Tailwind `animate-spin`, 1s linear, infinite) while a re-index starts (`src/components/sidebar.tsx:245`).

### Focus, targets and contrast
- **Focus ring** (`base.css:216-252`): `:where(a, button, input, textarea, select, summary, [tabindex]):focus-visible { outline: 2px solid var(--focus-ring, var(--color-forge)); outline-offset: 2px }`, unlayered so it beats `focus:outline-none`. Two hooks adjust it: `.focus-inset` (offset -2px) inside segmented or clipped controls, and `--focus-ring: var(--color-birch)` on forge fills. A `focus-visible:outline-*` utility cannot change it. The skip link's target, `#main`, shows no ring.
- **Skip link** (`base.css:142-175`): parked above the viewport, it slides into the top-left corner on focus, forge with bog mono 12px text and a birch ring, 44px tall on touch.
- **Targets:** 44px on coarse pointers through the `pointer-coarse:` variant (`min-h-11`, `h-11`, `size-11`); result rows 48px (`search-view.tsx:705-709`); fine pointers may go to 28 to 36px.
- **Contrast:** every text colour pair measured in Colors is 4.5:1 or more at rest, and so are item chips (forge on moss/50: 5.77 over bog, 5.37 over peat), the disabled primary button (ash on moss, 4.98) and birch/80 sidebar text on peat (8.51). Hidden decorative glyphs fall below: the ash/60 breadcrumb separator (3.19 on bog) and the 40% sort arrows (2.08 on peat). Lit states hold 4.5:1 too, because a lit forge-text control stops at forge/20 on bog and forge/15 on peat, and lighter grounds take less: the citation chip lights by its edge alone and keeps its forge/12 fill (4.62 on a phone card's title, its lightest ground), the new-question and floating ask buttons light to forge 15% mixed into opaque peat (4.64), and a segment whose view is loading takes a forge/20 tint over its ash label (4.83 on bog).
- **Other:** forced colours paint the page-load bar in `Highlight`; print hides the nav, banners, the ask button and the guide's contents; English text inside the Spanish interface carries `lang="en"`.

### Named Rules
**The One Named Value Rule.** A single named value is shown one way, its label on the left and the value beside it on the right: the infobox's stat rows (where a phrase or a list drops under its label instead), every table's phone cards, and the boss card's facts from 640px (stacked below it). Tables, the compare table included, show values in columns under their headings instead.

**The Plate Rule.** A picture always sits on a plate that holds its place, so a slow or missing image never moves a row.

## Do's and Don'ts

### Do:
- **Do** build every colour from the nine palette tokens (`src/app/globals.css`), and express a state as the same token at an alpha: a forge/10 fill under a forge/30 edge, moss/60 between rows, peat/40 stripes.
- **Do** spend forge as the One Light Rule allows: a solid fill only for a selected segment and a form's one primary action; forge text, edges and tints for the current place, "×20" counts, kickers and ordinals, citations, the guide's name chips, outlined secondary actions, alerts and the 2px focus ring.
- **Do** set every quantity a player compares against the chest in JetBrains Mono 13px, weight 600, tabular figures, forge, with the multiplier first ("×20"), as the recipe tile's count does (`.recipe-qty`).
- **Do** head a group with a small tracked label (JetBrains Mono 11px, 0.16em, uppercase, ash; `.label`); when it opens a section of the page (a browse axis, an answer's sources), run a 1px moss rule across the rest of the line, and inside a panel (an infobox group, the gallery) leave the label alone.
- **Do** give every control a 44px target on coarse pointers (`pointer-coarse:min-h-11`) and every result row 48px.
- **Do** set every text field and select at 16px under a coarse pointer (12 to 14px is fine for a fine one), with 6px corners, a 1px moss edge, the other neutral of its surface, a lichen edge on hover and a forge/50 edge on focus.
- **Do** hold reading text to 65 to 72ch (68ch is the norm) and let tables, tiles and pictures take the full width.
- **Do** show a single named value with its label on the left (Spectral 14px ash) and the value on the right (mono 13px birch, tabular); below 640px turn a table into labelled cards (the phone cards, `.stack-table`, with each cell's heading in `data-label`).
- **Do** round a card's first and last rows to its corner instead of clipping the card, as the stat list does (`calc(0.375rem - 1px)`).
- **Do** pin anything fixed above the phone tab bar at `bottom: calc(var(--tabbar-h) + <gap>)`, hide it while the reader scrolls down, lift it with the short bog shadow (`0 4px 12px -4px`, bog at 70%), and stick things under the nav at `top: var(--nav-h)`.
- **Do** put new component classes in a per-route stylesheet in `src/app/styles/` that opens with `@reference '../globals.css'`, keep them in the components layer, and import the sheet from every route that draws them; keep the home page on utilities alone.
- **Do** use the ember for "waiting for an answer" and the 260ms rise for something arriving.
- **Do** number a short ordered set of twelve or fewer (biomes, bosses, sources) with Futhark runes (`rune(n)`, which wraps after twelve), keeping the numeral beside the rune wherever a marker must be matched.
- **Do** load Fandom pictures at their drawn size and with no referrer (`FANDOM_IMG_PROPS`), on a moss-edged plate that keeps the row aligned when the picture fails, never enlarged (icons `object-fit: scale-down`).
- **Do** rely on the global 2px forge focus ring: drawn inside segmented or clipped controls (`.focus-inset`), and birch on forge fills (`--focus-ring`).

### Don't:
- **Don't** add a colour: no new hue, no neutral grey, no pure black or white (in a shadow either), and none of Tailwind's default palette, which stays available because the theme does not reset it but appears nowhere in the served CSS.
- **Don't** use blood for anything but failures and warnings that cost the player something; a tip is a plain note, and offline and degraded notices are forge.
- **Don't** set running text in Cinzel or in tracked capitals; captions over 24 characters and column headings over 20 go to sentence case.
- **Don't** set functional text under 12px; the 11px label is the only exception, and a chip sized to its text keeps a 12px floor (`max(0.85em, 0.75rem)`).
- **Don't** let a lit forge-text control fall below 4.5:1: its tint stops at forge/20 on bog and forge/15 on peat, over an opaque base, measured on the lightest ground the control can sit on; a citation chip, which can sit on a phone card's title, lights by its edge alone.
- **Don't** let anything scroll the page sideways at 360px: a wide table scrolls inside its own box, and long words break.
- **Don't** give a resting surface a shadow; depth is bog, peat and moss with 1px hairlines, and only controls that float over text lift.
- **Don't** add a spinner or any new looping motion, and never animate anything that the reduced-motion rule cannot stop.
- **Don't** restyle or remove the focus ring with utilities (`focus-visible:outline-*`, or `focus:outline-none` alone); the unlayered global ring is the one ring.
- **Don't** add rules to the two global stylesheets (`globals.css`, `base.css`) unless every page draws them: both block every route's first paint (`globals.css:4-9`), and the route test would not catch it, since it pins globals.css to its two imports but treats every class in base.css as global (`tests/unit/route-css.test.ts:66-67,205-208`).
- **Don't** use emoji or an icon font; glyphs are monochrome text characters or runes in `currentColor`, and line icons are 12-unit SVGs with a 1.25 stroke.
- **Don't** enlarge a picture past its natural size: `object-contain` alone does so in a box larger than the picture. Icons sit `scale-down` in fixed boxes, gallery pictures are capped at their natural size inside 4:3 boxes, and only a biome card's screenshot fills its 16:9 frame (`object-cover`).
