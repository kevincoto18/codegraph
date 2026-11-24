/**
 * Workspace-wide index of namespaces and types, for languages whose imports
 * and calls are resolved by name rather than by file path (Java, C#, Go).
 */
import type { RelPath } from '../../shared';
import type { ParsedFile } from './types';

/** Separator of the parts of a symbol key (cannot appear in names or paths). */
const KEY_SEPARATOR = '\u0000';

/**
 * Builds the key of a namespace of a language.
 *
 * @param language - Language id.
 * @param namespace - Namespace, package or package directory.
 * @returns The key, also used to watch the namespace for changes.
 */
export function namespaceKey(language: string, namespace: string): string {
  return `ns${KEY_SEPARATOR}${language}${KEY_SEPARATOR}${namespace}`;
}

/**
 * Builds the key that changes whenever a namespace of a language appears or
 * disappears (Go package imports depend on the set of package folders).
 *
 * @param language - Language id.
 * @returns The key.
 */
export function namespaceSetKey(language: string): string {
  return `ns-set${KEY_SEPARATOR}${language}`;
}

/**
 * Lists the namespaces a file contributes to: its own and those of its types.
 *
 * @param file - Parsed file.
 * @returns Distinct namespaces.
 */
export function namespacesOf(file: ParsedFile): string[] {
  const namespaces = new Set<string>();
  if (file.namespace !== undefined) {
    namespaces.add(file.namespace);
  }
  for (const type of file.types ?? []) {
    namespaces.add(type.namespace);
  }
  return [...namespaces];
}

/**
 * Adds a value to the set stored under a key.
 *
 * @param map - Multimap.
 * @param key - Key.
 * @param value - Value to add.
 */
function addTo(map: Map<string, Set<RelPath>>, key: string, value: RelPath): void {
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
 * @param map - Multimap.
 * @param key - Key.
 * @param value - Value to remove.
 * @returns `true` when the key no longer has values.
 */
function removeFrom(map: Map<string, Set<RelPath>>, key: string, value: RelPath): boolean {
  const values = map.get(key);
  if (values === undefined) {
    return false;
  }
  values.delete(value);
  if (values.size === 0) {
    map.delete(key);
    return true;
  }
  return false;
}

/** Empty result shared by lookups. */
const NO_FILES: readonly RelPath[] = [];

/**
 * Namespaces and types declared by the files of the workspace, by language.
 * Files are added and removed as they are parsed, so the table can be kept
 * up to date incrementally.
 */
export class SymbolTable {
  private readonly namespaceFiles = new Map<string, Set<RelPath>>();
  /** Namespace key → type name → declaring files. */
  private readonly typeFiles = new Map<string, Map<string, Set<RelPath>>>();
  private readonly namespacesByLanguage = new Map<string, Map<string, number>>();

  /**
   * Records the namespaces and types of a file.
   *
   * @param language - Language id of the file.
   * @param file - Parsed file.
   * @returns Whether a namespace of the language appeared.
   */
  public add(language: string, file: ParsedFile): boolean {
    let appeared = false;
    for (const namespace of namespacesOf(file)) {
      addTo(this.namespaceFiles, namespaceKey(language, namespace), file.filePath);
      appeared = this.countNamespace(language, namespace, 1) || appeared;
    }
    for (const type of file.types ?? []) {
      const key = namespaceKey(language, type.namespace);
      let types = this.typeFiles.get(key);
      if (types === undefined) {
        types = new Map();
        this.typeFiles.set(key, types);
      }
      addTo(types, type.name, file.filePath);
    }
    return appeared;
  }

  /**
   * Forgets the namespaces and types of a file.
   *
   * @param language - Language id of the file.
   * @param file - Parsed file, as it was added.
   * @returns Whether a namespace of the language disappeared.
   */
  public remove(language: string, file: ParsedFile): boolean {
    let disappeared = false;
    for (const namespace of namespacesOf(file)) {
      removeFrom(this.namespaceFiles, namespaceKey(language, namespace), file.filePath);
      disappeared = this.countNamespace(language, namespace, -1) || disappeared;
    }
    for (const type of file.types ?? []) {
      const key = namespaceKey(language, type.namespace);
      const types = this.typeFiles.get(key);
      if (types !== undefined) {
        removeFrom(types, type.name, file.filePath);
        if (types.size === 0) {
          this.typeFiles.delete(key);
        }
      }
    }
    return disappeared;
  }

  /**
   * Files that declare a namespace (or declare types in it).
   *
   * @param language - Language id.
   * @param namespace - Namespace.
   * @returns The files, in insertion order.
   */
  public filesInNamespace(language: string, namespace: string): readonly RelPath[] {
    const files = this.namespaceFiles.get(namespaceKey(language, namespace));
    return files === undefined ? NO_FILES : [...files];
  }

  /**
   * Files that declare a type (several for C# partial classes).
   *
   * @param language - Language id.
   * @param namespace - Namespace of the type.
   * @param name - Simple type name.
   * @returns The files.
   */
  public filesDeclaringType(language: string, namespace: string, name: string): readonly RelPath[] {
    const files = this.typeFiles.get(namespaceKey(language, namespace))?.get(name);
    return files === undefined ? NO_FILES : [...files];
  }

  /**
   * Types declared in a namespace, with their files.
   *
   * @param language - Language id.
   * @param namespace - Namespace.
   * @returns Type name → declaring files.
   */
  public typesInNamespace(
    language: string,
    namespace: string,
  ): ReadonlyMap<string, readonly RelPath[]> {
    const types = this.typeFiles.get(namespaceKey(language, namespace));
    return new Map([...(types ?? [])].map(([name, files]) => [name, [...files]]));
  }

  /**
   * Every namespace of a language.
   *
   * @param language - Language id.
   * @returns The namespaces.
   */
  public namespaces(language: string): ReadonlySet<string> {
    return new Set(this.namespacesByLanguage.get(language)?.keys() ?? []);
  }

  /** Forgets everything. */
  public clear(): void {
    this.namespaceFiles.clear();
    this.typeFiles.clear();
    this.namespacesByLanguage.clear();
  }

  /**
   * Counts how many files contribute to a namespace.
   *
   * @param language - Language id.
   * @param namespace - Namespace.
   * @param delta - `1` when a file is added, `-1` when removed.
   * @returns Whether the namespace appeared or disappeared.
   */
  private countNamespace(language: string, namespace: string, delta: 1 | -1): boolean {
    let counts = this.namespacesByLanguage.get(language);
    if (counts === undefined) {
      counts = new Map();
      this.namespacesByLanguage.set(language, counts);
    }
    const count = (counts.get(namespace) ?? 0) + delta;
    if (count <= 0) {
      counts.delete(namespace);
      return true;
    }
    counts.set(namespace, count);
    return count === 1;
  }
}
