import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { load } from 'cheerio';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { Lang } from '@/lib/i18n/strings';
import { withLang } from '../helpers/lang';

/*
 * The search page (`/wiki`): the server renders the ways in once and hands
 * them to the search, which draws them until something is typed.
 *
 * It used to draw them itself, inside a Suspense boundary whose fallback was
 * the whole search again. React streams a large boundary after its fallback,
 * so the HTML carried every tile twice and swapped the copies at the end, and
 * the tiles' code went to the browser for something with nothing to run.
 */

const nav = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => nav.search,
  usePathname: () => '/wiki',
  useRouter: () => ({ push() {}, replace() {}, prefetch() {}, refresh() {}, back() {}, forward() {} }),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
const axes = vi.hoisted(() => ({
  total: 1234,
  biomes: [{ name: 'Meadows', count: 120, icon: 'https://static.wikia.nocookie.net/valheim/images/1/1a/Meadows.png', label: 'Pradera' }],
  categories: [{ name: 'Weapons', count: 80, icon: null, label: 'Armas' }],
  stations: [{ name: 'Forge', count: 50, icon: null, label: 'Forja' }],
}));
vi.mock('@/lib/wiki/data', () => ({ getBrowseAxes: async () => axes }));

const { SearchView, linkToRouterPage } = await import('@/components/wiki/search-view');
const { default: WikiHomePage } = await import('@/app/wiki/page');

const BROWSE = createElement('p', { 'data-browse': '' }, 'the ways in');

/** The search as the server renders it, for an address whose query is `address`. */
function serverRender({ lang = 'es', serverQuery = '', address = serverQuery }: { lang?: Lang; serverQuery?: string; address?: string } = {}): string {
  nav.search = new URLSearchParams(address ? { q: address } : {});
  return renderToString(withLang(lang, createElement(SearchView, { lang, serverQuery, browse: BROWSE })));
}

describe('the search page, as the server renders it', () => {
  it('draws the browse section it is handed, once, while nothing is typed', () => {
    const $ = load(serverRender());
    expect($('[data-browse]')).toHaveLength(1);
    expect($('[role="region"]')).toHaveLength(0);
  });

  it('streams nothing later: no Suspense boundary to send a fallback first', () => {
    // A boundary around the search made React send its fallback (a whole
    // copy of the page) and the real thing after it, hidden, to be swapped
    // in. The route is dynamic, so `useSearchParams` needs none.
    expect(serverRender(), 'a Suspense boundary in the search view').not.toContain('<!--$');
    expect(serverRender({ serverQuery: 'troll' })).not.toContain('<!--$');
  });

  it('drops the browse section for the results while there is a query', () => {
    const $ = load(serverRender({ serverQuery: 'troll' }));
    expect($('[data-browse]')).toHaveLength(0);
    expect($('[role="region"]').attr('aria-label')).toBe('Resultados de la búsqueda');
    expect($('#wiki-search').attr('value')).toBe('troll');
  });

  it('labels the results in the reader’s language', () => {
    const $ = load(serverRender({ lang: 'en', serverQuery: 'troll' }));
    expect($('[role="region"]').attr('aria-label')).toBe('Search results');
  });

  it('names the field, so before any script runs the form is a GET to ?q=', () => {
    const $ = load(serverRender());
    const form = $('form[role="search"]');
    expect(form.find('input#wiki-search').attr('name')).toBe('q');
    // No `action` and no `method`: the page itself, by GET. An action would
    // also make the progress bar take every Enter for a page change.
    expect(form.attr('action')).toBeUndefined();
    expect(form.attr('method')).toBeUndefined();
  });

  it('draws the query the server rendered, whatever the address holds by then', () => {
    // Offline, the service worker answers `/wiki?q=troll` with the `/wiki` it
    // saved. Hydration must draw what that HTML holds, or React throws the
    // page away; the address's query follows one render later.
    const $ = load(serverRender({ serverQuery: '', address: 'troll' }));
    expect($('[data-browse]')).toHaveLength(1);
    expect($('#wiki-search').attr('value') ?? '').toBe('');
  });
});

/*
 * A tap the router has no change of address for: a link to the page it
 * shows. Read before the link's own handler, so the search can take the
 * link's query itself, since nothing else will tell it.
 */
describe('a tap on a link to the page the router shows', () => {
  const ORIGIN = 'https://valheim.example';
  const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  const link = (href: string, target = '') => ({ href: new URL(href, ORIGIN).href, target, download: false });
  /** The address bar, absolute, as `window.location.href` is. */
  const address = (path: string): string => new URL(path, ORIGIN).href;
  /** What the router shows: this page, with `query` in `?q=`. */
  const router = (query: string) => ({ pathname: '/wiki', query });

  it('is the search tab while what is typed has not reached the address', () => {
    expect(linkToRouterPage(plain, link('/wiki'), address('/wiki'), router(''))).toEqual({ query: '', address: null });
  });

  it('is the search tab while the address holds a query written past the router', () => {
    // A result followed, or Enter, inside the address's delay: the query went
    // to the address only, and the tab now abandons that result. The address
    // goes back to the router's page before the link navigates there.
    expect(linkToRouterPage(plain, link('/wiki'), address('/wiki?q=iron+sword'), router(''))).toEqual({
      query: '',
      address: '/wiki',
    });
  });

  it('is not the search tab once the router has a query: leaving it is a change of address', () => {
    expect(linkToRouterPage(plain, link('/wiki'), address('/wiki?q=troll'), router('troll'))).toBeNull();
    // An older query than the one written past it, too.
    expect(linkToRouterPage(plain, link('/wiki'), address('/wiki?q=iron+sword'), router('iron swor'))).toBeNull();
  });

  it('takes the query of a link to the search the router shows', () => {
    expect(linkToRouterPage(plain, link('/wiki?q=troll'), address('/wiki?q=trolls'), router('troll'))).toEqual({
      query: 'troll',
      address: '/wiki?q=troll',
    });
  });

  it('is not a result, a fragment, another site, or a tap that opens elsewhere', () => {
    const typed = address('/wiki?q=iron+sword');
    expect(linkToRouterPage(plain, link('/wiki/a/iron-sword'), typed, router(''))).toBeNull();
    expect(linkToRouterPage(plain, link('/wiki#main'), typed, router(''))).toBeNull();
    expect(linkToRouterPage(plain, link('/wiki#main'), address('/wiki'), router(''))).toBeNull();
    expect(linkToRouterPage(plain, link('https://valheim.fandom.com/wiki'), typed, router(''))).toBeNull();
    expect(linkToRouterPage({ ...plain, ctrlKey: true }, link('/wiki'), typed, router(''))).toBeNull();
    expect(linkToRouterPage(plain, link('/wiki', '_blank'), typed, router(''))).toBeNull();
  });
});

/** The first element in `node` whose type is `type`. */
function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  if (node.type === type) return node as ReactElement<Record<string, unknown>>;
  return findElement(node.props.children, type);
}

describe('the home page', () => {
  async function searchProps(query: Record<string, string | string[]>): Promise<{ serverQuery: unknown; browse: ReactNode }> {
    const page = await WikiHomePage({ searchParams: Promise.resolve(query) });
    const search = findElement(page, SearchView);
    expect(search, 'the page renders the search').not.toBeNull();
    return search!.props as { serverQuery: unknown; browse: ReactNode };
  }

  it('renders the ways in on the server and hands them to the search', async () => {
    const { browse } = await searchProps({});
    const $ = load(renderToStaticMarkup(withLang('es', createElement('div', null, browse))));
    expect($('a[href="/wiki/guide"]')).toHaveLength(1);
    expect($('#axis-biomes').text()).toBe('Biomas');
    expect($('a[href="/wiki/c/all?biome=Meadows"]')).toHaveLength(1);
    expect($('p').first().text()).toContain('1234');
  });

  it('tells the search the query it rendered, the first when there are several', async () => {
    expect((await searchProps({})).serverQuery).toBe('');
    expect((await searchProps({ q: 'troll' })).serverQuery).toBe('troll');
    expect((await searchProps({ q: ['iron', 'troll'] })).serverQuery).toBe('iron');
  });
});

/*
 * What the search view takes to the browser: everything it imports, except
 * `import type`, transitively. The browse tiles must not be in it.
 */
const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

function imports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && !statement.importClause?.isTypeOnly) {
      out.push(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && !statement.isTypeOnly) {
      out.push(statement.moduleSpecifier.text);
    }
  }
  return out;
}

function resolveSource(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith('./') || specifier.startsWith('../')) base = resolve(dirname(from), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function reachedFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of imports(file)) {
      const target = resolveSource(file, specifier);
      if (target) queue.push(target);
    }
  }
  return new Set([...seen].map((file) => relative(ROOT, file).split(sep).join('/')));
}

describe('the search view in the browser', () => {
  const reached = reachedFrom(join(SRC, 'components', 'wiki', 'search-view.tsx'));

  it('walks the imports it is meant to check', () => {
    // Sanity: a broken walk would pass the test below with nothing in it.
    expect(reached).toContain('src/lib/wiki/title-search.ts');
    expect(reached).toContain('src/components/shell/nav-tracker.ts');
  });

  it('does not take the browse tiles with it: the server renders them', () => {
    for (const file of [
      'src/components/wiki/browse-axes.tsx',
      'src/components/wiki/featured-guide-card.tsx',
      'src/components/wiki/category-grid.tsx',
      'src/components/wiki/lists/format.ts',
      'src/lib/i18n/browse-copy.ts',
    ]) {
      expect(reached, `${file} is imported by the search view's client code`).not.toContain(file);
    }
  });
});
