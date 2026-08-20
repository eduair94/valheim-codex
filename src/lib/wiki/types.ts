/** Identifier of a wiki we ingest from. */
export type SourceId = string;

export type WikiSource = {
  id: SourceId;
  /** Human label used in citations. */
  label: string;
  /** MediaWiki `api.php` endpoint. */
  api: string;
  /** Base for article URLs; the title is appended. */
  articleBase: string;
  /** 0 wins ties during fusion; higher values are penalised. */
  rank: number;
  /** Namespaces to ingest. 0 is the main article namespace. */
  namespaces: number[];
};

/** A page as listed by `list=allpages`. */
export type PageRef = {
  pageId: number;
  title: string;
};

/** A page as returned by `action=parse`. */
export type FetchedPage = {
  source: SourceId;
  pageId: number;
  title: string;
  url: string;
  revid: number;
  categories: string[];
  html: string;
};

/** One heading-delimited region of an article. */
export type Section = {
  /** Breadcrumb of ancestor headings, e.g. `Usage > Crafting`. Empty for the lead. */
  path: string;
  /** Prose with tables and infoboxes removed. */
  text: string;
  /** Tables that appeared inside this section, already flattened to text. */
  tables: string[];
};

export type InfoboxNode =
  | { kind: 'data'; label: string; value: string }
  | { kind: 'group'; label: string; children: InfoboxNode[] }
  | { kind: 'tabs'; tabs: { label: string; children: InfoboxNode[] }[] };

export type Infobox = {
  title: string;
  nodes: InfoboxNode[];
};

export type ParsedPage = {
  page: FetchedPage;
  infobox: Infobox | null;
  sections: Section[];
};

export type ChunkKind = 'prose' | 'infobox' | 'table';

export type WikiChunk = {
  /** Deterministic: `${source}:${pageId}:${kind}:${ordinal}`. */
  id: string;
  pageKey: string;
  source: SourceId;
  sourceRank: number;
  title: string;
  url: string;
  sectionPath: string;
  kind: ChunkKind;
  /** Embedded and cited verbatim, context prefix included. */
  content: string;
  tokenCount: number;
  contentHash: string;
};
