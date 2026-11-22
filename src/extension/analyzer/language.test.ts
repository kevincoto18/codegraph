import { posix } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RelPath } from '../../shared';
import type { WorkspaceReader } from '../graphService';
import { GraphService } from '../graphService';
import { ANALYZERS } from './analyzers';
import type { LanguageAnalyzer } from './language';
import { AnalyzerRegistry, LanguageRegistry } from './language';
import { LANGUAGES } from './languages';
import { linkGraph } from './linker';
import type { ParsedCall, ParsedFile, ParsedImport } from './types';

/**
 * A toy language, used to prove that a new language plugs in without
 * touching the linker, the service or the webview. Syntax, one statement per line:
 * - `use ./other` imports `other.dummy` as the namespace `other`;
 * - `fn name: a, other.b` declares an exported function calling `a()` and `other.b()`.
 */
const DUMMY_LANGUAGE: LanguageAnalyzer = {
  id: 'dummy',
  displayName: 'Dummy',
  extensions: ['.dummy'],
  version: 1,
  listImportCandidates: (fromFile, specifier) =>
    specifier.startsWith('./')
      ? [posix.normalize(posix.join(posix.dirname(fromFile), `${specifier}.dummy`))]
      : [],
  parse: (filePath, content) => {
    const imports: ParsedImport[] = [];
    const functions: ParsedFile['functions'][number][] = [];
    content.split('\n').forEach((raw, index) => {
      const line = raw.trim();
      if (line.startsWith('use ')) {
        const specifier = line.slice(4).trim();
        const localName = posix.basename(specifier);
        imports.push({
          specifier,
          syntax: 'import',
          line: index + 1,
          bindings: [{ kind: 'namespace', importedName: '*', localName }],
        });
      } else if (line.startsWith('fn ')) {
        const [name = '', callList = ''] = line.slice(3).split(':');
        const calls = callList
          .split(',')
          .map((call) => call.trim())
          .filter((call) => call !== '')
          .map((call): ParsedCall => {
            const [receiver, member] = call.split('.');
            return member === undefined
              ? { kind: 'identifier', name: call, line: index + 1 }
              : { kind: 'member', receiver: receiver ?? '', name: member, line: index + 1 };
          });
        functions.push({
          name: name.trim(),
          qualifiedName: name.trim(),
          functionKind: 'function',
          line: index + 1,
          endLine: index + 1,
          exported: true,
          calls,
        });
      }
    });
    const exports = functions.map((fn) => ({ exportedName: fn.name, localName: fn.name }));
    return { filePath, imports, functions, exports };
  },
};

/**
 * Creates a reader over an in-memory workspace.
 *
 * @param files - File contents by path.
 * @returns The reader.
 */
function reader(files: Readonly<Record<RelPath, string>>): WorkspaceReader {
  return {
    listFiles: () => Promise.resolve(Object.keys(files)),
    readFile: (filePath) => Promise.resolve(files[filePath] ?? ''),
  };
}

/** Logger that ignores everything. */
const silent = {
  /** Ignores the message. */
  info: (): void => undefined,
  /** Ignores the message. */
  warn: (): void => undefined,
  /** Ignores the message. */
  error: (): void => undefined,
};

describe('LanguageRegistry', () => {
  it('describes the built-in languages', () => {
    expect(LANGUAGES.extensions).toEqual(['.ts', '.tsx', '.js', '.jsx']);
    expect(LANGUAGES.sourceGlob).toBe('**/*.{ts,tsx,js,jsx}');
    expect(LANGUAGES.versionKey).toBe('typescript1');
    expect(LANGUAGES.forFile('src/a.tsx')?.id).toBe('typescript');
    expect(LANGUAGES.forFile('README.md')).toBeUndefined();
    expect(LANGUAGES.forFile('Makefile')).toBeUndefined();
  });

  it('filters files by language, exclusions and excluded directories', () => {
    expect(LANGUAGES.isAnalyzableFile('src/a.ts')).toBe(true);
    expect(LANGUAGES.isAnalyzableFile('src/a.d.ts')).toBe(false);
    expect(LANGUAGES.isAnalyzableFile('node_modules/x/a.js')).toBe(false);
    expect(LANGUAGES.isAnalyzableFile('src/a.py')).toBe(false);
  });

  it('resolves imports with the rules of the importing language', () => {
    const known = new Set(['src/b.ts', 'src/lib.dummy']);
    const registry = new LanguageRegistry([...LANGUAGES.languages, DUMMY_LANGUAGE]);
    expect(registry.resolveImport('src/a.ts', './b', known)).toBe('src/b.ts');
    expect(registry.resolveImport('src/a.dummy', './lib', known)).toBe('src/lib.dummy');
    expect(registry.resolveImport('src/a.dummy', './b', known)).toBeNull();
    expect(registry.resolveImport('README.md', './b', known)).toBeNull();
  });

  it('rejects two languages claiming the same extension', () => {
    expect(
      () => new LanguageRegistry([DUMMY_LANGUAGE, { ...DUMMY_LANGUAGE, id: 'other' }]),
    ).toThrow('Extension ".dummy" is claimed by both "dummy" and "other".');
  });

  it('parses with the analyzer of each language', () => {
    expect(ANALYZERS.parse('a.ts', 'export function f() {}').functions[0]?.name).toBe('f');
    expect(() => ANALYZERS.parse('a.dummy', '')).toThrow('No language analyzer for "a.dummy".');
  });
});

describe('a new language', () => {
  const registry = new AnalyzerRegistry([...ANALYZERS.languages, DUMMY_LANGUAGE]);
  const files = {
    'src/main.dummy': 'use ./lib\nfn main: helper, lib.greet\nfn helper:',
    'src/lib.dummy': 'fn greet:',
    'src/app.ts': 'export function start(): void {}',
  };

  it('is linked like any other language', () => {
    const parsed = Object.entries(files).map(([filePath, content]) =>
      registry.parse(filePath, content),
    );
    const snapshot = linkGraph(parsed, 1, registry);
    expect(snapshot.edges.map((edge) => edge.id).sort()).toEqual([
      'call:src/main.dummy#main->src/lib.dummy#greet',
      'call:src/main.dummy#main->src/main.dummy#helper',
      'import:src/main.dummy->src/lib.dummy',
    ]);
  });

  it('appears in the graph through the service without other changes', async () => {
    const service = new GraphService(reader(files), silent, undefined, { languages: registry });
    const snapshot = await service.initialize();
    expect(snapshot.nodes.map((node) => node.id).sort()).toEqual([
      'src/app.ts',
      'src/app.ts#start',
      'src/lib.dummy',
      'src/lib.dummy#greet',
      'src/main.dummy',
      'src/main.dummy#helper',
      'src/main.dummy#main',
    ]);
    expect(snapshot.edges).toHaveLength(3);
  });
});
