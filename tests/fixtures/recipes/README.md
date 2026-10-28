# Recipe fixtures

Saved pages for `extractRecipes` (`src/lib/wiki/recipes.ts`), read by
`tests/unit/recipes-extract.test.ts`. Each one is chosen for a shape of recipe
the extractor has to read; a page that changes on the wiki changes nothing
here until someone refreshes it on purpose.

## Where they came from

Each file is the live wiki's answer to the same call the ingest makes
(`fetchPage` in `src/lib/wiki/mediawiki.ts`), fetched read-only on 2026-10-27:

```
https://valheim.fandom.com/api.php?action=parse&pageid=<id>&prop=text|revid|categories&format=json&formatversion=2
```

They were copied from that day's crawl of all 1,027 pages rather than fetched
again, and kept as `{ "parse": { title, pageid, revid, text, categories } }`,
the shape of `tests/fixtures/Iron_Sword.json` and the other saved pages one
directory up. `sections` and `showtoc` are not there because `prop` does not
ask for them; nothing reads them.

| File | Page id | Revision | What it pins |
|---|---|---|---|
| `Bronze_Nails.json` | 871 | 48138 | a yield, `<b>Crafts 20</b>` before the list |
| `Iron_Nails.json` | 950 | 48194 | a yield of 10 |
| `Poison_Resistance_Mead.json` | 816 | 47695 | a mead and its "Mead base" infobox in a second tab |
| `Deer_Meat.json` | 3421 | 47549 | a raw meat (a creature drop) and its "Cooked" infobox |
| `Bread.json` | 960 | 47117 | bread and its dough ("Unbaked", yield 2) |
| `Cauldron.json` | 688 | 52034 | a station: Max Level, Improvements, a picture tabber that is not a level tabber, an entry outside any list; its table of extensions, with a Smoker no page or infobox states |
| `Forge_Cooler.json` | 1045 | 49672 | an extension: "Usage: Upgrades Forge" |
| `Karve.json` | 1006 | 45808 | a boat whose recipe takes 80 nails |
| `Tin.json` | 124 | 51715 | a smelted metal |
| `Bronze.json` | 571 | 46769 | two stations in Source ("Forge", "Smelter") |
| `Troll_Set.json` | 1120 | 52133 | an armor set: one infobox per piece, quantity first, `<br>` runs, "10Bone fragments" with no space |
| `Wood_Structures.json` | 5211 | 47957 | structure list tables: pieces with no article of their own |
| `Food.json` | 831 | 52140 | the food table's station, station level and multiplier columns |
| `Yuleklapp.json` | 6941 | 45789 | three sizes in one recipe cell, which no single recipe can say |
| `Anti-Sting_Concoction.json` | 6283 | 47707 | a second infobox titled like its page |
| `Root_Set.json` | 3612 | 51827 | "Root" linked to the disambiguation page, not the item |
| `Artisan_Table.json` | 1162 | 49687 | a station's table of extensions, the only place the Artisan Press's recipe is stated |

## Refreshing one

Fetch the page by id with the call above, sending the ingest's user agent
(`WikiValheimRAG/0.1 (<WIKI_CONTACT>)`), and save the response as it comes
(no pretty-printing needed). Then run `pnpm exec vitest run
tests/unit/recipes-extract.test.ts`: a page that reads differently fails the
fingerprint test, and `RECIPES_OUTPUT_HASH` in
`src/lib/wiki/recipes-version.ts` takes the new value it prints (alone when
only a fixture changed; with a `RECIPES_VERSION` bump when the extractor did).
