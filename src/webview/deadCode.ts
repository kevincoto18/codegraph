/**
 * Finds code that nothing in the graph uses: functions never called and
 * files nothing imports or calls into. Static analysis cannot see dynamic
 * calls, frameworks or entry points, so likely entry points are left out and
 * the result is a list of candidates, not a verdict. Pure, so it is unit-tested.
 */
import type { FileGraphNode, FunctionGraphNode, GraphSnapshot } from '../shared';
import { isTestFile } from './nodeFilters';

/** Functions and files that nothing in the graph uses. */
export interface UnusedCode {
  /** Functions never called (likely entry points excluded). */
  readonly functions: readonly FunctionGraphNode[];
  /** Files nothing imports and no other file calls into. */
  readonly files: readonly FileGraphNode[];
  /** Ids of both, for highlighting. */
  readonly ids: ReadonlySet<string>;
}

/** Function names called by runtimes and frameworks, not by the code itself. */
const ENTRY_FUNCTION_NAMES = new Set([
  'main',
  'Main',
  'init',
  'constructor',
  'render',
  'setup',
  'teardown',
  'toString',
  'ToString',
  'equals',
  'Equals',
  'hashCode',
  'GetHashCode',
  'compareTo',
  'CompareTo',
  'Dispose',
  'String',
  'Error',
  'ServeHTTP',
]);

/** File names (without extension) that start a program rather than being used by one. */
const ENTRY_FILE_NAMES = new Set([
  'index',
  'main',
  'app',
  'App',
  'server',
  'Program',
  'Startup',
  'cli',
  'manage',
  'setup',
  'conftest',
  '__init__',
  '__main__',
  'wsgi',
  'asgi',
]);

/**
 * Returns the last segment of a qualified name (`UserService.save` → `save`).
 *
 * @param qualifiedName - Function name with its class.
 * @returns The simple name.
 */
function simpleName(qualifiedName: string): string {
  return qualifiedName.slice(qualifiedName.lastIndexOf('.') + 1);
}

/**
 * Tells whether a function is probably called by a runtime, a framework or a
 * test runner rather than by the code (`main`, Python `__dunder__`, Go
 * `TestX`, React components used from JSX…).
 *
 * @param fn - Function.
 * @returns `true` for likely entry points.
 */
function isLikelyEntryFunction(fn: FunctionGraphNode): boolean {
  const name = simpleName(fn.qualifiedName);
  return (
    ENTRY_FUNCTION_NAMES.has(name) ||
    /^__\w+__$/.test(name) ||
    /^(Test|Benchmark|Example|Fuzz)[A-Z_]/.test(name) ||
    (/\.[jt]sx$/.test(fn.filePath) && /^[A-Z]/.test(name)) ||
    isTestFile(fn.filePath)
  );
}

/**
 * Tells whether a file probably starts a program or is loaded by a tool.
 *
 * @param file - File.
 * @returns `true` for likely entry files.
 */
function isLikelyEntryFile(file: FileGraphNode): boolean {
  const fileName = file.filePath.slice(file.filePath.lastIndexOf('/') + 1);
  const baseName = fileName.replace(/\.[^.]+$/, '');
  return (
    ENTRY_FILE_NAMES.has(baseName) ||
    /\.(config|setup)\.[cm]?[jt]s$/.test(fileName) ||
    isTestFile(file.filePath)
  );
}

/**
 * Finds the functions and files that nothing in the graph uses.
 *
 * A method whose name is called on another type is kept: it may run through
 * an interface or a base class (`repo.save()` resolved to `Repository.save`).
 *
 * @param snapshot - Graph.
 * @returns The unused functions and files.
 */
export function findUnusedCode(snapshot: GraphSnapshot): UnusedCode {
  const fileOf = new Map<string, string>();
  for (const node of snapshot.nodes) {
    fileOf.set(node.id, node.kind === 'function' ? node.fileId : node.id);
  }
  const functionsById = new Map(
    snapshot.nodes
      .filter((node): node is FunctionGraphNode => node.kind === 'function')
      .map((fn) => [fn.id, fn]),
  );
  const called = new Set<string>();
  const calledMethodNames = new Set<string>();
  const usedFromOutside = new Set<string>();
  for (const edge of snapshot.edges) {
    const sourceFile = fileOf.get(edge.source);
    const targetFile = fileOf.get(edge.target);
    if (edge.kind === 'call' && edge.source !== edge.target) {
      called.add(edge.target);
      const target = functionsById.get(edge.target);
      if (target?.qualifiedName.includes('.') === true) {
        calledMethodNames.add(simpleName(target.qualifiedName));
      }
    }
    if (targetFile !== undefined && sourceFile !== targetFile) {
      usedFromOutside.add(targetFile);
    }
  }

  const functions = [...functionsById.values()].filter(
    (fn) =>
      !called.has(fn.id) &&
      !isLikelyEntryFunction(fn) &&
      !(fn.qualifiedName.includes('.') && calledMethodNames.has(simpleName(fn.qualifiedName))),
  );
  const files = snapshot.nodes.filter(
    (node): node is FileGraphNode =>
      node.kind === 'file' && !usedFromOutside.has(node.id) && !isLikelyEntryFile(node),
  );
  return {
    functions,
    files,
    ids: new Set([...functions.map((fn) => fn.id), ...files.map((file) => file.id)]),
  };
}
