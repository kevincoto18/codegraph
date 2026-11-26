/**
 * Raw, per-file analysis results produced by the parser.
 *
 * @remarks These types are internal to the extension host. Specifiers and
 * call targets are unresolved here; the linker (Phase 3) turns them into graph
 * nodes and edges.
 */
import type { FunctionKind, RelPath } from '../../shared';
import type { PyFunctionInfo, PyModuleInfo } from './pythonModel';

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

/**
 * What an import refers to:
 * - `module`: a file found from the specifier's path (TypeScript, Python); the default
 * - `type`: one type, `namespace.Type` (Java `import a.b.Repo`, C# `using R = A.B.Repo`)
 * - `namespace`: every type of a namespace (Java `import a.b.*`, C# `using A.B`)
 * - `package`: a package directory found from an import path (Go)
 */
export type ImportTarget = 'module' | 'type' | 'namespace' | 'package';

/** A dependency on another module declared at the top level of a file. */
export interface ParsedImport {
  /** Raw module specifier as written, e.g. `./utils` or `react`. */
  readonly specifier: string;
  /** What the specifier refers to; `module` when omitted. */
  readonly target?: ImportTarget;
  /** Syntax that produced the import. */
  readonly syntax: ImportSyntax;
  /** 1-based line of the statement. */
  readonly line: number;
  /** Local names bound by the statement (empty for side-effect imports and re-exports). */
  readonly bindings: readonly ImportBinding[];
  /** `from m import *` (Python): every public name of the module becomes visible. */
  readonly star?: boolean;
  /**
   * Imports the package of a `from pkg import name` statement only to look
   * `name` up (Python): when every name is a submodule, the package is not
   * a dependency of its own.
   */
  readonly lookupOnly?: boolean;
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
  /**
   * Type of the receiver when the parser could infer it (`Repo`, or `db.Repo`
   * in Go); calls are then resolved by type (Java, C#, Go). A type written
   * `call:f` / `call:pkg.F` is the result type of that function.
   */
  readonly receiverType?: string;
  /**
   * Field of {@link receiverType} that is the actual receiver, for
   * `this.repo.save()` / `s.repo.Save()` when the field is declared elsewhere.
   */
  readonly receiverField?: string;
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
  /** Declared result type, when the language has one and it names a type (Go). */
  readonly resultType?: string;
  /** Calls made from this function, including from nested closures. */
  readonly calls: readonly ParsedCall[];
  /** Python: signature details and every use of a name (resolved with types). */
  readonly python?: PyFunctionInfo;
}

/** Maps a name visible to importers to the local declaration that backs it. */
export interface ParsedExport {
  /** Name importers use (`default` for default exports). */
  readonly exportedName: string;
  /** Local declaration name inside the file. */
  readonly localName: string;
}

/** A class, interface, struct or enum, for languages that resolve calls by type. */
export interface ParsedType {
  /** Simple name (`Repo`). */
  readonly name: string;
  /** Namespace, package or package directory that declares it (`com.app.db`). */
  readonly namespace: string;
  /** Simple names of its base classes and interfaces, in source order. */
  readonly bases: readonly string[];
  /** Type of each field or property, by name (simple or `pkg.Type` names). */
  readonly fields: Readonly<Record<string, string>>;
}

/** Complete raw analysis of one source file. */
export interface ParsedFile {
  readonly filePath: RelPath;
  readonly imports: readonly ParsedImport[];
  readonly functions: readonly ParsedFunction[];
  readonly exports: readonly ParsedExport[];
  /**
   * Namespace, package or package directory of the file (Java, C#, Go). Files
   * of the same namespace see each other's types (and functions, in Go).
   */
  readonly namespace?: string;
  /** Types declared in the file (Java, C#, Go). */
  readonly types?: readonly ParsedType[];
  /** Python: classes, module variables and module-level uses. */
  readonly python?: PyModuleInfo;
}
