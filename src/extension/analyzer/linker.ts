/**
 * Turns the per-file parser output of a whole workspace into a graph:
 * file and function nodes, import edges between files and call edges
 * between functions.
 *
 * @remarks Pure and deterministic: the same input always produces the same
 * snapshot (files are processed in path order), which keeps diffs minimal.
 * `linkGraph` rebuilds everything and is the reference implementation;
 * `IncrementalLinker` reuses the helpers exported here to update only the
 * files affected by a change.
 */
import { posix } from 'node:path';

import type {
  FileGraphNode,
  FunctionGraphNode,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  RelPath,
} from '../../shared';
import { createEdgeId, createFileId, createFunctionId } from '../../shared';
import type { LanguageRegistry } from './language';
import { LANGUAGES } from './languages';
import type { SymbolScope } from './scope';
import { buildSymbolScope, receiverTypeFiles, resolveScopedCall } from './scope';
import { SymbolTable } from './symbols';
import { PythonResolver } from './pythonResolver';
import type { ImportBinding, ImportSyntax, ParsedCall, ParsedFile, ParsedFunction } from './types';

/** Export name used for default exports. */
const DEFAULT_EXPORT_NAME = 'default';

/** A local import binding whose module resolved to a workspace file. */
interface ResolvedBinding {
  readonly binding: ImportBinding;
  readonly syntax: ImportSyntax;
  readonly targetFile: RelPath;
}

/** A parsed function together with its graph id. */
export interface IndexedFunction {
  readonly id: string;
  readonly parsed: ParsedFunction;
}

/** Lookup tables for one file, built once and shared by every resolution step. */
export interface FileIndex {
  readonly parsed: ParsedFile;
  readonly fileId: string;
  readonly functions: readonly IndexedFunction[];
  /** Top-level (non-method) functions by name; first declaration wins. */
  readonly functionsByName: ReadonlyMap<string, string>;
  /** Methods by class name, then by method name. */
  readonly methodsByClass: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Local declaration name by exported name. */
  readonly exports: ReadonlyMap<string, string>;
  /** Resolved import bindings by local name. */
  readonly bindings: ReadonlyMap<string, ResolvedBinding>;
  /** Resolved imports as `[targetFile, line]`, in source order. */
  readonly resolvedImports: readonly (readonly [RelPath, number])[];
  /** Files of the `from m import *` statements (Python). */
  readonly starImports: readonly RelPath[];
  /** Namespace-based visibility (Java, C#, Go); `null` for path-based languages. */
  readonly scope: SymbolScope | null;
}

/** Indexes of every file in the workspace, by path. */
export type WorkspaceIndex = ReadonlyMap<RelPath, FileIndex>;

/**
 * Builds the complete graph of a workspace.
 *
 * @param parsedFiles - Parser output of every analyzable file.
 * @param version - Version number assigned to the snapshot.
 * @param languages - Languages used to resolve imports.
 * @returns The graph snapshot.
 */
export function linkGraph(
  parsedFiles: Iterable<ParsedFile>,
  version: number,
  languages: LanguageRegistry = LANGUAGES,
): GraphSnapshot {
  const sortedFiles = [...parsedFiles].sort((a, b) => a.filePath.localeCompare(b.filePath));
  const knownFiles = new Set(sortedFiles.map((file) => file.filePath));
  const symbols = buildSymbolTable(sortedFiles, languages);
  const workspace: WorkspaceIndex = new Map(
    sortedFiles.map((file) => [file.filePath, indexFile(file, knownFiles, languages, symbols)]),
  );

  const nodes: GraphNode[] = [];
  const edges = new Map<string, GraphEdge>();
  for (const fileIndex of workspace.values()) {
    nodes.push(
      createFileNode(fileIndex),
      ...fileIndex.functions.map((fn) => createFunctionNode(fn, fileIndex)),
    );
    addImportEdges(fileIndex, edges);
    addCallEdges(fileIndex, workspace, edges);
  }

  return { version, nodes, edges: [...edges.values()] };
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/**
 * Builds the lookup tables of one file.
 *
 * @param parsed - Parser output of the file.
 * @param knownFiles - Paths of every analyzable file (for import resolution).
 * @param languages - Languages used to resolve imports.
 * @param symbols - Namespaces and types of the workspace (namespace-based languages).
 * @returns The file index.
 */
export function indexFile(
  parsed: ParsedFile,
  knownFiles: ReadonlySet<RelPath>,
  languages: LanguageRegistry = LANGUAGES,
  symbols: SymbolTable = new SymbolTable(),
): FileIndex {
  const functions = assignFunctionIds(parsed);
  const functionsByName = new Map<string, string>();
  const methodsByClass = new Map<string, Map<string, string>>();

  for (const { id, parsed: fn } of functions) {
    if (fn.className === undefined) {
      if (!functionsByName.has(fn.name)) {
        functionsByName.set(fn.name, id);
      }
      continue;
    }
    const methods = methodsByClass.get(fn.className) ?? new Map<string, string>();
    if (!methods.has(fn.name)) {
      methods.set(fn.name, id);
    }
    methodsByClass.set(fn.className, methods);
  }

  const { bindings, resolvedImports, starImports } = resolveFileImports(
    parsed,
    knownFiles,
    languages,
  );
  const scope = buildSymbolScope(parsed, languages.forFile(parsed.filePath), symbols);

  return {
    parsed,
    fileId: createFileId(parsed.filePath),
    functions,
    functionsByName,
    methodsByClass,
    exports: new Map(parsed.exports.map((entry) => [entry.exportedName, entry.localName])),
    bindings,
    resolvedImports: scope === null ? resolvedImports : [...resolvedImports, ...scope.typeImports],
    starImports,
    scope,
  };
}

/**
 * Builds the symbol table of a set of files.
 *
 * @param files - Parsed files.
 * @param languages - Languages of the files.
 * @returns Namespaces and types of the namespace-based languages.
 */
export function buildSymbolTable(
  files: Iterable<ParsedFile>,
  languages: LanguageRegistry = LANGUAGES,
): SymbolTable {
  const symbols = new SymbolTable();
  for (const file of files) {
    const language = languages.forFile(file.filePath);
    if (language !== undefined && file.namespace !== undefined) {
      symbols.add(language.id, file);
    }
  }
  return symbols;
}

/**
 * Assigns a stable id to every function of a file, disambiguating repeated
 * qualified names with an occurrence index.
 *
 * @param parsed - Parser output of the file.
 * @returns Functions paired with their ids, in source order.
 */
function assignFunctionIds(parsed: ParsedFile): IndexedFunction[] {
  const occurrences = new Map<string, number>();
  return parsed.functions.map((fn) => {
    const occurrence = (occurrences.get(fn.qualifiedName) ?? 0) + 1;
    occurrences.set(fn.qualifiedName, occurrence);
    return { id: createFunctionId(parsed.filePath, fn.qualifiedName, occurrence), parsed: fn };
  });
}

/**
 * Resolves the imports of a file against the workspace.
 *
 * @param parsed - Parser output of the file.
 * @param knownFiles - Paths of every analyzable file.
 * @param languages - Languages used to resolve imports.
 * @returns Resolved bindings by local name and resolved import targets.
 */
function resolveFileImports(
  parsed: ParsedFile,
  knownFiles: ReadonlySet<RelPath>,
  languages: LanguageRegistry,
): Pick<FileIndex, 'bindings' | 'resolvedImports' | 'starImports'> {
  const bindings = new Map<string, ResolvedBinding>();
  const resolvedImports: (readonly [RelPath, number])[] = [];
  const starImports: RelPath[] = [];
  const targets = parsed.imports.map((parsedImport) =>
    (parsedImport.target ?? 'module') === 'module' // Others are resolved by name (scope.ts).
      ? languages.resolveImport(parsed.filePath, parsedImport.specifier, knownFiles)
      : null,
  );
  // Names bound to a submodule (`from pkg import mod`), by statement line.
  const submoduleNames = new Set<string>();
  parsed.imports.forEach((parsedImport, index) => {
    if (targets[index] !== null && parsedImport.lookupOnly !== true) {
      for (const binding of parsedImport.bindings) {
        submoduleNames.add(`${String(parsedImport.line)}:${binding.localName}`);
      }
    }
  });

  parsed.imports.forEach((parsedImport, index) => {
    const targetFile = targets[index];
    if (targetFile === null || targetFile === undefined) {
      return;
    }
    // `from pkg import mod` only looks into the package to find the submodule.
    const onlySubmodules =
      parsedImport.lookupOnly === true &&
      parsedImport.bindings.every((binding) =>
        submoduleNames.has(`${String(parsedImport.line)}:${binding.localName}`),
      );
    if (!onlySubmodules) {
      resolvedImports.push([targetFile, parsedImport.line]);
    }
    if (parsedImport.star === true) {
      starImports.push(targetFile);
    }
    for (const binding of parsedImport.bindings) {
      bindings.set(binding.localName, { binding, syntax: parsedImport.syntax, targetFile });
    }
  });
  return { bindings, resolvedImports, starImports };
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/**
 * Creates the graph node of a file.
 *
 * @param fileIndex - Index of the file.
 * @returns The file node.
 */
export function createFileNode(fileIndex: FileIndex): FileGraphNode {
  return {
    id: fileIndex.fileId,
    kind: 'file',
    label: posix.basename(fileIndex.parsed.filePath),
    filePath: fileIndex.parsed.filePath,
    line: 1,
    functionIds: fileIndex.functions.map((fn) => fn.id),
  };
}

/**
 * Creates the graph node of a function.
 *
 * @param fn - Function with its id.
 * @param fileIndex - Index of the containing file.
 * @returns The function node.
 */
export function createFunctionNode(fn: IndexedFunction, fileIndex: FileIndex): FunctionGraphNode {
  return {
    id: fn.id,
    kind: 'function',
    label: fn.parsed.qualifiedName,
    filePath: fileIndex.parsed.filePath,
    line: fn.parsed.line,
    fileId: fileIndex.fileId,
    qualifiedName: fn.parsed.qualifiedName,
    functionKind: fn.parsed.functionKind,
    endLine: fn.parsed.endLine,
    exported: fn.parsed.exported,
  };
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/**
 * Adds one import edge per distinct imported workspace file.
 *
 * @param fileIndex - Index of the importing file.
 * @param edges - Edge accumulator keyed by id (mutated in place).
 */
export function addImportEdges(fileIndex: FileIndex, edges: Map<string, GraphEdge>): void {
  for (const [targetFile, line] of fileIndex.resolvedImports) {
    const target = createFileId(targetFile);
    if (target !== fileIndex.fileId) {
      addEdge(edges, { kind: 'import', source: fileIndex.fileId, target, line });
    }
  }
}

/**
 * Adds one call edge per distinct resolved caller → callee pair.
 *
 * @param fileIndex - Index of the file whose functions are callers.
 * @param workspace - Indexes of every file.
 * @param edges - Edge accumulator keyed by id (mutated in place).
 * @param consulted - Filled with the files looked into while resolving
 *   Python calls with types (other than the file's imports).
 */
export function addCallEdges(
  fileIndex: FileIndex,
  workspace: WorkspaceIndex,
  edges: Map<string, GraphEdge>,
  consulted?: Set<RelPath>,
): void {
  if (fileIndex.parsed.python !== undefined) {
    new PythonResolver(workspace, consulted).addCallEdges(fileIndex, edges);
    return;
  }
  for (const fn of fileIndex.functions) {
    for (const call of fn.parsed.calls) {
      if (fileIndex.scope !== null) {
        addScopedCallEdge(call, fn, fileIndex, workspace, edges);
        continue;
      }
      const target = resolveCall(call, fn.parsed, fileIndex, workspace);
      if (target !== null && target !== fn.id) {
        addEdge(edges, { kind: 'call', source: fn.id, target, line: call.line });
      }
    }
  }
}

/**
 * Adds the edge of a call of a namespace-based language and, when the callee
 * is reached through a namespace or package import, the import edge too.
 *
 * @param call - Parsed call.
 * @param caller - Calling function.
 * @param fileIndex - File of the caller.
 * @param workspace - Indexes of every file.
 * @param edges - Edge accumulator (mutated in place).
 */
function addScopedCallEdge(
  call: ParsedCall,
  caller: IndexedFunction,
  fileIndex: FileIndex,
  workspace: WorkspaceIndex,
  edges: Map<string, GraphEdge>,
): void {
  const target = resolveScopedCall(call, caller.parsed, fileIndex, workspace);
  if (target !== null && target.id !== caller.id) {
    addEdge(edges, { kind: 'call', source: caller.id, target: target.id, line: call.line });
  }
  // A type used through a namespace import (also `new Repo()` without a constructor).
  const usedFiles = target === null ? receiverTypeFiles(call, fileIndex) : [target.file];
  for (const file of usedFiles) {
    const importLine = fileIndex.scope?.importedFiles.get(file);
    if (importLine !== undefined && file !== fileIndex.parsed.filePath) {
      addEdge(edges, {
        kind: 'import',
        source: fileIndex.fileId,
        target: createFileId(file),
        line: importLine,
      });
    }
  }
}

/**
 * Inserts an edge unless one with the same id already exists, so the first
 * occurrence (lowest line) is kept.
 *
 * @param edges - Edge accumulator keyed by id (mutated in place).
 * @param edge - Edge without id.
 */
function addEdge(edges: Map<string, GraphEdge>, edge: Omit<GraphEdge, 'id'>): void {
  const id = createEdgeId(edge.kind, edge.source, edge.target);
  if (!edges.has(id)) {
    edges.set(id, { id, ...edge });
  }
}

// ---------------------------------------------------------------------------
// Call resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a call site to the id of the called function.
 *
 * @param call - Call site.
 * @param caller - Function that contains the call.
 * @param fileIndex - Index of the caller's file.
 * @param workspace - Indexes of every file.
 * @returns The callee's function id, or `null` if it cannot be determined.
 */
function resolveCall(
  call: ParsedCall,
  caller: ParsedFunction,
  fileIndex: FileIndex,
  workspace: WorkspaceIndex,
): string | null {
  switch (call.kind) {
    case 'this-member':
      return caller.className === undefined
        ? null
        : (fileIndex.methodsByClass.get(caller.className)?.get(call.name) ?? null);
    case 'identifier':
      return resolveIdentifierCall(call.name, fileIndex, workspace);
    case 'member':
      return call.receiver === undefined
        ? null
        : resolveMemberCall(call.receiver, call.name, fileIndex, workspace);
  }
}

/**
 * Resolves `name()`: a local top-level function or an imported function.
 *
 * @param name - Called identifier.
 * @param fileIndex - Index of the caller's file.
 * @param workspace - Indexes of every file.
 * @returns The callee's function id, or `null`.
 */
function resolveIdentifierCall(
  name: string,
  fileIndex: FileIndex,
  workspace: WorkspaceIndex,
): string | null {
  const local = fileIndex.functionsByName.get(name);
  if (local !== undefined) {
    return local;
  }
  const resolved = fileIndex.bindings.get(name);
  if (resolved === undefined) {
    return null;
  }
  const target = workspace.get(resolved.targetFile);
  if (target === undefined) {
    return null;
  }
  switch (resolved.binding.kind) {
    case 'named':
    case 'default':
      return resolveExportedFunction(target, resolved.binding.importedName);
    case 'namespace':
      // Calling a whole module is only valid for CommonJS (`module.exports = fn`).
      return resolved.syntax === 'require'
        ? resolveExportedFunction(target, DEFAULT_EXPORT_NAME)
        : null;
  }
}

/**
 * Resolves `receiver.name()`: a static method of a local or imported class,
 * or a function exported by a namespace-imported module.
 *
 * @param receiver - Receiver identifier.
 * @param name - Called member name.
 * @param fileIndex - Index of the caller's file.
 * @param workspace - Indexes of every file.
 * @returns The callee's function id, or `null`.
 */
function resolveMemberCall(
  receiver: string,
  name: string,
  fileIndex: FileIndex,
  workspace: WorkspaceIndex,
): string | null {
  const localMethod = fileIndex.methodsByClass.get(receiver)?.get(name);
  if (localMethod !== undefined) {
    return localMethod;
  }
  const resolved = fileIndex.bindings.get(receiver);
  if (resolved === undefined) {
    return null;
  }
  const target = workspace.get(resolved.targetFile);
  if (target === undefined) {
    return null;
  }
  if (resolved.binding.kind === 'namespace') {
    return resolveExportedFunction(target, name);
  }
  const className = target.exports.get(resolved.binding.importedName);
  return className === undefined ? null : (target.methodsByClass.get(className)?.get(name) ?? null);
}

/**
 * Finds the top-level function backing an export of a file.
 *
 * @param target - Index of the exporting file.
 * @param exportedName - Name under which the function is exported.
 * @returns The function id, or `null` if the export is missing or not a function.
 */
function resolveExportedFunction(target: FileIndex, exportedName: string): string | null {
  const localName = target.exports.get(exportedName);
  return localName === undefined ? null : (target.functionsByName.get(localName) ?? null);
}
