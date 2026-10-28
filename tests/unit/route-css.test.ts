import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Each route loads only the component CSS it draws.
 *
 * `globals.css` (Tailwind and `styles/base.css`) is every route's, and blocks
 * every first paint. The other files in `src/app/styles/` are imported by the
 * route segments that use them: the chat's page, the article's, the guide's
 * and the category's. That split fails silently: a component using a class
 * from one of those files, rendered on a route that does not import the file,
 * is just unstyled there. So this walks each route's imports as the bundler
 * does (its layouts, its page, and everything they import, client components
 * and dynamic imports included), collects the class names its modules write,
 * and checks that every class from a route stylesheet comes with that
 * stylesheet, and that no route imports one it does not use.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const APP = join(SRC, 'app');
const STYLES = join(APP, 'styles');
const GLOBALS = join(APP, 'globals.css');
const BASE = join(STYLES, 'base.css');

/** The layers `@import 'tailwindcss'` declares in globals.css, in their order. */
const TAILWIND_LAYERS = ['theme', 'base', 'components', 'utilities'];

const show = (file: string) => relative(ROOT, file).split(sep).join('/');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const ROUTE_STYLESHEETS = readdirSync(STYLES)
  .filter((name) => name.endsWith('.css'))
  .map((name) => join(STYLES, name))
  .filter((file) => file !== BASE);

/**
 * The classes a stylesheet styles on their own: the first class of each of
 * its selectors (`.stack-table tbody td` styles `stack-table`, and
 * `.g-table .stack-scroller` styles `g-table`). A class that only ever
 * appears inside another's selector is covered by that one. A prelude ends
 * at a semicolon too, so an at-rule statement before a rule
 * (`@reference '../globals.css';`) is not read as part of its selector.
 */
function rootClasses(file: string): Set<string> {
  const classes = new Set<string>();
  for (const [, prelude] of stripComments(readFileSync(file, 'utf8')).matchAll(/([^{};]+)\{/g)) {
    if (prelude!.trim().startsWith('@')) continue;
    for (const selector of prelude!.split(',')) {
      const first = /\.(-?[_a-zA-Z][\w-]*)/.exec(selector);
      if (first) classes.add(first[1]!);
    }
  }
  return classes;
}

const OWNERS = new Map<string, Set<string>>();
for (const file of ROUTE_STYLESHEETS) {
  for (const name of rootClasses(file)) {
    if (!OWNERS.has(name)) OWNERS.set(name, new Set());
    OWNERS.get(name)!.add(file);
  }
}
// Classes base.css styles are everyone's, wherever else they appear.
for (const name of rootClasses(BASE)) OWNERS.delete(name);

type Module = { imports: string[]; css: string[]; classes: Set<string> };
const modules = new Map<string, Module>();

function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier);
  else return null; // a package
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * What a module imports, and the route-stylesheet classes it writes: every
 * word of a `className` (string, template or any expression), and any other
 * string that is nothing but such classes with a hyphen in their name
 * (`'col-num'`, `'head-text'`), which is how class names are built outside
 * JSX. Plain words elsewhere (`'answer'`, `'cell'`) are too common to count.
 */
function parse(file: string): Module {
  const cached = modules.get(file);
  if (cached) return cached;
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const parsed: Module = { imports: [], css: [], classes: new Set() };
  modules.set(file, parsed);

  const addImport = (specifier: string) => {
    const target = resolveImport(file, specifier);
    if (!target) return;
    if (target.endsWith('.css')) parsed.css.push(target);
    else parsed.imports.push(target);
  };
  const textOf = (node: ts.Node): string | null =>
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
      ? node.text
      : null;
  const classNameWords = (node: ts.Node) => {
    const text = textOf(node);
    if (text !== null) for (const word of text.split(/\s+/)) if (OWNERS.has(word)) parsed.classes.add(word);
    node.forEachChild(classNameWords);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) addImport(node.moduleSpecifier.text);
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        addImport(node.moduleSpecifier.text);
      }
      return;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments;
      if (specifier && ts.isStringLiteral(specifier)) addImport(specifier.text);
    }
    if (ts.isJsxAttribute(node)) {
      if (node.name.getText(source) === 'className') {
        if (node.initializer) classNameWords(node.initializer);
        return;
      }
      // `data-testid="article-body"` names a test hook, not a class.
      if (node.initializer && ts.isStringLiteral(node.initializer)) return;
    }
    const text = textOf(node);
    if (text !== null && !ts.isTemplateHead(node) && !ts.isTemplateMiddle(node) && !ts.isTemplateTail(node)) {
      const words = text.trim().split(/\s+/);
      if (words.every((word) => word.includes('-') && OWNERS.has(word))) for (const word of words) parsed.classes.add(word);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return parsed;
}

/** Every module a route renders from, and every stylesheet they import. */
function closure(entries: string[]): { files: Set<string>; css: Set<string> } {
  const files = new Set<string>();
  const css = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const parsed = parse(file);
    for (const sheet of parsed.css) css.add(sheet);
    queue.push(...parsed.imports);
  }
  return { files, css };
}

const SEGMENT_FILES = ['page', 'not-found', 'error', 'global-error', 'loading', 'default'];
const WRAPPERS = ['layout', 'template'];

/** Every file that draws a route, each with the layouts and templates it renders inside. */
function routeEntries(): { entry: string; segments: string[] }[] {
  const entries: { entry: string; segments: string[] }[] = [];
  const walk = (dir: string, wrappers: string[]) => {
    const names = readdirSync(dir);
    const here = [...wrappers];
    for (const wrapper of WRAPPERS) if (names.includes(`${wrapper}.tsx`)) here.push(join(dir, `${wrapper}.tsx`));
    for (const name of names) {
      const file = join(dir, name);
      if (statSync(file).isDirectory()) {
        if (dir === APP && (name === 'api' || name === 'styles')) continue;
        walk(file, here);
        continue;
      }
      const stem = name.replace(/\.tsx$/, '');
      if (!name.endsWith('.tsx') || !SEGMENT_FILES.includes(stem)) continue;
      // global-error replaces the root layout: it is a document of its own.
      entries.push({ entry: file, segments: stem === 'global-error' ? [file] : [...here, file] });
    }
  };
  walk(APP, []);
  return entries;
}

const ROUTES = routeEntries();

describe('route stylesheets', () => {
  it('finds the routes and the classes it checks', () => {
    expect(ROUTES.map((r) => show(r.entry))).toEqual(
      expect.arrayContaining(['src/app/page.tsx', 'src/app/wiki/a/[slug]/page.tsx', 'src/app/wiki/guide/page.tsx']),
    );
    expect([...OWNERS.keys()]).toEqual(expect.arrayContaining(['answer', 'stack-table', 'compare-table', 'g-page', 'rune-chip']));
  });

  // Exact on purpose: whatever globals.css imports, every route waits for.
  it('keeps globals.css to Tailwind and base.css', () => {
    const imports = [...stripComments(readFileSync(GLOBALS, 'utf8')).matchAll(/@import\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports).toEqual(['tailwindcss', './styles/base.css']);
  });

  it('gives every class a route draws the stylesheet that styles it', () => {
    const missing: string[] = [];
    for (const { entry, segments } of ROUTES) {
      const { files, css } = closure(segments);
      for (const file of files) {
        for (const name of parse(file).classes) {
          const owners = OWNERS.get(name)!;
          if (![...owners].some((sheet) => css.has(sheet))) {
            missing.push(`${show(entry)}: .${name} (${show(file)}) needs ${[...owners].map(show).join(' or ')}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('imports no route stylesheet a route does not draw', () => {
    const unused: string[] = [];
    for (const { entry, segments } of ROUTES) {
      const { files } = closure(segments);
      const drawn = new Set([...files].flatMap((file) => [...parse(file).classes]));
      for (const segment of segments) {
        for (const sheet of parse(segment).css) {
          if (!ROUTE_STYLESHEETS.includes(sheet)) continue;
          const own = [...OWNERS].filter(([, owners]) => owners.has(sheet)).map(([name]) => name);
          if (!own.some((name) => drawn.has(name))) unused.push(`${show(entry)} imports ${show(sheet)} (via ${show(segment)})`);
        }
      }
    }
    expect(unused).toEqual([]);
  });

  it('imports every route stylesheet somewhere', () => {
    const imported = new Set(ROUTES.flatMap(({ segments }) => [...closure(segments).css]));
    expect(ROUTE_STYLESHEETS.filter((sheet) => !imported.has(sheet)).map(show)).toEqual([]);
  });

  /*
   * A route stylesheet is compiled on its own, after globals.css. Its layered
   * rules only land where they belong if they name a layer Tailwind already
   * declared: a misspelt `@layer component` would be a new layer, ordered after
   * `utilities`, and every rule in it would beat the utilities on the same
   * element. And Tailwind's own at-rules would need `@reference` to compile.
   */
  it('uses only the layers Tailwind declares, and no Tailwind at-rules', () => {
    const problems: string[] = [];
    for (const sheet of ROUTE_STYLESHEETS) {
      const css = stripComments(readFileSync(sheet, 'utf8'));
      for (const [, names] of css.matchAll(/@layer\s+([^{;]+)[{;]/g)) {
        for (const name of names!.split(',').map((n) => n.trim())) {
          if (!TAILWIND_LAYERS.includes(name)) problems.push(`${show(sheet)}: @layer ${name}`);
        }
      }
      const directive = /@(apply|variant|custom-variant|utility|theme|config|plugin|source)\b|--(theme|spacing|alpha)\(|\btheme\(/.exec(css);
      if (directive && !/@reference\s/.test(css)) problems.push(`${show(sheet)}: ${directive[0]} without @reference`);
    }
    expect(problems).toEqual([]);
  });

  /*
   * `@reference '../globals.css'` emits nothing, and reads as removable to
   * anyone who expects it only for `@apply`. It is what gives each color-mix()
   * of a palette colour a fallback in plain colour, for browsers without
   * color-mix(): taken out, nothing fails in a current browser, and the
   * fallbacks just disappear (globals.css says more).
   */
  it('compiles every route stylesheet that uses color-mix() against globals.css', () => {
    const mixing = ROUTE_STYLESHEETS.filter((sheet) => /color-mix\(/.test(stripComments(readFileSync(sheet, 'utf8'))));
    expect(mixing.length, 'route stylesheets using color-mix()').toBeGreaterThan(0);
    const missing = mixing.filter(
      (sheet) => !/@reference\s+['"]\.\.\/globals\.css['"]/.test(stripComments(readFileSync(sheet, 'utf8'))),
    );
    expect(missing.map(show)).toEqual([]);
  });
});
