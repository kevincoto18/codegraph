import { describe, expect, it } from 'vitest';

import type { GraphSnapshot } from '../../shared';
import { IncrementalLinker } from './incrementalLinker';
import type { LanguageDefinition } from './language';
import { LanguageRegistry } from './language';
import { linkGraph } from './linker';
import { splitQualifiedName } from './scope';
import type { ParsedCall, ParsedFile, ParsedFunction, ParsedImport, ParsedType } from './types';

/** A Java-like language: namespaces, types and imports by name. */
const CLASSY: LanguageDefinition = {
  id: 'classy',
  displayName: 'Classy',
  extensions: ['.cls'],
  version: 1,
  listImportCandidates: () => [],
};

/** A Go-like language: packages are folders, imported by path suffix. */
const PACKAGED: LanguageDefinition = {
  id: 'packaged',
  displayName: 'Packaged',
  extensions: ['.pkg'],
  version: 1,
  listImportCandidates: () => [],
  resolvePackage: (specifier, packages) =>
    [...packages].find((dir) => dir !== '' && specifier.endsWith(`/${dir}`)) ?? null,
};

const REGISTRY = new LanguageRegistry([CLASSY, PACKAGED]);

/**
 * Builds a method.
 *
 * @param className - Class name.
 * @param name - Method name.
 * @param calls - Calls it makes.
 * @returns The parsed function.
 */
function method(className: string, name: string, calls: ParsedCall[] = []): ParsedFunction {
  return {
    name,
    qualifiedName: `${className}.${name}`,
    className,
    functionKind: 'method',
    line: 2,
    endLine: 3,
    exported: true,
    calls,
  };
}

/**
 * Builds a type declaration.
 *
 * @param name - Type name.
 * @param namespace - Namespace.
 * @param extra - Bases and fields.
 * @returns The parsed type.
 */
function type(name: string, namespace: string, extra: Partial<ParsedType> = {}): ParsedType {
  return { name, namespace, bases: [], fields: {}, ...extra };
}

/**
 * Builds a file of a namespace-based language.
 *
 * @param filePath - Path.
 * @param namespace - Namespace.
 * @param parts - Imports, types and functions.
 * @returns The parsed file.
 */
function file(
  filePath: string,
  namespace: string,
  parts: { imports?: ParsedImport[]; types?: ParsedType[]; functions?: ParsedFunction[] },
): ParsedFile {
  return {
    filePath,
    namespace,
    imports: parts.imports ?? [],
    types: parts.types ?? [],
    functions: parts.functions ?? [],
    exports: [],
  };
}

/**
 * Call edges of a graph as `source -> target`.
 *
 * @param graph - Linked graph.
 * @returns Sorted edge descriptions.
 */
function callEdges(graph: GraphSnapshot): string[] {
  return graph.edges
    .filter((edge) => edge.kind === 'call')
    .map((edge) => `${edge.source} -> ${edge.target}`)
    .sort();
}

/**
 * Import edges of a graph as `source -> target`.
 *
 * @param graph - Linked graph.
 * @returns Sorted edge descriptions.
 */
function importEdges(graph: GraphSnapshot): string[] {
  return graph.edges
    .filter((edge) => edge.kind === 'import')
    .map((edge) => `${edge.source} -> ${edge.target}`)
    .sort();
}

const REPO = file('db/Repo.cls', 'app.db', {
  types: [type('Repo', 'app.db', { bases: ['BaseRepo'] })],
  functions: [method('Repo', 'save'), method('Repo', 'open')],
});

const BASE_REPO = file('db/BaseRepo.cls', 'app.db', {
  types: [type('BaseRepo', 'app.db')],
  functions: [method('BaseRepo', 'flush')],
});

const SERVICE = file('svc/Service.cls', 'app.svc', {
  imports: [
    {
      specifier: 'app.db.Repo',
      target: 'type',
      syntax: 'import',
      line: 1,
      bindings: [{ kind: 'named', importedName: 'Repo', localName: 'Repo' }],
    },
  ],
  types: [type('Service', 'app.svc', { fields: { repo: 'Repo' } })],
  functions: [
    method('Service', 'run', [
      { kind: 'member', receiver: 'r', receiverType: 'Repo', name: 'save', line: 5 },
      {
        kind: 'member',
        receiver: 'this.repo',
        receiverType: 'Service',
        receiverField: 'repo',
        name: 'flush',
        line: 6,
      },
      { kind: 'member', receiver: 'Repo', name: 'open', line: 7 },
      { kind: 'this-member', name: 'helper', line: 8 },
    ]),
    method('Service', 'helper'),
  ],
});

const HELPER = file('svc/Helper.cls', 'app.svc', {
  types: [type('Helper', 'app.svc')],
  functions: [
    method('Helper', 'go', [
      { kind: 'member', receiver: 's', receiverType: 'Service', name: 'run', line: 3 },
    ]),
  ],
});

describe('namespace-based resolution', () => {
  it('resolves calls by inferred type, field type, static type, inheritance and same namespace', () => {
    const graph = linkGraph([REPO, BASE_REPO, SERVICE, HELPER], 1, REGISTRY);
    expect(callEdges(graph)).toEqual([
      'svc/Helper.cls#Helper.go -> svc/Service.cls#Service.run',
      'svc/Service.cls#Service.run -> db/BaseRepo.cls#BaseRepo.flush',
      'svc/Service.cls#Service.run -> db/Repo.cls#Repo.open',
      'svc/Service.cls#Service.run -> db/Repo.cls#Repo.save',
      'svc/Service.cls#Service.run -> svc/Service.cls#Service.helper',
    ]);
    // Single-type imports draw an import edge; same-namespace use does not.
    expect(importEdges(graph)).toEqual(['svc/Service.cls -> db/Repo.cls']);
  });

  it('adds an import edge for namespace imports only when they are used', () => {
    const user = file('ui/View.cls', 'app.ui', {
      imports: [
        { specifier: 'app.db', target: 'namespace', syntax: 'import', line: 1, bindings: [] },
      ],
      types: [type('View', 'app.ui')],
      functions: [
        method('View', 'show', [{ kind: 'member', receiver: 'Repo', name: 'open', line: 4 }]),
      ],
    });
    const graph = linkGraph([REPO, BASE_REPO, user], 1, REGISTRY);
    expect(callEdges(graph)).toEqual(['ui/View.cls#View.show -> db/Repo.cls#Repo.open']);
    expect(importEdges(graph)).toEqual(['ui/View.cls -> db/Repo.cls']);
  });

  it('resolves package functions, imported packages and package-qualified types', () => {
    const db = file('internal/db/db.pkg', 'internal/db', {
      types: [type('Repo', 'internal/db')],
      functions: [
        { ...method('Repo', 'Save') },
        {
          name: 'Open',
          qualifiedName: 'Open',
          functionKind: 'function',
          line: 1,
          endLine: 2,
          exported: true,
          calls: [],
        },
      ],
    });
    const main = file('cmd/main.pkg', 'cmd', {
      imports: [
        {
          specifier: 'example.com/app/internal/db',
          target: 'package',
          syntax: 'import',
          line: 1,
          bindings: [{ kind: 'namespace', importedName: '*', localName: 'db' }],
        },
      ],
      functions: [
        {
          name: 'main',
          qualifiedName: 'main',
          functionKind: 'function',
          line: 3,
          endLine: 9,
          exported: false,
          calls: [
            { kind: 'member', receiver: 'db', name: 'Open', line: 4 },
            { kind: 'member', receiver: 'r', receiverType: 'db.Repo', name: 'Save', line: 5 },
            { kind: 'identifier', name: 'helper', line: 6 },
          ],
        },
      ],
    });
    const other = file('cmd/helper.pkg', 'cmd', {
      functions: [
        {
          name: 'helper',
          qualifiedName: 'helper',
          functionKind: 'function',
          line: 1,
          endLine: 2,
          exported: false,
          calls: [],
        },
      ],
    });
    const graph = linkGraph([db, main, other], 1, REGISTRY);
    expect(callEdges(graph)).toEqual([
      'cmd/main.pkg#main -> cmd/helper.pkg#helper',
      'cmd/main.pkg#main -> internal/db/db.pkg#Open',
      'cmd/main.pkg#main -> internal/db/db.pkg#Repo.Save',
    ]);
    expect(importEdges(graph)).toEqual(['cmd/main.pkg -> internal/db/db.pkg']);
  });

  it('keeps the incremental graph equal to a full link when types appear and disappear', () => {
    const linker = new IncrementalLinker(REGISTRY);
    linker.apply({ upserts: [SERVICE, HELPER], removals: [] });
    expect(callEdges(linker.snapshot(1))).toEqual(
      callEdges(linkGraph([SERVICE, HELPER], 1, REGISTRY)),
    );
    linker.apply({ upserts: [REPO, BASE_REPO], removals: [] });
    expect(callEdges(linker.snapshot(2))).toEqual(
      callEdges(linkGraph([REPO, BASE_REPO, SERVICE, HELPER], 2, REGISTRY)),
    );
    linker.apply({ upserts: [], removals: [BASE_REPO.filePath] });
    expect(callEdges(linker.snapshot(3))).toEqual(
      callEdges(linkGraph([REPO, SERVICE, HELPER], 3, REGISTRY)),
    );
    const renamed = { ...REPO, functions: [method('Repo', 'store'), method('Repo', 'open')] };
    linker.apply({ upserts: [renamed], removals: [] });
    expect(callEdges(linker.snapshot(4))).toEqual(
      callEdges(linkGraph([renamed, SERVICE, HELPER], 4, REGISTRY)),
    );
  });
});

describe('splitQualifiedName', () => {
  it('splits the last segment', () => {
    expect(splitQualifiedName('a.b.Repo')).toEqual({ namespace: 'a.b', name: 'Repo' });
    expect(splitQualifiedName('Repo')).toEqual({ namespace: '', name: 'Repo' });
  });
});
