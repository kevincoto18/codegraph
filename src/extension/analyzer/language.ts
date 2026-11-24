/**
 * Language-neutral contract of the analyzer: what a language must provide to
 * appear in the graph, and the registry that dispatches files to languages.
 *
 * @remarks Everything downstream (linker, cache, workers, webview) only sees
 * the neutral {@link ParsedFile} model, so adding a language means adding a
 * {@link LanguageAnalyzer}, never changing those layers.
 */
import type { RelPath } from '../../shared';
import type { ParsedFile } from './types';

/** Directory names that are never analyzed, at any depth and for any language. */
export const EXCLUDED_DIRECTORIES: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  'site-packages',
  'vendor',
  'target',
  'obj',
  '.gradle',
];

/**
 * Cheap description of a language: which files it handles and how its
 * imports map to workspace files. Contains no parser, so it can be loaded
 * when the extension activates.
 */
export interface LanguageDefinition {
  /** Stable identifier, e.g. `typescript`. */
  readonly id: string;
  /** Human-readable name, e.g. `TypeScript / JavaScript`. */
  readonly displayName: string;
  /** File extensions with the leading dot, e.g. `.ts`. */
  readonly extensions: readonly string[];
  /**
   * Version of the parser output. Bump it whenever parsing results change, so
   * persisted caches are discarded.
   */
  readonly version: number;
  /**
   * Optionally excludes files that have a supported extension but nothing to
   * analyze (e.g. TypeScript declaration files).
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns `true` to skip the file.
   */
  isExcluded?(filePath: RelPath): boolean;
  /**
   * Lists, in priority order, the workspace paths an import could refer to.
   *
   * @param fromFile - Workspace-relative POSIX path of the importing file.
   * @param specifier - Module specifier as written in the import.
   * @returns Candidate paths (empty for external packages).
   */
  listImportCandidates(fromFile: RelPath, specifier: string): RelPath[];
  /**
   * Finds the workspace package an import path refers to, for `package`
   * imports (Go: `"example.com/app/internal/db"` → the `internal/db` folder).
   *
   * @param specifier - Import path as written.
   * @param packages - Package directories present in the workspace.
   * @returns The package directory, or `null` for external packages.
   */
  resolvePackage?(specifier: string, packages: ReadonlySet<string>): string | null;
  /**
   * Whether code in a namespace also sees the types of its parent namespaces
   * (C#: `A.B.C` sees `A.B` and `A`).
   */
  readonly namespacesSeeParents?: boolean;
}

/** A language definition plus its parser. */
export interface LanguageAnalyzer extends LanguageDefinition {
  /**
   * Optionally loads what `parse` needs (e.g. a Tree-sitter grammar). Called
   * once before the first file of the language is parsed; must be idempotent.
   *
   * @returns Resolves when `parse` can be called.
   */
  prepare?(): Promise<void>;
  /**
   * Parses one file into the neutral model.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @param content - File text.
   * @returns Imports, functions, calls and exports of the file. Must not throw
   *   on syntax errors: return whatever could be parsed.
   */
  parse(filePath: RelPath, content: string): ParsedFile;
}

/**
 * Returns the extension of a path, with the leading dot.
 *
 * @param filePath - Workspace-relative POSIX path.
 * @returns The extension (e.g. `.tsx`), or `''` if the file name has none.
 */
function extensionOf(filePath: RelPath): string {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot);
}

/** Set of languages, indexed by file extension. */
export class LanguageRegistry<T extends LanguageDefinition = LanguageDefinition> {
  private readonly byExtension = new Map<string, T>();

  /**
   * Creates the registry.
   *
   * @param languages - Languages to register.
   * @throws Error if two languages claim the same extension.
   */
  public constructor(public readonly languages: readonly T[]) {
    for (const language of languages) {
      for (const extension of language.extensions) {
        const existing = this.byExtension.get(extension);
        if (existing !== undefined) {
          throw new Error(
            `Extension "${extension}" is claimed by both "${existing.id}" and "${language.id}".`,
          );
        }
        this.byExtension.set(extension, language);
      }
    }
  }

  /** Every supported extension, with the leading dot. */
  public get extensions(): string[] {
    return [...this.byExtension.keys()];
  }

  /** Glob matching every candidate source file (for `workspace.findFiles`). */
  public get sourceGlob(): string {
    return `**/*.{${this.extensions.map((extension) => extension.slice(1)).join(',')}}`;
  }

  /**
   * Compatibility key of the parser outputs of every language, e.g.
   * `typescript1`; it changes whenever a language changes its output.
   */
  public get versionKey(): string {
    return this.languages.map((language) => `${language.id}${String(language.version)}`).join('+');
  }

  /**
   * Finds the language of a file.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns The language, or `undefined` if no language handles the extension.
   */
  public forFile(filePath: RelPath): T | undefined {
    return this.byExtension.get(extensionOf(filePath));
  }

  /**
   * Decides whether a workspace-relative path should be analyzed.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @returns `true` if a language handles the file, does not exclude it, and
   *   it does not live inside an excluded directory.
   */
  public isAnalyzableFile(filePath: RelPath): boolean {
    const language = this.forFile(filePath);
    if (language === undefined || language.isExcluded?.(filePath) === true) {
      return false;
    }
    return !filePath.split('/').some((segment) => EXCLUDED_DIRECTORIES.includes(segment));
  }

  /**
   * Lists the workspace paths an import could refer to, using the rules of
   * the importing file's language.
   *
   * @param fromFile - Workspace-relative POSIX path of the importing file.
   * @param specifier - Module specifier as written in the import.
   * @returns Candidate paths, in priority order.
   */
  public listImportCandidates(fromFile: RelPath, specifier: string): RelPath[] {
    return this.forFile(fromFile)?.listImportCandidates(fromFile, specifier) ?? [];
  }

  /**
   * Resolves an import to a known workspace file.
   *
   * @param fromFile - Workspace-relative POSIX path of the importing file.
   * @param specifier - Module specifier as written in the import.
   * @param knownFiles - Every analyzable file of the workspace.
   * @returns The imported file, or `null` if it is external or unknown.
   */
  public resolveImport(
    fromFile: RelPath,
    specifier: string,
    knownFiles: ReadonlySet<RelPath>,
  ): RelPath | null {
    return (
      this.listImportCandidates(fromFile, specifier).find((candidate) =>
        knownFiles.has(candidate),
      ) ?? null
    );
  }
}

/** Registry of languages with their parsers. */
export class AnalyzerRegistry extends LanguageRegistry<LanguageAnalyzer> {
  private readonly prepared = new Map<string, Promise<void>>();

  /**
   * Prepares the analyzers of the languages present in a set of files, so
   * projects never load parsers they do not need.
   *
   * @param filePaths - Files about to be parsed.
   * @returns Resolves when every needed analyzer can parse.
   */
  public async prepare(filePaths: Iterable<RelPath>): Promise<void> {
    const needed = new Set<LanguageAnalyzer>();
    for (const filePath of filePaths) {
      const analyzer = this.forFile(filePath);
      if (analyzer?.prepare !== undefined) {
        needed.add(analyzer);
      }
    }
    await Promise.all(
      [...needed].map((analyzer) => {
        let preparing = this.prepared.get(analyzer.id);
        if (preparing === undefined) {
          preparing = analyzer.prepare?.() ?? Promise.resolve();
          // A failed preparation is retried on the next call.
          preparing.catch(() => this.prepared.delete(analyzer.id));
          this.prepared.set(analyzer.id, preparing);
        }
        return preparing;
      }),
    );
  }

  /**
   * Parses a file with the analyzer of its language.
   *
   * @param filePath - Workspace-relative POSIX path.
   * @param content - File text.
   * @returns The parsed file.
   * @throws Error if no language handles the file (callers check
   *   {@link isAnalyzableFile} first).
   */
  public parse(filePath: RelPath, content: string): ParsedFile {
    const analyzer = this.forFile(filePath);
    if (analyzer === undefined) {
      throw new Error(`No language analyzer for "${filePath}".`);
    }
    return analyzer.parse(filePath, content);
  }
}
