import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/*
 * The copy table stays out of the browser's chunks.
 *
 * `src/lib/i18n/strings.ts` merges every area's copy (`copy/*`) in both
 * languages, about 38 KB of source. Every client chunk that imported a value
 * from it carried all of it, and every page loaded three such chunks (its
 * own, `global-error`'s and the error boundary's). Client Components now read
 * their language's table from `LangProvider` with `useStrings`, and the other
 * language arrives through the one dynamic `import()` in `strings-loader.ts`.
 *
 * This walks the browser's module graph as the bundler does: from every
 * 'use client' module, through every import that is not `import type`
 * (static imports, re-exports and dynamic `import()`), and fails when a module
 * on it imports the table statically. Everything under `src/lib/chat`, the
 * chat's browser helpers, is held to the same rule whether reachable or not.
 * Server Components keep calling `strings()`: they are not on the graph.
 *
 * `import { type X } from '…/strings'` counts as a value import: with
 * `verbatimModuleSyntax` it compiles to `import {} from '…/strings'`, which
 * still loads the module. Write `import type { X }`.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const STRINGS_FILE = join(SRC, 'lib', 'i18n', 'strings.ts');
const COPY_DIR = join(SRC, 'lib', 'i18n', 'copy');
const LOADER_FILE = join(SRC, 'lib', 'i18n', 'strings-loader.ts');
const CHAT_LIB_DIR = join(SRC, 'lib', 'chat');

type ModuleImport = { specifier: string; typeOnly: boolean; dynamic: boolean };
type ParsedModule = { client: boolean; imports: ModuleImport[] };

/** What a module imports, and whether it starts with the 'use client' directive. */
function parseSource(fileName: string, text: string): ParsedModule {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);

  let client = false;
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === 'use client') client = true;
  }

  const imports: ModuleImport[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.push({
        specifier: statement.moduleSpecifier.text,
        typeOnly: Boolean(statement.importClause?.isTypeOnly),
        dynamic: false,
      });
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      imports.push({ specifier: statement.moduleSpecifier.text, typeOnly: statement.isTypeOnly, dynamic: false });
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteralLike(argument)) {
        imports.push({ specifier: argument.text, typeOnly: false, dynamic: true });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { client, imports };
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** The source file a specifier names, or null for a package or a non-TypeScript file. */
function resolveSpecifier(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith('./') || specifier.startsWith('../')) base = resolve(dirname(from), specifier);
  else return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')];
  for (const candidate of candidates) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const isTable = (file: string | null): boolean =>
  file !== null && (file === STRINGS_FILE || file.startsWith(COPY_DIR + sep));

const show = (file: string): string => relative(ROOT, file).split(sep).join('/');

const parsed = new Map<string, ParsedModule>();
function parseFile(file: string): ParsedModule {
  let found = parsed.get(file);
  if (!found) {
    found = parseSource(file, readFileSync(file, 'utf8'));
    parsed.set(file, found);
  }
  return found;
}

/** Every module the browser can load, each with the module that first reached it. */
function clientGraph(): { roots: string[]; reached: Map<string, string | null> } {
  const roots = sourceFiles(SRC).filter((file) => parseFile(file).client);
  const reached = new Map<string, string | null>();
  const queue: [string, string | null][] = roots.map((root) => [root, null]);
  while (queue.length > 0) {
    const [file, from] = queue.shift()!;
    if (reached.has(file)) continue;
    reached.set(file, from);
    for (const entry of parseFile(file).imports) {
      if (entry.typeOnly) continue;
      const target = resolveSpecifier(file, entry.specifier);
      // The table itself is what is looked for, not walked through.
      if (target && !isTable(target)) queue.push([target, file]);
    }
  }
  return { roots, reached };
}

function chain(reached: Map<string, string | null>, file: string): string {
  const path: string[] = [];
  for (let at: string | null | undefined = file; at; at = reached.get(at)) path.unshift(show(at));
  return path.join(' -> ');
}

describe('the import classifier this guard relies on', () => {
  const classify = (text: string): ModuleImport[] => parseSource('probe.tsx', text).imports;

  it('tells type imports from value imports', () => {
    expect(classify(`import type { Strings } from '@/lib/i18n/strings';`)).toEqual([
      { specifier: '@/lib/i18n/strings', typeOnly: true, dynamic: false },
    ]);
    expect(classify(`import { strings, type Lang } from '@/lib/i18n/strings';`)[0]?.typeOnly).toBe(false);
    // Kept as `import {} from …` under verbatimModuleSyntax: it still loads the table.
    expect(classify(`import { type Lang } from '@/lib/i18n/strings';`)[0]?.typeOnly).toBe(false);
    expect(classify(`import '@/lib/i18n/strings';`)[0]?.typeOnly).toBe(false);
  });

  it('sees re-exports and dynamic imports', () => {
    expect(classify(`export { STRINGS } from './strings';`)).toEqual([
      { specifier: './strings', typeOnly: false, dynamic: false },
    ]);
    expect(classify(`export type { Strings } from './strings';`)[0]?.typeOnly).toBe(true);
    expect(classify(`const load = () => import('./strings');`)).toEqual([
      { specifier: './strings', typeOnly: false, dynamic: true },
    ]);
  });

  it('finds the directive only at the top of a module', () => {
    expect(parseSource('a.tsx', `'use client';\nimport x from 'y';`).client).toBe(true);
    expect(parseSource('a.tsx', `import x from 'y';\n'use client';`).client).toBe(false);
  });
});

describe('the copy table in the browser', () => {
  const { roots, reached } = clientGraph();

  it('walks the client graph it is meant to guard', () => {
    // Sanity: if the walk broke, an empty graph would pass everything below.
    const shown = new Set([...reached.keys()].map(show));
    for (const file of [
      'src/app/global-error.tsx',
      'src/components/chat.tsx',
      'src/components/shell/error-view.tsx',
      'src/components/wiki/search-view.tsx',
    ]) {
      expect(roots.map(show), file).toContain(file);
    }
    // Shared modules that the browser reaches only through a client module.
    // (Not the browse tiles: the home page renders them on the server now,
    // and tests/unit/search-view.test.ts keeps them out of the browser.)
    expect(shown).toContain('src/lib/wiki/title-search.ts');
    expect(shown).toContain('src/components/wiki/lists/compare-model.ts');
    expect(shown).toContain('src/lib/chat/errors.ts');
  });

  it('is never imported statically by a module the browser loads, or by src/lib/chat', () => {
    const checked = new Set([...reached.keys(), ...sourceFiles(CHAT_LIB_DIR)]);
    const offenders: string[] = [];
    for (const file of checked) {
      for (const entry of parseFile(file).imports) {
        if (entry.typeOnly || entry.dynamic) continue;
        if (!isTable(resolveSpecifier(file, entry.specifier))) continue;
        offenders.push(`${chain(reached, file)} imports '${entry.specifier}'`);
      }
    }
    expect(
      offenders,
      'Read copy in a Client Component with useStrings() (components/shell/lang-context); import only types from the table.',
    ).toEqual([]);
  });

  it('is fetched lazily from one place only, strings-loader.ts', () => {
    const lazy: string[] = [];
    for (const file of reached.keys()) {
      for (const entry of parseFile(file).imports) {
        if (entry.dynamic && isTable(resolveSpecifier(file, entry.specifier))) lazy.push(show(file));
      }
    }
    expect(lazy).toEqual([show(LOADER_FILE)]);
  });
});
