/**
 * Keeps the workspace graph linked incrementally: a change re-indexes and
 * re-links only the files it can affect instead of the whole workspace.
 *
 * @remarks Edges are partitioned by the file that owns their source node
 * (import edges by the importer, call edges by the caller's file), so each
 * file has an independent "contribution" of nodes and edges that can be
 * recomputed and diffed on its own. The result is always identical to
 * {@link linkGraph} on the same files (verified by tests).
 */
import type { GraphEdge, GraphNode, GraphPatch, GraphSnapshot, RelPath } from '../../shared';
import { isStructurallyEqual } from './diff';
import type { FileIndex } from './linker';
import {
  addCallEdges,
  addImportEdges,
  createFileNode,
  createFunctionNode,
  indexFile,
} from './linker';
import type { LanguageRegistry } from './language';
import { LANGUAGES } from './languages';
import { SymbolTable, namespaceKey, namespaceSetKey, namespacesOf } from './symbols';
import type { ParsedFile } from './types';

/** Changes applied to the linker in one batch. */
export interface LinkChanges {
  /** Parser output of new or modified files. */
  readonly upserts: readonly ParsedFile[];
  /** Paths of deleted files (ignored if unknown or also upserted). */
  readonly removals: readonly RelPath[];
}

/** Graph changes produced by a batch: a {@link GraphPatch} without version. */
export type LinkDelta = Omit<GraphPatch, 'version'>;

/** Nodes and edges owned by one file. */
interface FileContribution {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/** Mutable accumulator of a {@link LinkDelta}. */
interface DeltaBuilder {
  readonly upsertNodes: GraphNode[];
  readonly removeNodeIds: string[];
  readonly upsertEdges: GraphEdge[];
  readonly removeEdgeIds: string[];
}

/** Contribution of a file that is not in the graph. */
const EMPTY_CONTRIBUTION: FileContribution = { nodes: [], edges: [] };

/**
 * Adds a value to the set stored under a key, creating the set if needed.
 *
 * @param map - Multimap to update.
 * @param key - Key of the set.
 * @param value - Value to add.
 */
function addToSet(map: Map<RelPath, Set<RelPath>>, key: RelPath, value: RelPath): void {
  const values = map.get(key);
  if (values === undefined) {
    map.set(key, new Set([value]));
  } else {
    values.add(value);
  }
}

/**
 * Removes a value from the set stored under a key, dropping empty sets.
 *
 * @param map - Multimap to update.
 * @param key - Key of the set.
 * @param value - Value to remove.
 */
function removeFromSet(map: Map<RelPath, Set<RelPath>>, key: RelPath, value: RelPath): void {
  const values = map.get(key);
  if (values?.delete(value) === true && values.size === 0) {
    map.delete(key);
  }
}

/**
 * Appends to a delta the changes between two versions of a file's contribution.
 *
 * @param previous - Contribution before the change.
 * @param next - Contribution after the change.
 * @param delta - Accumulator (mutated in place).
 */
function diffContribution(
  previous: FileContribution,
  next: FileContribution,
  delta: DeltaBuilder,
): void {
  diffElements(previous.nodes, next.nodes, delta.upsertNodes, delta.removeNodeIds);
  diffElements(previous.edges, next.edges, delta.upsertEdges, delta.removeEdgeIds);
}

/**
 * Compares two element lists by id and structural equality.
 *
 * @param previous - Old elements.
 * @param next - New elements.
 * @param upserts - Receives added or modified elements.
 * @param removedIds - Receives ids of removed elements.
 */
function diffElements<T extends { readonly id: string }>(
  previous: readonly T[],
  next: readonly T[],
  upserts: T[],
  removedIds: string[],
): void {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  for (const item of next) {
    const old = previousById.get(item.id);
    if (old === undefined || !isStructurallyEqual(old, item)) {
      upserts.push(item);
    }
    previousById.delete(item.id);
  }
  removedIds.push(...previousById.keys());
}

/**
 * Maintains the linked graph of a workspace across incremental changes.
 *
 * Which files are recomputed after a change:
 * - **re-indexed** (import resolution recomputed): changed files, plus files
 *   whose relative imports could point to a path that appeared or disappeared;
 * - **re-linked** (edges recomputed): re-indexed files, plus files that import
 *   bindings from a changed file (their call targets may have moved).
 */
export class IncrementalLinker {
  /**
   * Creates an empty linker.
   *
   * @param languages - Languages used to resolve imports.
   */
  public constructor(private readonly languages: LanguageRegistry = LANGUAGES) {}

  private readonly knownFiles = new Set<RelPath>();
  private readonly indexes = new Map<RelPath, FileIndex>();
  private readonly contributions = new Map<RelPath, FileContribution>();
  /** Importers by every path their relative imports could resolve to. */
  private readonly watchers = new Map<RelPath, Set<RelPath>>();
  /** Candidate paths watched by each importer. */
  private readonly watchedPaths = new Map<RelPath, readonly RelPath[]>();
  /** Files with import bindings into a file, by that file. */
  private readonly dependents = new Map<RelPath, Set<RelPath>>();
  /** Files each file imports bindings from. */
  private readonly dependencies = new Map<RelPath, readonly RelPath[]>();
  /** Namespaces and types of the namespace-based languages (Java, C#, Go). */
  private readonly symbols = new SymbolTable();
  /** Lazily assembled full graph; `null` after any change. */
  private assembled: Omit<GraphSnapshot, 'version'> | null = null;

  /** Number of files in the graph. */
  public get size(): number {
    return this.knownFiles.size;
  }

  /**
   * Checks whether a file is part of the graph.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns `true` if the file is linked.
   */
  public has(filePath: RelPath): boolean {
    return this.knownFiles.has(filePath);
  }

  /**
   * Lists the files of the graph.
   *
   * @returns Workspace-relative paths, in no particular order.
   */
  public getFilePaths(): RelPath[] {
    return [...this.knownFiles];
  }

  /** Removes every file. */
  public clear(): void {
    this.knownFiles.clear();
    this.indexes.clear();
    this.contributions.clear();
    this.watchers.clear();
    this.watchedPaths.clear();
    this.dependents.clear();
    this.dependencies.clear();
    this.symbols.clear();
    this.assembled = null;
  }

  /**
   * Applies a batch of changes and returns what changed in the graph.
   *
   * @param changes - Upserted and removed files.
   * @returns Added/modified and removed nodes and edges.
   */
  public apply(changes: LinkChanges): LinkDelta {
    const upserted = new Map(changes.upserts.map((file) => [file.filePath, file]));
    const removed = changes.removals.filter(
      (filePath) => this.knownFiles.has(filePath) && !upserted.has(filePath),
    );
    const added = [...upserted.keys()].filter((filePath) => !this.knownFiles.has(filePath));
    for (const filePath of added) {
      this.knownFiles.add(filePath);
    }
    for (const filePath of removed) {
      this.knownFiles.delete(filePath);
    }

    // Files whose import resolution may change.
    const reindex = new Set(upserted.keys());
    for (const key of this.updateSymbols(upserted, removed)) {
      for (const watcher of this.watchers.get(key) ?? []) {
        if (this.knownFiles.has(watcher)) {
          reindex.add(watcher);
        }
      }
    }
    for (const filePath of [...added, ...removed]) {
      for (const watcher of this.watchers.get(filePath) ?? []) {
        if (this.knownFiles.has(watcher)) {
          reindex.add(watcher);
        }
      }
    }

    const delta: DeltaBuilder = {
      upsertNodes: [],
      removeNodeIds: [],
      upsertEdges: [],
      removeEdgeIds: [],
    };
    for (const filePath of removed) {
      this.unregister(filePath);
      diffContribution(this.contributionOf(filePath), EMPTY_CONTRIBUTION, delta);
      this.contributions.delete(filePath);
      this.indexes.delete(filePath);
    }
    for (const filePath of reindex) {
      const parsed = upserted.get(filePath) ?? this.indexes.get(filePath)?.parsed;
      if (parsed === undefined) {
        continue;
      }
      this.unregister(filePath);
      const index = indexFile(parsed, this.knownFiles, this.languages, this.symbols);
      this.indexes.set(filePath, index);
      this.register(filePath, index);
    }

    // Files whose edges may change: re-indexed ones and importers of upserted files.
    const relink = new Set(reindex);
    for (const filePath of upserted.keys()) {
      for (const dependent of this.dependents.get(filePath) ?? []) {
        relink.add(dependent);
      }
    }
    for (const filePath of relink) {
      const index = this.indexes.get(filePath);
      if (index === undefined) {
        continue;
      }
      const previous = this.contributionOf(filePath);
      const next = this.buildContribution(index, reindex.has(filePath) ? null : previous);
      diffContribution(previous, next, delta);
      this.contributions.set(filePath, next);
    }

    this.assembled = null;
    return delta;
  }

  /**
   * Returns the full graph, identical to `linkGraph` on the same files.
   *
   * @param version - Version number assigned to the snapshot.
   * @returns The graph snapshot.
   */
  public snapshot(version: number): GraphSnapshot {
    if (this.assembled === null) {
      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      const filePaths = [...this.knownFiles].sort((a, b) => a.localeCompare(b));
      for (const filePath of filePaths) {
        const contribution = this.contributionOf(filePath);
        nodes.push(...contribution.nodes);
        edges.push(...contribution.edges);
      }
      this.assembled = { nodes, edges };
    }
    return { version, ...this.assembled };
  }

  /**
   * Returns the current contribution of a file.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns Its nodes and edges (empty if unknown).
   */
  private contributionOf(filePath: RelPath): FileContribution {
    return this.contributions.get(filePath) ?? EMPTY_CONTRIBUTION;
  }

  /**
   * Computes the nodes and edges owned by a file.
   *
   * @param index - Index of the file.
   * @param reuseNodesFrom - Previous contribution whose nodes are still valid
   *   (the file was not re-indexed), or `null` to rebuild them.
   * @returns The file's contribution.
   */
  private buildContribution(
    index: FileIndex,
    reuseNodesFrom: FileContribution | null,
  ): FileContribution {
    const nodes = reuseNodesFrom?.nodes ?? [
      createFileNode(index),
      ...index.functions.map((fn) => createFunctionNode(fn, index)),
    ];
    const edges = new Map<string, GraphEdge>();
    addImportEdges(index, edges);
    addCallEdges(index, this.indexes, edges);
    return { nodes, edges: [...edges.values()] };
  }

  /**
   * Updates the symbol table with removed and upserted files and lists the
   * symbol keys whose watchers must be re-indexed: the namespaces of those
   * files (before and after), plus the namespace set of a language when one
   * of its namespaces appeared or disappeared.
   *
   * @param upserted - New or changed files.
   * @param removed - Removed files.
   * @returns The changed symbol keys.
   */
  private updateSymbols(
    upserted: ReadonlyMap<RelPath, ParsedFile>,
    removed: readonly RelPath[],
  ): Set<string> {
    const changed = new Set<string>();
    /**
     * Records the keys of one file version and updates the table.
     *
     * @param file - File version.
     * @param add - Whether it is added (otherwise removed).
     */
    const apply = (file: ParsedFile, add: boolean): void => {
      const language = this.languages.forFile(file.filePath);
      if (language === undefined || file.namespace === undefined) {
        return;
      }
      for (const namespace of namespacesOf(file)) {
        changed.add(namespaceKey(language.id, namespace));
      }
      const setChanged = add
        ? this.symbols.add(language.id, file)
        : this.symbols.remove(language.id, file);
      if (setChanged) {
        changed.add(namespaceSetKey(language.id));
      }
    };
    for (const filePath of removed) {
      const previous = this.indexes.get(filePath)?.parsed;
      if (previous !== undefined) {
        apply(previous, false);
      }
    }
    for (const [filePath, file] of upserted) {
      const previous = this.indexes.get(filePath)?.parsed;
      if (previous !== undefined) {
        apply(previous, false);
      }
      apply(file, true);
    }
    return changed;
  }

  /**
   * Records which paths and symbol keys a file watches and which files it depends on.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @param index - Freshly built index of the file.
   */
  private register(filePath: RelPath, index: FileIndex): void {
    const candidates = index.parsed.imports.flatMap((parsedImport) =>
      this.languages.listImportCandidates(filePath, parsedImport.specifier),
    );
    // Namespace-based languages also watch the namespaces they look into.
    const uniqueCandidates = [...new Set([...candidates, ...(index.scope?.watchKeys ?? [])])];
    for (const candidate of uniqueCandidates) {
      addToSet(this.watchers, candidate, filePath);
    }
    this.watchedPaths.set(filePath, uniqueCandidates);

    const targets = [
      ...new Set([
        ...[...index.bindings.values()].map((binding) => binding.targetFile),
        ...(index.scope?.dependencies ?? []),
      ]),
    ];
    for (const target of targets) {
      addToSet(this.dependents, target, filePath);
    }
    this.dependencies.set(filePath, targets);
  }

  /**
   * Forgets the watched paths and dependencies of a file.
   *
   * @param filePath - Workspace-relative POSIX path.
   */
  private unregister(filePath: RelPath): void {
    for (const candidate of this.watchedPaths.get(filePath) ?? []) {
      removeFromSet(this.watchers, candidate, filePath);
    }
    this.watchedPaths.delete(filePath);
    for (const target of this.dependencies.get(filePath) ?? []) {
      removeFromSet(this.dependents, target, filePath);
    }
    this.dependencies.delete(filePath);
  }
}
