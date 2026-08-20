/** A run of readable prose. */
export type ParagraphBlock = {
  kind: 'paragraph';
  section: string;
  text: string;
};

/** A bullet or numbered list, kept as items rather than flattened prose. */
export type ListBlock = {
  kind: 'list';
  section: string;
  ordered: boolean;
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
  headers: string[];
  rows: string[][];
};

export type ArticleBlock = ParagraphBlock | ListBlock | TableBlock;

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
