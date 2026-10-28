/**
 * The reading document: what the ingest stores in `articles` and what the
 * reader renders.
 *
 * Shape changes, newest first. Each is backward compatible: a renderer that
 * predates it still shows the document correctly, only less well. Rows
 * written before a change keep the old shape until their page is revised
 * upstream or `pnpm ingest --reparse` re-derives them (`parser_version`, see
 * src/lib/ingest/version.ts), so a renderer meets both shapes for a while.
 *
 * Parser version 2 (2026-10)
 *
 *   - A tabber in the body is read tab by tab: its panels' headings,
 *     paragraphs, lists and tables are blocks of their own, and a tab that
 *     has no heading of its own is headed by its label, one level below the
 *     tabber's section ("Armor pieces > Quality 1"). An armor set's "Armor
 *     pieces" used to be one paragraph — "1\n\n2\n\n3\n\n4\n\nQuality 1…"
 *     — with the four levels' tables read into it as lines. A tab's text is
 *     never the lead, and tab labels never appear as text.
 *   - A tabber that only held infoboxes is dropped whatever wraps it, so the
 *     lead is the first real paragraph (Frosted Sweetbread's was "Baked\n\n
 *     Unbaked").
 *   - `infobox.tabs` comes from the first tabber in the infobox that holds
 *     data. Armor pieces open theirs with a tabber of pictures ("Icon"),
 *     which used to answer, and their quality levels — armor, durability,
 *     weight and recipe — were dropped: `tabs` was `[]` and `common` held
 *     only the type, source and id. Their `facets.station` now comes from
 *     `Source` too, since the levels state crafting materials.
 *   - `infobox.variants` names the tabs of a page that shows one infobox per
 *     tab ("Head", "Chest", "Legs"). The infobox is still the first tab's,
 *     which on an armor set is a piece's (`title` "Bronze helmet" on Bronze
 *     Armor), so the comparison leaves such a page out. Absent on old rows.
 *   - `facets.station` needs a recipe row that states one: materials that
 *     name something, or a numbered crafting level. A repair level, "n/a"
 *     and "nil" no longer count, so the traders who sell Hildir's clothes
 *     and Haldor's circlet are not stations.
 *
 * Parser version 1 (2026-10)
 *
 *   - Line breaks are `\n` inside the same string. Table cells, list items
 *     and infobox values used to lose every `<br>`, list item and paragraph
 *     boundary ("10 Wood8 Iron4 Root"); they now keep one line per entry
 *     ("10 Wood\n8 Iron\n4 Root"). A nested list becomes further lines of
 *     its parent item. Render with `white-space: pre-line`, or split on `\n`.
 *     A renderer that ignores it shows the lines run together with a space,
 *     which still reads and still links.
 *       Infobox values that were joined with "; " (recipes, resistances) now
 *     use `\n` too; `parseRecipe` accepts both. Paragraph text, as before,
 *     may carry line breaks the wiki source had.
 *   - `TableBlock.headers` merges stacked header rows ("Average per Tree ›
 *     G1") and is `[]` when the table has no header row; it never invents
 *     "Column 1" labels. Render no `<thead>` and no cell labels when empty.
 *     A table without `th` cells has a header only when its first row looks
 *     like one (bold, capitals, no digits over rows with digits, or levels
 *     "Quality | 1 | 2 | 3"); otherwise that row is data.
 *   - Table rows are laid out with rowspan and colspan applied, so each value
 *     sits under its own header; a rowspan value is repeated in every row it
 *     covers, and a colspan value sits once, in the first column it covers.
 *     Columns with no text in any row (image-only icon columns) are dropped,
 *     so cell 0 — the row heading — is the first column with text. A heading
 *     the wiki left blank to mean "same as above" takes the one above, when
 *     the table starts with one. A cell that is only a list of pictures holds
 *     their names, one per line ("Stone Axe\nFlint Axe").
 *   - `TableBlock.groupRows` lists full-width sub-heading rows ("10 of the
 *     following:"), which carry their text in cell 0 and '' elsewhere. In a
 *     one-column table they are its `th` rows: Hugin's lines, each under the
 *     event that prompts it ("Vegvisirs"). Absent on old rows; there such
 *     rows look the same and are unmarked.
 *   - `ParagraphBlock.notice` marks a wiki status banner kept as text
 *     ("This article is about removed content.\nThis page describes…").
 *     Banners about editing the wiki (work in progress, stub, deletion,
 *     disambiguation) are dropped, and so are the matching maintenance
 *     categories on the `articles` row.
 *   - `lead` is the first paragraph before any heading that is not a notice,
 *     wherever it sits; it used to be block 0 only, so a banner there left the
 *     article without one. Figure captions and the tab labels of a tabbed
 *     infobox ("Raw / Cooked") are no longer paragraphs, and so are never
 *     taken for it.
 *   - `images` holds pictures, not the 30px item icons that sit inline in
 *     prose, lists and table cells (declared size 64px or less, outside a
 *     gallery); a figure's caption travels with its image.
 *   - Inline maths reads as text ("total damage / duration") rather than as
 *     TeX source.
 */

/** Why a paragraph is a status banner rather than prose. */
export type NoticeKind = 'unfinished' | 'removed' | 'dlc' | 'upcoming' | 'other';

/** A run of readable prose. */
export type ParagraphBlock = {
  kind: 'paragraph';
  section: string;
  text: string;
  /** Present when the paragraph is a wiki status banner, not article text. */
  notice?: NoticeKind;
};

/** A bullet or numbered list, kept as items rather than flattened prose. */
export type ListBlock = {
  kind: 'list';
  section: string;
  ordered: boolean;
  /** One string per item; an item's own line breaks and sub-items are `\n`. */
  items: string[];
};

/**
 * A table with its header row separated from its body, so the reader can get a
 * sticky first column and horizontal scrolling instead of a wall of text.
 */
export type TableBlock = {
  kind: 'table';
  section: string;
  caption: string;
  /** One label per column, or `[]` when the table states none. */
  headers: string[];
  /**
   * Equal-length rows, `headers.length` wide whenever `headers` is not empty.
   * Cell 0 is what the row is about. Cells may contain `\n`.
   */
  rows: string[][];
  /** Indices into `rows` of full-width group headings. */
  groupRows?: number[];
};

export type ArticleBlock = ParagraphBlock | ListBlock | TableBlock;

/** `value` may hold several entries, one per line (`\n`). */
export type InfoboxRow = { label: string; value: string };

/** A labelled set of rows. An empty label means the rows stand on their own. */
export type InfoboxGroup = { label: string; rows: InfoboxRow[] };

export type InfoboxTab = { label: string; groups: InfoboxGroup[] };

export type ArticleInfobox = {
  title: string;
  image: ArticleImage | null;
  /** Rows that apply whatever tab is selected. */
  common: InfoboxGroup[];
  /** Upgrade levels, star levels, variants. Empty when the infobox has no tabs. */
  tabs: InfoboxTab[];
  /**
   * When the page shows one infobox per tab, those tabs' labels, in order:
   * "Head", "Chest", "Legs" on an armor set, "Raw", "Cooked" on a meat,
   * "Mead", "Mead base". This infobox is the first tab's (its `title` says
   * whose), and the others are not read. Absent when the page has one.
   */
  variants?: string[];
};

export type ArticleImage = {
  url: string;
  alt: string;
  caption?: string;
};

/**
 * Facets lifted out of the infobox so they can be queried.
 *
 * The wiki already states these — `Main biome: Plains`, `Source: Forge` — but
 * only inside prose-shaped infobox rows. Promoting them is what turns "read an
 * article" into "browse everything from the Plains".
 */
export type ArticleFacets = {
  biome?: string;
  station?: string;
  type?: string;
  /** `SwordIron` and friends; useful for console commands and exact lookup. */
  internalId?: string;
};

export type ArticleDoc = {
  /** Opening summary, shown under the identity strip. */
  lead: string;
  blocks: ArticleBlock[];
  infobox: ArticleInfobox | null;
  images: ArticleImage[];
  facets: ArticleFacets;
};
