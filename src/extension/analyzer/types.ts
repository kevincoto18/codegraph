/**
 * Raw, per-file analysis results produced by the parser.
 *
 * @remarks These types are internal to the extension host. Specifiers and
 * call targets are unresolved here; the linker (Phase 3) turns them into graph
 * nodes and edges.
 */
import type { FunctionKind, RelPath } from '../../shared';

/** How a local name was bound by an import or `require`. */
export type ImportBindingKind = 'default' | 'named' | 'namespace';

/** A local name introduced by an import statement. */
export interface ImportBinding {
  /** Binding form. */
  readonly kind: ImportBindingKind;
  /** Name exported by the target module (`default` for default, `*` for namespace). */
  readonly importedName: string;
  /** Name used inside the importing file. */
  readonly localName: string;
}

/** Syntax that produced an import. */
export type ImportSyntax = 'import' | 're-export' | 'require';

/** A dependency on another module declared at the top level of a file. */
export interface ParsedImport {
  /** Raw module specifier as written, e.g. `./utils` or `react`. */
  readonly specifier: string;
  /** Syntax that produced the import. */
  readonly syntax: ImportSyntax;
  /** 1-based line of the statement. */
  readonly line: number;
  /** Local names bound by the statement (empty for side-effect imports and re-exports). */
  readonly bindings: readonly ImportBinding[];
}

/** Shape of a call expression found inside a function body. */
export type CallKind = 'identifier' | 'member' | 'this-member';

/** A call site inside a function body. */
export interface ParsedCall {
  /**
   * Call shape:
   * - `identifier`: `foo()`
   * - `member`: `receiver.foo()` where `receiver` is a plain identifier
   * - `this-member`: `this.foo()`
   */
  readonly kind: CallKind;
  /** Called name (`foo` in every example above). */
  readonly name: string;
  /** Receiver identifier, only for `member` calls. */
  readonly receiver?: string;
  /** 1-based line of the call. */
  readonly line: number;
}

/** A function-like declaration that becomes a graph node. */
export interface ParsedFunction {
  /** Simple name (`save`). */
  readonly name: string;
  /** Name including its class, if any (`UserService.save`). */
  readonly qualifiedName: string;
  /** Enclosing class name, for methods. */
  readonly className?: string;
  /** Syntactic form. */
  readonly functionKind: FunctionKind;
  /** 1-based start line. */
  readonly line: number;
  /** 1-based end line. */
  readonly endLine: number;
  /** Whether the function (or its class) is exported. */
  readonly exported: boolean;
  /** Calls made from this function, including from nested closures. */
  readonly calls: readonly ParsedCall[];
}

/** Maps a name visible to importers to the local declaration that backs it. */
export interface ParsedExport {
  /** Name importers use (`default` for default exports). */
  readonly exportedName: string;
  /** Local declaration name inside the file. */
  readonly localName: string;
}

/** Complete raw analysis of one source file. */
export interface ParsedFile {
  readonly filePath: RelPath;
  readonly imports: readonly ParsedImport[];
  readonly functions: readonly ParsedFunction[];
  readonly exports: readonly ParsedExport[];
}
